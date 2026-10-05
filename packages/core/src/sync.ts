/**
 * Getting work into the store: from a calendar feed, from a token, or from a
 * snapshot the extension took with the student's session. All three end in
 * `mergeItem`, so the richest data wins and nothing regresses.
 */
import type { CanvasSnapshot, Course, WorkItem } from "./types.js";
import { CanvasClient } from "./canvas/client.js";
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

// ---- calendar feed ----------------------------------------------------

export async function syncFeed(store: Store, userId: string, feedUrl: string, fetchImpl: typeof fetch = fetch): Promise<SyncReport> {
  const res = await fetchImpl(feedUrl, { headers: { Accept: "text/calendar, */*" } });
  if (!res.ok) throw new Error(`feed returned ${res.status}`);
  const text = await res.text();
  const host = hostOf(feedUrl);
  const nowIso = new Date().toISOString();
  let count = 0;
  for (const ev of parseIcs(text)) {
    const item = canvasFeedEventToItem(ev, nowIso, host);
    if (!item) continue;
    saveItem(store, userId, item);
    count++;
  }
  return { courses: 0, items: count, detailsFetched: 0, errors: [] };
}

// ---- token sync -------------------------------------------------------

export async function syncWithClient(store: Store, userId: string, client: CanvasClient): Promise<SyncReport> {
  const report: SyncReport = { courses: 0, items: 0, detailsFetched: 0, errors: [] };
  const nowIso = new Date().toISOString();
  const courses = new Map<string, Course>();
  for (const raw of await client.courses()) {
    const c = normaliseCourse(raw);
    if (!c) continue;
    courses.set(c.id, c);
    store.upsertCourse(userId, c);
    report.courses++;
  }
  const ctx: NormaliseContext = { baseUrl: client.baseUrl, courses, now: nowIso };

  const start = new Date(Date.now() - PLANNER_PAST_DAYS * 86_400_000);
  const end = new Date(Date.now() + PLANNER_FUTURE_DAYS * 86_400_000);
  const planner = await client.plannerItems(isoDate(start), isoDate(end));
  const seen = new Map<string, WorkItem>();
  for (const raw of planner) {
    const item = normalisePlannerItem(raw, ctx);
    if (!item) continue;
    seen.set(item.id, saveItem(store, userId, item));
    report.items++;
  }

  try {
    for (const raw of await client.missingSubmissions()) {
      const r = raw as Record<string, unknown>;
      const courseRaw = r["course"];
      const c = normaliseCourse(courseRaw);
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
    }
  } catch (e) {
    report.errors.push(`missing_submissions: ${(e as Error).message}`);
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
          report.errors.push(`quiz ${detailed.quizId}: ${(e as Error).message}`);
        }
      }
      saveItem(store, userId, withQuiz, { detailsFetched: true });
      report.detailsFetched++;
      budget--;
    } catch (e) {
      report.errors.push(`assignment ${item.assignmentId}: ${(e as Error).message}`);
    }
  }
  return report;
}

// ---- extension snapshot -----------------------------------------------

export function ingestSnapshot(store: Store, userId: string, snap: CanvasSnapshot): SyncReport {
  const report: SyncReport = { courses: 0, items: 0, detailsFetched: 0, errors: [] };
  const nowIso = snap.fetchedAt || new Date().toISOString();
  const courses = store.courseMap(userId);
  for (const raw of snap.courses ?? []) {
    const c = normaliseCourse(raw);
    if (!c) continue;
    courses.set(c.id, c);
    store.upsertCourse(userId, c);
    report.courses++;
  }
  const ctx: NormaliseContext = { baseUrl: snap.baseUrl, courses, now: nowIso };
  const seen = new Map<string, WorkItem>();
  for (const raw of snap.plannerItems ?? []) {
    const item = normalisePlannerItem(raw, ctx);
    if (!item) continue;
    seen.set(item.id, saveItem(store, userId, item));
    report.items++;
  }
  for (const raw of snap.missingSubmissions ?? []) {
    const r = raw as Record<string, unknown>;
    const existing = store.getItem(userId, `canvas:assignment:${String(r["id"])}`)?.item;
    const item = applyAssignment(raw, ctx, existing);
    if (!item) continue;
    if (item.status === "open") item.status = "missing";
    seen.set(item.id, saveItem(store, userId, item, { detailsFetched: true }));
    report.detailsFetched++;
  }
  for (const [assignmentId, raw] of Object.entries(snap.assignments ?? {})) {
    const id = `canvas:assignment:${assignmentId}`;
    const existing = seen.get(id) ?? store.getItem(userId, id)?.item;
    const detailed = applyAssignment(raw, ctx, existing);
    if (!detailed) continue;
    let withQuiz = detailed;
    const quizRaw = detailed.quizId ? snap.quizzes?.[detailed.quizId] : undefined;
    if (quizRaw) withQuiz = applyQuiz(quizRaw, detailed);
    seen.set(id, saveItem(store, userId, withQuiz, { detailsFetched: true }));
    report.detailsFetched++;
  }
  return report;
}
