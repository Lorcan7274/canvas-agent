/**
 * The estimate a tool returns: a shared prior (Claude's task card when one is
 * cached, the heuristic otherwise), calibrated by the student's own logged
 * times, replaced outright by their actual once they log one.
 *
 * Reading an estimate never waits on the model unless asked to (`useLlm`).
 * Task cards are built ahead of time by `warmTaskCards`, from a job, with
 * bounded concurrency; until one exists the heuristic stands in. A card that
 * cannot be had (a refusal, an invalid card, an API error) is remembered per
 * item version with a time to try again, so it is not asked for on every read.
 */
import type { Estimate, WorkItem } from "../types.js";
import { Store, itemVersionHash, type ActualSample } from "../store/db.js";
import { heuristicEstimate } from "./heuristic.js";
import { applyCalibration, bucketForMinutes, calibrate, sigmaFromP80, type RatioSample } from "./calibrate.js";
import { TaskCardError, type LlmEstimator, type TaskCard } from "./llm.js";
import { shortHash, truncate } from "../text.js";

export interface EstimateOptions {
  /**
   * Ask the model for an item that has no task card yet and wait for the
   * answer. Off by default: then a cached card is used when there is one and
   * the heuristic otherwise, and nothing waits on the model.
   */
  useLlm?: boolean;
  /** Estimate as if the student had not logged this item yet (what they were shown before logging). */
  ignoreLogged?: boolean;
}

export interface EstimateServiceOptions {
  /** Where failures to get a task card are reported. Defaults to console.warn. Never given secrets. */
  log?: (message: string, meta: Record<string, unknown>) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export interface FullEstimate extends Estimate {
  sigma: number;
  calibrationSamples: number;
  /** The prior's p50 before calibration: what a logged actual is compared with. */
  priorP50Hours?: number;
  pooled?: { medianHours: number; n: number };
}

export interface WarmResult {
  /** Model calls made. */
  asked: number;
  created: number;
  failed: number;
  /** Items that needed no call: events, cards already cached, failures still waiting to retry, or over `max`. */
  skipped: number;
}

const Z80 = 0.8416;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A task card's p50 is held to this range before it is stored. */
export const TASK_CARD_P50_RANGE = { min: 0.1, max: 80 } as const;

interface Failure {
  reason: string;
  retryMs: number;
}

function classifyFailure(e: unknown): Failure {
  if (e instanceof TaskCardError) return { reason: e.reason, retryMs: e.retryable ? 15 * MINUTE : e.reason === "refusal" ? 7 * DAY : DAY };
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    if (status === 408 || status === 409 || status === 429 || status >= 500) return { reason: `http ${status}`, retryMs: 15 * MINUTE };
    if (status === 401 || status === 403) return { reason: `http ${status}`, retryMs: HOUR };
    return { reason: `http ${status}`, retryMs: DAY };
  }
  // Timeouts and connection errors carry no status.
  return { reason: (e as Error | null)?.name ?? "error", retryMs: 15 * MINUTE };
}

interface UserContext {
  items: Map<string, WorkItem>;
  coursePoints: Map<string, number | undefined>;
  latest: Map<string, ActualSample>;
  samples: Array<RatioSample & { itemId: string }>;
}

function median(sorted: number[]): number | undefined {
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
}

function round(h: number): number {
  return Math.round(h * 4) / 4;
}

