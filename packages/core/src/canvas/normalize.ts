/**
 * Turns raw Canvas JSON (planner items, assignments, quizzes, courses) into
 * WorkItems. The same code runs on a token sync and on an extension snapshot,
 * so both paths produce identical rows.
 */
import type { Course, ItemKind, ItemStatus, WorkItem } from "../types.js";
import { htmlToText } from "../text.js";

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obj = (v: unknown): Raw | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : undefined);

export function normaliseCourse(raw: unknown): Course | undefined {
  const r = obj(raw);
  if (!r || r["id"] === undefined) return undefined;
  const term = obj(r["term"]);
  const c: Course = {
    id: String(r["id"]),
    name: str(r["name"]) ?? str(r["course_code"]) ?? `Course ${String(r["id"])}`,
    code: str(r["course_code"]) ?? str(r["name"]) ?? String(r["id"]),
  };
  const termName = str(term?.["name"]);
  const termEnd = str(term?.["end_at"]);
  if (termName) c.termName = termName;
  if (termEnd) c.termEndsAt = termEnd;
  return c;
}

const KIND_BY_PLANNABLE: Record<string, ItemKind | null> = {
  assignment: "assignment",
  quiz: "quiz",
  discussion_topic: "discussion",
  wiki_page: "page",
  calendar_event: "event",
  planner_note: "note",
  assessment_request: "peer_review",
  announcement: null, // not work
};

const ID_TYPE_BY_KIND: Record<ItemKind, string> = {
  assignment: "assignment",
  quiz: "quiz",
  discussion: "discussion",
  page: "page",
  event: "event",
  note: "note",
  peer_review: "peer_review",
  other: "other",
};

export function itemIdFor(kind: ItemKind, canvasId: string, assignmentId?: string): string {
  if (assignmentId && (kind === "quiz" || kind === "discussion" || kind === "assignment")) {
    return `canvas:assignment:${assignmentId}`;
  }
  return `canvas:${ID_TYPE_BY_KIND[kind]}:${canvasId}`;
}

function statusFromSubmissions(subs: Raw | undefined, override: Raw | undefined): { status: ItemStatus; late?: boolean } {
  if (override?.["dismissed"] === true) return { status: "dismissed" };
  if (override?.["marked_complete"] === true) return { status: "done" };
  if (!subs) return { status: "open" };
  const late = bool(subs["late"]);
  const out: { status: ItemStatus; late?: boolean } = { status: "open" };
  if (late !== undefined) out.late = late;
  if (subs["excused"] === true) out.status = "excused";
  else if (subs["graded"] === true) out.status = "graded";
  else if (subs["submitted"] === true) out.status = "submitted";
  else if (subs["missing"] === true) out.status = "missing";
  return out;
}

