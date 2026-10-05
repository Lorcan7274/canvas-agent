/**
 * Per-student calibration. Each logged actual gives a ratio actual/estimate.
 * A student's factor for a course shrinks toward their overall factor, which
 * shrinks toward 1. Everything is done in log space (ratios multiply).
 */
const PRIOR_WEIGHT = 3; // pseudo-observations at ratio 1
const Z80 = 0.8416;
function logRatios(samples) {
    return samples
        .filter((s) => s.estimatedHours > 0 && s.actualHours > 0)
        .map((s) => Math.log(s.actualHours / s.estimatedHours))
        .map((x) => Math.min(2.5, Math.max(-2.5, x))); // one 12× outlier should not own the factor
}
function shrunkMean(values, priorMean, priorWeight) {
    const sum = values.reduce((a, b) => a + b, 0);
    return (sum + priorMean * priorWeight) / (values.length + priorWeight);
}
function std(values, mean) {
    if (values.length < 2)
        return 0;
    const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(v);
}
export function calibrate(samples, courseId, baseSigma) {
    const all = logRatios(samples);
    const userMean = shrunkMean(all, 0, PRIOR_WEIGHT);
    const course = courseId ? logRatios(samples.filter((s) => s.courseId === courseId)) : [];
    const courseMean = course.length ? shrunkMean(course, userMean, PRIOR_WEIGHT) : userMean;
    const n = course.length || all.length;
    // Narrow the spread as evidence accumulates, but never below the observed scatter.
    const observed = std(all, userMean);
    let sigma = baseSigma * Math.sqrt(PRIOR_WEIGHT / (n + PRIOR_WEIGHT));
    sigma = Math.max(sigma, Math.min(baseSigma, observed), 0.25);
    return { factor: Math.exp(courseMean), sigma, samples: all.length, courseSamples: course.length };
}
export function applyCalibration(p50Hours, cal) {
    const p50 = p50Hours * cal.factor;
    return { p50Hours: round(p50), p80Hours: round(p50 * Math.exp(Z80 * cal.sigma)) };
}
function round(h) {
    return Math.round(h * 4) / 4;
}
/** One-tap buckets a student can answer after the fact. */
export const TIME_BUCKETS = {
    "<1h": 40,
    "1-2h": 90,
    "2-4h": 180,
    "4-8h": 360,
    "8h+": 600,
};
//# sourceMappingURL=calibrate.js.map