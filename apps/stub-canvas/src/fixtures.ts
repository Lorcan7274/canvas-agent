/**
 * A term's worth of plausible Canvas data for three courses. Dates are
 * relative to `base` so tests and demos always have work due this week.
 *
 * The data has the shapes real Canvas sends and the normaliser must survive:
 * a New Quiz (an LTI `external_tool` assignment), an undated assignment,
 * submitted / late / excused / missing work, `marked_complete` and
 * `dismissed` planner overrides, a locked assignment (description withheld),
 * wiki pages, planner notes, an announcement and a peer review in the
 * planner, a planner item with `plannable: null`, `submissions: false`, and a
 * feed that writes 23:59 dues as `VALUE=DATE`, folds long lines and links to
 * `/calendar?...#assignment_N`. The stub's Canvas runs on UTC.
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
  /** New Quizzes: an LTI tool behind an assignment. */
  is_quiz_lti_assignment?: boolean;
  external_tool_tag_attributes?: { url: string; new_tab: boolean };
  /** Still locked for the student: Canvas withholds the description. */
  locked_for_user?: boolean;
  lock_explanation?: string;
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

/** Planner entries that are not assignments: pages with a to-do date, notes, announcements, peer reviews. */
export interface StubPlannerExtra {
  plannable_type: string;
  plannable_id: number;
  course_id?: number;
  plannable: Record<string, unknown> | null;
  plannable_date: string;
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
  /** Calendar events (planner `calendar_event`, feed `event-calendar-event-N`). */
  events: Array<{ id: number; course_id: number; title: string; start_at: string; end_at: string; all_day: boolean }>;
  plannerExtras: StubPlannerExtra[];
}

