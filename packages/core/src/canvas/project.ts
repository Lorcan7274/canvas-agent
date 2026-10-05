/**
 * The fields of raw Canvas objects that normalize.ts reads, and nothing else.
 * The extension applies this before a snapshot leaves the browser and the
 * server applies it again before ingesting, so submission bodies, attachments,
 * comments, LTI launch parameters, preview URLs and the like never travel or
 * get stored. Arrays, map sizes and strings are capped.
 *
 * Type imports only: the extension bundles this file.
 */
import type { CanvasSnapshot } from "../types.js";

export const SNAPSHOT_LIMITS = {
  courses: 300,
  plannerItems: 3000,
  missingSubmissions: 1000,
  /** Detail maps (assignments, quizzes), entries. */
  details: 300,
  /** HTML descriptions; htmlToText reads no more than this either. */
  descriptionChars: 200_000,
  /** Every other string: titles, dates, ids, URLs. */
  textChars: 2000,
  submissionTypes: 20,
  rubricCriteria: 200,
} as const;

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : undefined);

function scalar(v: unknown, max: number = SNAPSHOT_LIMITS.textChars): string | number | boolean | null | undefined {
  if (v === null) return null;
  if (typeof v === "string") return v.length > max ? v.slice(0, max) : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  return undefined;
}

function pick(src: Raw, keys: readonly string[], out: Raw = {}): Raw {
  for (const k of keys) {
    const v = scalar(src[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Relative Canvas links, or absolute ones on the snapshot's own origin. Anything else is dropped. */
function sameOriginLink(v: unknown, origin: string): string | undefined {
  if (typeof v !== "string" || !v || v.length > SNAPSHOT_LIMITS.textChars) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return v.startsWith("//") ? undefined : v;
  try {
    return new URL(v).origin === origin ? v : undefined;
  } catch {
    return undefined;
  }
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

export function pickCourse(raw: unknown): Raw | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const out = pick(r, ["id", "name", "course_code"]);
  const term = obj(r["term"]);
  if (term) out["term"] = pick(term, ["name", "end_at"]);
  return out;
}

const PLANNABLE_KEYS = ["id", "assignment_id", "course_id", "due_at", "todo_date", "start_at", "title", "name", "updated_at", "unlock_at", "lock_at", "points_possible"] as const;

export function pickPlannerItem(raw: unknown, origin: string): Raw | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const out = pick(r, ["plannable_type", "plannable_id", "course_id", "plannable_date"]);
  const link = sameOriginLink(r["html_url"], origin);
  if (link) out["html_url"] = link;
  const p = obj(r["plannable"]);
  if (p) {
    const plannable = pick(p, PLANNABLE_KEYS);
    const plink = sameOriginLink(p["html_url"], origin);
    if (plink) plannable["html_url"] = plink;
    out["plannable"] = plannable;
  }
  const subs = obj(r["submissions"]);
  if (subs) out["submissions"] = pick(subs, ["late", "excused", "graded", "submitted", "missing"]);
  const override = obj(r["planner_override"]);
  if (override) out["planner_override"] = pick(override, ["dismissed", "marked_complete"]);
  return out;
}

const ASSIGNMENT_KEYS = [
  "id",
  "course_id",
  "quiz_id",
  "is_quiz_assignment",
  "is_quiz_lti_assignment",
  "name",
  "due_at",
  "unlock_at",
  "lock_at",
  "points_possible",
  "allowed_attempts",
  "peer_reviews",
  "group_category_id",
  "updated_at",
] as const;

export function pickAssignment(raw: unknown, origin: string): Raw | undefined {
  const a = obj(raw);
  if (!a) return undefined;
  const out = pick(a, ASSIGNMENT_KEYS);
  const link = sameOriginLink(a["html_url"], origin);
  if (link) out["html_url"] = link;
  const description = scalar(a["description"], SNAPSHOT_LIMITS.descriptionChars);
  if (typeof description === "string" || description === null) out["description"] = description;
  if (Array.isArray(a["submission_types"])) {
    out["submission_types"] = (a["submission_types"] as unknown[])
      .filter((t): t is string => typeof t === "string")
      .slice(0, SNAPSHOT_LIMITS.submissionTypes)
      .map((t) => t.slice(0, 64));
  }
  // Only the number of criteria is read; their text stays in Canvas.
  if (Array.isArray(a["rubric"])) out["rubric"] = (a["rubric"] as unknown[]).slice(0, SNAPSHOT_LIMITS.rubricCriteria).map(() => ({}));
  // Only presence is read; the topic body and the LTI launch parameters stay in Canvas.
  if (obj(a["discussion_topic"])) out["discussion_topic"] = {};
  if (obj(a["external_tool_tag_attributes"])) out["external_tool_tag_attributes"] = {};
  const sub = obj(a["submission"]);
  if (sub) out["submission"] = pick(sub, ["submitted_at", "score", "late", "workflow_state", "excused", "missing"]);
  const course = pickCourse(a["course"]);
  if (course) out["course"] = course;
  return out;
}

export function pickQuiz(raw: unknown): Raw | undefined {
  const q = obj(raw);
  if (!q) return undefined;
  const out = pick(q, ["time_limit", "question_count", "allowed_attempts", "quiz_type", "points_possible"]);
  const description = scalar(q["description"], SNAPSHOT_LIMITS.descriptionChars);
  if (typeof description === "string" || description === null) out["description"] = description;
  return out;
}

function list(v: unknown, max: number, f: (x: unknown) => Raw | undefined): Raw[] {
  if (!Array.isArray(v)) return [];
  const out: Raw[] = [];
  for (const x of v.slice(0, max)) {
    const p = f(x);
    if (p) out.push(p);
  }
  return out;
}

function detailMap(v: unknown, f: (x: unknown) => Raw | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const m = obj(v);
  if (!m) return out;
  let n = 0;
  for (const [k, x] of Object.entries(m)) {
    if (n >= SNAPSHOT_LIMITS.details) break;
    if (!/^\d{1,20}$/.test(k)) continue; // Canvas ids; also keeps "__proto__" and friends out
    const p = f(x);
    if (!p) continue;
    out[k] = p;
    n++;
  }
  return out;
}

/** A snapshot reduced to what the normaliser reads, with every list and string capped. */
export function projectCanvasSnapshot(snap: CanvasSnapshot): CanvasSnapshot {
  const baseUrl = typeof snap.baseUrl === "string" ? snap.baseUrl.slice(0, SNAPSHOT_LIMITS.textChars) : "";
  const origin = originOf(baseUrl);
  const out: CanvasSnapshot = {
    baseUrl,
    fetchedAt: typeof snap.fetchedAt === "string" ? snap.fetchedAt.slice(0, 40) : "",
    courses: list(snap.courses, SNAPSHOT_LIMITS.courses, pickCourse),
    plannerItems: list(snap.plannerItems, SNAPSHOT_LIMITS.plannerItems, (x) => pickPlannerItem(x, origin)),
  };
  if (snap.missingSubmissions !== undefined) out.missingSubmissions = list(snap.missingSubmissions, SNAPSHOT_LIMITS.missingSubmissions, (x) => pickAssignment(x, origin));
  if (snap.assignments !== undefined) out.assignments = detailMap(snap.assignments, (x) => pickAssignment(x, origin));
  if (snap.quizzes !== undefined) out.quizzes = detailMap(snap.quizzes, pickQuiz);
  return out;
}
