/**
 * Getting work into the store: from a calendar feed, from a token, or from a
 * snapshot the extension took with the student's session. All three end in
 * `mergeItem`, so the richest data wins and nothing regresses.
 *
 * Each phase writes in one transaction. After a complete planner list (or a
 * feed), rows of that host and source that Canvas no longer lists inside the
 * range it covered are marked gone (`Store.markItemsGone`): they leave every
 * listing and come back if Canvas lists them again.
 */
import type { CanvasSnapshot, Course, ItemSource, ItemStatus, WorkItem } from "./types.js";
import { CanvasClient, CanvasError, type ListInfo } from "./canvas/client.js";
import { EgressError, assertPublicHttpsUrl, safeFetch, type EgressPolicy } from "./egress.js";
import {
  UNTITLED,
  applyAssignment,
  applyQuiz,
  clearedFields,
  hostOf,
  lockedForUser,
  normaliseCourse,
  normalisePlannerItem,
  withoutClearedMark,
  type NormaliseContext,
} from "./canvas/normalize.js";
import { SNAPSHOT_LIMITS } from "./canvas/project.js";
import { canvasFeedEventToItem, parseIcs } from "./ics.js";
import { Store, itemVersionHash, type ItemRow } from "./store/db.js";
import { shortHash } from "./text.js";
import { isValidTimeZone, localDateKey } from "./tz.js";

export interface SyncReport {
  courses: number;
  items: number;
  detailsFetched: number;
  errors: string[];
  /** Rows marked gone because Canvas stopped listing them. */
  removed?: number;
}

const PLANNER_PAST_DAYS = 14;
const PLANNER_FUTURE_DAYS = 120;
/** Detail fetches per sync, to stay well inside Canvas's per-token quota. Failed requests count too. */
const DETAIL_BUDGET = 40;
const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

function sameLocalDate(a: string, b: string, tz: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return a === b;
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  return localDateKey(da, zone) === localDateKey(db, zone);
}

export interface MergeOptions {
  /**
   * The student's zone. A feed date moves a richer row's due time only when it
   * falls on another local date: Canvas writes 23:59 dues as bare dates, so the
   * feed's time is a guess and the API's is exact. Default UTC.
   */
  timezone?: string;
}

/**
 * Field-level merge: a thinner source never erases what a richer one stored.
 * Fields the incoming item marks as cleared (`clearedFields`) are removed; a
 * detail-derived kind (a New Quiz is "quiz", the planner says "assignment")
 * and a real title survive a planner refresh.
 */
