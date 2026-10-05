import { describe, expect, it } from "vitest";
import { UNTITLED, applyAssignment, applyQuiz, clearedFields, lockedForUser, normaliseCourse, normalisePlannerItem, type NormaliseContext } from "../src/canvas/normalize.js";
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

describe("mergeItem keeps what a thinner view cannot know (B4)", () => {
  it("keeps a New Quiz's detail-derived kind when the planner calls it an assignment again", () => {
    const planner = (title = "RM Check") =>
      normalisePlannerItem({ course_id: 101, plannable_id: 2004, plannable_type: "assignment", plannable: { id: 2004, title, due_at: "2026-10-10T23:59:00Z" }, submissions: { submitted: false } }, ctx)!;
    const detailed = applyAssignment({ id: 2004, course_id: 101, name: "RM Check", submission_types: ["external_tool"], is_quiz_lti_assignment: true }, ctx, planner())!;
    expect(detailed.kind).toBe("quiz");
    const again = mergeItem(detailed, planner());
    expect(again.kind).toBe("quiz");
    expect(again.isExternalTool).toBe(true);
  });

  it("never replaces a real title with the placeholder", () => {
    const rich = applyAssignment({ id: 5, course_id: 101, name: "Essay 3" }, ctx)!;
    const blank = normalisePlannerItem({ course_id: 101, plannable_id: 5, plannable_type: "assignment", plannable: null, plannable_date: "2026-10-10T23:59:00Z" }, ctx)!;
    expect(blank.title).toBe(UNTITLED);
    expect(mergeItem(rich, blank).title).toBe("Essay 3");
    // A feed row with a title fills in a placeholder.
    const feed = { ...blank, source: "feed" as const, title: "Essay 3 (feed)" };
    expect(mergeItem(blank, feed).title).toBe("Essay 3 (feed)");
  });
});

describe("cleared fields clear, absent fields stay (B5)", () => {
  const full = () =>
    applyAssignment(
      { id: 9, course_id: 101, name: "PS", due_at: "2026-10-10T23:59:00Z", unlock_at: "2026-10-01T00:00:00Z", lock_at: "2026-10-11T00:00:00Z", points_possible: 20, description: "<p>12 problems</p>", group_category_id: 4, submission_types: ["online_upload"] },
      ctx,
    )!;

  it("deletes a due date, dates and points Canvas sent as null", () => {
    const stored = full();
    const update = applyAssignment({ id: 9, course_id: 101, name: "PS", due_at: null, unlock_at: null, lock_at: null, points_possible: null, description: null }, ctx, stored)!;
    expect(clearedFields(update)).toEqual(expect.arrayContaining(["dueAt", "unlockAt", "lockAt", "pointsPossible", "descriptionText"]));
    const merged = mergeItem(stored, update);
    for (const k of ["dueAt", "unlockAt", "lockAt", "pointsPossible", "descriptionText", "descriptionChars"] as const) expect(merged[k], k).toBeUndefined();
    // The mark never reaches storage.
    expect(clearedFields(merged)).toEqual([]);
    expect(JSON.stringify(update)).not.toContain("cleared");
  });

  it("a planner refresh with due_at null clears the stored due date; a refresh without the key keeps it", () => {
    const stored = full();
    const nulled = normalisePlannerItem({ course_id: 101, plannable_id: 9, plannable_type: "assignment", plannable: { id: 9, title: "PS", due_at: null, points_possible: null } }, ctx)!;
    const merged = mergeItem(stored, nulled);
    expect(merged.dueAt).toBeUndefined();
    expect(merged.pointsPossible).toBeUndefined();
    const silent = normalisePlannerItem({ course_id: 101, plannable_id: 9, plannable_type: "assignment", plannable: { id: 9, title: "PS" } }, ctx)!;
    const kept = mergeItem(stored, silent);
    expect(kept.dueAt).toBe("2026-10-10T23:59:00Z");
    expect(kept.pointsPossible).toBe(20);
  });

  it("sets isGroup and isExternalTool only from fields that are there", () => {
    const stored = full();
    expect(stored.isGroup).toBe(true);
    expect(stored.isExternalTool).toBe(false);
    const thin = applyAssignment({ id: 9, course_id: 101, name: "PS" }, ctx)!;
    expect(thin.isGroup).toBeUndefined();
    expect(thin.isExternalTool).toBeUndefined();
    const merged = mergeItem(stored, thin);
    expect(merged.isGroup).toBe(true);
    const ungrouped = applyAssignment({ id: 9, course_id: 101, name: "PS", group_category_id: null }, ctx)!;
    expect(mergeItem(stored, ungrouped).isGroup).toBe(false);
  });

  it("clears an old planner mark when the override is gone", () => {
    const marked = normalisePlannerItem({ course_id: 101, plannable_id: 9, plannable_type: "assignment", plannable: { id: 9, title: "PS" }, planner_override: { marked_complete: true, dismissed: false } }, ctx)!;
    const unmarked = normalisePlannerItem({ course_id: 101, plannable_id: 9, plannable_type: "assignment", plannable: { id: 9, title: "PS" }, submissions: { submitted: false }, planner_override: null }, ctx)!;
    const merged = mergeItem(marked, unmarked);
    expect(merged.status).toBe("open");
    expect(merged.markedComplete).toBeUndefined();
  });

  it("keeps the description of an assignment that is still locked", () => {
    const stored = full();
    const locked = applyAssignment({ id: 9, course_id: 101, name: "PS", description: null, locked_for_user: true }, ctx, stored)!;
    expect(lockedForUser({ locked_for_user: true })).toBe(true);
    expect(mergeItem(stored, locked).descriptionText).toBe("12 problems");
  });

  it("drops a removed quiz time limit", () => {
    const withLimit = applyQuiz({ time_limit: 30, question_count: 10 }, applyAssignment({ id: 3, course_id: 101, quiz_id: 7 }, ctx)!);
    const noLimit = applyQuiz({ time_limit: null, question_count: 10 }, withLimit);
    expect(noLimit.quiz).toEqual({ questionCount: 10 });
  });
});

