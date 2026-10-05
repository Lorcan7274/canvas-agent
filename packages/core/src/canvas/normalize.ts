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
/** The key is there and Canvas sent null: the value was removed, not merely left out of this view. */
const isNull = (r: Raw | undefined, k: string): boolean => r !== undefined && Object.hasOwn(r, k) && r[k] === null;

/** The title of an item Canvas sent without one. `mergeItem` never lets it replace a real title. */
export const UNTITLED = "(untitled)";

/** Fields a source may clear: everything except identity, kind, title, status and updatedAt. */
export type ClearableField = Exclude<keyof WorkItem, "id" | "source" | "kind" | "title" | "status" | "updatedAt">;

const CLEARED = Symbol("canvas-agent.cleared");
type Marked = WorkItem & { [CLEARED]?: ClearableField[] };

/**
 * Fields this incoming item says were cleared in Canvas (`due_at: null` and
 * the like), so `mergeItem` deletes them instead of keeping the stored value.
 * Carried on a symbol key: object spread keeps it, JSON never stores it.
 */
export function clearedFields(item: WorkItem): readonly ClearableField[] {
  return (item as Marked)[CLEARED] ?? [];
}

/** Removes `keys` from the item and records them as cleared. */
function clear(item: WorkItem, keys: ClearableField[]): void {
  if (!keys.length) return;
  const m = item as Marked;
  for (const k of keys) delete m[k];
  m[CLEARED] = [...new Set([...(m[CLEARED] ?? []), ...keys])];
}

/** A copy without the cleared-fields mark, for storing or merging. */
export function withoutClearedMark(item: WorkItem): WorkItem {
  const out = { ...item } as Marked;
  delete out[CLEARED];
  return out;
}

/** Canvas withholds the description (and sometimes more) of an assignment that is still locked for the student. */
export function lockedForUser(raw: unknown): boolean {
  return obj(raw)?.["locked_for_user"] === true;
}

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

/** Planner types we know. Anything else Canvas adds later (e.g. `sub_assignment` checkpoints) is kept as "other". */
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

/**
 * Ids carry no host (B7, deferred): two Canvas instances with colliding ids
 * (dual enrolment, or a school's `*.beta.` / `*.test.` copy, which reuses the
 * production ids) land on the same row. The extension must not register those
 * copies, and a student should connect one instance per id space.
 */
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
  if (!type) return undefined;
  const known = Object.hasOwn(KIND_BY_PLANNABLE, type) ? KIND_BY_PLANNABLE[type] : undefined;
  if (known === null) return undefined; // announcements: not work
  const kind: ItemKind = known ?? "other";
  const p = obj(r["plannable"]) ?? {};
  const canvasId = str(r["plannable_id"]) ?? str(p["id"]);
  if (!canvasId) return undefined;
  // Only work graded through an assignment is keyed by it; a peer review or a checkpoint is its own task.
  const graded = kind === "assignment" || kind === "quiz" || kind === "discussion";
  const assignmentId = graded ? (str(p["assignment_id"]) ?? (kind === "assignment" ? canvasId : undefined)) : undefined;
  const courseId = str(r["course_id"]) ?? str(p["course_id"]);
  const course = courseId ? ctx.courses.get(courseId) : undefined;
  const { status, late } = statusFromSubmissions(obj(r["submissions"]), obj(r["planner_override"]) ?? undefined);
  const dueAt =
    str(p["due_at"]) ?? str(p["todo_date"]) ?? (kind === "event" ? str(p["start_at"]) : undefined) ?? str(r["plannable_date"]);
  const title = str(p["title"]) ?? str(p["name"]);
  const item: WorkItem = {
    id: itemIdFor(kind, canvasId, assignmentId),
    source: "canvas",
    host: hostOf(ctx.baseUrl),
    canvasType: type,
    canvasId,
    kind,
    title: title ?? UNTITLED,
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
  const cleared: ClearableField[] = [];
  if (dueAt) item.dueAt = dueAt;
  else if (isNull(p, "due_at") || isNull(p, "todo_date")) cleared.push("dueAt");
  if (kind === "event") {
    const end = str(p["end_at"]);
    if (end) item.endAt = end;
    else if (isNull(p, "end_at")) cleared.push("endAt");
    const allDay = bool(p["all_day"]);
    if (allDay !== undefined) item.allDay = allDay;
  }
  const unlock = str(p["unlock_at"]);
  const lock = str(p["lock_at"]);
  if (unlock) item.unlockAt = unlock;
  else if (isNull(p, "unlock_at")) cleared.push("unlockAt");
  if (lock) item.lockAt = lock;
  else if (isNull(p, "lock_at")) cleared.push("lockAt");
  const points = num(p["points_possible"]);
  if (points !== undefined) item.pointsPossible = points;
  else if (isNull(p, "points_possible")) cleared.push("pointsPossible");
  const override = obj(r["planner_override"]);
  if (override) {
    const mc = bool(override["marked_complete"]);
    const dm = bool(override["dismissed"]);
    if (mc !== undefined) item.markedComplete = mc;
    if (dm !== undefined) item.dismissed = dm;
  } else if (isNull(r, "planner_override")) {
    cleared.push("markedComplete", "dismissed");
  }
  clear(item, cleared);
  return item;
}

