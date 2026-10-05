/**
 * Everything the tools, the settings page and the jobs do, in one place, so
 * an MCP call and a button on the settings page cannot drift apart.
 */
import {
  CanvasClient,
  EstimateService,
  Sealer,
  Store,
  TIME_BUCKETS,
  formatLocal,
  hashToken,
  isValidTimeZone,
  normaliseBaseUrl,
  planBlocks,
  randomToken,
  syncFeed,
  syncWithClient,
  writeIcs,
  type CanvasAccount,
  type FullEstimate,
  type Interval,
  type Preferences,
  type ProposedBlock,
  type StudyBlock,
  type SyncReport,
  type WorkItem,
} from "@canvas-agent/core";
import type { Config } from "./config.js";
import { BLOCK_PROPERTY, GoogleCalendar } from "./google/calendar.js";

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
  horizon: { start: string; end: string };
  blocks: Array<ProposedBlock & { startLocal: string; endLocal: string }>;
  unscheduled: Array<{ itemId: string; title: string; hoursShort: number; reason: string }>;
  dayLoad: Record<string, number>;
  freeHours: number;
  busySource: "google+provided" | "google" | "provided" | "none";
  notes: string[];
}

export interface CommitInput {
  blocks: Array<{ itemId: string; start: string; end: string }>;
  /** Replace this user's still-planned blocks for the same items first. */
  replace?: boolean;
  /** Write to Google Calendar when connected. Default true. */
  calendar?: boolean;
}

export interface CommitResult {
  created: Array<StudyBlock & { title: string; startLocal: string; calendarWritten: boolean }>;
  replaced: number;
  calendar: "google" | "ics" | "none";
  icsFeedUrl?: string;
  errors: string[];
}

