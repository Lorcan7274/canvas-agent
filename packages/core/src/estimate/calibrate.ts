/**
 * Per-student calibration. Each logged actual gives a ratio actual/estimate,
 * worked in log space (ratios multiply).
 *
 * Factor: the student's overall factor (from their other courses) is a mean
 * shrunk toward 1 with three pseudo-observations; the course factor is the
 * course's mean shrunk toward that, also with three. Ratios are clipped to
 * ±1.5 in log space (×4.5), so one wild answer cannot own the factor, and each
 * item counts once, with its latest actual.
 *
 * Spread: a predictive log-sd, pooled from the prior's own spread (as three
 * pseudo-observations) and the scatter of the student's ratios around their
 * mean, widened for the uncertainty in the factor itself. It uses the course's
 * ratios once the course has five, else all of the student's. Evidence of
 * tight scatter narrows it; evidence of wide scatter widens it past the
 * prior's spread.
 *
 * Bucket answers ("2-4h") are intervals, not numbers: each counts as the
 * calibrated estimate moved into the bucket, so a bucket that agrees with the
 * estimate confirms it rather than pulling it toward the bucket's middle.
 */

export interface RatioSample {
  courseId?: string;
  /** Identifies the item; when several samples share it only the last one counts. */
  itemId?: string;
  /** Hours the estimate said (the uncalibrated prior at the time). */
  estimatedHours: number;
  /** Hours it took. Ignored when `bucket` is given. */
  actualHours: number;
  /** The answer was a bucket: the actual lies between these bounds (hours; `hiHours` may be Infinity). */
  bucket?: { loHours: number; hiHours: number };
}

export interface Calibration {
  factor: number;
  /** Log-space spread to use for p80 after calibration. */
  sigma: number;
  samples: number;
  courseSamples: number;
}

/** Pseudo-observations behind every mean and spread. */
export const PRIOR_WEIGHT = 3;
/** Log ratios are clipped to ±this (×4.5 either way). */
export const LOG_RATIO_CLIP = 1.5;
/** A course's own scatter sets the spread once it has this many samples. */
export const COURSE_SPREAD_MIN_SAMPLES = 5;
export const SIGMA_FLOOR = 0.25;
const Z80 = 0.8416;

function clip(x: number): number {
  return Math.min(LOG_RATIO_CLIP, Math.max(-LOG_RATIO_CLIP, x));
}

/** Last sample per item (samples without an item id all count), in input order. */
function latestPerItem(samples: RatioSample[]): RatioSample[] {
  const last = new Map<string, number>();
  samples.forEach((s, i) => {
    if (s.itemId !== undefined) last.set(s.itemId, i);
  });
  return samples.filter((s, i) => s.itemId === undefined || last.get(s.itemId) === i);
}

function usable(s: RatioSample): boolean {
  if (!(s.estimatedHours > 0) || !Number.isFinite(s.estimatedHours)) return false;
  if (s.bucket) return s.bucket.hiHours > 0 && s.bucket.hiHours >= s.bucket.loHours;
  return s.actualHours > 0 && Number.isFinite(s.actualHours);
}

function shrunkMean(values: number[], priorMean: number, priorWeight: number): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return (sum + priorMean * priorWeight) / (values.length + priorWeight);
}

interface Means {
  user: number;
  course: number;
}

function means(xs: number[], courses: Array<string | undefined>, courseId: string | undefined): Means {
  const inCourse: number[] = [];
  const others: number[] = [];
  xs.forEach((x, i) => (courseId !== undefined && courses[i] === courseId ? inCourse : others).push(x));
  // The student's overall factor leaves this course out, so its samples are not counted twice.
  const user = shrunkMean(others, 0, PRIOR_WEIGHT);
  return { user, course: inCourse.length ? shrunkMean(inCourse, user, PRIOR_WEIGHT) : user };
}

/**
 * Predictive log-sd from `n` log ratios: (K·base² + Σ(x − x̄)²) / (K + n − 1),
 * times (1 + 1/(n + K)) for the factor's own uncertainty. With no samples it is
 * the prior's spread.
 */
