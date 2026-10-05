/**
 * Getting work into the store: from a calendar feed, from a token, or from a
 * snapshot the extension took with the student's session. All three end in
 * `mergeItem`, so the richest data wins and nothing regresses.
 */
import type { CanvasSnapshot, Course, WorkItem } from "./types.js";
import { CanvasClient, CanvasError } from "./canvas/client.js";
import { EgressError, assertPublicHttpsUrl, safeFetch, type EgressPolicy } from "./egress.js";
import { applyAssignment, applyQuiz, hostOf, normaliseCourse, normalisePlannerItem, type NormaliseContext } from "./canvas/normalize.js";
import { canvasFeedEventToItem, parseIcs } from "./ics.js";
import { Store, itemVersionHash } from "./store/db.js";
import { shortHash } from "./text.js";

export interface SyncReport {
  courses: number;
  items: number;
  detailsFetched: number;
  errors: string[];
}

const PLANNER_PAST_DAYS = 14;
const PLANNER_FUTURE_DAYS = 120;
/** Detail fetches per sync, to stay well inside Canvas's per-token quota. */
const DETAIL_BUDGET = 40;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Field-level merge: a thinner source never erases what a richer one stored. */
export function mergeItem(existing: WorkItem | undefined, incoming: WorkItem): WorkItem {
  if (!existing) return incoming;
  if (incoming.source === "feed" && existing.source !== "feed") {
    const out: WorkItem = { ...existing };
    if (incoming.dueAt) out.dueAt = incoming.dueAt;
    if (!out.courseCode && incoming.courseCode) out.courseCode = incoming.courseCode;
    if (!out.url && incoming.url) out.url = incoming.url;
    if (!out.descriptionText && incoming.descriptionText) {
      out.descriptionText = incoming.descriptionText;
      out.descriptionChars = incoming.descriptionChars ?? incoming.descriptionText.length;
    }
    return out;
  }
  const out: WorkItem = { ...existing, ...stripUndefined(incoming) };
  // Keep detail-only fields from a previous full fetch when the planner view lacks them.
  for (const k of ["descriptionText", "descriptionChars", "submissionTypes", "allowedAttempts", "rubricCriteria", "peerReviews", "isGroup", "isExternalTool", "quiz", "unlockAt", "lockAt", "assignmentId", "quizId"] as const) {
    if (incoming[k] === undefined && existing[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = existing[k];
  }
  if (incoming.source === "feed") out.source = existing.source;
  return out;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function saveItem(store: Store, userId: string, incoming: WorkItem, opts: { detailsFetched?: boolean } = {}): WorkItem {
  const existing = store.getItem(userId, incoming.id)?.item;
  const merged = mergeItem(existing, incoming);
  store.upsertItem(userId, merged, itemVersionHash(merged, shortHash), opts);
  return merged;
}

/** A message safe to show the student or log: our own generic errors pass, anything else is replaced. */
export function syncErrorMessage(e: unknown, fallback = "could not be read"): string {
  return e instanceof CanvasError || e instanceof EgressError ? e.message : fallback;
}

function unreadable(report: SyncReport, n: number): void {
  if (n) report.errors.push(`${n} Canvas record(s) could not be read and were skipped`);
}

// ---- calendar feed ----------------------------------------------------

/** Largest feed accepted. A full term with descriptions is well under this. */
export const FEED_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The canonical form of a Canvas calendar feed URL, or an error:
 * https (loopback http only under the test policy), public host, exactly
 * `/feeds/calendars/user_<token>.ics`, no query string.
 */
export function assertCanvasFeedUrl(input: string, policy: EgressPolicy = {}): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new CanvasError("that is not a Canvas calendar feed URL", 0, "");
  }
  if (u.search || !/^\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics$/.test(u.pathname)) throw new CanvasError("that is not a Canvas calendar feed URL", 0, "");
  assertPublicHttpsUrl(u, policy);
  return `${u.origin}${u.pathname}`;
}

export interface FeedSyncOptions extends EgressPolicy {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function syncFeed(store: Store, userId: string, feedUrl: string, opts: FeedSyncOptions = {}): Promise<SyncReport> {
  const policy: EgressPolicy = opts.allowHttpLoopback ? { allowHttpLoopback: true } : {};
  const url = assertCanvasFeedUrl(feedUrl, policy);
  const init: RequestInit = { headers: { Accept: "text/calendar, */*" } };
  if (opts.signal) init.signal = opts.signal;
  const res = await safeFetch(url, init, { ...policy, maxBytes: FEED_MAX_BYTES, maxRedirects: 3, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  if (!res.ok) {
    const gone = [401, 403, 404, 410].includes(res.status);
    throw new CanvasError(gone ? "Canvas no longer serves this calendar feed; copy the link again from Canvas (Calendar, Calendar Feed)" : "the calendar feed could not be fetched; it will be retried", res.status, "");
  }
  const text = await res.text();
  const host = hostOf(url);
  const nowIso = new Date().toISOString();
  const report: SyncReport = { courses: 0, items: 0, detailsFetched: 0, errors: [] };
  let skipped = 0;
  const events = parseIcs(text);
  store.transaction(() => {
    for (const ev of events) {
      try {
        const item = canvasFeedEventToItem(ev, nowIso, host);
        if (!item) continue;
        saveItem(store, userId, item);
        report.items++;
      } catch {
        skipped++;
      }
    }
  });
  unreadable(report, skipped);
  return report;
}

// ---- token sync -------------------------------------------------------

export async function syncWithClient(store: Store, userId: string, client: CanvasClient): Promise<SyncReport> {
  const report: SyncReport = { courses: 0, items: 0, detailsFetched: 0, errors: [] };
  const nowIso = new Date().toISOString();
  const courses = new Map<string, Course>();
  let skipped = 0;
  // Network first, then each phase's writes in one synchronous transaction.
  const rawCourses = await client.courses();
  store.transaction(() => {
    for (const raw of rawCourses) {
      try {
        const c = normaliseCourse(raw);
        if (!c) continue;
        courses.set(c.id, c);
        store.upsertCourse(userId, c);
        report.courses++;
      } catch {
        skipped++;
      }
    }
  });
  const ctx: NormaliseContext = { baseUrl: client.baseUrl, courses, now: nowIso };

  const start = new Date(Date.now() - PLANNER_PAST_DAYS * 86_400_000);
  const end = new Date(Date.now() + PLANNER_FUTURE_DAYS * 86_400_000);
  const planner = await client.plannerItems(isoDate(start), isoDate(end));
  const seen = new Map<string, WorkItem>();
  store.transaction(() => {
    for (const raw of planner) {
      try {
        const item = normalisePlannerItem(raw, ctx);
        if (!item) continue;
        seen.set(item.id, saveItem(store, userId, item));
        report.items++;
      } catch {
        skipped++;
      }
    }
  });

  try {
    const missing = await client.missingSubmissions();
    store.transaction(() => {
      for (const raw of missing) {
        try {
          const r = raw as Record<string, unknown>;
          const c = normaliseCourse(r["course"]);
          if (c && !courses.has(c.id)) {
            courses.set(c.id, c);
            store.upsertCourse(userId, c);
          }
          const existing = store.getItem(userId, `canvas:assignment:${String(r["id"])}`)?.item;
          const item = applyAssignment(raw, ctx, existing);
          if (!item) continue;
          if (item.status === "open") item.status = "missing";
          seen.set(item.id, saveItem(store, userId, item, { detailsFetched: true }));
          report.detailsFetched++;
        } catch {
          skipped++;
        }
      }
    });
  } catch (e) {
    report.errors.push(`missing submissions: ${syncErrorMessage(e)}`);
  }

  // Details for assignment-backed items that are new or changed since the last fetch.
  let budget = DETAIL_BUDGET;
  for (const item of seen.values()) {
    if (budget <= 0) break;
    if (!item.assignmentId || !item.courseId) continue;
    if (item.status === "done" || item.status === "dismissed" || item.status === "graded") continue;
    const row = store.getItem(userId, item.id);
    if (row?.detailsFetchedAt && row.detailsFetchedAt >= item.updatedAt) continue;
    try {
      const detailed = applyAssignment(await client.assignment(item.courseId, item.assignmentId), ctx, item);
      if (!detailed) continue;
      let withQuiz = detailed;
      if (detailed.quizId && detailed.kind === "quiz") {
        try {
          withQuiz = applyQuiz(await client.quiz(item.courseId, detailed.quizId), detailed);
          budget--;
        } catch (e) {
          report.errors.push(`quiz ${detailed.quizId}: ${syncErrorMessage(e)}`);
        }
      }
      saveItem(store, userId, withQuiz, { detailsFetched: true });
      report.detailsFetched++;
      budget--;
    } catch (e) {
      report.errors.push(`assignment ${item.assignmentId}: ${syncErrorMessage(e)}`);
      // A stopped sync stops here rather than failing every remaining detail.
      if (e instanceof CanvasError && e.status === 0) break;
      if (e instanceof EgressError && e.code === "timeout") break;
    }
  }
  unreadable(report, skipped);
  return report;
}

// ---- extension snapshot -----------------------------------------------

export function ingestSnapshot(store: Store, userId: string, snap: CanvasSnapshot): SyncReport {
  const report: SyncReport = { courses: 0, items: 0, detailsFetched: 0, errors: [] };
  const nowIso = snap.fetchedAt || new Date().toISOString();
  let skipped = 0;
  store.transaction(() => {
    const courses = store.courseMap(userId);
    for (const raw of snap.courses ?? []) {
      try {
        const c = normaliseCourse(raw);
        if (!c) continue;
        courses.set(c.id, c);
        store.upsertCourse(userId, c);
        report.courses++;
      } catch {
        skipped++;
      }
    }
    const ctx: NormaliseContext = { baseUrl: snap.baseUrl, courses, now: nowIso };
    const seen = new Map<string, WorkItem>();
    for (const raw of snap.plannerItems ?? []) {
      try {
        const item = normalisePlannerItem(raw, ctx);
        if (!item) continue;
        seen.set(item.id, saveItem(store, userId, item));
        report.items++;
      } catch {
        skipped++;
      }
    }
    for (const raw of snap.missingSubmissions ?? []) {
      try {
        const r = raw as Record<string, unknown>;
        const existing = store.getItem(userId, `canvas:assignment:${String(r["id"])}`)?.item;
        const item = applyAssignment(raw, ctx, existing);
        if (!item) continue;
        if (item.status === "open") item.status = "missing";
        seen.set(item.id, saveItem(store, userId, item, { detailsFetched: true }));
        report.detailsFetched++;
      } catch {
        skipped++;
      }
    }
    for (const [assignmentId, raw] of Object.entries(snap.assignments ?? {})) {
      try {
        const id = `canvas:assignment:${assignmentId}`;
        const existing = seen.get(id) ?? store.getItem(userId, id)?.item;
        const detailed = applyAssignment(raw, ctx, existing);
        if (!detailed) continue;
        let withQuiz = detailed;
        const quizRaw = detailed.quizId ? snap.quizzes?.[detailed.quizId] : undefined;
        if (quizRaw) withQuiz = applyQuiz(quizRaw, detailed);
        seen.set(id, saveItem(store, userId, withQuiz, { detailsFetched: true }));
        report.detailsFetched++;
      } catch {
        skipped++;
      }
    }
  });
  unreadable(report, skipped);
  return report;
}