export function mergeItem(existing: WorkItem | undefined, incoming: WorkItem, opts: MergeOptions = {}): WorkItem {
  if (!existing) return withoutClearedMark(incoming);
  if (incoming.source === "feed" && existing.source !== "feed") {
    const out: WorkItem = { ...existing };
    const moved = incoming.dueAt !== undefined && (!existing.dueAt || !sameLocalDate(existing.dueAt, incoming.dueAt, opts.timezone ?? "UTC"));
    if (moved) out.dueAt = incoming.dueAt!;
    if (incoming.endAt && (moved || !out.endAt)) out.endAt = incoming.endAt;
    if (out.allDay === undefined && incoming.allDay !== undefined) out.allDay = incoming.allDay;
    if (out.title === UNTITLED && incoming.title !== UNTITLED) out.title = incoming.title;
    if (!out.courseCode && incoming.courseCode) out.courseCode = incoming.courseCode;
    if (!out.url && incoming.url) out.url = incoming.url;
    if (!out.descriptionText && incoming.descriptionText) {
      out.descriptionText = incoming.descriptionText;
      out.descriptionChars = incoming.descriptionChars ?? incoming.descriptionText.length;
    }
    return out;
  }
  const out: WorkItem = { ...existing, ...stripUndefined(incoming) };
  if (incoming.kind === "assignment" && existing.kind !== "assignment") out.kind = existing.kind;
  if (incoming.title === UNTITLED && existing.title) out.title = existing.title;
  for (const k of clearedFields(incoming)) delete out[k];
  if (incoming.source === "feed") out.source = existing.source;
  return out;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export interface SaveOptions extends MergeOptions {
  /** The item carries a full detail fetch: record it, and reset the retry count. */
  detailsFetched?: boolean;
}

export function saveItem(store: Store, userId: string, incoming: WorkItem, opts: SaveOptions = {}): WorkItem {
  const existing = store.getItem(userId, incoming.id)?.item;
  const merged = mergeItem(existing, incoming, opts);
  store.upsertItem(userId, merged, itemVersionHash(merged, shortHash), { detailsFetched: opts.detailsFetched === true });
  return merged;
}

// ---- which details to fetch ---------------------------------------------

/** Finished, handed-in or excused work needs no brief. */
const NO_DETAIL_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>(["done", "dismissed", "graded", "submitted", "excused"]);

/** Wait after `failures` failed (or locked) detail fetches in a row: 1 h, 4 h, 16 h, 64 h, then 7 days. */
export function detailRetryDelayMs(failures: number): number {
  return Math.min(3_600_000 * 4 ** Math.max(0, failures - 1), 7 * DAY_MS);
}

/**
 * The one rule for refetching an assignment's details, used by the token
 * sync and by the extension's wanted list: assignment-backed work that is
 * still to do, never fetched, changed in Canvas since, or unlocked since (a
 * locked assignment's description is withheld). After a failure it waits
 * `detailRetryDelayMs`, unless Canvas changed or unlocked the item meanwhile.
 */
export function needsDetails(row: ItemRow, nowIso: string): boolean {
  const item = row.item;
  if (!item.assignmentId || !item.courseId || NO_DETAIL_STATUSES.has(item.status)) return false;
  const now = ms(nowIso);
  const updated = ms(item.updatedAt);
  const unlock = ms(item.unlockAt);
  const unlockedSince = (t: number) => unlock > t && unlock <= now;
  if (row.detailsFailures > 0) {
    const failed = ms(row.detailsFailedAt);
    const changed = updated > failed || unlockedSince(failed);
    if (!changed && now < failed + detailRetryDelayMs(row.detailsFailures)) return false;
  }
  const fetched = ms(row.detailsFetchedAt);
  if (Number.isNaN(fetched)) return true;
  return updated > fetched || unlockedSince(fetched);
}

/** Rows that `needsDetails`, upcoming work first (soonest due), then undated, then past due (latest first). */
export function pickDetailCandidates(rows: Iterable<ItemRow>, nowIso: string, limit = Infinity): ItemRow[] {
  const now = ms(nowIso);
  const key = (r: ItemRow): [number, number] => {
    const due = ms(r.item.dueAt);
    if (Number.isNaN(due)) return [1, 0];
    return due >= now ? [0, due] : [2, -due];
  };
  return [...rows]
    .filter((r) => needsDetails(r, nowIso))
    .map((r) => ({ r, k: key(r) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1])
    .slice(0, limit)
    .map((x) => x.r);
}

/** Marks rows of one host and source, due inside [from, to], that this sync did not see. Call inside a transaction. */
function markVanished(store: Store, userId: string, scope: { host: string; source: ItemSource; from: string; to: string }, seen: ReadonlySet<string>): number {
  if (!(scope.from < scope.to)) return 0;
  const gone = store
    .listItems(userId, { from: scope.from, to: scope.to, includeUndated: false })
    .filter((r) => r.item.host === scope.host && r.item.source === scope.source && !seen.has(r.item.id))
    .map((r) => r.item.id);
  store.markItemsGone(userId, gone);
  return gone.length;
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
  /** The student's zone (`prefs.timezone`): date-only dues become 23:59 there. Default UTC. */
  timezone?: string;
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
  const timezone = opts.timezone && isValidTimeZone(opts.timezone) ? opts.timezone : "UTC";
  const nowIso = new Date().toISOString();
  const report: SyncReport = { courses: 0, items: 0, detailsFetched: 0, errors: [] };
  let skipped = 0;
  const events = parseIcs(text, { timeZone: timezone });
  const seen = new Set<string>();
  let first = Infinity;
  let last = -Infinity;
  store.transaction(() => {
    for (const ev of events) {
      try {
        const item = canvasFeedEventToItem(ev, nowIso, host, timezone);
        if (!item) continue;
        saveItem(store, userId, item, { timezone });
        seen.add(item.id);
        const due = ms(item.dueAt);
        if (!Number.isNaN(due)) {
          first = Math.min(first, due);
          last = Math.max(last, due);
        }
        report.items++;
      } catch {
        skipped++;
      }
    }
    // Feed rows on this host inside the span this feed covers that it no longer carries.
    if (seen.size && first < last) {
      report.removed = markVanished(store, userId, { host, source: "feed", from: new Date(first).toISOString(), to: new Date(last).toISOString() }, seen);
    }
  });
  unreadable(report, skipped);
  return report;
}

// ---- token sync -------------------------------------------------------

/** A stopped sync, a network failure or a throttle: nothing wrong with the item, stop asking for now. */
function stopsDetails(e: unknown): boolean {
  if (e instanceof CanvasError) return e.status === 0 || e.throttled;
  return e instanceof EgressError && (e.code === "timeout" || e.code === "network");
}

function pushCapped(report: SyncReport, errors: string[], what: string, max = 3): void {
  report.errors.push(...errors.slice(0, max));
  if (errors.length > max) report.errors.push(`${errors.length - max} more ${what} could not be read`);
}

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
  const host = hostOf(client.baseUrl);

  const start = new Date(Date.now() - PLANNER_PAST_DAYS * DAY_MS);
  const end = new Date(Date.now() + PLANNER_FUTURE_DAYS * DAY_MS);
  const listed: ListInfo = {};
  const planner = await client.plannerItems(isoDate(start), isoDate(end), listed);
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
      const deferred: string[] = [];
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
          const locked = lockedForUser(raw);
          seen.set(item.id, saveItem(store, userId, item, { detailsFetched: !locked }));
          if (locked) deferred.push(item.id);
          report.detailsFetched++;
        } catch {
          skipped++;
        }
      }
      store.markDetailsFailed(userId, deferred);
    });
  } catch (e) {
    report.errors.push(`missing submissions: ${syncErrorMessage(e)}`);
  }

  // Rows Canvas stopped listing inside the planner range (a day's margin each side for time zones).
  if (!listed.truncated) {
    store.transaction(() => {
      const from = new Date(start.getTime() + DAY_MS).toISOString();
      const to = new Date(end.getTime() - DAY_MS).toISOString();
      report.removed = markVanished(store, userId, { host, source: "canvas", from, to }, new Set(seen.keys()));
    });
  }

  // Details for assignment-backed work that is new, changed or unlocked since the last fetch; upcoming first.
  const rows = [...seen.keys()].map((id) => store.getItem(userId, id)).filter((r): r is ItemRow => r !== undefined);
  const results: Array<{ item: WorkItem; fetched: boolean }> = [];
  const failed: string[] = [];
  const errors: string[] = [];
  let budget = DETAIL_BUDGET;
  try {
    for (const row of pickDetailCandidates(rows, nowIso)) {
      if (budget <= 0) break;
      const item = row.item;
      const courseId = item.courseId!;
      let stop = false;
      try {
        const raw = await client.assignment(courseId, item.assignmentId!);
        const detailed = applyAssignment(raw, ctx, item);
        if (!detailed) continue;
        let withQuiz = detailed;
        // Locked: Canvas withheld the description. Keep what came, try again later.
        let complete = !lockedForUser(raw);
        if (detailed.quizId && detailed.kind === "quiz") {
          try {
            withQuiz = applyQuiz(await client.quiz(courseId, detailed.quizId), detailed);
          } catch (e) {
            errors.push(`quiz ${detailed.quizId}: ${syncErrorMessage(e)}`);
            complete = false;
            stop = stopsDetails(e);
          } finally {
            budget--;
          }
        }
        results.push({ item: withQuiz, fetched: complete });
        if (!complete && !stop) failed.push(item.id);
        report.detailsFetched++;
      } catch (e) {
        errors.push(`assignment ${item.assignmentId}: ${syncErrorMessage(e)}`);
        // A stopped or throttled sync stops here rather than failing every remaining detail.
        if (stopsDetails(e)) stop = true;
        else failed.push(item.id);
      } finally {
        budget--;
      }
      if (stop) break;
    }
  } finally {
    store.transaction(() => {
      for (const r of results) saveItem(store, userId, r.item, { detailsFetched: r.fetched });
      store.markDetailsFailed(userId, failed);
    });
  }
  pushCapped(report, errors, "assignment detail(s)");
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
    const failed: string[] = [];
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
        const locked = lockedForUser(raw);
        seen.set(item.id, saveItem(store, userId, item, { detailsFetched: !locked }));
        if (locked) failed.push(item.id);
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
        const locked = lockedForUser(raw);
        seen.set(id, saveItem(store, userId, withQuiz, { detailsFetched: !locked }));
        if (locked) failed.push(id);
        report.detailsFetched++;
      } catch {
        skipped++;
      }
    }
    for (const assignmentId of snap.detailFailures ?? []) failed.push(`canvas:assignment:${assignmentId}`);
    store.markDetailsFailed(userId, failed);
    // Only a complete planner list with its range says what Canvas no longer lists.
    const w = snap.plannerWindow;
    const listed = snap.plannerItems ?? [];
    if (w && listed.length < SNAPSHOT_LIMITS.plannerItems) {
      const from = ms(w.start) + DAY_MS;
      const to = ms(w.end) - DAY_MS;
      if (from < to) {
        report.removed = markVanished(store, userId, { host: hostOf(snap.baseUrl), source: "canvas", from: new Date(from).toISOString(), to: new Date(to).toISOString() }, new Set(seen.keys()));
      }
    }
  });
  unreadable(report, skipped);
  return report;
}