/**
 * Merges a full Assignment object into an item (or builds one from it).
 * Keys Canvas sent as null clear the field; keys it left out keep it. While
 * the assignment is locked for the student the description is withheld, so
 * it is neither read nor cleared.
 */
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
    title: str(a["name"]) ?? UNTITLED,
    status: "open",
    updatedAt: ctx.now,
  };
  const item: WorkItem = { ...base, kind, assignmentId };
  delete (item as Marked)[CLEARED];
  const cleared: ClearableField[] = [];
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
  else if (isNull(a, "due_at")) cleared.push("dueAt");
  const unlock = str(a["unlock_at"]);
  const lock = str(a["lock_at"]);
  if (unlock) item.unlockAt = unlock;
  else if (isNull(a, "unlock_at")) cleared.push("unlockAt");
  if (lock) item.lockAt = lock;
  else if (isNull(a, "lock_at")) cleared.push("lockAt");
  const points = num(a["points_possible"]);
  if (points !== undefined) item.pointsPossible = points;
  else if (isNull(a, "points_possible")) cleared.push("pointsPossible");
  const types = Array.isArray(a["submission_types"]) ? (a["submission_types"] as unknown[]).map(String) : undefined;
  if (types) item.submissionTypes = types;
  const attempts = num(a["allowed_attempts"]);
  if (attempts !== undefined) item.allowedAttempts = attempts;
  else if (isNull(a, "allowed_attempts")) cleared.push("allowedAttempts");
  if (!lockedForUser(a) && Object.hasOwn(a, "description")) {
    const text = htmlToText(str(a["description"]));
    if (text) {
      item.descriptionText = text;
      item.descriptionChars = text.length;
    } else {
      cleared.push("descriptionText", "descriptionChars");
    }
  }
  const rubric = Array.isArray(a["rubric"]) ? (a["rubric"] as unknown[]).length : undefined;
  if (rubric !== undefined) item.rubricCriteria = rubric;
  const peer = bool(a["peer_reviews"]);
  if (peer !== undefined) item.peerReviews = peer;
  // Booleans only from fields Canvas actually sent; a thinner object says nothing about them.
  if (Object.hasOwn(a, "group_category_id")) item.isGroup = a["group_category_id"] !== null && a["group_category_id"] !== undefined;
  const externalTag = obj(a["external_tool_tag_attributes"]) !== undefined;
  if (types || externalTag) item.isExternalTool = types?.includes("external_tool") === true || externalTag;
  const updated = str(a["updated_at"]);
  if (updated) item.updatedAt = updated;
  const sub = obj(a["submission"]);
  if (sub) {
    const submittedAt = str(sub["submitted_at"]);
    if (submittedAt) item.submittedAt = submittedAt;
    else if (isNull(sub, "submitted_at")) cleared.push("submittedAt");
    const score = num(sub["score"]);
    if (score !== undefined) item.score = score;
    else if (isNull(sub, "score")) cleared.push("score");
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
  // Missing submissions carry the student's planner marks (include[]=planner_overrides); they win over the submission state.
  const override = obj(a["planner_override"]);
  if (override) {
    const mc = bool(override["marked_complete"]);
    const dm = bool(override["dismissed"]);
    if (mc !== undefined) item.markedComplete = mc;
    if (dm !== undefined) item.dismissed = dm;
    if (dm === true) item.status = "dismissed";
    else if (mc === true) item.status = "done";
  }
  clear(item, cleared);
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
  else if (isNull(q, "time_limit")) delete facts.timeLimitMinutes; // the limit was removed
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
