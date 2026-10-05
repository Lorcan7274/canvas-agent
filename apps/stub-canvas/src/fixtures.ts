/**
 * A term's worth of plausible Canvas data for three courses. Dates are
 * relative to `base` so tests and demos always have work due this week.
 */

export interface StubCourse {
  id: number;
  name: string;
  course_code: string;
  term: { id: number; name: string; start_at: string; end_at: string };
  enrollment_term_id: number;
  workflow_state: "available";
}

export interface StubAssignment {
  id: number;
  course_id: number;
  name: string;
  description: string;
  due_at: string | null;
  unlock_at: string | null;
  lock_at: string | null;
  points_possible: number;
  submission_types: string[];
  allowed_attempts: number;
  rubric?: Array<{ id: string; description: string; points: number }>;
  peer_reviews: boolean;
  group_category_id: number | null;
  quiz_id?: number;
  is_quiz_assignment?: boolean;
  discussion_topic?: { id: number; title: string; require_initial_post: boolean };
  html_url: string;
  updated_at: string;
  submission?: {
    workflow_state: "unsubmitted" | "submitted" | "graded";
    submitted_at: string | null;
    score: number | null;
    late: boolean;
    missing: boolean;
    excused: boolean;
  };
}

export interface StubQuiz {
  id: number;
  course_id: number;
  assignment_id: number;
  title: string;
  description: string;
  quiz_type: "assignment" | "practice_quiz";
  time_limit: number | null;
  question_count: number;
  allowed_attempts: number;
  points_possible: number;
  due_at: string | null;
  html_url: string;
}

export interface Fixtures {
  base: Date;
  user: { id: number; name: string; primary_email: string; login_id: string };
  courses: StubCourse[];
  assignments: StubAssignment[];
  quizzes: StubQuiz[];
  /** planner overrides keyed by `${type}:${id}` */
  overrides: Record<string, { id: number; marked_complete: boolean; dismissed: boolean }>;
}