const DUE_SOON_HOURS = 72;

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

  feedToken(userId: string): string {
    // Deterministic per user so the subscription URL survives restarts; sealed secret, not a hash of the id.
    return hashToken(`plan-feed:${userId}:${this.config.secretKey}`).slice(0, 32);
  }

  userForFeedToken(token: string): string | undefined {
    for (const u of this.store.listUsers()) if (this.feedToken(u.id) === token) return u.id;
    return undefined;
  }

  planFeedUrl(userId: string): string {
    return `${this.config.baseUrl}/feeds/plan/${this.feedToken(userId)}.ics`;
  }

  // ---- canvas accounts ------------------------------------------------

  addTokenAccount(userId: string, baseUrl: string, token: string): CanvasAccount {
    const url = normaliseBaseUrl(baseUrl);
    this.assertCanvasHost(url);
    return this.store.upsertCanvasAccount({ userId, baseUrl: url, kind: "token", secretSealed: this.sealer.seal(token) });
  }

  addFeedAccount(userId: string, feedUrl: string): CanvasAccount {
    const u = new URL(feedUrl.trim());
    if (u.protocol !== "https:" && !u.hostname.match(/^(localhost|127\.0\.0\.1)$/)) throw new Error("feed URL must be https");
    if (!/\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics$/.test(u.pathname)) throw new Error("that is not a Canvas calendar feed URL");
    const base = `${u.protocol}//${u.host}`;
    this.assertCanvasHost(base);
    return this.store.upsertCanvasAccount({ userId, baseUrl: base, kind: "feed", secretSealed: this.sealer.seal(u.toString()) });
  }

  addSessionAccount(userId: string, baseUrl: string): CanvasAccount {
    const url = normaliseBaseUrl(baseUrl);
    this.assertCanvasHost(url);
    return this.store.upsertCanvasAccount({ userId, baseUrl: url, kind: "session" });
  }

  private assertCanvasHost(baseUrl: string): void {
    const allow = this.config.canvasHostAllowlist;
    if (!allow.length) return;
    const host = new URL(baseUrl).host;
    if (!allow.some((h) => host === h || host.endsWith("." + h))) throw new Error(`Canvas host ${host} is not allowed on this server`);
  }

  async syncAccount(account: CanvasAccount): Promise<SyncReport> {
    try {
      let report: SyncReport;
      if (account.kind === "token") {
        const token = this.sealer.open(account.secretSealed ?? "");
        report = await syncWithClient(this.store, account.userId, new CanvasClient({ baseUrl: account.baseUrl, token }));
      } else if (account.kind === "feed") {
        report = await syncFeed(this.store, account.userId, this.sealer.open(account.secretSealed ?? ""));
      } else {
        return { courses: 0, items: 0, detailsFetched: 0, errors: [] }; // the extension pushes
      }
      this.store.markSync(account.id, report.errors.length ? report.errors.join("; ").slice(0, 500) : null);
      return report;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      this.store.markSync(account.id, msg);
      return { courses: 0, items: 0, detailsFetched: 0, errors: [msg] };
    }
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

  openItems(userId: string, from: string, to: string, includeDone = false): WorkItem[] {
    return this.store
      .listItems(userId, { from, to, includeUndated: false })
      .map((r) => r.item)
      .filter((i) => i.kind !== "event" || i.dueAt! >= from)
      .filter((i) => includeDone || !["done", "dismissed", "graded", "submitted", "excused"].includes(i.status));
  }

  async workload(userId: string, opts: { from?: string; to?: string; includeDone?: boolean; refresh?: boolean } = {}): Promise<{ from: string; to: string; items: WorkloadItem[]; syncedAt?: string; warnings: string[] }> {
    const user = this.userOrThrow(userId);
    const now = new Date();
    const from = opts.from ?? new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const to = opts.to ?? new Date(now.getTime() + 14 * 86_400_000).toISOString();
    const warnings: string[] = [];
    if (opts.refresh) for (const r of await this.syncUser(userId)) warnings.push(...r.errors);
    const planned = this.plannedMinutesByItem(userId);
    const items: WorkloadItem[] = [];
    for (const item of this.openItems(userId, from, to, opts.includeDone ?? false)) {
      const est = await this.estimates.estimate(userId, item, { useLlm: this.config.useLlm });
      const p = planned.get(item.id);
      const w: WorkloadItem = {
        id: item.id,
        title: item.title,
        kind: item.kind,
        status: item.status,
        estimate: { p50Hours: est.p50Hours, p80Hours: est.p80Hours, basis: est.basis, confidence: est.confidence },
        plannedMinutes: p?.minutes ?? 0,
        plannedBlocks: p?.blocks ?? 0,
      };
      if (est.pooled) w.estimate.pooledMedianHours = est.pooled.medianHours;
      if (item.courseCode || item.courseName) {
        w.course = {};
        if (item.courseCode) w.course.code = item.courseCode;
        if (item.courseName) w.course.name = item.courseName;
      }
      if (item.dueAt) {
        w.dueAt = item.dueAt;
        w.dueLocal = formatLocal(item.dueAt, user.prefs.timezone);
      }
      if (item.pointsPossible !== undefined) w.pointsPossible = item.pointsPossible;
      if (item.url) w.url = item.url;
      if (item.late) w.late = true;
      const logged = this.store.latestActualFor(userId, item.id);
      if (logged) w.loggedMinutes = logged.minutes;
      items.push(w);
    }
    const accounts = this.store.listCanvasAccounts(userId);
    const syncedAt = accounts.map((a) => a.lastSyncAt).filter((x): x is string => !!x).sort().pop();
    for (const a of accounts) if (a.lastError) warnings.push(`${a.kind} ${new URL(a.baseUrl).host}: ${a.lastError}`);
    if (!accounts.length) warnings.push("No Canvas connected yet. Open the settings page to add a token, a calendar feed, or pair the browser extension.");
    const out: { from: string; to: string; items: WorkloadItem[]; syncedAt?: string; warnings: string[] } = { from, to, items, warnings };
    if (syncedAt) out.syncedAt = syncedAt;
    return out;
  }

  async assignment(userId: string, itemId: string) {
    const user = this.userOrThrow(userId);
    const row = this.store.getItem(userId, itemId);
    if (!row) throw new Error(`no item ${itemId}`);
    const item = row.item;
    const est = await this.estimates.estimate(userId, item, { useLlm: this.config.useLlm });
    const blocks = this.store.listBlocks(userId, { itemId }).map((b) => ({ ...b, startLocal: formatLocal(b.start, user.prefs.timezone) }));
    const history = this.store
      .listActuals(userId)
      .filter((a) => a.itemId !== itemId)
      .map((a) => ({ a, item: this.store.getItem(userId, a.itemId)?.item }))
      .filter((x) => x.item && x.item.courseId === item.courseId)
      .slice(-5)
      .map((x) => ({ title: x.item!.title, minutes: x.a.minutes, estimatedHours: x.a.estimatedHours }));
    return { item, estimate: est, blocks, sameCourseHistory: history, dueLocal: item.dueAt ? formatLocal(item.dueAt, user.prefs.timezone) : undefined };
  }

  // ---- planning -------------------------------------------------------

  private async googleBusy(userId: string, from: string, to: string): Promise<Interval[] | undefined> {
    if (!this.google) return undefined;
    const token = await this.googleAccessToken(userId);
    if (!token) return undefined;
    const acct = this.store.getGoogleAccount(userId)!;
    return this.google.freeBusy(token, [acct.calendarId], from, to);
  }

  async googleAccessToken(userId: string): Promise<string | undefined> {
    if (!this.google) return undefined;
    const acct = this.store.getGoogleAccount(userId);
    if (!acct) return undefined;
    if (acct.accessTokenSealed && acct.accessExpiresAt && new Date(acct.accessExpiresAt).getTime() - Date.now() > 60_000) {
      return this.sealer.open(acct.accessTokenSealed);
    }
    const refreshed = await this.google.refresh(this.sealer.open(acct.refreshTokenSealed));
    this.store.putGoogleAccount({
      ...acct,
      accessTokenSealed: this.sealer.seal(refreshed.access_token),
      accessExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    });
    return refreshed.access_token;
  }

  async propose(userId: string, opts: ProposeOptions = {}): Promise<ProposeResult> {
    const user = this.userOrThrow(userId);
    const now = new Date();
    const start = opts.from ?? now.toISOString();
    const end = opts.to ?? new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const notes: string[] = [];
    let busy: Interval[] = [...(opts.busy ?? [])];
    let busySource: ProposeResult["busySource"] = opts.busy?.length ? "provided" : "none";
    if (opts.useGoogleBusy !== false) {
      try {
        const g = await this.googleBusy(userId, start, end);
        if (g) {
          busy = busy.concat(g);
          busySource = opts.busy?.length ? "google+provided" : "google";
        }
      } catch (e) {
        notes.push(`could not read Google Calendar busy time: ${(e as Error).message}`);
      }
    }
    if (busySource === "none") notes.push("No calendar busy time was available; blocks assume the work windows in your preferences are free. Pass busy intervals from your calendar for a better plan.");

    const planned = this.plannedMinutesByItem(userId);
    const lookahead = new Date(new Date(end).getTime() + 14 * 86_400_000).toISOString();
    const candidates = this.openItems(userId, start, lookahead).filter((i) => i.kind !== "event" && (!opts.itemIds || opts.itemIds.includes(i.id)));
    const items = [];
    for (const item of candidates) {
      const est = await this.estimates.estimate(userId, item, { useLlm: this.config.useLlm });
      const dueMs = item.dueAt ? new Date(item.dueAt).getTime() : undefined;
      const dueSoon = dueMs !== undefined && dueMs - now.getTime() < DUE_SOON_HOURS * 3_600_000;
      const target = opts.conservative || dueSoon ? est.p80Hours : est.p50Hours;
      const already = (planned.get(item.id)?.minutes ?? 0) / 60;
      const logged = this.store.latestActualFor(userId, item.id);
      if (logged) continue;
      // Items due after the horizon only get time now when they are big.
      if (dueMs !== undefined && dueMs > new Date(end).getTime() && target - already < 4) continue;
      const hoursNeeded = Math.max(0, target - already);
      if (hoursNeeded < 0.25) continue;
      const planItem: { itemId: string; title: string; hoursNeeded: number; dueAt?: string; unlockAt?: string; priority?: number } = {
        itemId: item.id,
        title: item.courseCode ? `${item.title} (${item.courseCode})` : item.title,
        hoursNeeded,
      };
      if (item.dueAt) planItem.dueAt = item.dueAt;
      if (item.unlockAt) planItem.unlockAt = item.unlockAt;
      if (item.pointsPossible !== undefined) planItem.priority = item.pointsPossible;
      items.push(planItem);
    }
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
    return {
      horizon: { start, end },
      blocks: result.blocks.map((b) => ({ ...b, startLocal: formatLocal(b.start, user.prefs.timezone), endLocal: formatLocal(b.end, user.prefs.timezone) })),
      unscheduled: result.unscheduled,
      dayLoad: result.dayLoad,
      freeHours: result.freeHours,
      busySource,
      notes,
    };
  }

  async commit(userId: string, input: CommitInput): Promise<CommitResult> {
    const user = this.userOrThrow(userId);
    const errors: string[] = [];
    let replaced = 0;
    const google = this.google ? this.store.getGoogleAccount(userId) : undefined;
    const token = input.calendar !== false && google ? await this.googleAccessToken(userId).catch((e) => (errors.push(`Google token: ${(e as Error).message}`), undefined)) : undefined;
    if (input.replace) {
      for (const itemId of new Set(input.blocks.map((b) => b.itemId))) {
        for (const victim of this.store.deleteBlocksForItem(userId, itemId, ["planned"])) {
          replaced++;
          if (victim.calendarEventId && token && google) {
            await this.google!.deleteEvent(token, victim.calendarId ?? google.calendarId, victim.calendarEventId).catch((e) => errors.push(`delete event: ${(e as Error).message}`));
          }
        }
      }
    }
    const created: CommitResult["created"] = [];
    for (const b of input.blocks) {
      const item = this.store.getItem(userId, b.itemId)?.item;
      if (!item) {
        errors.push(`unknown item ${b.itemId}`);
        continue;
      }
      const startMs = new Date(b.start).getTime();
      const endMs = new Date(b.end).getTime();
      if (!(endMs > startMs)) {
        errors.push(`bad interval for ${b.itemId}`);
        continue;
      }
      const minutes = Math.round((endMs - startMs) / 60_000);
      let block = this.store.addBlock(userId, { itemId: b.itemId, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), minutes });
      let written = false;
      if (token && google) {
        try {
          const ev = await this.google!.insertEvent(token, google.calendarId, {
            summary: `Study: ${item.title}${item.courseCode ? ` (${item.courseCode})` : ""}`,
            description: blockDescription(item, user.prefs.timezone),
            start: block.start,
            end: block.end,
            blockId: block.id,
            ...(item.url ? { url: item.url } : {}),
          });
          this.store.updateBlock(userId, block.id, { calendarEventId: ev.id, calendarId: google.calendarId });
          block = this.store.getBlock(userId, block.id)!;
          written = true;
        } catch (e) {
          errors.push(`Google event for ${item.title}: ${(e as Error).message}`);
        }
      }
      created.push({ ...block, title: item.title, startLocal: formatLocal(block.start, user.prefs.timezone), calendarWritten: written });
    }
    const out: CommitResult = { created, replaced, calendar: token && google ? "google" : "ics", errors };
    out.icsFeedUrl = this.planFeedUrl(userId);
    return out;
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

  async logTime(userId: string, itemId: string, input: { minutes?: number; bucket?: string }): Promise<{ minutes: number; estimateWas?: number; blocksClosed: number }> {
    const row = this.store.getItem(userId, itemId);
    if (!row) throw new Error(`no item ${itemId}`);
    let minutes = input.minutes;
    if (minutes === undefined && input.bucket) minutes = TIME_BUCKETS[input.bucket];
    if (minutes === undefined || !(minutes > 0)) throw new Error("minutes or a bucket (<1h, 1-2h, 2-4h, 4-8h, 8h+) is required");
    const { estimate: prior } = await this.estimates.prior(userId, row.item, { useLlm: false });
    this.store.addActual(userId, {
      itemId,
      host: row.item.host,
      courseId: row.item.courseId,
      minutes: Math.round(minutes),
      source: input.minutes !== undefined ? "exact" : "bucket",
      estimatedHours: prior.p50Hours,
    });
    let closed = 0;
    for (const b of this.store.listBlocks(userId, { itemId })) {
      if (b.status === "planned" || b.status === "kept" || b.status === "moved") {
        this.store.updateBlock(userId, b.id, { status: "done" });
        closed++;
      }
    }
    return { minutes: Math.round(minutes), estimateWas: prior.p50Hours, blocksClosed: closed };
  }

  /** What the student has not told us about: items past due with planned blocks and no actual. */
  pendingCheckIns(userId: string): Array<{ itemId: string; title: string; dueAt?: string; plannedMinutes: number; estimateP50: number }> {
    const nowIso = new Date().toISOString();
    const planned = this.plannedMinutesByItem(userId);
    const out: Array<{ itemId: string; title: string; dueAt?: string; plannedMinutes: number; estimateP50: number }> = [];
    for (const r of this.store.listItems(userId, { to: nowIso, includeUndated: false })) {
      const item = r.item;
      if (item.kind === "event") continue;
      if (this.store.latestActualFor(userId, item.id)) continue;
      const p = planned.get(item.id);
      const touched = p || ["submitted", "graded", "done"].includes(item.status);
      if (!touched) continue;
      const prior = this.store.getPrior(`${item.host ?? "local"}|${item.id}|${r.versionHash}`);
      const entry: { itemId: string; title: string; dueAt?: string; plannedMinutes: number; estimateP50: number } = {
        itemId: item.id,
        title: item.title,
        plannedMinutes: p?.minutes ?? 0,
        estimateP50: prior?.p50Hours ?? 0,
      };
      if (item.dueAt) entry.dueAt = item.dueAt;
      out.push(entry);
    }
    return out.slice(-10);
  }

  // ---- preferences ----------------------------------------------------

  setPreferences(userId: string, patch: Partial<Preferences>): Preferences {
    if (patch.timezone && !isValidTimeZone(patch.timezone)) throw new Error(`unknown time zone ${patch.timezone}`);
    return this.store.updatePrefs(userId, patch);
  }

  // ---- calendar reconciliation ---------------------------------------

  async reconcileGoogle(userId: string): Promise<{ kept: number; moved: number; deleted: number }> {
    const google = this.google ? this.store.getGoogleAccount(userId) : undefined;
    const token = google ? await this.googleAccessToken(userId) : undefined;
    const stats = { kept: 0, moved: 0, deleted: 0 };
    if (!token || !google) return stats;
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    for (const b of this.store.listBlocks(userId, { from: since })) {
      if (!b.calendarEventId || b.status === "deleted" || b.status === "done") continue;
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
    }
    return stats;
  }
}

function blockDescription(item: WorkItem, tz: string): string {
  const lines = [item.courseName ? `${item.courseCode ?? ""} ${item.courseName}`.trim() : item.courseCode ?? "", item.dueAt ? `Due ${formatLocal(item.dueAt, tz)}` : "", item.url ?? "", "", "Planned by canvas-agent. Move or delete this block freely; the planner notices."];
  return lines.filter((l, i) => l || i === 3).join("\n");
}
