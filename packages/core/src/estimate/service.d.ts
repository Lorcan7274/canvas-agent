/**
 * The estimate a tool returns: a shared prior (Claude's task card when
 * available, the heuristic otherwise), calibrated by the student's own logged
 * times, replaced outright by their actual once they log one.
 */
import type { Estimate, WorkItem } from "../types.js";
import { Store } from "../store/db.js";
import type { LlmEstimator } from "./llm.js";
export interface EstimateOptions {
    /** Ask the model for items it has not seen. Costs a call per new assignment. */
    useLlm?: boolean;
}
export interface FullEstimate extends Estimate {
    sigma: number;
    calibrationSamples: number;
    pooled?: {
        medianHours: number;
        n: number;
    };
}
export declare class EstimateService {
    private readonly store;
    private readonly llm?;
    constructor(store: Store, llm?: LlmEstimator | undefined);
    private priorKey;
    private coursePointsMedian;
    prior(userId: string, item: WorkItem, opts?: EstimateOptions): Promise<{
        estimate: Estimate;
        sigma: number;
    }>;
    estimate(userId: string, item: WorkItem, opts?: EstimateOptions): Promise<FullEstimate>;
    private samples;
}