describe("planner shapes (B10, D7)", () => {
  it("keeps unknown planner types as 'other' and never reads the object prototype", () => {
    const sub = normalisePlannerItem({ course_id: 101, plannable_id: 55, plannable_type: "sub_assignment", plannable: { id: 55, title: "Reply to two peers", assignment_id: 2002, due_at: "2026-10-10T23:59:00Z" } }, ctx)!;
    expect(sub.kind).toBe("other");
    expect(sub.id).toBe("canvas:other:55");
    expect(sub.assignmentId).toBeUndefined();
    expect(normalisePlannerItem({ plannable_type: "constructor", plannable_id: 1, plannable: { id: 1 } }, ctx)?.kind).toBe("other");
    expect(normalisePlannerItem({ plannable_type: "", plannable_id: 1 }, ctx)).toBeUndefined();
  });

  it("reads calendar events' end and all-day flag, and survives submissions: false", () => {
    const ev = normalisePlannerItem(
      { course_id: 101, plannable_id: 8801, plannable_type: "calendar_event", plannable: { id: 8801, title: "Review", start_at: "2026-10-16T17:00:00Z", end_at: "2026-10-16T18:30:00Z", all_day: false }, submissions: false, planner_override: null },
      ctx,
    )!;
    expect(ev).toMatchObject({ kind: "event", dueAt: "2026-10-16T17:00:00Z", endAt: "2026-10-16T18:30:00Z", allDay: false, status: "open" });
  });

  it("lets a missing submission's planner override win over 'missing'", () => {
    const dismissed = applyAssignment({ id: 3007, course_id: 101, name: "HW 3", planner_override: { dismissed: true, marked_complete: false } }, ctx)!;
    expect(dismissed.status).toBe("dismissed");
    const done = applyAssignment({ id: 3008, course_id: 101, name: "HW 4", planner_override: { dismissed: false, marked_complete: true } }, ctx)!;
    expect(done.status).toBe("done");
    expect(done.markedComplete).toBe(true);
  });
});

describe("feed dates against an exact API time (B1)", () => {
  const api = applyAssignment({ id: 1, course_id: 101, name: "Essay", due_at: "2026-10-11T03:59:00Z" }, ctx)!; // 23:59 in New York
  const feedAt = (dueAt: string) => ({ ...api, source: "feed" as const, dueAt });
  it("keeps the API time when the feed's date-only due falls on the same local date", () => {
    expect(mergeItem(api, feedAt("2026-10-11T03:59:00.000Z"), { timezone: "America/New_York" }).dueAt).toBe("2026-10-11T03:59:00Z");
    // 23:59 New York read back from VALUE=DATE:20261010, a few seconds off: still the API's.
    expect(mergeItem(api, feedAt("2026-10-11T03:59:59.000Z"), { timezone: "America/New_York" }).dueAt).toBe("2026-10-11T03:59:00Z");
  });
  it("moves the due date when the feed says another local day", () => {
    expect(mergeItem(api, feedAt("2026-10-13T03:59:00.000Z"), { timezone: "America/New_York" }).dueAt).toBe("2026-10-13T03:59:00.000Z");
  });
  it("fills a due date the richer row lacks", () => {
    const undated = applyAssignment({ id: 1, course_id: 101, name: "Essay" }, ctx)!;
    expect(mergeItem(undated, feedAt("2026-10-13T03:59:00.000Z")).dueAt).toBe("2026-10-13T03:59:00.000Z");
  });
});
