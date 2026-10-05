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

const SHAPE_RULES: Array<[Shape, RegExp]> = [
  ["exam", /\b(final|midterm|exam|test)\b(?!\s*(?:case|data|prep sheet))/i],
  ["project", /\b(project|capstone|portfolio|prototype)\b/i],
  ["presentation", /\b(presentation|slides|pitch|talk)\b/i],
  ["lab", /\b(lab(?:oratory)? report|lab\s*\d|practical)\b/i],
  ["paper", /\b(essay|paper|report|literature review|analysis|thesis|memo|case study|research)\b/i],
  ["reflection", /\b(reflection|journal|response|reaction)\b/i],
  ["reading", /\b(read(?:ing)?|chapter|ch\.?\s*\d|textbook|article)\b/i],
  ["problem_set", /\b(problem set|homework|hw|pset|exercises|worksheet|assignment\s*\d|practice)\b/i],
  ["discussion", /\b(discussion|forum|post|reply)\b/i],
  ["quiz", /\b(quiz|check-?in|knowledge check)\b/i],
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

function fromQuantities(shape: Shape, q: Quantities, item: WorkItem): { hours?: number; why: string[] } {
  const why: string[] = [];
  let hours: number | undefined;
  const writing = shape === "paper" || shape === "reflection" || shape === "project" || shape === "lab";
  if (q.words) {
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
  if (q.problems) {
    const h = q.problems * 0.3 + 0.25;
    hours = hours ? hours + h : h;
    why.push(`${q.problems} problem(s) ≈ ${h.toFixed(1)}h at 18 min each`);
  }
  if (q.sources && writing) {
    const h = q.sources * 0.4;
    hours = (hours ?? BASE_HOURS[shape]) + h;
    why.push(`${q.sources} source(s) add ${h.toFixed(1)}h of reading`);
  }
  if (shape === "quiz") {
    const tl = item.quiz?.timeLimitMinutes;
    const qc = item.quiz?.questionCount ?? q.questions;
    if (tl) {
      hours = tl / 60 + 0.5;
      why.push(`time limit ${tl} min plus 30 min review`);
    } else if (qc) {
      hours = (qc * 2.5) / 60 + 0.5;
      why.push(`${qc} question(s) at 2.5 min plus 30 min review`);
    }
  }
  if (q.minutes && !hours && shape !== "quiz") {
    hours = q.minutes / 60;
    why.push(`description states ${q.minutes} minutes`);
  }
  return hours !== undefined ? { hours, why } : { why };
}

export function heuristicEstimate(item: WorkItem, ctx: HeuristicContext = {}): HeuristicResult {
  const shape = detectShape(item);
  const text = `${item.title}\n${item.descriptionText ?? ""}`;
  const q = extractQuantities(text);
  const why: string[] = [`looks like ${shape.replace("_", " ")}`];
  const features: Record<string, number | string | boolean> = { shape };

  let hours: number;
  let confidence: HeuristicResult["confidence"] = "low";
  const fq = fromQuantities(shape, q, item);
  if (fq.hours !== undefined) {
    hours = fq.hours;
    confidence = "high";
    why.push(...fq.why);
  } else {
    hours = BASE_HOURS[shape];
    confidence = shape === "generic" ? "low" : "medium";
    why.push(`no quantities in the description, base ${hours}h for this kind`);
  }

  const pf = pointsFactor(item.pointsPossible, ctx.coursePointsMedian);
  if (pf !== 1 && fq.hours === undefined) {
    hours *= pf;
    why.push(`${item.pointsPossible} points vs course median ${ctx.coursePointsMedian ?? 20}: ×${pf.toFixed(2)}`);
  }
  features["pointsFactor"] = Number(pf.toFixed(2));

  if (item.rubricCriteria && item.rubricCriteria > 3) {
    const f = 1 + 0.1 * (item.rubricCriteria - 3);
    hours *= f;
    why.push(`${item.rubricCriteria} rubric criteria: ×${f.toFixed(2)}`);
  }
  if (item.peerReviews) {
    hours += 0.5;
    why.push("peer review adds 30 min");
  }
  if (item.isGroup) {
    hours *= 1.1;
    why.push("group work: ×1.10 for coordination");
  }
  if (item.kind === "discussion") {
    const replies = text.match(/\b(\w+|\d+)\s+(?:replies|responses|peers?|classmates)/i);
    if (replies) why.push("replies to classmates included");
  }
  if (item.descriptionChars && item.descriptionChars > 2500 && fq.hours === undefined) {
    hours *= 1.2;
    why.push("long brief: ×1.2");
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
