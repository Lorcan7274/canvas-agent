import { describe, expect, it } from "vitest";
import { heuristicEstimate, requiredReplies } from "../src/estimate/heuristic.js";
import { applyCalibration, bucketForMinutes, calibrate, predictiveSigma, sigmaFromP80, TIME_BUCKET_BOUNDS, TIME_BUCKETS, type RatioSample } from "../src/estimate/calibrate.js";
import type { WorkItem } from "../src/types.js";

const base = (over: Partial<WorkItem>): WorkItem => ({
  id: "canvas:assignment:1",
  source: "canvas",
  kind: "assignment",
  title: "x",
  status: "open",
  updatedAt: "2026-10-05T00:00:00Z",
  ...over,
});

/** Seeded uniform [0, 1): mulberry32. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

describe("heuristicEstimate", () => {
  it("uses the quiz time limit", () => {
    const e = heuristicEstimate(base({ kind: "quiz", title: "Quiz 6", quiz: { timeLimitMinutes: 30, questionCount: 15 } }));
    expect(e.p50Hours).toBe(1);
    expect(e.confidence).toBe("high");
    expect(e.p80Hours).toBeGreaterThan(e.p50Hours);
  });
  it("sizes an essay by word count", () => {
    const e = heuristicEstimate(base({ title: "Essay 2", descriptionText: "Write a 1500-word essay. Cite at least 4 peer-reviewed sources.", pointsPossible: 100, rubricCriteria: 4, peerReviews: true }));
    // 1500 words -> 4.1h, +4 sources*0.4 = 5.7h, +0.5 peer review = 6.2 -> 6.25. The rubric does not stretch a measured length.
    expect(e.p50Hours).toBe(6.25);
    expect(e.confidence).toBe("high");
    expect(e.reasoning).toContain("1500 words");
    expect(e.reasoning).not.toContain("rubric");
  });
  it("sizes a problem set by problem count", () => {
    const e = heuristicEstimate(base({ title: "Problem Set 5", descriptionText: "Complete 12 problems from chapter 4." }));
    expect(e.p50Hours).toBe(3.75);
  });
  it("falls back to a kind base and scales by points", () => {
    const e = heuristicEstimate(base({ title: "Midterm Exam", pointsPossible: 200 }), { coursePointsMedian: 30 });
    expect(e.confidence).toBe("medium");
    expect(e.p50Hours).toBeGreaterThan(6);
    expect(e.p50Hours).toBeLessThanOrEqual(15);
  });
  it("never goes below fifteen minutes", () => {
    const e = heuristicEstimate(base({ title: "Attendance", pointsPossible: 1 }), { coursePointsMedian: 100 });
    expect(e.p50Hours).toBeGreaterThanOrEqual(0.25);
  });

  // The misreads the review found, pinned: each row is title (+ brief), what it should read as, and the number.
  const table: Array<{ name: string; item: Partial<WorkItem>; median?: number; shape: string; p50: number; confidence: "low" | "medium" | "high" }> = [
    // A6: durations that are windows, not effort.
    { name: "a posting window is not effort", item: { kind: "discussion", title: "Week 3 Discussion", descriptionText: "Post within 48 hours of the lecture." }, shape: "discussion", p50: 1, confidence: "medium" },
    { name: "a 24-hour take-home window is not effort", item: { title: "Take-home Exam 2", descriptionText: "You have 24 hours to complete this take-home.", pointsPossible: 100 }, median: 50, shape: "exam", p50: 7.75, confidence: "medium" },
    { name: "a stated duration alone is medium confidence", item: { title: "Watch lecture", descriptionText: "This should take about 45 minutes." }, shape: "generic", p50: 0.75, confidence: "medium" },
    { name: "an exam's stated sitting adds to the prep", item: { title: "Final Exam", descriptionText: "A 90-minute exam in class." }, shape: "exam", p50: 7.5, confidence: "medium" },
    // A7: final/midterm are modifiers; test only on its own.
    { name: "Final Project is a project", item: { title: "Final Project", pointsPossible: 100 }, median: 50, shape: "project", p50: 10.25, confidence: "medium" },
    { name: "Final Paper is a paper", item: { title: "Final Paper" }, shape: "paper", p50: 3, confidence: "medium" },
    { name: "Final Reflection is a reflection", item: { title: "Final Reflection" }, shape: "reflection", p50: 1, confidence: "medium" },
    { name: "a pre-test is a quiz", item: { title: "Chapter 1 Pre-test" }, shape: "quiz", p50: 1, confidence: "medium" },
    { name: "exam review problems are a problem set", item: { title: "Exam review problems" }, shape: "problem_set", p50: 2.5, confidence: "medium" },
    { name: "a problem set about analysis is a problem set", item: { title: "Problem Set 4: Regression Analysis" }, shape: "problem_set", p50: 2.5, confidence: "medium" },
    { name: "unit tests in a brief are not an exam", item: { title: "Assignment 4", descriptionText: "Write unit tests for the parser." }, shape: "problem_set", p50: 2.5, confidence: "medium" },
    { name: "Final Draft is not an exam", item: { title: "Final Draft" }, shape: "generic", p50: 2, confidence: "low" },
    { name: "a midterm taken as a 120-minute quiz gets exam prep", item: { kind: "quiz", title: "Midterm Exam", pointsPossible: 200, quiz: { timeLimitMinutes: 120 } }, median: 30, shape: "quiz", p50: 13.75, confidence: "medium" },
    { name: "the same midterm as an assignment", item: { title: "Midterm Exam", pointsPossible: 200 }, median: 30, shape: "exam", p50: 11.75, confidence: "medium" },
    { name: "an hour-long quiz gets two hours' review", item: { kind: "quiz", title: "Chapter 5 Quiz", quiz: { timeLimitMinutes: 60 } }, shape: "quiz", p50: 3, confidence: "high" },
    // A8: quantity misreads.
    { name: "a section number is not a count; exercises 1-15 are 15", item: { title: "Homework 3", descriptionText: "Section 2.3 exercises 1-15" }, shape: "problem_set", p50: 4.75, confidence: "high" },
    { name: "pages 112-140 are 29 pages of reading", item: { title: "Reading: Smith", descriptionText: "Read pages 112-140" }, shape: "reading", p50: 3.25, confidence: "high" },
    { name: "chapters 3 and 9 are two chapters", item: { title: "Reading week 5", descriptionText: "Read chapters 3 and 9." }, shape: "reading", p50: 3, confidence: "high" },
    { name: "two to three pages is three", item: { title: "Response paper", descriptionText: "Write two to three pages." }, shape: "paper", p50: 3.5, confidence: "high" },
    // A15: what earns high confidence, rubric cap, replies.
    { name: "sources alone stay medium and keep the points factor", item: { title: "Research Paper", descriptionText: "Use at least 8 sources.", pointsPossible: 200 }, shape: "paper", p50: 10, confidence: "medium" },
    { name: "the same paper without sources", item: { title: "Research Paper", pointsPossible: 200 }, shape: "paper", p50: 6.75, confidence: "medium" },
    { name: "a rubric does not stretch a measured length (3 criteria)", item: { title: "Essay", descriptionText: "Write 1500 words.", rubricCriteria: 3 }, shape: "paper", p50: 4, confidence: "high" },
    { name: "a rubric does not stretch a measured length (10 criteria)", item: { title: "Essay", descriptionText: "Write 1500 words.", rubricCriteria: 10 }, shape: "paper", p50: 4, confidence: "high" },
    { name: "a rubric stretches an unsized brief by at most x1.3", item: { title: "Essay", rubricCriteria: 10 }, shape: "paper", p50: 4, confidence: "medium" },
    { name: "required replies add 18 minutes each", item: { kind: "discussion", title: "Week 7 Discussion: Deviance", descriptionText: "Post a 250-word response to the prompt by Wednesday, then reply to two classmates by Friday.", pointsPossible: 10 }, shape: "discussion", p50: 1.75, confidence: "high" },
    { name: "a project's design document is a write-up on top of the build", item: { title: "Project 2: Hash Map", descriptionText: "Implement a hash map. Include tests and a short design document (2 pages).", pointsPossible: 150 }, median: 150, shape: "project", p50: 10.5, confidence: "medium" },
  ];
  it.each(table)("$name", ({ item, median, shape, p50, confidence }) => {
    const e = heuristicEstimate(base(item), median ? { coursePointsMedian: median } : {});
    expect(e.features["shape"]).toBe(shape);
    expect(e.p50Hours).toBe(p50);
    expect(e.confidence).toBe(confidence);
    expect(e.p80Hours).toBeGreaterThan(e.p50Hours);
  });

  it("explains every number it applies", () => {
    expect(heuristicEstimate(base({ title: "Essay", rubricCriteria: 10 })).reasoning).toContain("×1.30 (capped)");
    expect(heuristicEstimate(base({ kind: "discussion", title: "D", descriptionText: "Reply to two classmates." })).reasoning).toContain("2 required replies add 0.6h");
    expect(heuristicEstimate(base({ kind: "quiz", title: "Quiz", quiz: { timeLimitMinutes: 90 } })).reasoning).toContain("2h review");
  });

  it("counts required replies", () => {
    expect(requiredReplies("then reply to two classmates by Friday")).toBe(2);
    expect(requiredReplies("Respond to at least 3 peers")).toBe(3);
    expect(requiredReplies("Write two substantive replies")).toBe(2);
    expect(requiredReplies("reply to a classmate")).toBe(1);
    expect(requiredReplies("Post your answer")).toBeUndefined();
  });
});

describe("calibrate", () => {
  it("starts at a factor of one", () => {
    const c = calibrate([], undefined, 0.5);
    expect(c.factor).toBe(1);
    expect(c.sigma).toBe(0.5);
  });
  it("moves toward the observed ratio as evidence grows", () => {
    const two = (n: number) => Array.from({ length: n }, () => ({ estimatedHours: 1, actualHours: 2, courseId: "c" }));
    const f1 = calibrate(two(1), "c", 0.5).factor;
    const f6 = calibrate(two(6), "c", 0.5).factor;
    expect(f1).toBeGreaterThan(1);
    expect(f6).toBeGreaterThan(f1);
    expect(f6).toBeLessThan(2);
  });
  it("shrinks the course factor toward the student's overall factor", () => {
    const samples = [
      ...Array.from({ length: 8 }, () => ({ estimatedHours: 1, actualHours: 1.5, courseId: "a" })),
      { estimatedHours: 1, actualHours: 4, courseId: "b" },
    ];
    const cb = calibrate(samples, "b", 0.5);
    expect(cb.factor).toBeGreaterThan(1.3);
    expect(cb.factor).toBeLessThan(2.5);
  });
  it("leaves the target course out of the overall factor, so its samples count once", () => {
    const eight = Array.from({ length: 8 }, () => ({ estimatedHours: 1, actualHours: 1.5, courseId: "a" }));
    // Only course a: the overall factor has nothing else and stays at 1; the course mean shrinks toward it.
    expect(calibrate(eight, "a", 0.5).factor).toBeCloseTo(Math.exp((8 * Math.log(1.5)) / 11), 9);
  });
  it("counts each item once, with its latest actual", () => {
    const c = calibrate(
      [
        { itemId: "x", estimatedHours: 1, actualHours: 3, courseId: "c" },
        { itemId: "x", estimatedHours: 1, actualHours: 1, courseId: "c" },
      ],
      "c",
      0.5,
    );
    expect(c.samples).toBe(1);
    expect(c.factor).toBeCloseTo(1, 9);
  });
  it("clips a wild ratio at ±1.5 in log space", () => {
    const c = calibrate([{ estimatedHours: 0.25, actualHours: 3, courseId: "c" }], "c", 0.5); // 12x
    expect(c.factor).toBeCloseTo(Math.exp(1.5 / 4), 9);
  });
  it("reads a bucket as its bounds: short quizzes answered <1h are not slow", () => {
    const quizzes = Array.from({ length: 5 }, (_, i) => ({ itemId: `q${i}`, courseId: "c", estimatedHours: 0.25, actualHours: TIME_BUCKETS["<1h"]! / 60, bucket: TIME_BUCKET_BOUNDS["<1h"]! }));
    expect(calibrate(quizzes, "c", 0.45).factor).toBeCloseTo(1, 6);
    const one8 = calibrate([{ courseId: "c", estimatedHours: 0.25, actualHours: 10, bucket: TIME_BUCKET_BOUNDS["8h+"]! }], "c", 0.45);
    expect(one8.factor).toBeLessThanOrEqual(Math.exp(1.5 / 4) + 1e-9);
  });
  it("lets a bucket that agrees with the calibrated estimate confirm it", () => {
    const exact = Array.from({ length: 6 }, (_, i) => ({ itemId: `e${i}`, courseId: "c", estimatedHours: 1, actualHours: 2 }));
    const without = calibrate(exact, "c", 0.45).factor;
    const withBucket = calibrate([...exact, { itemId: "b", courseId: "c", estimatedHours: 1, actualHours: 1.5, bucket: TIME_BUCKET_BOUNDS["1-2h"]! }], "c", 0.45).factor;
    expect(Math.abs(withBucket - without)).toBeLessThan(0.02);
  });
  it("widens for one big miss and narrows, to a floor, for consistent ratios", () => {
    const good = Array.from({ length: 10 }, (_, i) => ({ itemId: `g${i}`, courseId: "c", estimatedHours: 1, actualHours: 1 }));
    expect(calibrate([...good, { itemId: "m", courseId: "c", estimatedHours: 1, actualHours: 5 }], "c", 0.45).sigma).toBeGreaterThan(0.45);
    const steady = Array.from({ length: 20 }, (_, i) => ({ itemId: `s${i}`, courseId: "c", estimatedHours: 1, actualHours: 1.2 }));
    expect(calibrate(steady, "c", 0.45).sigma).toBe(0.25);
  });
  it("uses the course's own scatter once it has five samples", () => {
    const steady = Array.from({ length: 5 }, (_, i) => ({ itemId: `s${i}`, courseId: "steady", estimatedHours: 1, actualHours: 1 }));
    const wild = [0.3, 3, 0.5, 2.5, 1].map((a, i) => ({ itemId: `w${i}`, courseId: "wild", estimatedHours: 1, actualHours: a }));
    expect(calibrate([...steady, ...wild], "steady", 0.45).sigma).toBeLessThan(0.45);
    expect(calibrate([...steady, ...wild], "wild", 0.45).sigma).toBeGreaterThan(0.6);
  });
  it("applies the factor and spread", () => {
    const r = applyCalibration(2, { factor: 1.5, sigma: 0.4, samples: 5, courseSamples: 2 });
    expect(r.p50Hours).toBe(3);
    expect(r.p80Hours).toBeGreaterThan(3);
  });
  it("derives a spread from a p50/p80 pair, clamped", () => {
    expect(sigmaFromP80(2, 3)).toBeCloseTo(Math.log(1.5) / 0.8416, 9);
    expect(sigmaFromP80(2, 2)).toBe(0.25);
    expect(sigmaFromP80(1, 100)).toBe(1.2);
    expect(predictiveSigma([], 0.6)).toBe(0.6);
  });
  it("maps stored bucket minutes back to their bounds", () => {
    expect(bucketForMinutes(180)).toEqual({ label: "2-4h", loHours: 2, hiHours: 4 });
    expect(bucketForMinutes(600)?.hiHours).toBe(Infinity);
    expect(bucketForMinutes(181)).toBeUndefined();
  });

  it("puts four in five actuals under p80 after 30 logged items (seeded Monte Carlo, log-sd 0.6)", () => {
    const r = rng(20261005);
    const z = normal(r);
    for (const baseSigma of [0.45, 0.6, 0.8]) {
      let covered = 0;
      const trials = 2000;
      for (let t = 0; t < trials; t++) {
        const bias = 0.4 * z(); // this student's own factor, unknown to the estimator
        const samples: RatioSample[] = Array.from({ length: 30 }, (_, i) => ({ itemId: `i${i}`, courseId: "c", estimatedHours: 2, actualHours: 2 * Math.exp(bias + 0.6 * z()) }));
        const cal = calibrate(samples, "c", baseSigma);
        const p80 = 2 * cal.factor * Math.exp(0.8416 * cal.sigma);
        if (2 * Math.exp(bias + 0.6 * z()) <= p80) covered++;
      }
      const coverage = covered / trials;
      expect(coverage, `base sigma ${baseSigma}`).toBeGreaterThanOrEqual(0.75);
      expect(coverage, `base sigma ${baseSigma}`).toBeLessThanOrEqual(0.85);
    }
  });
});
