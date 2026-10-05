/**
 * Everything the tools, the settings page and the jobs do, in one place, so
 * an MCP call and a button on the settings page cannot drift apart.
 */
import {
  CanvasClient,
  EgressError,
  EstimateService,
  Sealer,
  Store,
  TIME_BUCKETS,
  addDaysToKey,
  assertCanvasFeedUrl,
  assertPublicHttpsUrl,
  MAX_HORIZON_DAYS,
  formatLocal,
  hashToken,
  hoursNeededInHorizon,
  isLoopbackHostname,
  isValidTimeZone,
  localDateKey,
  normaliseBaseUrl,
  parseDateKey,
  planBlocks,
  preferenceErrors,
  randomToken,
  syncErrorMessage,
  syncFeed,
  syncWithClient,
  writeIcs,
  zonedParts,
  zonedTimeToUtc,
  type CanvasAccount,
  type FullEstimate,
  type GoogleAccount,
  type Interval,
  type Preferences,
  type ProposedBlock,
  type StudyBlock,
  type SyncReport,
  type WorkItem,
} from "@canvas-agent/core";
import type { Config } from "./config.js";
import { randomBytes } from "node:crypto";
import { BLOCK_PROPERTY, GoogleCalendar, GoogleError, eventIdForBlock, googleErrorMessage, isInvalidGrant } from "./google/calendar.js";

export interface WorkloadItem {
  id: string;
  title: string;
  course?: { code?: string; name?: string };
  kind: WorkItem["kind"];
  status: WorkItem["status"];
  dueAt?: string;
  dueLocal?: string;
  pointsPossible?: number;
  url?: string;
  estimate: { p50Hours: number; p80Hours: number; basis: FullEstimate["basis"]; confidence: FullEstimate["confidence"]; pooledMedianHours?: number };
  plannedMinutes: number;
  plannedBlocks: number;
  loggedMinutes?: number;
  late?: boolean;
}

/** A Canvas calendar event: not work, no estimate; propose_plan treats it as busy time. */
export interface WorkloadEvent {
  id: string;
  title: string;
  course?: { code?: string; name?: string };
  start: string;
  /** Absent when Canvas gave no end; propose_plan then assumes an hour. */
  end?: string;
  startLocal: string;
  endLocal?: string;
}

export interface CheckIn {
  itemId: string;
  title: string;
  dueAt?: string;
  plannedMinutes: number;
  estimateP50: number;
}

export interface WorkloadResult {
  from: string;
  to: string;
  /** The student's IANA zone: every *Local field is in it. */
  timezone: string;
  /** Dated work due in the period (and, in the default period, older missing work), earliest first, at most `limit`. */
  items: WorkloadItem[];
  /** How many dated items matched before the limit. */
  total: number;
  /** Pass as `from` for the items after the limit (items due at exactly this instant may repeat). */
  nextFrom?: string;
  /** p50 hours over `items`. */
  p50Hours: number;
  /** Open work with no due date. */
  undated: WorkloadItem[];
  undatedTotal: number;
  events: WorkloadEvent[];
  /** Finished or past work to ask "how long did it take" about, newest first. */
  checkIns: CheckIn[];
  syncedAt?: string;
  warnings: string[];
}

export interface ProposeOptions {
  from?: string;
  to?: string;
  itemIds?: string[];
  busy?: Interval[];
  strategy?: "early" | "even";
  /** Use p80 for everything, not only what is due within 72 hours. */
  conservative?: boolean;
  useGoogleBusy?: boolean;
}

export interface ProposeResult {
  timezone: string;
  horizon: { start: string; end: string };
  blocks: Array<ProposedBlock & { startLocal: string; endLocal: string }>;
  unscheduled: Array<{ itemId: string; title: string; hoursShort: number; reason: string }>;
  dayLoad: Record<string, number>;
  freeHours: number;
  busySource: "google+provided" | "google" | "provided" | "none";
  /** Canvas calendar events inside the horizon, treated as busy. */
  canvasEvents: number;
  notes: string[];
}

export interface CommitInput {
  blocks: Array<{ itemId: string; start: string; end: string }>;
  /** Remove this user's still-planned future blocks for the same items first (blocks being committed again are kept). */
  replace?: boolean;
  /** Write to Google Calendar when connected. Default true. */
  calendar?: boolean;
}

export interface CommitResult {
  /** Every block asked for that is now saved, in the order asked, including ones that were saved already. */
  created: Array<{ blockId: string; itemId: string; title: string; start: string; end: string; startLocal: string; minutes: number; calendarWritten: boolean; alreadySaved?: boolean }>;
  /** New blocks saved by this call. */
  saved: number;
  /** Blocks that were already saved (same item, start and end): returned, never saved twice. */
  duplicates: number;
  /** Of `created`, how many are in Google Calendar. */
  inCalendar: number;
  replaced: number;
  /** "ics": in the plan feed only; its link is on the settings page, never in a tool result. */
  calendar: "google" | "ics" | "none";
  errors: string[];
}

export interface BlockView {
  blockId: string;
  itemId: string;
  title: string;
  course?: string;
  start: string;
  end: string;
  startLocal: string;
  endLocal: string;
  minutes: number;
  status: StudyBlock["status"];
  inCalendar: boolean;
}

export interface ClearResult {
  cleared: number;
  removedEvents: number;
  /** Blocks left in place because their Google event could not be deleted; retry, or remove_blocks. */
  failed: Array<{ blockId: string; itemId: string; start: string; reason: string }>;
  /** Which block states were cleared. */
  statuses: StudyBlock["status"][];
  from: string;
  to?: string;
  warnings: string[];
}

export interface LogTimeResult {
  itemId: string;
  minutes: number;
  /** The calibrated p50 the student was shown before this log. */
  estimateWas?: number;
  /** Past or ongoing blocks marked done. */
  blocksClosed: number;
  /** Future blocks removed (with their calendar events): the work is finished. */
  blocksRemoved: number;
  /** The same minutes were logged for this item moments ago; nothing was added. */
  duplicate: boolean;
  warnings: string[];
}

/** What get_assignment shows: the student's view of one item, without storage internals. */
export interface AssignmentView {
  item: {
    id: string;
    title: string;
    kind: WorkItem["kind"];
    status: WorkItem["status"];
    course?: { code?: string; name?: string };
    dueAt?: string;
    unlockAt?: string;
    lockAt?: string;
    pointsPossible?: number;
    submissionTypes?: string[];
    allowedAttempts?: number;
    rubricCriteria?: number;
    peerReviews?: boolean;
    isGroup?: boolean;
    quiz?: WorkItem["quiz"];
    url?: string;
    late?: boolean;
    submittedAt?: string;
    descriptionText?: string;
    /** The description was cut to DESCRIPTION_CHARS_SHOWN characters. */
    descriptionTruncated?: boolean;
  };
  estimate: { p50Hours: number; p80Hours: number; basis: FullEstimate["basis"]; confidence: FullEstimate["confidence"]; reasoning?: string; steps?: string[]; pooledMedianHours?: number };
  /** Saved blocks that are not removed. */
  blocks: Array<{ blockId: string; start: string; end: string; startLocal: string; minutes: number; status: StudyBlock["status"]; inCalendar: boolean }>;
  sameCourseHistory: Array<{ title: string; minutes: number; estimatedHours: number | null }>;
  timezone: string;
  dueLocal?: string;
}

// ---- time inputs ---------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

function isCalendarDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * An agent's date or time, as a UTC ISO instant for comparing with stored values.
 * Accepts RFC 3339 with an offset, or a date alone, read in the student's zone:
 * the start of that day, or with `edge: "end"` the end of it (the next midnight).
 */
