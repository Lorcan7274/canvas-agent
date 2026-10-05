/**
 * The cold-start estimate: how long a piece of work takes, from what Canvas
 * tells us about it. Hours, log-normal, p50 and p80. Deliberately legible so a
 * wrong estimate can be traced to a rule.
 */
import type { WorkItem } from "../types.js";
export interface HeuristicResult {
    p50Hours: number;
    p80Hours: number;
    /** Log-space spread used for p80; calibration narrows it. */
    sigma: number;
    confidence: "low" | "medium" | "high";
    reasoning: string;
    steps: string[];
    features: Record<string, number | string | boolean>;
}
export interface HeuristicContext {
    /** Median points of graded items in the same course, if known. */
    coursePointsMedian?: number | undefined;
}
export declare function heuristicEstimate(item: WorkItem, ctx?: HeuristicContext): HeuristicResult;
