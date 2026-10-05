/**
 * The cold-start estimate: how long a piece of work takes, from what Canvas
 * tells us about it. Hours, log-normal, p50 and p80. Deliberately legible so a
 * wrong estimate can be traced to a rule.
 */
import type { WorkItem } from "../types.js";
import { extractQuantities, type Quantities } from "../text.js";

export interface HeuristicResult {
  p50Hours: number;
  p80Hours: number;
  /** Log-space spread used for p80; calibration narrows it. */
  sigma: number;
  confidence: "low" | "medium" | "high";
  reasoning: string;
  steps: string[];
  features: Record<string, number | string | boolean>;
}

export interface HeuristicContext {
  /** Median points of graded items in the same course, if known. */
  coursePointsMedian?: number | undefined;
}

const Z80 = 0.8416;

type Shape =
  | "exam"
  | "project"
  | "presentation"
  | "lab"
  | "paper"
  | "reading"
  | "problem_set"
  | "discussion"
  | "quiz"
  | "reflection"
  | "generic";

/**
 * First match wins, title before description. Modifiers come before the nouns
 * they modify: "Final Project" is a project, "Final Paper" a paper, "Problem
 * Set 4: Regression Analysis" a problem set, "Exam review problems" a problem
 * set, "Chapter 1 Pre-test" a quiz. "Final"/"midterm" make an exam only on
 * their own or before exam/test; "test" counts only as its own word, never in
 * "pre-test", "unit test" or "test cases".
 */