function iso(base: Date, days: number, hour = 23, minute = 59): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function makeFixtures(base = new Date(), origin = "https://canvas.example.edu"): Fixtures {
  const termStart = iso(base, -40, 0, 0);
  const termEnd = iso(base, 75, 23, 59);
  const courses: StubCourse[] = [
    { id: 101, name: "General Chemistry I", course_code: "CHEM 101", term: { id: 7, name: "Fall 2026", start_at: termStart, end_at: termEnd }, enrollment_term_id: 7, workflow_state: "available" },
    { id: 202, name: "Intro to Sociology", course_code: "SOC 110", term: { id: 7, name: "Fall 2026", start_at: termStart, end_at: termEnd }, enrollment_term_id: 7, workflow_state: "available" },
    { id: 303, name: "Data Structures", course_code: "CS 201", term: { id: 7, name: "Fall 2026", start_at: termStart, end_at: termEnd }, enrollment_term_id: 7, workflow_state: "available" },
  ];
  const upd = iso(base, -3, 10, 0);
  const url = (c: number, a: number) => `${origin}/courses/${c}/assignments/${a}`;
  const unsub = { workflow_state: "unsubmitted" as const, submitted_at: null, score: null, late: false, missing: false, excused: false };

  const assignments: StubAssignment[] = [
    {
      id: 1001, course_id: 101, name: "Problem Set 5: Stoichiometry",
      description: "<p>Complete <b>12 problems</b> from chapter 4 (4.12, 4.15, 4.18, ...). Show all work. Upload a single PDF.</p>",
      due_at: iso(base, 2), unlock_at: iso(base, -5, 0, 0), lock_at: iso(base, 3), points_possible: 20,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(101, 1001), updated_at: upd, submission: unsub,
    },
    {
      id: 1002, course_id: 101, name: "Lab Report 3: Titration",
      description: "<p>Write a lab report (4-5 pages, double-spaced) covering purpose, method, data tables, analysis and sources of error. Include at least 2 sources.</p>",
      due_at: iso(base, 6), unlock_at: null, lock_at: null, points_possible: 50,
      submission_types: ["online_upload"], allowed_attempts: 1, peer_reviews: false, group_category_id: null,
      rubric: [
        { id: "r1", description: "Purpose", points: 5 }, { id: "r2", description: "Method", points: 10 },
        { id: "r3", description: "Data", points: 10 }, { id: "r4", description: "Analysis", points: 15 }, { id: "r5", description: "Error", points: 10 },
      ],
      html_url: url(101, 1002), updated_at: upd, submission: unsub,
    },
    {
      id: 1003, course_id: 101, name: "Quiz 6: Gas Laws",
      description: "<p>Covers sections 5.1-5.4. One attempt.</p>",
      due_at: iso(base, 4), unlock_at: iso(base, 1, 8, 0), lock_at: iso(base, 4), points_possible: 10,
      submission_types: ["online_quiz"], allowed_attempts: 1, peer_reviews: false, group_category_id: null,
      quiz_id: 501, is_quiz_assignment: true, html_url: `${origin}/courses/101/quizzes/501`, updated_at: upd, submission: unsub,
    },
    {
      id: 2001, course_id: 202, name: "Essay 2: Social Stratification",
      description: "<p>Write a 1500-word essay analysing one institution through the lens of conflict theory. Cite at least 4 peer-reviewed sources in ASA style.</p>",
      due_at: iso(base, 9), unlock_at: null, lock_at: null, points_possible: 100,
      submission_types: ["online_text_entry", "online_upload"], allowed_attempts: -1, peer_reviews: true, group_category_id: null,
      rubric: [
        { id: "s1", description: "Thesis", points: 20 }, { id: "s2", description: "Evidence", points: 30 },
        { id: "s3", description: "Analysis", points: 30 }, { id: "s4", description: "Style", points: 20 },
      ],
      html_url: url(202, 2001), updated_at: upd, submission: unsub,
    },
    {
      id: 2002, course_id: 202, name: "Week 7 Discussion: Deviance",
      description: "<p>Post a 250-word response to the prompt by Wednesday, then reply to two classmates by Friday.</p>",
      due_at: iso(base, 3), unlock_at: null, lock_at: null, points_possible: 10,
      submission_types: ["discussion_topic"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      discussion_topic: { id: 7002, title: "Week 7 Discussion: Deviance", require_initial_post: true },
      html_url: `${origin}/courses/202/discussion_topics/7002`, updated_at: upd, submission: unsub,
    },
    {
      id: 2003, course_id: 202, name: "Reading Response: Chapters 6-7",
      description: "<p>Read chapters 6 and 7 of the textbook and submit a one-page response.</p>",
      due_at: iso(base, 1), unlock_at: null, lock_at: null, points_possible: 5,
      submission_types: ["online_text_entry"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(202, 2003), updated_at: upd, submission: unsub,
    },
    {
      id: 3001, course_id: 303, name: "Project 2: Hash Map Implementation",
      description: "<p>Implement an open-addressing hash map in C with linear probing and resizing. Include tests and a short design document (2 pages). Work in pairs.</p>",
      due_at: iso(base, 12), unlock_at: null, lock_at: null, points_possible: 150,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: 9,
      html_url: url(303, 3001), updated_at: upd, submission: unsub,
    },
    {
      id: 3002, course_id: 303, name: "Homework 6: Trees",
      description: "<p>8 problems on BST and AVL rotations. Handwritten scans accepted.</p>",
      due_at: iso(base, 5), unlock_at: null, lock_at: null, points_possible: 30,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(303, 3002), updated_at: upd, submission: unsub,
    },
    {
      id: 3003, course_id: 303, name: "Midterm Exam",
      description: "<p>In class. Covers weeks 1-7.</p>",
      due_at: iso(base, 14, 14, 0), unlock_at: null, lock_at: null, points_possible: 200,
      submission_types: ["on_paper"], allowed_attempts: 1, peer_reviews: false, group_category_id: null,
      html_url: url(303, 3003), updated_at: upd, submission: unsub,
    },
    {
      id: 3004, course_id: 303, name: "Homework 5: Linked Lists",
      description: "<p>6 problems.</p>",
      due_at: iso(base, -2), unlock_at: null, lock_at: null, points_possible: 30,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(303, 3004), updated_at: upd,
      submission: { workflow_state: "unsubmitted", submitted_at: null, score: null, late: false, missing: true, excused: false },
    },
    {
      id: 1000, course_id: 101, name: "Problem Set 4: Reactions",
      description: "<p>10 problems.</p>",
      due_at: iso(base, -6), unlock_at: null, lock_at: null, points_possible: 20,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(101, 1000), updated_at: upd,
      submission: { workflow_state: "graded", submitted_at: iso(base, -7, 20, 0), score: 18, late: false, missing: false, excused: false },
    },
  ];

  const quizzes: StubQuiz[] = [
    {
      id: 501, course_id: 101, assignment_id: 1003, title: "Quiz 6: Gas Laws", description: "<p>Covers sections 5.1-5.4.</p>",
      quiz_type: "assignment", time_limit: 30, question_count: 15, allowed_attempts: 1, points_possible: 10,
      due_at: iso(base, 4), html_url: `${origin}/courses/101/quizzes/501`,
    },
  ];

  return {
    base,
    user: { id: 42, name: "Sam Student", primary_email: "sam@example.edu", login_id: "sam" },
    courses,
    assignments,
    quizzes,
    overrides: {
      "assignment:2003": { id: 9001, marked_complete: false, dismissed: false },
    },
  };
}

export function plannerItemsFor(f: Fixtures, origin: string): unknown[] {
  const items: unknown[] = [];
  for (const a of f.assignments) {
    const quiz = a.quiz_id ? f.quizzes.find((q) => q.id === a.quiz_id) : undefined;
    const type = quiz ? "quiz" : a.discussion_topic ? "discussion_topic" : "assignment";
    const plannableId = quiz ? quiz.id : a.discussion_topic ? a.discussion_topic.id : a.id;
    const sub = a.submission ?? { workflow_state: "unsubmitted", submitted_at: null, score: null, late: false, missing: false, excused: false };
    const ov = f.overrides[`${type}:${plannableId}`] ?? f.overrides[`assignment:${a.id}`];
    items.push({
      context_type: "Course",
      course_id: a.course_id,
      plannable_id: plannableId,
      plannable_type: type,
      plannable: {
        id: plannableId,
        title: a.name,
        due_at: a.due_at,
        points_possible: a.points_possible,
        created_at: a.updated_at,
        updated_at: a.updated_at,
        ...(type !== "assignment" ? { assignment_id: a.id } : {}),
      },
      plannable_date: a.due_at,
      html_url: a.html_url.replace(origin, ""),
      submissions: {
        submitted: sub.workflow_state !== "unsubmitted",
        excused: sub.excused,
        graded: sub.workflow_state === "graded",
        late: sub.late,
        missing: sub.missing,
        needs_grading: sub.workflow_state === "submitted",
        has_feedback: false,
      },
      planner_override: ov
        ? { id: ov.id, plannable_type: type, plannable_id: plannableId, user_id: f.user.id, marked_complete: ov.marked_complete, dismissed: ov.dismissed, workflow_state: "active" }
        : null,
      new_activity: false,
    });
  }
  // One calendar event: a review session.
  items.push({
    context_type: "Course",
    course_id: 303,
    plannable_id: 8801,
    plannable_type: "calendar_event",
    plannable: { id: 8801, title: "Midterm review session", start_at: iso(f.base, 11, 17, 0), end_at: iso(f.base, 11, 18, 30), all_day: false },
    plannable_date: iso(f.base, 11, 17, 0),
    html_url: "/calendar?event_id=8801",
    submissions: false,
    planner_override: null,
    new_activity: false,
  });
  return items;
}

export function feedFor(f: Fixtures, origin: string): string {
  const fmt = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Instructure//Canvas//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Canvas"];
  for (const a of f.assignments) {
    if (!a.due_at) continue;
    const course = f.courses.find((c) => c.id === a.course_id)!;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:event-assignment-${a.id}`);
    lines.push(`DTSTAMP:${fmt(a.updated_at)}`);
    lines.push(`DTSTART:${fmt(a.due_at)}`);
    lines.push(`DTEND:${fmt(a.due_at)}`);
    lines.push(`SUMMARY:${esc(`${a.name} [${course.course_code}]`)}`);
    lines.push(`DESCRIPTION:${esc(a.description.replace(/<[^>]+>/g, ""))}`);
    lines.push(`URL:${origin}/courses/${a.course_id}/assignments/${a.id}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