export interface NormaliseContext {
  baseUrl: string;
  courses: Map<string, Course>;
  now: string;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function absoluteUrl(baseUrl: string, u: string | undefined): string | undefined {
  if (!u) return undefined;
  if (/^https?:\/\//i.test(u)) return u;
  return baseUrl.replace(/\/$/, "") + (u.startsWith("/") ? u : "/" + u);
}

export function normalisePlannerItem(raw: unknown, ctx: NormaliseContext): WorkItem | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const type = str(r["plannable_type"]) ?? "";
  const kind = KIND_BY_PLANNABLE[type];
  if (kind === null || kind === undefined) return kind === null ? undefined : undefined;
  const p = obj(r["plannable"]) ?? {};
  const canvasId = str(r["plannable_id"]) ?? str(p["id"]);
  if (!canvasId) return undefined;
  const assignmentId = str(p["assignment_id"]) ?? (kind === "assignment" ? canvasId : undefined);
  const courseId = str(r["course_id"]) ?? str(p["course_id"]);
  const course = courseId ? ctx.courses.get(courseId) : undefined;
  const { status, late } = statusFromSubmissions(obj(r["submissions"]), obj(r["planner_override"]) ?? undefined);
  const dueAt =
    str(p["due_at"]) ?? str(p["todo_date"]) ?? (kind === "event" ? str(p["start_at"]) : undefined) ?? str(r["plannable_date"]);
  const item: WorkItem = {
    id: itemIdFor(kind, canvasId, assignmentId),
    source: "canvas",
    host: hostOf(ctx.baseUrl),
    canvasType: type,
    canvasId,
    kind,
    title: str(p["title"]) ?? str(p["name"]) ?? "(untitled)",
    status,
    updatedAt: str(p["updated_at"]) ?? ctx.now,
  };
  if (assignmentId) item.assignmentId = assignmentId;
  if (kind === "quiz") item.quizId = canvasId;
  if (late !== undefined) item.late = late;
  if (courseId) item.courseId = courseId;
  if (course) {
    item.courseCode = course.code;
    item.courseName = course.name;
  }
  const url = absoluteUrl(ctx.baseUrl, str(r["html_url"]) ?? str(p["html_url"]));
  if (url) item.url = url;
  if (dueAt) item.dueAt = dueAt;
  const unlock = str(p["unlock_at"]);
  const lock = str(p["lock_at"]);
  if (unlock) item.unlockAt = unlock;
  if (lock) item.lockAt = lock;
  const points = num(p["points_possible"]);
  if (points !== undefined) item.pointsPossible = points;
  const override = obj(r["planner_override"]);
  if (override) {
    const mc = bool(override["marked_complete"]);
    const dm = bool(override["dismissed"]);
    if (mc !== undefined) item.markedComplete = mc;
    if (dm !== undefined) item.dismissed = dm;
  }
  return item;
}

/** Merges a full Assignment object into an item (or builds one from it). */
export function applyAssignment(raw: unknown, ctx: NormaliseContext, existing?: WorkItem): WorkItem | undefined {
  const a = obj(raw);
  if (!a || a["id"] === undefined) return existing;
  const assignmentId = String(a["id"]);
  const courseId = str(a["course_id"]) ?? existing?.courseId;
  const course = courseId ? ctx.courses.get(courseId) : undefined;
  const quizId = str(a["quiz_id"]);
  const isQuiz = quizId !== undefined || a["is_quiz_assignment"] === true || a["is_quiz_lti_assignment"] === true;
  const isDiscussion = obj(a["discussion_topic"]) !== undefined;
  const kind: ItemKind = existing?.kind && existing.kind !== "assignment" ? existing.kind : isQuiz ? "quiz" : isDiscussion ? "discussion" : "assignment";
  const base: WorkItem = existing ?? {
    id: `canvas:assignment:${assignmentId}`,
    source: "canvas",
    host: hostOf(ctx.baseUrl),
    canvasType: "assignment",
    canvasId: assignmentId,
    kind,
    title: str(a["name"]) ?? "(untitled)",
    status: "open",
    updatedAt: ctx.now,
  };
  const item: WorkItem = { ...base, kind, assignmentId };
  const name = str(a["name"]);
  if (name) item.title = name;
  if (courseId) item.courseId = courseId;
  if (course) {
    item.courseCode = course.code;
    item.courseName = course.name;
  }
  if (quizId) item.quizId = quizId;
  const url = absoluteUrl(ctx.baseUrl, str(a["html_url"]));
  if (url) item.url = url;
  const due = str(a["due_at"]);
  if (due) item.dueAt = due;
  const unlock = str(a["unlock_at"]);
  const lock = str(a["lock_at"]);
  if (unlock) item.unlockAt = unlock;
  if (lock) item.lockAt = lock;
  const points = num(a["points_possible"]);
  if (points !== undefined) item.pointsPossible = points;
  const types = Array.isArray(a["submission_types"]) ? (a["submission_types"] as unknown[]).map(String) : undefined;
  if (types) item.submissionTypes = types;
  const attempts = num(a["allowed_attempts"]);
  if (attempts !== undefined) item.allowedAttempts = attempts;
  const text = htmlToText(str(a["description"]));
  if (text) {
    item.descriptionText = text;
    item.descriptionChars = text.length;
  }
  const rubric = Array.isArray(a["rubric"]) ? (a["rubric"] as unknown[]).length : undefined;
  if (rubric !== undefined) item.rubricCriteria = rubric;
  const peer = bool(a["peer_reviews"]);
  if (peer !== undefined) item.peerReviews = peer;
  item.isGroup = a["group_category_id"] !== null && a["group_category_id"] !== undefined;
  item.isExternalTool = types?.includes("external_tool") === true || obj(a["external_tool_tag_attributes"]) !== undefined;
  const updated = str(a["updated_at"]);
  if (updated) item.updatedAt = updated;
  const sub = obj(a["submission"]);
  if (sub) {
    const submittedAt = str(sub["submitted_at"]);
    if (submittedAt) item.submittedAt = submittedAt;
    const score = num(sub["score"]);
    if (score !== undefined) item.score = score;
    const late = bool(sub["late"]);
    if (late !== undefined) item.late = late;
    const state = str(sub["workflow_state"]);
    if (item.status !== "done" && item.status !== "dismissed") {
      if (sub["excused"] === true) item.status = "excused";
      else if (state === "graded") item.status = "graded";
      else if (state === "submitted" || state === "pending_review" || submittedAt) item.status = "submitted";
      else if (sub["missing"] === true) item.status = "missing";
    }
  }
  return item;
}

export function applyQuiz(raw: unknown, item: WorkItem): WorkItem {
  const q = obj(raw);
  if (!q) return item;
  const out: WorkItem = { ...item, kind: "quiz" };
  const facts = { ...(item.quiz ?? {}) };
  const tl = num(q["time_limit"]);
  const qc = num(q["question_count"]);
  const at = num(q["allowed_attempts"]);
  const qt = str(q["quiz_type"]);
  if (tl !== undefined) facts.timeLimitMinutes = tl;
  if (qc !== undefined) facts.questionCount = qc;
  if (at !== undefined) facts.allowedAttempts = at;
  if (qt) facts.quizType = qt;
  out.quiz = facts;
  const text = htmlToText(str(q["description"]));
  if (text && !out.descriptionText) {
    out.descriptionText = text;
    out.descriptionChars = text.length;
  }
  const points = num(q["points_possible"]);
  if (points !== undefined && out.pointsPossible === undefined) out.pointsPossible = points;
  return out;
}

/** Items that carry nothing a student acts on: dismissed, past events already over. */
export function isActionable(item: WorkItem, nowIso: string): boolean {
  if (item.status === "dismissed") return false;
  if (item.kind === "event" && item.dueAt && item.dueAt < nowIso) return false;
  return true;
}