const EXAM_RE =
  /\b(?:mid-?terms?\b(?!\s*(?:review|prep|study|guide|paper|project|essay|report))|finals?\b(?=\s*(?:exams?|examinations?|tests?|$|[:\-–(,\d]))|exam(?:ination)?s?\b(?!\s*(?:review|prep|preparation|study|guide|practice|wrapper|corrections?))|(?<!(?:pre|post|unit|practice|pilot)[\s-]?)test\b(?![\s-]*(?:cases?|data|suites?|plans?|bench|drivers?|files?|runs?|harness|prep|review)))/i;

const SHAPE_RULES: Array<[Shape, RegExp]> = [
  ["project", /\b(?:project|capstone|portfolio|prototype)\b/i],
  ["presentation", /\b(?:presentation|slides|pitch|talk)\b/i],
  ["lab", /\b(?:lab(?:oratory)? report|lab\s*#?\d|practical)\b/i],
  ["problem_set", /\b(?:problem sets?|problems|psets?|exercises|worksheets?|practice (?:problems|exams?|tests?|sets?|questions)|review (?:sheet|packet|problems|questions)|study guide)\b/i],
  ["paper", /\b(?:essay|paper|report|literature review|analysis|thesis|memo|case study|research)\b/i],
  ["reflection", /\b(?:reflection|journal|response|reaction)\b/i],
  ["exam", EXAM_RE],
  ["quiz", /\b(?:quiz(?:zes)?|pre-?test|post-?test|check-?in|knowledge check|self-?assessment)\b/i],
  ["reading", /\b(?:read(?:ing)?|chapter|ch\.?\s*\d|textbook|article)\b/i],
  ["problem_set", /\b(?:homework|hw|assignment\s*#?\d)\b/i],
  ["discussion", /\b(?:discussion|forum|post|reply)\b/i],
];

const BASE_HOURS: Record<Shape, number> = {
  exam: 6,
  project: 8,
  presentation: 3,
  lab: 3,
  paper: 3,
  reflection: 1,
  reading: 1.5,
  problem_set: 2.5,
  discussion: 1,
  quiz: 1,
  generic: 2,
};

/** Hours per required reply to classmates in a discussion. */
const HOURS_PER_REPLY = 0.3;
/** Most a rubric can stretch an estimate that had no quantities to size it. */
const RUBRIC_CAP = 1.3;
/** Review before a timed quiz: short ones, and ones of an hour or more. */
const QUIZ_REVIEW_HOURS = 0.5;
const LONG_QUIZ_MINUTES = 60;
const LONG_QUIZ_REVIEW_HOURS = 2;

function detectShape(item: WorkItem): Shape {
  const title = item.title;
  const head = (item.descriptionText ?? "").slice(0, 400);
  if (item.kind === "quiz") return "quiz";
  if (item.kind === "discussion") return "discussion";
  for (const [shape, re] of SHAPE_RULES) if (re.test(title)) return shape;
  for (const [shape, re] of SHAPE_RULES) if (re.test(head)) return shape;
  return "generic";
}

function pointsFactor(points: number | undefined, median: number | undefined): number {
  if (points === undefined || points <= 0) return 1;
  const ref = median && median > 0 ? median : 20;
  const f = Math.pow(points / ref, 0.35);
  return Math.min(2.5, Math.max(0.5, f));
}

const REPLY_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const REPLY_RES = [
  /\b(?:reply|respond|comment)(?:\s+(?:to|on))?\s+(?:at least\s+|a minimum of\s+)?(\d{1,2}|a|an|one|another|two|three|four|five|six)\s+(?:(?:of\s+)?(?:your\s+)?(?:other\s+)?)(?:classmates?|peers?|others|students?|posts?)\b/i,
  /\b(\d{1,2}|one|two|three|four|five|six)\s+(?:peer\s+|substantive\s+|substantial\s+|thoughtful\s+)?(?:replies|responses to (?:classmates|peers)|comments on)\b/i,
];

/** How many replies to classmates a discussion asks for, when it says. */
export function requiredReplies(text: string): number | undefined {
  for (const re of REPLY_RES) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const n = REPLY_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    if (Number.isInteger(n) && n > 0 && n <= 10) return n;
  }
  return undefined;
}

interface Sizing {
  hours?: number;
  /** "high" when sized by words, pages, chapters, problems, questions or a Canvas time limit; "medium" for a duration the brief states. */
  confidence?: "high" | "medium";
  why: string[];
}

function sizeFromRecord(shape: Shape, q: Quantities, item: WorkItem, pf: number, ctx: HeuristicContext): Sizing {
  const why: string[] = [];
  let hours: number | undefined;
  let confidence: Sizing["confidence"];
  // A project's pages or words are its write-up, not the project: see `projectWriteUp`.
  const writing = shape === "paper" || shape === "reflection" || shape === "lab";
  if (q.words && shape !== "project") {
    hours = (q.words / 250) * 0.6 + 0.5;
    why.push(`${q.words} words ≈ ${hours.toFixed(1)}h at 250 words per 36 min plus setup`);
  } else if (q.pages && writing) {
    hours = q.pages * 1.0 + 0.5;
    why.push(`${q.pages} written page(s) ≈ ${hours.toFixed(1)}h at an hour per page`);
  } else if (q.pages && shape === "reading") {
    hours = q.pages * 0.1 + 0.25;
    why.push(`${q.pages} page(s) of reading ≈ ${hours.toFixed(1)}h at 6 min per page`);
  } else if (q.chapters && shape === "reading") {
    hours = q.chapters * 1.5;
    why.push(`${q.chapters} chapter(s) ≈ ${hours.toFixed(1)}h at 90 min each`);
  }
  if (hours !== undefined) confidence = "high";
  if (q.problems && shape !== "quiz") {
    const h = q.problems * 0.3 + 0.25;
    hours = hours ? hours + h : h;
    confidence = "high";
    why.push(`${q.problems} problem(s) ≈ ${h.toFixed(1)}h at 18 min each`);
  }
  if (shape === "quiz") {
    const canvasLimit = item.quiz?.timeLimitMinutes;
    const tl = canvasLimit ?? q.minutes;
    const qc = item.quiz?.questionCount ?? q.questions;
    const examLike = EXAM_RE.test(item.title);
    let review = QUIZ_REVIEW_HOURS;
    let reviewWhy = "30 min review";
    if (examLike) {
      review = BASE_HOURS.exam * pf;
      reviewWhy = `exam prep ${review.toFixed(1)}h (an exam taken as a quiz: base ${BASE_HOURS.exam}h × ${pf.toFixed(2)} for ${item.pointsPossible ?? "unknown"} points vs course median ${ctx.coursePointsMedian ?? 20})`;
    } else if (tl !== undefined && tl >= LONG_QUIZ_MINUTES) {
      review = LONG_QUIZ_REVIEW_HOURS;
      reviewWhy = `${LONG_QUIZ_REVIEW_HOURS}h review (a timed quiz of an hour or more is studied for like a test)`;
    }
    if (tl) {
      hours = tl / 60 + review;
      confidence = canvasLimit && !examLike ? "high" : "medium";
      why.push(`time limit ${tl} min${canvasLimit ? "" : " (stated in the brief)"} plus ${reviewWhy}`);
    } else if (qc) {
      hours = (qc * 2.5) / 60 + review;
      confidence = examLike ? "medium" : "high";
      why.push(`${qc} question(s) at 2.5 min plus ${reviewWhy}`);
    } else if (examLike) {
      hours = review;
      confidence = "medium";
      why.push(reviewWhy);
    }
  }
  if (q.minutes && hours === undefined && shape !== "quiz" && shape !== "exam") {
    hours = q.minutes / 60;
    confidence = "medium";
    why.push(`the brief states ${q.minutes} minutes`);
  }
  const out: Sizing = { why };
  if (hours !== undefined) out.hours = hours;
  if (confidence) out.confidence = confidence;
  return out;
}

/** Hours for a project's written part, which comes on top of the build. */
function projectWriteUp(q: Quantities): { hours: number; why: string } | undefined {
  if (q.words) {
    const h = (q.words / 250) * 0.6 + 0.5;
    return { hours: h, why: `a ${q.words}-word write-up adds ${h.toFixed(1)}h` };
  }
  if (q.pages) {
    const h = q.pages * 1.0 + 0.5;
    return { hours: h, why: `a ${q.pages}-page write-up adds ${h.toFixed(1)}h at an hour per page` };
  }
  return undefined;
}

export function heuristicEstimate(item: WorkItem, ctx: HeuristicContext = {}): HeuristicResult {
  const shape = detectShape(item);
  const text = `${item.title}\n${item.descriptionText ?? ""}`;
  const q = extractQuantities(text);
  const why: string[] = [`looks like ${shape.replace("_", " ")}`];
  const features: Record<string, number | string | boolean> = { shape };
  const pf = pointsFactor(item.pointsPossible, ctx.coursePointsMedian);
  features["pointsFactor"] = Number(pf.toFixed(2));

  let hours: number;
  let confidence: HeuristicResult["confidence"];
  const sized = sizeFromRecord(shape, q, item, pf, ctx);
  if (sized.hours !== undefined) {
    // Sized by the record itself: points, rubric size and brief length no longer scale it.
    hours = sized.hours;
    confidence = sized.confidence ?? "medium";
    why.push(...sized.why);
  } else {
    hours = BASE_HOURS[shape];
    confidence = shape === "generic" ? "low" : "medium";
    why.push(`nothing in the brief sizes it, base ${hours}h for this kind`);
    if (pf !== 1) {
      hours *= pf;
      why.push(`${item.pointsPossible} points vs course median ${ctx.coursePointsMedian ?? 20}: ×${pf.toFixed(2)}`);
    }
    const writeUp = shape === "project" ? projectWriteUp(q) : undefined;
    if (writeUp) {
      hours += writeUp.hours;
      why.push(writeUp.why);
    }
    if (shape === "exam" && q.minutes) {
      hours += q.minutes / 60;
      why.push(`plus the ${q.minutes}-minute sitting`);
    }
    if (item.rubricCriteria && item.rubricCriteria > 3) {
      const raw = 1 + 0.1 * (item.rubricCriteria - 3);
      const f = Math.min(RUBRIC_CAP, raw);
      hours *= f;
      why.push(`${item.rubricCriteria} rubric criteria: ×${f.toFixed(2)}${raw > RUBRIC_CAP ? " (capped)" : ""}`);
    }
    if (item.descriptionChars && item.descriptionChars > 2500) {
      hours *= 1.2;
      why.push("long brief: ×1.2");
    }
  }

  if (q.sources && (shape === "paper" || shape === "reflection" || shape === "project" || shape === "lab")) {
    // Sources add reading time but do not say how big the piece is: confidence stays where it was.
    const h = q.sources * 0.4;
    hours += h;
    why.push(`${q.sources} source(s) add ${h.toFixed(1)}h of reading`);
  }
  if (item.peerReviews) {
    hours += 0.5;
    why.push("peer review adds 30 min");
  }
  if (item.isGroup) {
    hours *= 1.1;
    why.push("group work: ×1.10 for coordination");
  }
  if (item.kind === "discussion" || shape === "discussion") {
    const replies = requiredReplies(text);
    if (replies) {
      hours += replies * HOURS_PER_REPLY;
      why.push(`${replies} required repl${replies === 1 ? "y" : "ies"} add ${(replies * HOURS_PER_REPLY).toFixed(1)}h at 18 min each`);
      features["replies"] = replies;
    }
  }

  hours = Math.max(0.25, hours);
  const sigma = confidence === "high" ? 0.45 : confidence === "medium" ? 0.6 : 0.8;
  const p80 = hours * Math.exp(Z80 * sigma);
  Object.assign(features, q);

  const steps = defaultSteps(shape);
  return {
    p50Hours: round(hours),
    p80Hours: round(p80),
    sigma,
    confidence,
    reasoning: why.join("; "),
    steps,
    features,
  };
}

function defaultSteps(shape: Shape): string[] {
  switch (shape) {
    case "paper":
      return ["read the prompt and rubric", "gather sources and notes", "outline", "draft", "revise and cite", "submit"];
    case "problem_set":
      return ["review the relevant notes", "work the problems", "check answers", "write up and submit"];
    case "reading":
      return ["read", "take notes on key points"];
    case "quiz":
      return ["review notes", "take the quiz"];
    case "discussion":
      return ["read the prompt and any required material", "write the post", "reply to classmates"];
    case "exam":
      return ["collect topics", "review notes and problems", "practice under time", "final pass on weak spots"];
    case "project":
      return ["clarify scope", "plan milestones", "build", "test or review", "write up", "submit"];
    case "presentation":
      return ["outline the story", "make slides", "rehearse"];
    case "lab":
      return ["organise data", "analysis", "write the report"];
    case "reflection":
      return ["re-read the material", "write"];
    default:
      return ["read the brief", "do the work", "check and submit"];
  }
}

function round(h: number): number {
  return Math.round(h * 4) / 4;
}