export class EstimateService {
  private readonly inflight = new Map<string, Promise<Estimate | undefined>>();
  private readonly log: (message: string, meta: Record<string, unknown>) => void;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly llm?: LlmEstimator,
    opts: EstimateServiceOptions = {},
  ) {
    this.log = opts.log ?? ((message, meta) => console.warn(`[estimates] ${message}`, meta));
    this.now = opts.now ?? Date.now;
  }

  private priorKey(item: WorkItem, versionHash: string): string {
    return `${item.host ?? "local"}|${item.id}|${versionHash}`;
  }

  // ---- per-user context, read once per call ----------------------------

  private context(userId: string): UserContext {
    const items = new Map(this.store.listItems(userId).map((r) => [r.item.id, r.item]));
    const byCourse = new Map<string, number[]>();
    for (const i of items.values()) {
      if (!i.courseId || typeof i.pointsPossible !== "number" || !(i.pointsPossible > 0)) continue;
      const list = byCourse.get(i.courseId) ?? [];
      list.push(i.pointsPossible);
      byCourse.set(i.courseId, list);
    }
    const coursePoints = new Map<string, number | undefined>();
    for (const [c, pts] of byCourse) coursePoints.set(c, pts.length < 3 ? undefined : median(pts.sort((a, b) => a - b)));
    const latest = new Map<string, ActualSample>();
    for (const a of this.store.listActuals(userId)) latest.set(a.itemId, a); // ordered by time: the last one wins
    const samples: UserContext["samples"] = [];
    for (const a of latest.values()) {
      if (!a.estimatedHours || !(a.estimatedHours > 0)) continue;
      const s: RatioSample & { itemId: string } = { itemId: a.itemId, estimatedHours: a.estimatedHours, actualHours: a.minutes / 60 };
      const course = a.courseId ?? items.get(a.itemId)?.courseId;
      if (course) s.courseId = course;
      const bucket = a.source === "bucket" ? bucketForMinutes(a.minutes) : undefined;
      if (bucket) s.bucket = { loHours: bucket.loHours, hiHours: bucket.hiHours };
      samples.push(s);
    }
    return { items, coursePoints, latest, samples };
  }

  private coursePointsMedian(userId: string, courseId: string | undefined): number | undefined {
    if (!courseId) return undefined;
    const pts = this.store
      .listItems(userId)
      .map((r) => r.item)
      .filter((i) => i.courseId === courseId && typeof i.pointsPossible === "number" && i.pointsPossible > 0)
      .map((i) => i.pointsPossible as number)
      .sort((a, b) => a - b);
    if (pts.length < 3) return undefined;
    return median(pts);
  }

  // ---- priors -----------------------------------------------------------

  /** A cached task card for exactly this item version, with its spread. */
  private cachedCard(item: WorkItem, versionHash: string): { estimate: Estimate; sigma: number } | undefined {
    const cached = this.store.getPrior(this.priorKey(item, versionHash));
    if (!cached || cached.basis !== "llm") return undefined;
    const sigma = typeof cached.sigma === "number" && cached.sigma > 0 ? cached.sigma : sigmaFromP80(cached.p50Hours, cached.p80Hours);
    return { estimate: { ...cached, sigma }, sigma };
  }

  private heuristicPrior(item: WorkItem, versionHash: string, coursePointsMedian: number | undefined): { estimate: Estimate; sigma: number } {
    // Never stored: it is cheap, reads this student's course median, and must follow rule changes at once.
    const h = heuristicEstimate(item, { coursePointsMedian });
    const est: Estimate = {
      itemId: item.id,
      p50Hours: h.p50Hours,
      p80Hours: h.p80Hours,
      basis: "heuristic",
      confidence: h.confidence,
      reasoning: h.reasoning,
      steps: h.steps,
      versionHash,
      createdAt: new Date(this.now()).toISOString(),
      sigma: h.sigma,
    };
    return { estimate: est, sigma: h.sigma };
  }

  /**
   * The prior without calling the model: the shared task card when one is
   * cached for exactly this item version, else this student's own heuristic.
   * Heuristic priors are never shared or stored: they read the student's course median.
   */
  quickPrior(userId: string, item: WorkItem): { estimate: Estimate; sigma: number } {
    const versionHash = itemVersionHash(item, shortHash);
    return this.cachedCard(item, versionHash) ?? this.heuristicPrior(item, versionHash, this.coursePointsMedian(userId, item.courseId));
  }

  private async priorWith(ctx: UserContext, item: WorkItem, opts: EstimateOptions): Promise<{ estimate: Estimate; sigma: number }> {
    const versionHash = itemVersionHash(item, shortHash);
    const cached = this.cachedCard(item, versionHash);
    if (cached) return cached;
    if (opts.useLlm && this.llm && item.kind !== "event") {
      const card = await this.fetchCard(item, versionHash);
      if (card) return { estimate: card, sigma: card.sigma! };
    }
    return this.heuristicPrior(item, versionHash, item.courseId ? ctx.coursePoints.get(item.courseId) : undefined);
  }

  async prior(userId: string, item: WorkItem, opts: EstimateOptions = {}): Promise<{ estimate: Estimate; sigma: number }> {
    if (!opts.useLlm) return this.quickPrior(userId, item);
    return this.priorWith(this.context(userId), item, opts);
  }

  // ---- task cards -------------------------------------------------------

  /** True when the model has not been asked about this item version, or a failure's retry time has passed. */
  needsTaskCard(item: WorkItem): boolean {
    if (!this.llm || item.kind === "event") return false;
    const cached = this.store.getPrior(this.priorKey(item, itemVersionHash(item, shortHash)));
    if (!cached) return true;
    if (cached.basis === "llm") return false;
    return cached.basis === "llm_failed" && !(cached.retryAfter && Date.parse(cached.retryAfter) > this.now());
  }

  /**
   * Builds task cards for the items that need one, `concurrency` model calls
   * at a time (default 3) and at most `max` calls (default 25). Meant for a
   * background job after a sync, never a request path. Resolves when done;
   * never rejects for a model failure.
   */
  async warmTaskCards(items: WorkItem[], opts: { concurrency?: number; max?: number } = {}): Promise<WarmResult> {
    const result: WarmResult = { asked: 0, created: 0, failed: 0, skipped: 0 };
    const seen = new Set<string>();
    const todo: Array<{ item: WorkItem; versionHash: string }> = [];
    const max = Math.max(0, opts.max ?? 25);
    for (const item of items) {
      const versionHash = itemVersionHash(item, shortHash);
      const key = this.priorKey(item, versionHash);
      if (seen.has(key) || !this.needsTaskCard(item) || todo.length >= max) {
        result.skipped++;
        continue;
      }
      seen.add(key);
      todo.push({ item, versionHash });
    }
    const workers = Math.min(todo.length, Math.max(1, Math.min(8, opts.concurrency ?? 3)));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let next = todo.shift(); next; next = todo.shift()) {
          result.asked++;
          const card = await this.fetchCard(next.item, next.versionHash);
          if (card) result.created++;
          else result.failed++;
        }
      }),
    );
    return result;
  }

  /** One model call per item version at a time; failures are logged and remembered with a retry time. */
  private fetchCard(item: WorkItem, versionHash: string): Promise<Estimate | undefined> {
    const key = this.priorKey(item, versionHash);
    const stored = this.store.getPrior(key);
    if (stored?.basis === "llm") return Promise.resolve(stored);
    if (stored?.basis === "llm_failed" && stored.retryAfter && Date.parse(stored.retryAfter) > this.now()) return Promise.resolve(undefined);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.askModel(item, versionHash, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async askModel(item: WorkItem, versionHash: string, key: string): Promise<Estimate | undefined> {
    let failure: Failure;
    let detail: string;
    try {
      const card = await this.llm!.taskCard(item);
      const est = card ? this.cardToEstimate(item, versionHash, card) : undefined;
      if (est) {
        this.store.putPrior(key, est);
        return est;
      }
      failure = { reason: "invalid", retryMs: DAY };
      detail = card ? `implausible hours p50 ${card.p50_hours} p80 ${card.p80_hours}` : "no task card";
    } catch (e) {
      failure = classifyFailure(e);
      detail = truncate(e instanceof Error ? e.message : String(e), 300);
    }
    const now = this.now();
    this.log("no task card", { itemId: item.id, reason: failure.reason, detail, retryInMinutes: Math.round(failure.retryMs / MINUTE) });
    this.store.putPrior(key, {
      itemId: item.id,
      p50Hours: 0,
      p80Hours: 0,
      basis: "llm_failed",
      confidence: "low",
      reasoning: failure.reason,
      versionHash,
      createdAt: new Date(now).toISOString(),
      retryAfter: new Date(now + failure.retryMs).toISOString(),
    });
    return undefined;
  }

  /** A task card as a shared prior: p50 held to [0.1, 80] h, the spread taken from its p80, p80 rebuilt from that spread. */
  private cardToEstimate(item: WorkItem, versionHash: string, card: TaskCard): Estimate | undefined {
    if (!Number.isFinite(card.p50_hours) || !(card.p50_hours > 0)) return undefined;
    const p50 = Math.min(TASK_CARD_P50_RANGE.max, Math.max(TASK_CARD_P50_RANGE.min, card.p50_hours));
    const sigma = sigmaFromP80(card.p50_hours, Math.max(card.p80_hours, card.p50_hours));
    const p50Hours = Math.max(0.25, round(p50));
    // Model output is shown to every student with this assignment: keep it short and treat it as data.
    const capped = p50 !== card.p50_hours ? ` (the card said ${card.p50_hours}h; held to ${p50}h)` : "";
    return {
      itemId: item.id,
      p50Hours,
      p80Hours: Math.max(p50Hours, round(p50 * Math.exp(Z80 * sigma))),
      basis: "llm",
      confidence: card.confidence,
      reasoning: truncate(card.reasoning, 1000) + capped,
      steps: card.steps.slice(0, 10).map((s) => truncate(s, 200)),
      versionHash,
      createdAt: new Date(this.now()).toISOString(),
      sigma,
    };
  }

  // ---- estimates --------------------------------------------------------

  async estimate(userId: string, item: WorkItem, opts: EstimateOptions = {}): Promise<FullEstimate> {
    return this.estimateWith(this.context(userId), item, opts);
  }

  /** Estimates for many items of one student, reading their items and actuals once. Keyed by item id. */
  async estimateMany(userId: string, items: WorkItem[], opts: EstimateOptions = {}): Promise<Map<string, FullEstimate>> {
    const ctx = this.context(userId);
    const out = new Map<string, FullEstimate>();
    for (const item of items) out.set(item.id, await this.estimateWith(ctx, item, opts));
    return out;
  }

  private async estimateWith(ctx: UserContext, item: WorkItem, opts: EstimateOptions): Promise<FullEstimate> {
    const logged = opts.ignoreLogged ? undefined : ctx.latest.get(item.id);
    const { estimate: prior, sigma } = await this.priorWith(ctx, item, opts);
    const samples = ctx.samples.filter((s) => s.itemId !== item.id);
    const cal = calibrate(samples, item.courseId, sigma);
    const out: FullEstimate = { ...prior, sigma: cal.sigma, calibrationSamples: cal.samples, priorP50Hours: prior.p50Hours };
    if (cal.samples > 0) {
      const c = applyCalibration(prior.p50Hours, cal);
      out.p50Hours = c.p50Hours;
      out.p80Hours = c.p80Hours;
      out.basis = "calibrated";
      out.reasoning = `${prior.reasoning ?? ""}; your past ${cal.courseSamples || cal.samples} logged item(s) ${cal.factor >= 1 ? "take" : "take only"} ×${cal.factor.toFixed(2)} of the first guess`.replace(/^; /, "");
    }
    if (logged) {
      const bucket = logged.source === "bucket" ? bucketForMinutes(logged.minutes) : undefined;
      // A bucket answer reads as the estimate moved into the bucket.
      const hours = bucket ? Math.max(0.25, round(Math.min(Math.max(out.p50Hours, bucket.loHours), bucket.hiHours))) : round(logged.minutes / 60);
      out.p50Hours = hours;
      out.p80Hours = hours;
      out.basis = "logged";
      out.confidence = "high";
      out.reasoning = bucket ? `you logged ${bucket.label}` : `you logged ${logged.minutes} minutes`;
    }
    if (item.host) {
      const pooled = this.store.pooledActual(item.host, item.id);
      if (pooled) out.pooled = { medianHours: round(pooled.medianMinutes / 60), n: pooled.n };
    }
    return out;
  }
}
