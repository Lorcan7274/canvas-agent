import { describe, expect, it } from "vitest";
import { applyAssignment, applyQuiz, normaliseCourse, normalisePlannerItem, type NormaliseContext } from "../src/canvas/normalize.js";
import { mergeItem } from "../src/sync.js";

const ctx: NormaliseContext = {
  baseUrl: "https://canvas.example.edu",
  courses: new Map([["101", { id: "101", name: "General Chemistry I", code: "CHEM 101" }]]),
  now: "2026-10-05T12:00:00.000Z",
};

describe("normalisePlannerItem", () => {
  it("builds an assignment item with status from submissions", () => {
    const item = normalisePlannerItem(
      {
        context_type: "Course",
        course_id: 101,
        plannable_id: 1001,
        plannable_type: "assignment",
        plannable: { id: 1001, title: "PS 5", due_at: "2026-10-07T23:59:00Z", points_possible: 20, updated_at: "2026-10-01T00:00:00Z" },
        html_url: "/courses/101/assignments/1001",
        submissions: { submitted: false, excused: false, graded: false, late: false, missing: false },
        planner_override: null,
      },
      ctx,
    )!;
    expect(item.id).toBe("canvas:assignment:1001");
    expect(item.assignmentId).toBe("1001");
    expect(item.courseCode).toBe("CHEM 101");
    expect(item.url).toBe("https://canvas.example.edu/courses/101/assignments/1001");
    expect(item.status).toBe("open");
    expect(item.host).toBe("canvas.example.edu");
  });

  it("keys quizzes and discussions by their assignment id", () => {
    const quiz = normalisePlannerItem(
      { course_id: 101, plannable_id: 501, plannable_type: "quiz", plannable: { id: 501, title: "Quiz 6", assignment_id: 1003, due_at: "2026-10-09T23:59:00Z" }, submissions: { submitted: false } },
      ctx,
    )!;
    expect(quiz.id).toBe("canvas:assignment:1003");
    expect(quiz.kind).toBe("quiz");
    expect(quiz.quizId).toBe("501");
  });

  it("respects planner overrides and submission states", () => {
    const done = normalisePlannerItem(
      { course_id: 101, plannable_id: 1, plannable_type: "assignment", plannable: { id: 1, title: "x" }, submissions: { submitted: false }, planner_override: { marked_complete: true, dismissed: false } },
      ctx,
    )!;
    expect(done.status).toBe("done");
    const graded = normalisePlannerItem(
      { course_id: 101, plannable_id: 2, plannable_type: "assignment", plannable: { id: 2, title: "y" }, submissions: { submitted: true, graded: true, late: true } },
      ctx,
    )!;
    expect(graded.status).toBe("graded");
    expect(graded.late).toBe(true);
  });

  it("skips announcements", () => {
    expect(normalisePlannerItem({ plannable_id: 3, plannable_type: "announcement", plannable: { id: 3 } }, ctx)).toBeUndefined();
  });
});

describe("applyAssignment / applyQuiz", () => {
  it("enriches a planner item with description, rubric and submission", () => {
    const base = normalisePlannerItem(
      { course_id: 101, plannable_id: 1002, plannable_type: "assignment", plannable: { id: 1002, title: "Lab 3" }, submissions: { submitted: false } },
      ctx,
    )!;
    const item = applyAssignment(
      {
        id: 1002, course_id: 101, name: "Lab Report 3", description: "<p>Write 4-5 pages.</p>", points_possible: 50,
        submission_types: ["online_upload"], allowed_attempts: 1, rubric: [{}, {}, {}, {}, {}], peer_reviews: false, group_category_id: null,
        html_url: "https://canvas.example.edu/courses/101/assignments/1002", updated_at: "2026-10-02T00:00:00Z",
        submission: { workflow_state: "submitted", submitted_at: "2026-10-04T10:00:00Z", score: null, late: false, missing: false, excused: false },
      },
      ctx,
      base,
    )!;
    expect(item.title).toBe("Lab Report 3");
    expect(item.descriptionText).toBe("Write 4-5 pages.");
    expect(item.rubricCriteria).toBe(5);
    expect(item.status).toBe("submitted");
    expect(item.submittedAt).toBe("2026-10-04T10:00:00Z");
    expect(item.isGroup).toBe(false);
  });

  it("marks quiz assignments and merges quiz facts", () => {
    const a = applyAssignment({ id: 1003, course_id: 101, name: "Quiz 6", quiz_id: 501, submission_types: ["online_quiz"] }, ctx)!;
    expect(a.kind).toBe("quiz");
    const q = applyQuiz({ id: 501, time_limit: 30, question_count: 15, allowed_attempts: 1, quiz_type: "assignment" }, a);
    expect(q.quiz).toEqual({ timeLimitMinutes: 30, questionCount: 15, allowedAttempts: 1, quizType: "assignment" });
  });
});

describe("mergeItem", () => {
  it("lets a feed row update the due date without erasing details", () => {
    const rich = applyAssignment({ id: 1, course_id: 101, name: "Essay", description: "<p>1500 words</p>", points_possible: 100, due_at: "2026-10-10T23:59:00Z" }, ctx)!;
    const feed = { ...rich, source: "feed" as const, descriptionText: undefined, pointsPossible: undefined, dueAt: "2026-10-12T23:59:00Z" };
    const merged = mergeItem(rich, feed);
    expect(merged.dueAt).toBe("2026-10-12T23:59:00Z");
    expect(merged.descriptionText).toBe("1500 words");
    expect(merged.pointsPossible).toBe(100);
    expect(merged.source).toBe("canvas");
  });
  it("keeps detail fields when a planner refresh lacks them", () => {
    const rich = applyAssignment({ id: 1, course_id: 101, name: "Essay", description: "<p>1500 words</p>", rubric: [{}, {}] }, ctx)!;
    const thin = normalisePlannerItem({ course_id: 101, plannable_id: 1, plannable_type: "assignment", plannable: { id: 1, title: "Essay (v2)" }, submissions: { submitted: true } }, ctx)!;
    const merged = mergeItem(rich, thin);
    expect(merged.title).toBe("Essay (v2)");
    expect(merged.status).toBe("submitted");
    expect(merged.descriptionText).toBe("1500 words");
    expect(merged.rubricCriteria).toBe(2);
  });
});

describe("normaliseCourse", () => {
  it("reads code and term", () => {
    expect(normaliseCourse({ id: 7, name: "Soc", course_code: "SOC 110", term: { name: "Fall", end_at: "2026-12-20T00:00:00Z" } })).toEqual({
      id: "7", name: "Soc", code: "SOC 110", termName: "Fall", termEndsAt: "2026-12-20T00:00:00Z",
    });
  });
});