/**
 * `days` from `base` at hour:minute UTC. setUTCDate rolls over month and year
 * ends correctly (Oct 31 + 1 is Nov 1), so offsets never land on a bad date.
 */
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
    {
      id: 2004, course_id: 202, name: "Research Methods Check (New Quiz)",
      description: "<p>Take the quiz on research methods \u2014 sampling, surveys and ethics. 20 questions, one attempt; review chapters 2\u20133 first.</p>",
      due_at: iso(base, 5), unlock_at: null, lock_at: null, points_possible: 15,
      submission_types: ["external_tool"], allowed_attempts: 1, peer_reviews: false, group_category_id: null,
      is_quiz_lti_assignment: true, external_tool_tag_attributes: { url: "https://quiz-lti.example/lti/launch", new_tab: false },
      html_url: url(202, 2004), updated_at: upd, submission: unsub,
    },
    {
      id: 2005, course_id: 202, name: "Reading Response: Chapter 5",
      description: "<p>One page on chapter 5.</p>",
      due_at: iso(base, -3), unlock_at: null, lock_at: null, points_possible: 5,
      submission_types: ["online_text_entry"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(202, 2005), updated_at: upd,
      submission: { workflow_state: "submitted", submitted_at: iso(base, -2, 9, 30), score: null, late: true, missing: false, excused: false },
    },
    {
      id: 2006, course_id: 202, name: "Field Observation Notes",
      description: "<p>Notes from one hour of observation in a public place.</p>",
      due_at: iso(base, -1), unlock_at: null, lock_at: null, points_possible: 10,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(202, 2006), updated_at: upd,
      submission: { workflow_state: "unsubmitted", submitted_at: null, score: null, late: false, missing: false, excused: true },
    },
    {
      // No due date: never in the planner or the feed; only its detail endpoint knows it.
      id: 2007, course_id: 202, name: "Optional Extra Credit Reflection",
      description: "<p>Optional: a short reflection on any reading, any time this term.</p>",
      due_at: null, unlock_at: null, lock_at: null, points_possible: 5,
      submission_types: ["online_text_entry"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(202, 2007), updated_at: upd, submission: unsub,
    },
    {
      id: 3005, course_id: 303, name: "Homework 4: Arrays",
      description: "<p>5 problems on dynamic arrays.</p>",
      due_at: iso(base, -4), unlock_at: null, lock_at: null, points_possible: 30,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(303, 3005), updated_at: upd,
      submission: { workflow_state: "submitted", submitted_at: iso(base, -5, 21, 0), score: null, late: false, missing: false, excused: false },
    },
    {
      // The student marked it done in the planner before submitting anything.
      id: 3006, course_id: 303, name: "Lab 2 Reflection",
      description: "<p>Half a page on what went wrong in lab 2.</p>",
      due_at: iso(base, 8), unlock_at: null, lock_at: null, points_possible: 5,
      submission_types: ["online_text_entry"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(303, 3006), updated_at: upd, submission: unsub,
    },
    {
      // Missing, older than the planner's 14 days, and dismissed by the student: only missing_submissions returns it.
      id: 3007, course_id: 303, name: "Homework 3: Recursion",
      description: "<p>4 problems.</p>",
      due_at: iso(base, -20), unlock_at: null, lock_at: null, points_possible: 30,
      submission_types: ["online_upload"], allowed_attempts: -1, peer_reviews: false, group_category_id: null,
      html_url: url(303, 3007), updated_at: upd,
      submission: { workflow_state: "unsubmitted", submitted_at: null, score: null, late: false, missing: true, excused: false },
    },
    {
      // Locked until next week: Canvas withholds the description until then.
      id: 3008, course_id: 303, name: "Final Project Proposal",
      description: "<p>Two pages: the problem, the data structure you will build, and a test plan.</p>",
      due_at: iso(base, 16), unlock_at: iso(base, 3, 8, 0), lock_at: null, points_possible: 20,
      submission_types: ["online_upload"], allowed_attempts: 1, peer_reviews: false, group_category_id: null,
      locked_for_user: true, lock_explanation: "This assignment is locked until next week.",
      html_url: url(303, 3008), updated_at: upd, submission: unsub,
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
      "assignment:3006": { id: 9002, marked_complete: true, dismissed: false },
      "assignment:3007": { id: 9003, marked_complete: false, dismissed: true },
    },
    events: [{ id: 8801, course_id: 303, title: "Midterm review session", start_at: iso(base, 11, 17, 0), end_at: iso(base, 11, 18, 30), all_day: false }],
    plannerExtras: [
      {
        plannable_type: "wiki_page", plannable_id: 77, course_id: 202,
        plannable: { id: 77, title: "Week 8 Reading: Chapter 9", todo_date: iso(base, 7, 9, 0), created_at: upd, updated_at: upd },
        plannable_date: iso(base, 7, 9, 0), html_url: "/courses/202/pages/week-8-reading-chapter-9",
      },
      {
        plannable_type: "planner_note", plannable_id: 12,
        plannable: { id: 12, title: "Email advisor about spring classes", todo_date: iso(base, 2, 12, 0), details: "", user_id: 42, course_id: null, created_at: upd, updated_at: upd },
        plannable_date: iso(base, 2, 12, 0), html_url: "/api/v1/planner_notes/12",
      },
      {
        plannable_type: "announcement", plannable_id: 6001, course_id: 303,
        plannable: { id: 6001, title: "Midterm room change", created_at: iso(base, -1, 9, 0), updated_at: iso(base, -1, 9, 0) },
        plannable_date: iso(base, -1, 9, 0), html_url: "/courses/303/discussion_topics/6001",
      },
      {
        plannable_type: "assessment_request", plannable_id: 4401, course_id: 202,
        plannable: { id: 4401, title: "Essay 2: Social Stratification", todo_date: iso(base, 11), workflow_state: "assigned", created_at: upd, updated_at: upd },
        plannable_date: iso(base, 11), html_url: "/courses/202/assignments/2001/submissions/77",
      },
      {
        // Canvas sometimes sends an item whose object it could not render.
        plannable_type: "discussion_topic", plannable_id: 7003, course_id: 202,
        plannable: null,
        plannable_date: iso(base, 10, 12, 0), html_url: "/courses/202/discussion_topics/7003",
      },
    ],
  };
}

export function plannerItemsFor(f: Fixtures, origin: string): unknown[] {
  const items: unknown[] = [];
  const override = (type: string, plannableId: number, key: string) => {
    const ov = f.overrides[key];
    return ov
      ? { id: ov.id, plannable_type: type, plannable_id: plannableId, user_id: f.user.id, marked_complete: ov.marked_complete, dismissed: ov.dismissed, workflow_state: "active" }
      : null;
  };
  for (const a of f.assignments) {
    if (!a.due_at) continue; // the planner lists dated work only
    const quiz = a.quiz_id ? f.quizzes.find((q) => q.id === a.quiz_id) : undefined;
    const type = quiz ? "quiz" : a.discussion_topic ? "discussion_topic" : "assignment";
    const plannableId = quiz ? quiz.id : a.discussion_topic ? a.discussion_topic.id : a.id;
    const sub = a.submission ?? { workflow_state: "unsubmitted", submitted_at: null, score: null, late: false, missing: false, excused: false };
    const ov = f.overrides[`${type}:${plannableId}`] ? `${type}:${plannableId}` : `assignment:${a.id}`;
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
      planner_override: override(type, plannableId, ov),
      new_activity: false,
    });
  }
  for (const e of f.events) {
    items.push({
      context_type: "Course",
      course_id: e.course_id,
      plannable_id: e.id,
      plannable_type: "calendar_event",
      plannable: { id: e.id, title: e.title, start_at: e.start_at, end_at: e.end_at, all_day: e.all_day },
      plannable_date: e.start_at,
      html_url: `/calendar?event_id=${e.id}&include_contexts=course_${e.course_id}`,
      submissions: false,
      planner_override: null,
      new_activity: false,
    });
  }
  for (const x of f.plannerExtras) {
    items.push({
      context_type: x.course_id ? "Course" : "User",
      ...(x.course_id ? { course_id: x.course_id } : {}),
      plannable_id: x.plannable_id,
      plannable_type: x.plannable_type,
      plannable: x.plannable,
      plannable_date: x.plannable_date,
      html_url: x.html_url,
      submissions: false,
      planner_override: override(x.plannable_type, x.plannable_id, `${x.plannable_type}:${x.plannable_id}`),
      new_activity: false,
    });
  }
  return items;
}

