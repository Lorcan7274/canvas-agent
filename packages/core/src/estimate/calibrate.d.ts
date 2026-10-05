/**
 * Per-student calibration. Each logged actual gives a ratio actual/estimate.
 * A student's factor for a course shrinks toward their overall factor, which
 * shrinks toward 1. Everything is done in log space (ratios multiply).
 */
export interface RatioSample {
    courseId?: string;
    /** Hours the estimate said. */
    estimatedHours: number;
    actualHours: number;
}
export interface Calibration {
    factor: number;
    /** Log-space spread to use for p80 after calibration. */
    sigma: number;
    samples: number;
    courseSamples: number;
}
export declare function calibrate(samples: RatioSample[], courseId: string | undefined, baseSigma: number): Calibration;
export declare function applyCalibration(p50Hours: number, cal: Calibration): {
    p50Hours: number;
    p80Hours: number;
};
/** One-tap buckets a student can answer after the fact. */
export declare const TIME_BUCKETS: Record<string, number>;