export function parseInstant(value: string, tz: string, name: string, opts: { edge?: "start" | "end"; dateOnly?: boolean } = {}): string {
  const v = String(value).trim();
  const d = DATE_ONLY.exec(v);
  if (d && opts.dateOnly !== false && isCalendarDate(Number(d[1]), Number(d[2]), Number(d[3]))) {
    const key = parseDateKey(opts.edge === "end" ? addDaysToKey(v, 1) : v);
    return zonedTimeToUtc(key.year, key.month, key.day, 0, 0, tz).toISOString();
  }
  const m = DATE_TIME.exec(v);
  if (m && isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6] ?? 0) < 60) {
    const ms = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const example = opts.dateOnly === false ? "" : `, or a date like 2026-10-07 (read in ${tz})`;
  throw new Error(`${name} must be an ISO 8601 date-time with an offset, like 2026-10-07T18:00:00-04:00${example}; got ${JSON.stringify(v.slice(0, 40))}`);
}

/** An instant as local wall time with its offset in `tz`: 2026-10-07T18:00:00-04:00. */
export function isoInZone(iso: string, tz: string): string {
  const d = new Date(iso);
  const ms = Math.floor(d.getTime() / 1000) * 1000;
  const p = zonedParts(new Date(ms), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off === 0 ? "Z" : `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`}`;
}

async function eachLimit<T>(items: T[], limit: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await f(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

/** Thrown once Google has refused the stored refresh token; the account has been disconnected. */
export class GoogleDisconnectedError extends GoogleError {
  constructor() {
    super("Google Calendar access was revoked or has expired, so it has been disconnected; reconnect it on the settings page", 401, "invalid_grant");
    this.name = "GoogleDisconnectedError";
  }
}

/** Interactive syncs (a button, a tool call) stop after this; the jobs allow longer. */
export const INTERACTIVE_SYNC_DEADLINE_MS = 45_000;
export const DESCRIPTION_CHARS_SHOWN = 4000;
export const DEFAULT_WORKLOAD_LIMIT = 50;
export const MAX_COMMIT_BLOCKS = 40;

const DUE_SOON_HOURS = 72;
const DAY_MS = 86_400_000;
/** Statuses that mean the student is finished with an item. */
const FINISHED: WorkItem["status"][] = ["done", "dismissed", "graded", "submitted", "excused"];
/** Blocks that still hold time on the calendar. */
const ACTIVE_BLOCK: StudyBlock["status"][] = ["planned", "kept", "moved"];
/** What clear_plan removes: the plan from now on, including blocks the student moved. */
const CLEARABLE: StudyBlock["status"][] = ["planned", "moved"];
/** A Canvas event without an end blocks this long. */
const EVENT_DEFAULT_MS = 3_600_000;
/** Check-ins look back this far. */
const CHECK_IN_DAYS = 21;
const CHECK_IN_MAX = 10;
/** The same minutes logged for the same item within this window count once. */
const DUPLICATE_LOG_MS = 10 * 60_000;
/** propose_plan considers work due this long after the horizon (pro-rated). */
const LOOKAHEAD_DAYS = 28;

export class Services {
  readonly estimates: EstimateService;
  readonly google?: GoogleCalendar;

  constructor(
    readonly store: Store,
    readonly sealer: Sealer,
    readonly config: Config,
    estimates: EstimateService,
    google?: GoogleCalendar,
  ) {
    this.estimates = estimates;
    if (google) this.google = google;
  }

  // ---- users and credentials -----------------------------------------

  userOrThrow(userId: string) {
    const u = this.store.getUser(userId);
    if (!u) throw new Error("unknown user");
    return u;
  }

  createConnectorKey(userId: string, label = "assistant"): string {
    const key = "ck_" + randomToken(24);
    this.store.createConnectorKey(userId, hashToken(key), label);
    return key;
  }

  createDeviceToken(userId: string, name: string | null): string {
    const token = "dv_" + randomToken(24);
    this.store.createDevice(userId, hashToken(token), name);
    return token;
  }

  // ---- the plan feed (a random capability URL, stored hashed for lookup and sealed for display) --

  private newFeedToken(userId: string): string {
    const token = randomBytes(16).toString("hex");
    this.store.putFeedToken(userId, hashToken(token), this.sealer.seal(token));
    return token;
  }

  private feedToken(userId: string): string {
    const sealed = this.store.getFeedTokenSealed(userId);
    if (sealed) {
      try {
        return this.sealer.open(sealed);
      } catch {
        // SECRET_KEY changed: issue a new link
      }
    }
    return this.newFeedToken(userId);
  }

  userForFeedToken(token: string): string | undefined {
    return this.store.userForFeedTokenHash(hashToken(token));
  }

  /** The student's plan feed URL, created on first use. A capability: show it on the settings page only. */
  planFeedUrl(userId: string): string {
    return `${this.config.baseUrl}/feeds/plan/${this.feedToken(userId)}.ics`;
  }

  /** A new plan feed URL; the old one stops working at once. For a "Regenerate feed link" button. */
  rotateFeedToken(userId: string): string {
    this.userOrThrow(userId);
    return `${this.config.baseUrl}/feeds/plan/${this.newFeedToken(userId)}.ics`;
  }

  /** "Delete my data": every row this student owns, in one transaction. Calendar events already written stay. */
  deleteUserData(userId: string): void {
    this.store.deleteUserData(userId);
  }

  // ---- canvas accounts ------------------------------------------------

  private get egress(): { allowHttpLoopback?: boolean } {
    return this.config.allowLoopbackEgress ? { allowHttpLoopback: true } : {};
  }

  addTokenAccount(userId: string, baseUrl: string, token: string): CanvasAccount {
    const url = normaliseBaseUrl(baseUrl);
    assertPublicHttpsUrl(url, this.egress);
    this.assertCanvasHost(url);
    if (!token.trim() || token.length > 512) throw new Error("that does not look like a Canvas access token");
    return this.store.upsertCanvasAccount({ userId, baseUrl: url, kind: "token", secretSealed: this.sealer.seal(token.trim()) });
  }

  addFeedAccount(userId: string, feedUrl: string): CanvasAccount {
    const url = assertCanvasFeedUrl(feedUrl, this.egress);
    const base = new URL(url).origin;
    this.assertCanvasHost(base);
    return this.store.upsertCanvasAccount({ userId, baseUrl: base, kind: "feed", secretSealed: this.sealer.seal(url) });
  }

  /** The server never fetches a session account; the address only has to be a sane https origin. */
  addSessionAccount(userId: string, baseUrl: string): CanvasAccount {
    const url = normaliseBaseUrl(baseUrl);
    const u = new URL(url);
    const loopback = this.config.allowLoopbackEgress && isLoopbackHostname(u.hostname);
    if (u.protocol !== "https:" && !loopback) throw new Error("Canvas must be https");
    this.assertCanvasHost(url);
    return this.store.upsertCanvasAccount({ userId, baseUrl: url, kind: "session" });
  }

  private assertCanvasHost(baseUrl: string): void {
    const allow = this.config.canvasHostAllowlist;
    if (!allow.length) return;
    const host = new URL(baseUrl).host;
    if (!allow.some((h) => host === h || host.endsWith("." + h))) throw new Error(`Canvas host ${host} is not allowed on this server`);
  }

  /**
   * Removes a Canvas account and, when no other account reads that host, its
   * items; then the plan for those items: planned and moved blocks go, with
   * their Google events where Google will delete them (best effort: a block
   * whose event stays is removed anyway, and a warning says so).
   */
  async removeCanvasAccount(userId: string, accountId: string): Promise<{ removedItems: number; blocksRemoved: number; removedEvents: number; warnings: string[] }> {
    const itemIds = new Set(this.store.deleteCanvasAccount(userId, accountId));
    const victims = itemIds.size ? this.store.listBlocks(userId).filter((b) => itemIds.has(b.itemId) && CLEARABLE.includes(b.status)) : [];
    const r = await this.removeBlockList(userId, victims);
    for (const f of r.failed) this.store.updateBlock(userId, f.block.id, { status: "deleted" });
    const warnings = [...r.warnings];
    if (r.failed.length) warnings.push(`${r.failed.length} study block(s) were removed but their Google Calendar events could not be (${r.failed[0]!.reason}); delete those events in Google Calendar.`);
    return { removedItems: itemIds.size, blocksRemoved: victims.length, removedEvents: r.removedEvents, warnings };
  }

  /**
   * One sync, bounded by a deadline that also cancels its requests. Never
   * throws; the result's errors and the account's last error are generic.
   */
  async syncAccount(account: CanvasAccount, opts: { deadlineMs?: number } = {}): Promise<SyncReport> {
    if (account.kind === "session") return { courses: 0, items: 0, detailsFetched: 0, errors: [] }; // the extension pushes
    const ctrl = new AbortController();
    const stopped = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener("abort", () => reject(new EgressError("the sync took too long and was stopped; it will be retried", "timeout")), { once: true });
    });
    const timer = setTimeout(() => ctrl.abort(), opts.deadlineMs ?? INTERACTIVE_SYNC_DEADLINE_MS);
    timer.unref?.();
    try {
      const work = (async (): Promise<SyncReport> => {
        if (account.kind === "token") {
          const token = this.sealer.open(account.secretSealed ?? "");
          return syncWithClient(this.store, account.userId, new CanvasClient({ baseUrl: account.baseUrl, token, signal: ctrl.signal, ...this.egress }));
        }
        // All-day feed dates (Canvas's 23:59 due times) resolve in the student's zone.
        const timezone = this.store.getUser(account.userId)?.prefs.timezone ?? "UTC";
        return syncFeed(this.store, account.userId, this.sealer.open(account.secretSealed ?? ""), { signal: ctrl.signal, timezone, ...this.egress });
      })();
      const report = await Promise.race([work, stopped]);
      this.store.markSync(account.id, report.errors.length ? report.errors.join("; ").slice(0, 500) : null, true);
      return report;
    } catch (e) {
      const msg = syncErrorMessage(e, "the sync failed; it will be retried").slice(0, 500);
      this.store.markSync(account.id, msg, false);
      return { courses: 0, items: 0, detailsFetched: 0, errors: [msg] };
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }

  /** Starts a sync and returns at once, e.g. right after an account is added. */
  syncInBackground(account: CanvasAccount, log: (msg: string) => void = () => {}): void {
    void this.syncAccount(account).then((r) => {
      if (r.errors.length) log(`first sync ${account.kind} ${new URL(account.baseUrl).host}: ${r.errors.join("; ")}`);
    });
  }

  async syncUser(userId: string): Promise<SyncReport[]> {
    const out: SyncReport[] = [];
    for (const a of this.store.listCanvasAccounts(userId)) out.push(await this.syncAccount(a));
    return out;
  }

  // ---- workload -------------------------------------------------------

  private plannedMinutesByItem(userId: string): Map<string, { minutes: number; blocks: number }> {
    const m = new Map<string, { minutes: number; blocks: number }>();
    for (const b of this.store.listBlocks(userId)) {
      if (b.status === "deleted") continue;
      const cur = m.get(b.itemId) ?? { minutes: 0, blocks: 0 };
      cur.minutes += b.minutes;
      cur.blocks += 1;
      m.set(b.itemId, cur);
    }
    return m;
  }

  private workloadItem(item: WorkItem, est: FullEstimate, tz: string, planned: { minutes: number; blocks: number } | undefined, loggedMinutes: number | undefined): WorkloadItem {
    const w: WorkloadItem = {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      estimate: { p50Hours: est.p50Hours, p80Hours: est.p80Hours, basis: est.basis, confidence: est.confidence },
      plannedMinutes: planned?.minutes ?? 0,
      plannedBlocks: planned?.blocks ?? 0,
    };
    if (est.pooled) w.estimate.pooledMedianHours = est.pooled.medianHours;
    const course = courseOf(item);
    if (course) w.course = course;
    if (item.dueAt) {
      w.dueAt = item.dueAt;
      w.dueLocal = formatLocal(item.dueAt, tz);
    }
    if (item.pointsPossible !== undefined) w.pointsPossible = item.pointsPossible;
    if (item.url) w.url = item.url;
    if (item.late) w.late = true;
    if (loggedMinutes !== undefined) w.loggedMinutes = loggedMinutes;
    return w;
  }

  /**
   * The read path: never waits on a model. Estimates are the cached task card or
   * the heuristic, calibrated; cards are built in the background (`warmEstimates`).
   */
  private readEstimate(userId: string, item: WorkItem): Promise<FullEstimate> {
    return this.estimates.estimate(userId, item, { useLlm: false });
  }

  /** The same for many items, reading the student's items and actuals once. */
  private readEstimates(userId: string, items: WorkItem[]): Promise<Map<string, FullEstimate>> {
    return this.estimates.estimateMany(userId, items, { useLlm: false });
  }

  async workload(userId: string, opts: { from?: string; to?: string; includeDone?: boolean; refresh?: boolean; limit?: number } = {}): Promise<WorkloadResult> {
    const user = this.userOrThrow(userId);
    const tz = user.prefs.timezone;
    const now = Date.now();
    const from = opts.from ? parseInstant(opts.from, tz, "from") : new Date(now - 7 * DAY_MS).toISOString();
    const to = opts.to ? parseInstant(opts.to, tz, "to", { edge: "end" }) : new Date(now + 14 * DAY_MS).toISOString();
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!(toMs > fromMs)) throw new Error(`"to" (${to}) must be after "from" (${from})`);
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? DEFAULT_WORKLOAD_LIMIT)));
    const warnings: string[] = [];
    if (opts.refresh) for (const r of await this.syncUser(userId)) warnings.push(...r.errors);
    const planned = this.plannedMinutesByItem(userId);

    const dated: WorkItem[] = [];
    const undated: WorkItem[] = [];
    const events: WorkloadEvent[] = [];
    for (const { item } of this.store.listItems(userId)) {
      const due = item.dueAt ? Date.parse(item.dueAt) : undefined;
      if (item.kind === "event") {
        if (due === undefined || !(due >= fromMs && due <= toMs)) continue;
        const end = item.endAt ? Date.parse(item.endAt) : due + EVENT_DEFAULT_MS;
        if (end < now) continue; // over already: nothing to plan around
        const ev: WorkloadEvent = { id: item.id, title: item.title, start: item.dueAt!, startLocal: formatLocal(item.dueAt!, tz) };
        const course = courseOf(item);
        if (course) ev.course = course;
        if (item.endAt) {
          ev.end = item.endAt;
          ev.endLocal = formatLocal(item.endAt, tz);
        }
        events.push(ev);
        continue;
      }
      if (!opts.includeDone && FINISHED.includes(item.status)) continue;
      if (due === undefined) undated.push(item);
      else if (due >= fromMs && due <= toMs) dated.push(item);
      // The default period starts a week ago; missing work older than that still needs doing.
      else if (!opts.from && item.status === "missing" && due < fromMs) dated.push(item);
    }
    dated.sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!) || a.title.localeCompare(b.title));

    const shown = dated.slice(0, limit);
    const shownUndated = undated.slice(0, 20);
    const ests = await this.readEstimates(userId, [...shown, ...shownUndated]);
    const view = (item: WorkItem) => this.workloadItem(item, ests.get(item.id)!, tz, planned.get(item.id), this.store.latestActualFor(userId, item.id)?.minutes);
    const items = shown.map(view);
    const undatedShown = shownUndated.map(view);

    const accounts = this.store.listCanvasAccounts(userId);
    const syncedAt = accounts.map((a) => a.lastSyncAt).filter((x): x is string => !!x).sort().pop();
    for (const a of accounts) if (a.lastError) warnings.push(`${a.kind} ${new URL(a.baseUrl).host}: ${a.lastError}`);
    if (!accounts.length) warnings.push(`No Canvas connected yet. Open the settings page (${this.config.baseUrl}/) to add a token, a calendar feed, or pair the browser extension.`);
    const out: WorkloadResult = {
      from,
      to,
      timezone: tz,
      items,
      total: dated.length,
      p50Hours: Math.round(items.reduce((s, i) => s + i.estimate.p50Hours, 0) * 4) / 4,
      undated: undatedShown,
      undatedTotal: undated.length,
      events,
      checkIns: await this.checkIns(userId),
      warnings,
    };
    if (dated.length > limit) out.nextFrom = dated[limit]!.dueAt!;
    if (syncedAt) out.syncedAt = syncedAt;
    return out;
  }

  async assignment(userId: string, itemId: string): Promise<AssignmentView> {
    const user = this.userOrThrow(userId);
    const tz = user.prefs.timezone;
    const row = this.store.getItem(userId, itemId);
    if (!row) throw new Error(`no item ${itemId}; use an id from get_workload`);
    const i = row.item;
    const est = await this.readEstimate(userId, i);
    const blocks = this.store
      .listBlocks(userId, { itemId })
      .filter((b) => b.status !== "deleted")
      .map((b) => ({ blockId: b.id, start: b.start, end: b.end, startLocal: formatLocal(b.start, tz), minutes: b.minutes, status: b.status, inCalendar: !!b.calendarEventId }));
    const history = this.store
      .listActuals(userId)
      .filter((a) => a.itemId !== itemId)
      .map((a) => ({ a, item: this.store.getItem(userId, a.itemId)?.item }))
      .filter((x) => x.item && x.item.courseId === i.courseId)
      .slice(-5)
      .map((x) => ({ title: x.item!.title, minutes: x.a.minutes, estimatedHours: x.a.estimatedHours }));
    const item: AssignmentView["item"] = { id: i.id, title: i.title, kind: i.kind, status: i.status };
    const course = courseOf(i);
    if (course) item.course = course;
    for (const k of ["dueAt", "unlockAt", "lockAt", "pointsPossible", "submissionTypes", "allowedAttempts", "rubricCriteria", "peerReviews", "isGroup", "quiz", "url", "late", "submittedAt"] as const) {
      if (i[k] !== undefined) (item as Record<string, unknown>)[k] = i[k];
    }
    if (i.descriptionText) {
      item.descriptionText = i.descriptionText.slice(0, DESCRIPTION_CHARS_SHOWN);
      if (i.descriptionText.length > DESCRIPTION_CHARS_SHOWN) item.descriptionTruncated = true;
    }
    const estimate: AssignmentView["estimate"] = { p50Hours: est.p50Hours, p80Hours: est.p80Hours, basis: est.basis, confidence: est.confidence };
    if (est.reasoning) estimate.reasoning = est.reasoning;
    if (est.steps?.length) estimate.steps = est.steps;
    if (est.pooled) estimate.pooledMedianHours = est.pooled.medianHours;
    const out: AssignmentView = { item, estimate, blocks, sameCourseHistory: history, timezone: tz };
    if (i.dueAt) out.dueLocal = formatLocal(i.dueAt, tz);
    return out;
  }

  /**
   * Builds model task cards ahead of time for work coming up, so tools never wait
   * on a model. A no-op without one; items with a card (or a recent failure) cost nothing.
   */
  async warmEstimates(userId: string, opts: { concurrency?: number; max?: number; horizonDays?: number } = {}): Promise<{ asked: number; created: number; failed: number; skipped: number }> {
    const now = Date.now();
    const until = now + (opts.horizonDays ?? 21) * DAY_MS;
    const upcoming = this.store
      .listItems(userId)
      .map((r) => r.item)
      .filter((i) => i.kind !== "event" && !FINISHED.includes(i.status) && !!i.dueAt)
      .filter((i) => Date.parse(i.dueAt!) <= until && (Date.parse(i.dueAt!) >= now || i.status === "missing"))
      .sort((x, y) => Date.parse(x.dueAt!) - Date.parse(y.dueAt!));
    return this.estimates.warmTaskCards(upcoming, { concurrency: opts.concurrency ?? 2, max: opts.max ?? 20 });
  }

  // ---- planning -------------------------------------------------------

  private async googleBusy(userId: string, from: string, to: string): Promise<Interval[] | undefined> {
    if (!this.google) return undefined;
    const token = await this.googleAccessToken(userId);
    if (!token) return undefined;
    const acct = this.store.getGoogleAccount(userId)!;
    return this.google.freeBusy(token, [acct.calendarId], from, to);
  }

  /**
   * A fresh access token, refreshed when needed. When Google refuses the refresh
   * token (revoked, expired, the testing-mode week ran out) the account is
   * disconnected and a `GoogleDisconnectedError` says so.
   */
  async googleAccessToken(userId: string): Promise<string | undefined> {
    if (!this.google) return undefined;
    const acct = this.store.getGoogleAccount(userId);
    if (!acct) return undefined;
    if (acct.accessTokenSealed && acct.accessExpiresAt && new Date(acct.accessExpiresAt).getTime() - Date.now() > 60_000) {
      return this.sealer.open(acct.accessTokenSealed);
    }
    let refreshed: Awaited<ReturnType<GoogleCalendar["refresh"]>>;
    try {
      refreshed = await this.google.refresh(this.sealer.open(acct.refreshTokenSealed));
    } catch (e) {
      if (isInvalidGrant(e)) {
        this.store.deleteGoogleAccount(userId);
        throw new GoogleDisconnectedError();
      }
      throw e;
    }
    this.store.putGoogleAccount({
      ...acct,
      accessTokenSealed: this.sealer.seal(refreshed.access_token),
      accessExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    });
    return refreshed.access_token;
  }

  /** Minutes already planned per item that still count: blocks in the future, or confirmed by the calendar or a log. */
  private countedMinutesByItem(userId: string, nowMs: number): Map<string, number> {
    const m = new Map<string, number>();
    for (const b of this.store.listBlocks(userId)) {
      const counts = b.status === "kept" || b.status === "moved" || b.status === "done" || (b.status === "planned" && Date.parse(b.end) > nowMs);
      if (counts) m.set(b.itemId, (m.get(b.itemId) ?? 0) + b.minutes);
    }
    return m;
  }

  async propose(userId: string, opts: ProposeOptions = {}): Promise<ProposeResult> {
    const user = this.userOrThrow(userId);
    const tz = user.prefs.timezone;
    const now = new Date();
    const nowMs = now.getTime();
    const start = opts.from ? parseInstant(opts.from, tz, "from") : now.toISOString();
    const end = opts.to ? parseInstant(opts.to, tz, "to", { edge: "end" }) : new Date(nowMs + 7 * DAY_MS).toISOString();
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!(endMs > startMs)) throw new Error(`"to" (${end}) must be after "from" (${start})`);
    if (endMs <= nowMs) throw new Error(`the horizon ends in the past (${end}); plan from now on`);
    if (endMs - startMs > MAX_HORIZON_DAYS * DAY_MS) throw new Error(`plan at most ${MAX_HORIZON_DAYS} days at a time`);
    const notes: string[] = [];
    const provided: Interval[] = (opts.busy ?? []).map((b, i) => {
      const s = parseInstant(b.start, tz, `busy[${i}].start`);
      const e = parseInstant(b.end, tz, `busy[${i}].end`, { edge: "end" });
      if (!(Date.parse(e) > Date.parse(s))) throw new Error(`busy[${i}]: end (${e}) must be after start (${s})`);
      return { start: s, end: e };
    });
    let busy: Interval[] = [...provided];
    let busySource: ProposeResult["busySource"] = provided.length ? "provided" : "none";
    if (opts.useGoogleBusy !== false) {
      try {
        const g = await this.googleBusy(userId, start, end);
        if (g) {
          busy = busy.concat(g);
          busySource = provided.length ? "google+provided" : "google";
        }
      } catch (e) {
        notes.push(`Could not read Google Calendar busy time: ${googleErrorMessage(e)}`);
      }
    }
    if (busySource === "none") notes.push("No calendar busy time was available; blocks assume the work windows in the student's preferences are free.");

    const all = this.store.listItems(userId).map((r) => r.item);
    // Canvas calendar events are busy time, not work. All-day ones (holidays, reading days) are not.
    let canvasEvents = 0;
    for (const ev of all) {
      if (ev.kind !== "event" || !ev.dueAt || ev.allDay) continue;
      const s = Date.parse(ev.dueAt);
      const e = ev.endAt ? Date.parse(ev.endAt) : s + EVENT_DEFAULT_MS;
      if (!(e > s) || e - s >= DAY_MS || e <= startMs || s >= endMs) continue;
      busy.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
      canvasEvents++;
    }

    const counted = this.countedMinutesByItem(userId, nowMs);
    const lookaheadMs = endMs + LOOKAHEAD_DAYS * DAY_MS;
    const minBlockHours = user.prefs.minBlockMinutes / 60;
    const requested = opts.itemIds ? new Set(opts.itemIds) : undefined;
    const skipped: ProposeResult["unscheduled"] = [];
    const skip = (item: WorkItem, reason: string) => {
      if (requested) skipped.push({ itemId: item.id, title: item.title, hoursShort: 0, reason });
    };
    const items: Parameters<typeof planBlocks>[0]["items"] = [];
    const candidates: Array<{ item: WorkItem; dueMs: number | undefined; asap: boolean }> = [];
    const seen = new Set<string>();
    for (const item of all) {
      if (requested && !requested.has(item.id)) continue;
      seen.add(item.id);
      if (item.kind === "event") {
        skip(item, "a calendar event, not work to plan; it is treated as busy time");
        continue;
      }
      if (FINISHED.includes(item.status)) {
        skip(item, `already ${item.status}`);
        continue;
      }
      if (this.store.latestActualFor(userId, item.id)) {
        skip(item, "time already logged, so it counts as finished");
        continue;
      }
      if (item.lockAt && Date.parse(item.lockAt) <= nowMs) {
        skip(item, "closed in Canvas (past its lock date)");
        continue;
      }
      const dueMs = item.dueAt ? Date.parse(item.dueAt) : undefined;
      // Missing work (and anything past due the student asks for) is planned as soon as possible, with no deadline.
      const asap = dueMs !== undefined && dueMs <= nowMs && (item.status === "missing" || !!requested);
      if (dueMs !== undefined && dueMs <= nowMs && !asap) continue;
      if (dueMs === undefined && !requested) continue; // undated work only when asked for by id
      if (dueMs !== undefined && dueMs < startMs && !asap) {
        skip(item, "due before the start of this horizon");
        continue;
      }
      if (dueMs !== undefined && dueMs > lookaheadMs && !requested) continue;
      candidates.push({ item, dueMs, asap });
    }
    const ests = await this.readEstimates(userId, candidates.map((c) => c.item));
    let missingAsap = false;
    for (const { item, dueMs, asap } of candidates) {
      const est = ests.get(item.id)!;
      const dueSoon = dueMs !== undefined && dueMs - nowMs < DUE_SOON_HOURS * 3_600_000;
      const target = opts.conservative || dueSoon ? est.p80Hours : est.p50Hours;
      let hoursNeeded = Math.max(0, target - (counted.get(item.id) ?? 0) / 60);
      if (dueMs !== undefined && dueMs > endMs) {
        // Due after the horizon: only this horizon's share of the time left before the buffer.
        hoursNeeded = Math.round(hoursNeededInHorizon(hoursNeeded, { now: now.toISOString(), horizonEnd: end, dueAt: item.dueAt, bufferHours: user.prefs.bufferHoursBeforeDue }) * 4) / 4;
        if (hoursNeeded < minBlockHours) {
          skip(item, "due after this horizon; its share of the work fits later");
          continue;
        }
      }
      if (hoursNeeded < 0.25) {
        skip(item, "already planned in full");
        continue;
      }
      const planItem: (typeof items)[number] = {
        itemId: item.id,
        title: item.courseCode ? `${item.title} (${item.courseCode})` : item.title,
        hoursNeeded,
      };
      if (item.dueAt && !asap) planItem.dueAt = item.dueAt;
      if (asap) planItem.asap = true; // overdue work goes before anything dated
      if (asap && item.status === "missing") missingAsap = true;
      if (item.unlockAt) planItem.unlockAt = item.unlockAt;
      if (item.pointsPossible !== undefined) planItem.priority = item.pointsPossible;
      items.push(planItem);
    }
    for (const id of requested ?? []) {
      if (seen.has(id)) continue;
      const row = this.store.getItem(userId, id);
      if (row?.goneAt) skipped.push({ itemId: id, title: row.item.title, hoursShort: 0, reason: "no longer listed in Canvas" });
      else skipped.push({ itemId: id, title: id, hoursShort: 0, reason: "no such item; use an id from get_workload" });
    }
    if (missingAsap) notes.push("Missing work is planned as soon as possible.");

    const existing = this.store.listBlocks(userId, { from: start, to: end });
    const planInput: Parameters<typeof planBlocks>[0] = {
      now: now.toISOString(),
      horizonStart: start,
      horizonEnd: end,
      items,
      busy,
      existingBlocks: existing,
      prefs: user.prefs,
    };
    if (opts.strategy) planInput.strategy = opts.strategy;
    const result = planBlocks(planInput);
    if (result.warnings?.length) notes.push(...result.warnings);
    const placed = new Set(result.blocks.map((b) => b.itemId));
    const reported = new Set(result.unscheduled.map((u) => u.itemId));
    // Every requested id the planner took but placed nothing for, and did not explain, gets a reason too.
    for (const i of items) if (requested && !placed.has(i.itemId) && !reported.has(i.itemId)) skipped.push({ itemId: i.itemId, title: i.title, hoursShort: i.hoursNeeded, reason: "no free time for a block in the work windows" });
    return {
      timezone: tz,
      horizon: { start, end },
      blocks: result.blocks.map((b) => ({ ...b, startLocal: formatLocal(b.start, tz), endLocal: formatLocal(b.end, tz) })),
      unscheduled: [...skipped, ...result.unscheduled],
      dayLoad: result.dayLoad,
      freeHours: result.freeHours,
      busySource,
      canvasEvents,
      notes,
    };
  }

  /** Google is connected and reachable for this user, or why not. */
  private async googleContext(userId: string, want = true): Promise<{ google?: GoogleAccount; token?: string; error?: string; gone: boolean }> {
    if (!want || !this.google) return { gone: true };
    const google = this.store.getGoogleAccount(userId);
    if (!google) return { gone: true };
    try {
      const token = await this.googleAccessToken(userId);
      return token ? { google, token, gone: false } : { gone: true };
    } catch (e) {
      return { google, error: googleErrorMessage(e), gone: e instanceof GoogleDisconnectedError };
    }
  }

  /** Inserts the event for a block under an id derived from it; a 409 from an earlier, unrecorded attempt is adopted. */
  private async writeEvent(token: string, google: GoogleAccount, block: StudyBlock, item: WorkItem, tz: string): Promise<string> {
    const id = eventIdForBlock(block.id);
    try {
      const ev = await this.google!.insertEvent(token, google.calendarId, {
        id,
        summary: `Study: ${item.title}${item.courseCode ? ` (${item.courseCode})` : ""}`,
        description: blockDescription(item, tz),
        start: block.start,
        end: block.end,
        blockId: block.id,
        ...(item.url ? { url: item.url } : {}),
      });
      return ev.id ?? id;
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 409)) throw e;
      const ev = await this.google!.getEvent(token, google.calendarId, id);
      const ours = ev?.extendedProperties?.private?.[BLOCK_PROPERTY] === block.id;
      if (ev && ours && ev.status !== "cancelled") return ev.id;
      throw new GoogleError(ours ? "this block's event was deleted in Google Calendar; remove the block and commit it again to restore it" : "Google Calendar already has a different event with this block's id", 409);
    }
  }

  async commit(userId: string, input: CommitInput): Promise<CommitResult> {
    const user = this.userOrThrow(userId);
    const tz = user.prefs.timezone;
    if (input.blocks.length > MAX_COMMIT_BLOCKS) throw new Error(`commit at most ${MAX_COMMIT_BLOCKS} blocks at a time`);
    const errors: string[] = [];
    const wants: Array<{ itemId: string; item: WorkItem; start: string; end: string; minutes: number }> = [];
    input.blocks.forEach((b, i) => {
      let start: string;
      let end: string;
      try {
        start = parseInstant(b.start, tz, `blocks[${i}].start`, { dateOnly: false });
        end = parseInstant(b.end, tz, `blocks[${i}].end`, { dateOnly: false });
      } catch (e) {
        errors.push((e as Error).message);
        return;
      }
      const row = this.store.getItem(userId, b.itemId);
      if (!row) {
        errors.push(`blocks[${i}]: no item ${b.itemId}; copy item_id from a proposed block's itemId`);
        return;
      }
      if (row.goneAt) {
        errors.push(`blocks[${i}]: ${b.itemId} is no longer listed in Canvas; it is not planned`);
        return;
      }
      const item = row.item;
      const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
      if (!(minutes > 0)) {
        errors.push(`blocks[${i}]: end must be after start`);
        return;
      }
      wants.push({ itemId: b.itemId, item, start, end, minutes });
    });
    const key = (b: { itemId: string; start: string; end: string }) => `${b.itemId}|${b.start}|${b.end}`;
    const g = await this.googleContext(userId, input.calendar !== false);
    if (g.error) errors.push(`Google Calendar: ${g.error}`);

    let replaced = 0;
    if (input.replace && wants.length) {
      const keep = new Set(wants.map(key));
      const items = new Set(wants.map((w) => w.itemId));
      const nowMs = Date.now();
      const victims = this.store
        .listBlocks(userId)
        .filter((b) => items.has(b.itemId) && b.status === "planned" && Date.parse(b.start) >= nowMs && !keep.has(key(b)));
      const r = await this.removeBlockList(userId, victims);
      replaced = r.removed.length;
      for (const f of r.failed) errors.push(`could not replace block ${f.block.id}: ${f.reason}`);
      errors.push(...r.warnings);
    }

    // Save first, in one transaction; a block already saved (same item, start, end) is returned, not saved again.
    const active = new Map<string, StudyBlock>();
    for (const b of this.store.listBlocks(userId)) if (b.status !== "deleted") active.set(key(b), b);
    const rows: Array<{ block: StudyBlock; item: WorkItem; existing: boolean }> = [];
    this.store.transaction(() => {
      for (const w of wants) {
        const found = active.get(key(w));
        if (found) {
          rows.push({ block: found, item: w.item, existing: true });
          continue;
        }
        const block = this.store.addBlock(userId, { itemId: w.itemId, start: w.start, end: w.end, minutes: w.minutes });
        active.set(key(block), block);
        rows.push({ block, item: w.item, existing: false });
      }
    });

    // Then the calendar, a few at a time. A retry writes what an earlier call could not.
    if (g.token && g.google) {
      const token = g.token;
      const google = g.google;
      const todo = [...new Map(rows.filter((r) => !r.block.calendarEventId && r.block.status !== "done").map((r) => [r.block.id, r])).values()];
      await eachLimit(todo, 4, async (r) => {
        try {
          const eventId = await this.writeEvent(token, google, r.block, r.item, tz);
          this.store.updateBlock(userId, r.block.id, { calendarEventId: eventId, calendarId: google.calendarId });
          const fresh = this.store.getBlock(userId, r.block.id)!;
          for (const x of rows) if (x.block.id === fresh.id) x.block = fresh;
        } catch (e) {
          errors.push(`Google event for ${r.item.title} at ${formatLocal(r.block.start, tz)}: ${googleErrorMessage(e)}`);
        }
      });
    }
    const created: CommitResult["created"] = rows.map((r) => ({
      blockId: r.block.id,
      itemId: r.block.itemId,
      title: r.item.title,
      start: r.block.start,
      end: r.block.end,
      startLocal: formatLocal(r.block.start, tz),
      minutes: r.block.minutes,
      calendarWritten: !!r.block.calendarEventId,
      ...(r.existing ? { alreadySaved: true } : {}),
    }));
    return {
      created,
      saved: rows.filter((r) => !r.existing).length,
      duplicates: rows.filter((r) => r.existing).length,
      inCalendar: created.filter((c) => c.calendarWritten).length,
      replaced,
      calendar: g.token && g.google ? "google" : "ics",
      errors,
    };
  }

  /**
   * Marks blocks deleted, each only once its Google event is gone. When Google is
   * no longer connected at all the events cannot be reached: the blocks go and a
   * warning says the events may remain.
   */
  private async removeBlockList(userId: string, victims: StudyBlock[]): Promise<{ removed: StudyBlock[]; removedEvents: number; failed: Array<{ block: StudyBlock; reason: string }>; warnings: string[] }> {
    const out = { removed: [] as StudyBlock[], removedEvents: 0, failed: [] as Array<{ block: StudyBlock; reason: string }>, warnings: [] as string[] };
    if (!victims.length) return out;
    const g = victims.some((v) => v.calendarEventId) ? await this.googleContext(userId) : { gone: true as const };
    let orphaned = 0;
    await eachLimit(victims, 4, async (v) => {
      if (v.calendarEventId) {
        if (g.token && g.google) {
          try {
            await this.google!.deleteEvent(g.token, v.calendarId ?? g.google.calendarId, v.calendarEventId);
            out.removedEvents++;
          } catch (e) {
            out.failed.push({ block: v, reason: googleErrorMessage(e) });
            return;
          }
        } else if (g.gone) {
          orphaned++;
        } else {
          out.failed.push({ block: v, reason: "error" in g && g.error ? g.error : "Google Calendar could not be reached" });
          return;
        }
      }
      this.store.updateBlock(userId, v.id, { status: "deleted" });
      out.removed.push(v);
    });
    if (orphaned) out.warnings.push(`${orphaned} removed block(s) still have an event in Google Calendar, which is no longer connected; delete those events there.`);
    return out;
  }

  /** Removes the plan from `from` (default now) on: planned and moved blocks that start in the period. */
  async clearPlan(userId: string, opts: { itemIds?: string[]; from?: string; to?: string } = {}): Promise<ClearResult> {
    const tz = this.userOrThrow(userId).prefs.timezone;
    const from = opts.from ? parseInstant(opts.from, tz, "from") : new Date().toISOString();
    const to = opts.to ? parseInstant(opts.to, tz, "to", { edge: "end" }) : undefined;
    const fromMs = Date.parse(from);
    const toMs = to ? Date.parse(to) : Infinity;
    if (!(toMs > fromMs)) throw new Error(`"to" (${to}) must be after "from" (${from})`);
    const items = opts.itemIds ? new Set(opts.itemIds) : undefined;
    const victims = this.store
      .listBlocks(userId)
      .filter((b) => CLEARABLE.includes(b.status) && Date.parse(b.start) >= fromMs && Date.parse(b.start) < toMs && (!items || items.has(b.itemId)));
    const r = await this.removeBlockList(userId, victims);
    const out: ClearResult = {
      cleared: r.removed.length,
      removedEvents: r.removedEvents,
      failed: r.failed.map((f) => ({ blockId: f.block.id, itemId: f.block.itemId, start: f.block.start, reason: f.reason })),
      statuses: CLEARABLE,
      from,
      warnings: r.warnings,
    };
    if (to) out.to = to;
    return out;
  }

  private blockView(userId: string, b: StudyBlock, tz: string, items = new Map<string, WorkItem | undefined>()): BlockView {
    if (!items.has(b.itemId)) items.set(b.itemId, this.store.getItem(userId, b.itemId)?.item);
    const item = items.get(b.itemId);
    const v: BlockView = {
      blockId: b.id,
      itemId: b.itemId,
      title: item?.title ?? b.itemId,
      start: b.start,
      end: b.end,
      startLocal: formatLocal(b.start, tz),
      endLocal: formatLocal(b.end, tz),
      minutes: b.minutes,
      status: b.status,
      inCalendar: !!b.calendarEventId,
    };
    if (item?.courseCode) v.course = item.courseCode;
    return v;
  }

  /** Saved blocks overlapping the period (default: today in the student's zone through 14 days on). */
  getPlan(userId: string, opts: { from?: string; to?: string } = {}): { timezone: string; from: string; to: string; blocks: BlockView[]; totalMinutes: number } {
    const tz = this.userOrThrow(userId).prefs.timezone;
    const today = parseDateKey(localDateKey(new Date(), tz));
    const from = opts.from ? parseInstant(opts.from, tz, "from") : zonedTimeToUtc(today.year, today.month, today.day, 0, 0, tz).toISOString();
    const to = opts.to ? parseInstant(opts.to, tz, "to", { edge: "end" }) : new Date(Date.parse(from) + 14 * DAY_MS).toISOString();
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!(toMs > fromMs)) throw new Error(`"to" (${to}) must be after "from" (${from})`);
    const items = new Map<string, WorkItem | undefined>();
    const blocks = this.store
      .listBlocks(userId)
      .filter((b) => b.status !== "deleted" && Date.parse(b.end) > fromMs && Date.parse(b.start) < toMs)
      .map((b) => this.blockView(userId, b, tz, items));
    return { timezone: tz, from, to, blocks, totalMinutes: blocks.reduce((s, b) => s + b.minutes, 0) };
  }

  async removeBlocks(userId: string, blockIds: string[]): Promise<{ removed: string[]; removedEvents: number; alreadyRemoved: string[]; failed: Array<{ blockId: string; reason: string }>; warnings: string[] }> {
    this.userOrThrow(userId);
    const failed: Array<{ blockId: string; reason: string }> = [];
    const alreadyRemoved: string[] = [];
    const victims: StudyBlock[] = [];
    for (const id of new Set(blockIds)) {
      const b = this.store.getBlock(userId, id);
      if (!b) failed.push({ blockId: id, reason: "no such block; use a blockId from get_plan" });
      else if (b.status === "deleted") alreadyRemoved.push(id);
      else victims.push(b);
    }
    const r = await this.removeBlockList(userId, victims);
    for (const f of r.failed) failed.push({ blockId: f.block.id, reason: `${f.reason}; the block was kept` });
    return { removed: r.removed.map((b) => b.id), removedEvents: r.removedEvents, alreadyRemoved, failed, warnings: r.warnings };
  }

  /** Moves one block, and its Google event first: if Google refuses, nothing changes. */
  async moveBlock(userId: string, blockId: string, startIn: string, endIn: string): Promise<{ block: BlockView; calendarUpdated: boolean; warnings: string[] }> {
    const tz = this.userOrThrow(userId).prefs.timezone;
    const b = this.store.getBlock(userId, blockId);
    if (!b) throw new Error(`no block ${blockId}; use a blockId from get_plan`);
    if (b.status === "deleted") throw new Error(`block ${blockId} was removed; commit a new block instead`);
    const start = parseInstant(startIn, tz, "start", { dateOnly: false });
    const end = parseInstant(endIn, tz, "end", { dateOnly: false });
    const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
    if (!(minutes > 0)) throw new Error("end must be after start");
    const warnings: string[] = [];
    let calendarUpdated = false;
    if (b.calendarEventId) {
      const g = await this.googleContext(userId);
      if (g.token && g.google) {
        try {
          await this.google!.patchEvent(g.token, b.calendarId ?? g.google.calendarId, b.calendarEventId, { start, end });
          calendarUpdated = true;
        } catch (e) {
          throw new Error(`Google Calendar did not move the event (${googleErrorMessage(e)}); nothing was changed`);
        }
      } else if (g.gone) {
        warnings.push("Google Calendar is no longer connected; the block moved here and in the calendar feed, but its old Google event stays where it was.");
      } else {
        throw new Error(`Google Calendar could not be reached (${g.error ?? "unknown error"}); nothing was changed`);
      }
    }
    this.store.updateBlock(userId, b.id, { start, end, minutes, ...(b.status === "kept" ? { status: "planned" as const } : {}) });
    return { block: this.blockView(userId, this.store.getBlock(userId, b.id)!, tz), calendarUpdated, warnings };
  }

  planFeedIcs(userId: string): string {
    const user = this.userOrThrow(userId);
    const blocks = this.store.listBlocks(userId).filter((b) => b.status !== "deleted");
    const events = blocks.map((b) => {
      const item = this.store.getItem(userId, b.itemId)?.item;
      const ev: { uid: string; start: string; end: string; summary: string; description?: string; url?: string } = {
        uid: `${b.id}@canvas-agent`,
        start: b.start,
        end: b.end,
        summary: `Study: ${item?.title ?? b.itemId}${item?.courseCode ? ` (${item.courseCode})` : ""}`,
      };
      if (item) ev.description = blockDescription(item, user.prefs.timezone);
      if (item?.url) ev.url = item.url;
      return ev;
    });
    return writeIcs("Study blocks", events);
  }

  // ---- actuals --------------------------------------------------------

  /**
   * Records how long finished work took. Blocks still ahead are removed (with
   * their events): the work is done. Past and ongoing blocks are marked done.
   * The same minutes logged again within a few minutes (a retry) count once.
   */
  async logTime(userId: string, itemId: string, input: { minutes?: number; bucket?: string }): Promise<LogTimeResult> {
    const row = this.store.getItem(userId, itemId);
    if (!row) throw new Error(`no item ${itemId}; use an id from get_workload`);
    let minutes = input.minutes;
    if (minutes === undefined && input.bucket) {
      minutes = TIME_BUCKETS[input.bucket];
      if (minutes === undefined) throw new Error(`bucket must be one of ${Object.keys(TIME_BUCKETS).join(", ")}`);
    }
    if (minutes === undefined || !Number.isFinite(minutes) || !(minutes > 0)) throw new Error("minutes or a bucket (<1h, 1-2h, 2-4h, 4-8h, 8h+) is required");
    if (minutes > 100 * 60) throw new Error("that is more than 100 hours; log minutes for this one item only");
    const rounded = Math.max(1, Math.round(minutes));
    const nowMs = Date.now();
    const latest = this.store.latestActualFor(userId, itemId);
    const duplicate = !!latest && latest.minutes === rounded && nowMs - Date.parse(latest.createdAt) < DUPLICATE_LOG_MS;
    let estimateWas: number | undefined;
    if (!duplicate) {
      // What the student was shown (calibrated, as if nothing were logged yet).
      const shown = await this.estimates.estimate(userId, row.item, { useLlm: false, ignoreLogged: true });
      estimateWas = shown.p50Hours;
      this.store.addActual(userId, {
        itemId,
        host: row.item.host,
        courseId: row.item.courseId,
        minutes: rounded,
        source: input.minutes !== undefined ? "exact" : "bucket",
        // Calibration compares actuals with the uncalibrated prior.
        estimatedHours: shown.priorP50Hours ?? shown.p50Hours,
      });
    }
    let closed = 0;
    const future: StudyBlock[] = [];
    for (const b of this.store.listBlocks(userId, { itemId })) {
      if (!ACTIVE_BLOCK.includes(b.status)) continue;
      if (Date.parse(b.start) > nowMs) future.push(b);
      else {
        this.store.updateBlock(userId, b.id, { status: "done" });
        closed++;
      }
    }
    const r = await this.removeBlockList(userId, future);
    const warnings = [...r.warnings];
    if (r.failed.length) warnings.push(`${r.failed.length} future block(s) could not be removed from Google Calendar (${r.failed[0]!.reason}); they stay planned. Retry with remove_blocks: ${r.failed.map((f) => f.block.id).join(", ")}`);
    const out: LogTimeResult = { itemId, minutes: rounded, blocksClosed: closed, blocksRemoved: r.removed.length, duplicate, warnings };
    if (estimateWas !== undefined) out.estimateWas = estimateWas;
    return out;
  }

  /** Items to ask about: due in the last three weeks, planned or handed in, no time logged; newest first. */
  private checkInCandidates(userId: string): Array<{ item: WorkItem; plannedMinutes: number }> {
    const nowMs = Date.now();
    const sinceMs = nowMs - CHECK_IN_DAYS * DAY_MS;
    const planned = this.plannedMinutesByItem(userId);
    const out: Array<{ item: WorkItem; plannedMinutes: number }> = [];
    for (const { item } of this.store.listItems(userId)) {
      if (item.kind === "event" || !item.dueAt) continue;
      const due = Date.parse(item.dueAt);
      if (!(due >= sinceMs && due <= nowMs)) continue;
      const p = planned.get(item.id);
      if (!p && !["submitted", "graded", "done"].includes(item.status)) continue;
      if (this.store.latestActualFor(userId, item.id)) continue;
      out.push({ item, plannedMinutes: p?.minutes ?? 0 });
    }
    return out.sort((a, b) => Date.parse(b.item.dueAt!) - Date.parse(a.item.dueAt!)).slice(0, CHECK_IN_MAX);
  }

  private checkInEntry(item: WorkItem, plannedMinutes: number, p50: number): CheckIn {
    const entry: CheckIn = { itemId: item.id, title: item.title, plannedMinutes, estimateP50: p50 };
    if (item.dueAt) entry.dueAt = item.dueAt;
    return entry;
  }

  /** Check-ins with the estimate the student was shown (calibrated). */
  async checkIns(userId: string): Promise<CheckIn[]> {
    const candidates = this.checkInCandidates(userId);
    const ests = await this.readEstimates(userId, candidates.map((c) => c.item));
    return candidates.map((c) => this.checkInEntry(c.item, c.plannedMinutes, ests.get(c.item.id)!.p50Hours));
  }

  /**
   * The same list, synchronously, with the uncalibrated prior. For callers that
   * cannot await; `workload().checkIns` carries the calibrated numbers.
   */
  pendingCheckIns(userId: string): CheckIn[] {
    return this.checkInCandidates(userId).map((c) => this.checkInEntry(c.item, c.plannedMinutes, this.estimates.quickPrior(userId, c.item).estimate.p50Hours));
  }

  // ---- preferences ----------------------------------------------------

  setPreferences(userId: string, patch: Partial<Preferences>): Preferences {
    const current = this.userOrThrow(userId).prefs;
    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw new Error(`unknown time zone ${patch.timezone}; use an IANA name such as America/New_York`);
    // Checked on the merged result, so "min block above max block" is caught whichever one changed.
    const problems = preferenceErrors({ ...current, ...patch });
    if (problems.length) throw new Error(problems.join("; "));
    if (patch.assistantUrl !== undefined) {
      let u: URL | undefined;
      try {
        u = new URL(patch.assistantUrl);
      } catch {
        u = undefined;
      }
      // The extension opens this in a tab: https only, never javascript:, data: or file:.
      if (!u || u.protocol !== "https:" || u.username || u.password) throw new Error("the assistant URL must be an https:// address");
      patch = { ...patch, assistantUrl: u.toString().replace("%7Bq%7D", "{q}") };
    }
    return this.store.updatePrefs(userId, patch);
  }

  // ---- calendar reconciliation ---------------------------------------

  /** Notices blocks the student moved or deleted in Google. One bad event never stops the rest. */
  async reconcileGoogle(userId: string): Promise<{ kept: number; moved: number; deleted: number; errors: number }> {
    const google = this.google ? this.store.getGoogleAccount(userId) : undefined;
    const token = google ? await this.googleAccessToken(userId) : undefined;
    const stats = { kept: 0, moved: 0, deleted: 0, errors: 0 };
    if (!token || !google) return stats;
    const since = new Date(Date.now() - 14 * DAY_MS).toISOString();
    for (const b of this.store.listBlocks(userId, { from: since })) {
      if (!b.calendarEventId || b.status === "deleted" || b.status === "done") continue;
      try {
        const ev = await this.google!.getEvent(token, b.calendarId ?? google.calendarId, b.calendarEventId);
        if (!ev || ev.status === "cancelled") {
          this.store.updateBlock(userId, b.id, { status: "deleted" });
          stats.deleted++;
          continue;
        }
        if (ev.extendedProperties?.private?.[BLOCK_PROPERTY] !== b.id) continue;
        const start = ev.start?.dateTime;
        const end = ev.end?.dateTime;
        if (start && end && (new Date(start).toISOString() !== b.start || new Date(end).toISOString() !== b.end)) {
          const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
          this.store.updateBlock(userId, b.id, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), minutes, status: "moved" });
          stats.moved++;
        } else if (b.status === "planned" && new Date(b.end).getTime() < Date.now()) {
          this.store.updateBlock(userId, b.id, { status: "kept" });
          stats.kept++;
        }
      } catch {
        stats.errors++;
      }
    }
    return stats;
  }
}

function courseOf(item: WorkItem): { code?: string; name?: string } | undefined {
  if (!item.courseCode && !item.courseName) return undefined;
  const c: { code?: string; name?: string } = {};
  if (item.courseCode) c.code = item.courseCode;
  if (item.courseName) c.name = item.courseName;
  return c;
}

function blockDescription(item: WorkItem, tz: string): string {
  const lines = [item.courseName ? `${item.courseCode ?? ""} ${item.courseName}`.trim() : item.courseCode ?? "", item.dueAt ? `Due ${formatLocal(item.dueAt, tz)}` : "", item.url ?? "", "", "Planned by canvas-agent. Move or delete this block freely; the planner notices."];
  return lines.filter((l, i) => l || i === 3).join("\n");
}
