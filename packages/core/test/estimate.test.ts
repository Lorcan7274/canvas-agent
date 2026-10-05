import { describe, expect, it } from "vitest";
import { heuristicEstimate } from "../src/estimate/heuristic.js";
import { applyCalibration, calibrate } from "../src/estimate/calibrate.js";
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

describe("heuristicEstimate", () => {
  it("uses the quiz time limit", () => {
    const e = heuristicEstimate(base({ kind: "quiz", title: "Quiz 6", quiz: { timeLimitMinutes: 30, questionCount: 15 } }));
    expect(e.p50Hours).toBe(1);
    expect(e.confidence).toBe("high");
    expect(e.p80Hours).toBeGreaterThan(e.p50Hours);
  });
  it("sizes an essay by word count", () => {
    const e = heuristicEstimate(base({ title: "Essay 2", descriptionText: "Write a 1500-word essay. Cite at least 4 peer-reviewed sources.", pointsPossible: 100, rubricCriteria: 4, peerReviews: true }));
    // 1500 words -> 4.1h, +4 sources*0.4 = 5.7h, rubric 4 -> x1.1 = 6.27, +0.5 peer review = 6.77 -> 6.75
    expect(e.p50Hours).toBe(6.75);
    expect(e.confidence).toBe("high");
    expect(e.reasoning).toContain("1500 words");
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
  it("applies the factor and spread", () => {
    const r = applyCalibration(2, { factor: 1.5, sigma: 0.4, samples: 5, courseSamples: 2 });
    expect(r.p50Hours).toBe(3);
    expect(r.p80Hours).toBeGreaterThan(3);
  });
});