/** What `missing_submissions` returns: past-due unsubmitted assignments, with the planner marks when asked for. */
export function missingSubmissionsFor(f: Fixtures, includePlannerOverrides: boolean): unknown[] {
  return f.assignments
    .filter((x) => x.submission?.missing)
    .map((x) => {
      const { submission: _submission, locked_for_user: _locked, lock_explanation: _why, ...a } = x;
      const out: Record<string, unknown> = { ...a, course: f.courses.find((c) => c.id === x.course_id) };
      if (includePlannerOverrides) {
        const ov = f.overrides[`assignment:${x.id}`];
        out["planner_override"] = ov ? { id: ov.id, plannable_type: "assignment", plannable_id: x.id, marked_complete: ov.marked_complete, dismissed: ov.dismissed } : null;
      }
      return out;
    });
}

/** RFC 5545 folding at 75 octets of UTF-8, between code points, as Canvas's icalendar library does. */
function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

/**
 * The student's calendar feed as Canvas writes it: assignments due at 23:59
 * (in Canvas's zone, here UTC) are all-day `VALUE=DATE` events without DTEND,
 * other dues are instants, URLs point at the calendar page with
 * `#assignment_N`, and long lines are folded.
 */
export function feedFor(f: Fixtures, origin: string): string {
  const fmt = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const calendarUrl = (courseId: number, at: string, anchor: string) =>
    `${origin}/calendar?include_contexts=course_${courseId}&month=${at.slice(5, 7)}&year=${at.slice(0, 4)}#${anchor}`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Instructure//Canvas//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Sam Student Calendar (Canvas)"];
  for (const a of f.assignments) {
    if (!a.due_at) continue;
    const course = f.courses.find((c) => c.id === a.course_id)!;
    lines.push("BEGIN:VEVENT");
    lines.push(`DTSTAMP:${fmt(a.updated_at)}`);
    if (a.due_at.slice(11, 16) === "23:59") {
      lines.push(`DTSTART;VALUE=DATE:${a.due_at.slice(0, 10).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART:${fmt(a.due_at)}`);
      lines.push(`DTEND:${fmt(a.due_at)}`);
    }
    lines.push(`UID:event-assignment-${a.id}`);
    lines.push(`SUMMARY:${esc(`${a.name} [${course.course_code}]`)}`);
    if (!a.locked_for_user) lines.push(`DESCRIPTION:${esc(a.description.replace(/<[^>]+>/g, ""))}`);
    lines.push(`URL;VALUE=URI:${calendarUrl(a.course_id, a.due_at, `assignment_${a.id}`)}`);
    lines.push("END:VEVENT");
  }
  for (const e of f.events) {
    const course = f.courses.find((c) => c.id === e.course_id)!;
    lines.push("BEGIN:VEVENT");
    lines.push(`DTSTAMP:${fmt(e.start_at)}`);
    lines.push(`DTSTART:${fmt(e.start_at)}`);
    lines.push(`DTEND:${fmt(e.end_at)}`);
    lines.push(`UID:event-calendar-event-${e.id}`);
    lines.push(`SUMMARY:${esc(`${e.title} [${course.course_code}]`)}`);
    lines.push(`URL;VALUE=URI:${calendarUrl(e.course_id, e.start_at, `calendar_event_${e.id}`)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