export function predictiveSigma(xs: number[], baseSigma: number): number {
  const n = xs.length;
  if (n === 0) return Math.max(SIGMA_FLOOR, baseSigma);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ss = xs.reduce((a, x) => a + (x - mean) ** 2, 0);
  const s2 = (PRIOR_WEIGHT * baseSigma ** 2 + ss) / (PRIOR_WEIGHT + n - 1);
  return Math.max(SIGMA_FLOOR, Math.sqrt(s2 * (1 + 1 / (n + PRIOR_WEIGHT))));
}

export function calibrate(samples: RatioSample[], courseId: string | undefined, baseSigma: number): Calibration {
  const kept = latestPerItem(samples).filter(usable);
  const courses = kept.map((s) => s.courseId);
  const exactLog = (s: RatioSample) => clip(Math.log(s.actualHours / s.estimatedHours));
  // Buckets resolve against the factor they would get; a few rounds settle it.
  const perCourse = new Map<string | undefined, number>();
  const factorFor = (c: string | undefined): number => {
    if (!perCourse.has(c)) perCourse.set(c, 0);
    return perCourse.get(c)!;
  };
  let xs: number[] = [];
  const rounds = kept.some((s) => s.bucket) ? 4 : 1;
  for (let round = 0; round < rounds; round++) {
    xs = kept.map((s) => {
      if (!s.bucket) return exactLog(s);
      const guess = s.estimatedHours * Math.exp(factorFor(s.courseId));
      const resolved = Math.min(Math.max(guess, s.bucket.loHours), s.bucket.hiHours);
      return clip(Math.log(Math.max(resolved, 1 / 60) / s.estimatedHours));
    });
    const next = new Map<string | undefined, number>();
    for (const c of new Set(courses)) next.set(c, means(xs, courses, c).course);
    perCourse.clear();
    for (const [c, v] of next) perCourse.set(c, v);
  }
  const m = means(xs, courses, courseId);
  const courseXs = courseId !== undefined ? xs.filter((_, i) => courses[i] === courseId) : [];
  const spreadXs = courseXs.length >= COURSE_SPREAD_MIN_SAMPLES ? courseXs : xs;
  return {
    factor: Math.exp(m.course),
    sigma: predictiveSigma(spreadXs, baseSigma),
    samples: xs.length,
    courseSamples: courseXs.length,
  };
}

export function applyCalibration(p50Hours: number, cal: Calibration): { p50Hours: number; p80Hours: number } {
  const p50 = p50Hours * cal.factor;
  return { p50Hours: round(p50), p80Hours: round(p50 * Math.exp(Z80 * cal.sigma)) };
}

/** Log-space spread implied by a p50/p80 pair, clamped to [0.25, 1.2]. */
export function sigmaFromP80(p50Hours: number, p80Hours: number): number {
  const s = p50Hours > 0 && p80Hours > 0 ? Math.log(p80Hours / p50Hours) / Z80 : NaN;
  return Number.isFinite(s) ? Math.min(1.2, Math.max(SIGMA_FLOOR, s)) : 0.6;
}

function round(h: number): number {
  return Math.max(0.25, Math.round(h * 4) / 4);
}

/**
 * One-tap buckets a student can answer after the fact, as the minutes stored
 * for them. The stored number only names the bucket: calibration reads it back
 * as the bucket's bounds (`TIME_BUCKET_BOUNDS`).
 */
export const TIME_BUCKETS: Record<string, number> = {
  "<1h": 40,
  "1-2h": 90,
  "2-4h": 180,
  "4-8h": 360,
  "8h+": 600,
};

/** Each bucket's bounds in hours. */
export const TIME_BUCKET_BOUNDS: Record<string, { loHours: number; hiHours: number }> = {
  "<1h": { loHours: 0.1, hiHours: 1 },
  "1-2h": { loHours: 1, hiHours: 2 },
  "2-4h": { loHours: 2, hiHours: 4 },
  "4-8h": { loHours: 4, hiHours: 8 },
  "8h+": { loHours: 8, hiHours: Infinity },
};

/** The bucket a stored bucket answer's minutes stand for, if they are one of `TIME_BUCKETS`. */
export function bucketForMinutes(minutes: number): { label: string; loHours: number; hiHours: number } | undefined {
  for (const [label, m] of Object.entries(TIME_BUCKETS)) {
    if (m === minutes) return { label, ...TIME_BUCKET_BOUNDS[label]! };
  }
  return undefined;
}
