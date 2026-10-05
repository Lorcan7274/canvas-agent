/**
 * The estimate a tool returns: a shared prior (Claude's task card when
 * available, the heuristic otherwise), calibrated by the student's own logged
 * times, replaced outright by their actual once they log one.
 */
import type { Estimate, WorkItem } from "../types.js";
import { Store } from "../store/db.js";
import { heuristicEstimate } from "./heuristic.js";
import { applyCalibration, calibrate, type RatioSample } from "./calibrate.js";
import type { LlmEstimator } from "./llm.js";
import { itemVersionHash } from "../store/db.js";
import { shortHash, truncate } from "../text.js";

export interface EstimateOptions {
  /** Ask the model for items it has not seen. Costs a call per new assignment. */
  useLlm?: boolean;
}

export interface FullEstimate extends Estimate {
  sigma: number;
  calibrationSamples: number;
  pooled?: { medianHours: number; n: number };
}

export class EstimateService {
  constructor(
    private readonly store: Store,
    private readonly llm?: LlmEstimator,
  ) {}

  private priorKey(item: WorkItem, versionHash: string): string {
    return `${item.host ?? "local"}|${item.id}|${versionHash}`;
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
    return pts[Math.floor(pts.length / 2)];
  }

  /**
   * The prior without calling the model: the shared task card when one is
   * cached for exactly this item version, else this student's own heuristic.
   * Heuristic priors are never shared: they read the student's course median.
   */
  quickPrior(userId: string, item: WorkItem): { estimate: Estimate; sigma: number } {
    const versionHash = itemVersionHash(item, shortHash);
    const cached = this.store.getPrior(this.priorKey(item, versionHash));
    if (cached && cached.basis === "llm") return { estimate: cached, sigma: sigmaFor(cached.confidence) };
    const h = heuristicEstimate(item, { coursePointsMedian: this.coursePointsMedian(userId, item.courseId) });
    const est: Estimate = {
      itemId: item.id,
      p50Hours: h.p50Hours,
      p80Hours: h.p80Hours,
      basis: "heuristic",
      confidence: h.confidence,
      reasoning: h.reasoning,
      steps: h.steps,
      versionHash,
      createdAt: new Date().toISOString(),
    };
    return { estimate: est, sigma: h.sigma };
  }

  async prior(userId: string, item: WorkItem, opts: EstimateOptions = {}): Promise<{ estimate: Estimate; sigma: number }> {
    const quick = this.quickPrior(userId, item);
    if (quick.estimate.basis === "llm" || !opts.useLlm || !this.llm || item.kind === "event") return quick;
    const versionHash = quick.estimate.versionHash;
    try {
      const card = await this.llm.taskCard(item);
      if (card) {
        // Model output is shown to every student with this assignment: keep it short and treat it as data.
        const est: Estimate = {
          itemId: item.id,
          p50Hours: round(card.p50_hours),
          p80Hours: round(Math.max(card.p80_hours, card.p50_hours)),
          basis: "llm",
          confidence: card.confidence,
          reasoning: truncate(card.reasoning, 1000),
          steps: card.steps.slice(0, 10).map((s) => truncate(s, 200)),
          versionHash,
          createdAt: new Date().toISOString(),
        };
        this.store.putPrior(this.priorKey(item, versionHash), est);
        return { estimate: est, sigma: sigmaFor(card.confidence) };
      }
    } catch {
      // fall through to the heuristic; the model is optional
    }
    return quick;
  }

  async estimate(userId: string, item: WorkItem, opts: EstimateOptions = {}): Promise<FullEstimate> {
    const logged = this.store.latestActualFor(userId, item.id);
    const { estimate: prior, sigma } = await this.prior(userId, item, opts);
    const samples = this.samples(userId);
    const cal = calibrate(samples, item.courseId, sigma);
    const out: FullEstimate = { ...prior, sigma: cal.sigma, calibrationSamples: cal.samples };
    if (logged) {
      const hours = round(logged.minutes / 60);
      out.p50Hours = hours;
      out.p80Hours = hours;
      out.basis = "logged";
      out.confidence = "high";
      out.reasoning = `you logged ${logged.minutes} minutes`;
    } else if (cal.samples > 0) {
      const c = applyCalibration(prior.p50Hours, cal);
      out.p50Hours = c.p50Hours;
      out.p80Hours = c.p80Hours;
      out.basis = "calibrated";
      out.reasoning = `${prior.reasoning ?? ""}; your past ${cal.courseSamples || cal.samples} logged item(s) ${cal.factor >= 1 ? "take" : "take only"} ×${cal.factor.toFixed(2)} of the first guess`.replace(/^; /, "");
    }
    if (item.host) {
      const pooled = this.store.pooledActual(item.host, item.id);
      if (pooled) out.pooled = { medianHours: round(pooled.medianMinutes / 60), n: pooled.n };
    }
    return out;
  }

  private samples(userId: string): RatioSample[] {
    const items = new Map(this.store.listItems(userId).map((r) => [r.item.id, r.item]));
    return this.store
      .listActuals(userId)
      .filter((a) => a.estimatedHours && a.estimatedHours > 0)
      .map((a) => {
        const s: RatioSample = { estimatedHours: a.estimatedHours as number, actualHours: a.minutes / 60 };
        const course = a.courseId ?? items.get(a.itemId)?.courseId;
        if (course) s.courseId = course;
        return s;
      });
  }
}

function sigmaFor(confidence: Estimate["confidence"]): number {
  return confidence === "high" ? 0.4 : confidence === "medium" ? 0.55 : 0.75;
}

function round(h: number): number {
  return Math.round(h * 4) / 4;
}
