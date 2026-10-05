/** Small text helpers: HTML to text, quantity extraction, hashing. */
import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Longest HTML read; anything after it is dropped before any regex runs. */
export const HTML_MAX_CHARS = 200_000;

/** Drops `<tag ...> ... </tag>` blocks in one linear pass; an unclosed block runs to the end. */
function dropBlocks(s: string, tag: string): string {
  const open = new RegExp(`<${tag}`, "gi");
  const close = new RegExp(`</${tag}`, "gi");
  let out = "";
  let i = 0;
  for (;;) {
    open.lastIndex = i;
    const start = open.exec(s);
    if (!start) return out + s.slice(i);
    out += s.slice(i, start.index) + " ";
    close.lastIndex = open.lastIndex;
    const end = close.exec(s);
    if (!end) return out;
    const gt = s.indexOf(">", close.lastIndex);
    if (gt < 0) return out;
    i = gt + 1;
  }
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html.length > HTML_MAX_CHARS ? html.slice(0, HTML_MAX_CHARS) : html;
  s = dropBlocks(dropBlocks(s, "script"), "style");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n");
  s = s.replace(/<li\b[^<>]*>/gi, "• ");
  s = s.replace(/<[^<>]*>/g, " ");
  s = s.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,8}|[a-z]{1,32});/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export interface Quantities {
  pages?: number;
  words?: number;
  problems?: number;
  questions?: number;
  /** A duration stated as effort or a time limit ("a 90-minute exam", "takes about 2 hours"), never a window ("within 48 hours"). */
  minutes?: number;
  chapters?: number;
  sources?: number;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};
const WORDS = Object.keys(WORD_NUMBERS).join("|");

/**
 * A count: an integer, optionally with thousands separators ("1,500", "1.500"),
 * or a number word. Never part of a larger number: "2.3" and "4.12" are section
 * numbers, not counts.
 */
const COUNT = `(?<![\\d.,])(\\d{1,3}(?:[.,]\\d{3})+|\\d{1,5}|\\b(?:${WORDS})\\b)(?![.,]?\\d)`;
/** "4-5", "two to three", "1,000–1,500": the upper bound counts. */
const COUNT_RANGE = `${COUNT}(?:\\s*\\(\\d{1,5}\\))?(?:\\s*(?:-|–|—|to)\\s*${COUNT})?`;
const BETWEEN_COUNT_AND_UNIT = `[\\s-]*(?:(?:double|single|1\\.5)[- ]spaced[\\s,-]*|(?:full|typed|written|complete|additional|separate|scholarly|academic)\\s+)?`;

function toCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const w = WORD_NUMBERS[raw.toLowerCase()];
  if (w !== undefined) return w;
  const n = Number(raw.replace(/[.,]/g, ""));
  return Number.isInteger(n) ? n : undefined;
}

/** "N unit" with N a count (or a range of counts, upper bound). */
function countBeforeUnit(t: string, unit: string): number | undefined {
  const m = new RegExp(`${COUNT_RANGE}${BETWEEN_COUNT_AND_UNIT}${unit}\\b`, "i").exec(t);
  if (!m) return undefined;
  return toCount(m[2] ?? m[1]);
}

const LIST_ITEM = `\\d{1,4}(?:\\.\\d{1,3})?(?:\\s*(?:-|–|—|to|through|thru)\\s*\\d{1,4}(?:\\.\\d{1,3})?)?`;
const LIST = `${LIST_ITEM}(?:\\s*(?:,\\s*and\\b|,|;|&|\\band\\b)\\s*${LIST_ITEM})*`;

/** Size of one list item: "7" -> 1, "3-5" -> 3, "3.1-3.15" -> 15. Undefined when it cannot be counted. */
function itemSize(raw: string): number | undefined {
  const m = /^(\d{1,4})(?:\.(\d{1,3}))?(?:\s*(?:-|–|—|to|through|thru)\s*(\d{1,4})(?:\.(\d{1,3}))?)?$/.exec(raw.trim());
  if (!m) return undefined;
  if (m[3] === undefined) return 1;
  const [a, aSub, b, bSub] = [Number(m[1]), m[2], Number(m[3]), m[4]];
  // Dotted ranges count within one section: 3.1-3.15, or 3.1-15.
  if (aSub !== undefined && bSub !== undefined) return a === b && Number(bSub) >= Number(aSub) ? Number(bSub) - Number(aSub) + 1 : undefined;
  if (aSub !== undefined) return b >= Number(aSub) ? b - Number(aSub) + 1 : undefined;
  if (bSub !== undefined) return undefined;
  return b >= a ? b - a + 1 : undefined;
}

/** "chapters 3 and 9" -> 2, "chapters 4-6" -> 3, "exercises 1-15 odd" -> 8. `minItems` 2 skips bare references ("page 5"). */
function unitBeforeList(t: string, unit: string, minItems: number): number | undefined {
  const m = new RegExp(`\\b${unit}\\s*(?:#|nos?\\.?\\s*)?(${LIST})(\\s*\\(?\\s*(?:odd|even)\\b)?`, "i").exec(t);
  if (!m || !m[1]) return undefined;
  const parts = m[1].split(/\s*(?:,\s*and\b|,|;|&|\band\b)\s*/i).filter(Boolean);
  let total = 0;
  for (const p of parts) {
    const n = itemSize(p);
    if (n === undefined) return undefined;
    total += n;
  }
  const isRange = parts.length > 1 || /[-–—]|to|thr/i.test(m[1]);
  if (parts.length < minItems && !isRange) return undefined;
  if (m[2]) total = Math.ceil(total / 2); // odd or even ones only
  return total > 0 ? total : undefined;
}

const DUR_NUM = `(?<![\\d.,])(\\d{1,3}(?:\\.\\d{1,2})?|\\b(?:${WORDS}|an?|half an?)\\b)(?![.,]?\\d)`;
const DUR_RANGE = `${DUR_NUM}(?:\\s*(?:-|–|—|to|or)\\s*${DUR_NUM})?`;
const DUR_UNIT = `(minutes?|mins?\\.?|hours?|hrs?\\.?)`;
/** Phrasings that state how long the work (or the sitting) takes. */
const EFFORT_PATTERNS: RegExp[] = [
  // "a 90-minute exam", "two-hour lab"
  new RegExp(`${DUR_RANGE}\\s*-\\s*(minute|min|hour|hr)\\b`, "i"),
  // "time limit of 60 minutes", "timed: 45 minutes"
  new RegExp(`\\b(?:time limit|timed|time allowed|allotted time)(?:\\s*(?:of|is|:|=))?\\s*(?:about\\s+)?${DUR_RANGE}\\s*${DUR_UNIT}`, "i"),
  // "45 minutes time limit", "60 minutes, timed"
  new RegExp(`${DUR_RANGE}\\s*${DUR_UNIT}\\s*,?\\s*(?:time limit|timed|limit)\\b`, "i"),
  // "takes about 2 hours", "plan for 3 hours", "approximately 30 minutes"
  new RegExp(
    `\\b(?:takes?|taking|should take|will take|expect(?:ed)? to (?:take|spend)|spend|plan (?:on|for)|allow|allot|budget|set aside|requires?|lasts?|duration(?:\\s*(?:of|is|:))?|length(?:\\s*(?:of|is|:))?|estimated(?: time)?(?:\\s*(?:of|is|:))?|approximately|approx\\.?|about|around|roughly|~)\\s*(?:about\\s+|around\\s+|approximately\\s+|roughly\\s+)?${DUR_RANGE}\\s*${DUR_UNIT}`,
    "i",
  ),
  // "the exam is 2 hours long"
  new RegExp(`${DUR_RANGE}\\s*${DUR_UNIT}\\s+(?:long|in length)\\b`, "i"),
  // "you have 30 minutes", "you will have 2 hours"
  new RegExp(`\\byou(?:'ll| will)?\\s+(?:have|get)\\s+${DUR_RANGE}\\s*${DUR_UNIT}`, "i"),
];
/** Words just before a duration that make it a window or a rate, not effort. */
const WINDOW_BEFORE = /\b(?:within|after|before|late|per|each|every|up to|available|open|no later than|in advance|by|prior|at least|over|last|first)\s*$/i;
/** Words just after a duration that make it a window or a rate. */
const WINDOW_AFTER = /^\s*(?:before|after|prior|late|in advance|ahead|of (?:the )?(?:deadline|due date|class|lecture)|notice|window|from|following|later|per|each|a (?:day|week)|every|to (?:submit|post|turn in))\b/i;
/** A stated duration longer than this is a window to submit in, not the work. */
export const MAX_STATED_EFFORT_MINUTES = 360;

function durationNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const r = raw.toLowerCase();
  if (r === "a" || r === "an") return 1;
  if (r.startsWith("half")) return 0.5;
  const w = WORD_NUMBERS[r];
  if (w !== undefined) return w;
  const n = Number(r);
  return Number.isFinite(n) ? n : undefined;
}

function statedEffortMinutes(t: string): number | undefined {
  for (const re of EFFORT_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const before = t.slice(Math.max(0, m.index - 25), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (WINDOW_BEFORE.test(before) || WINDOW_AFTER.test(after)) continue;
    const value = durationNumber(m[2] ?? m[1]);
    const unit = (m[3] ?? "").toLowerCase();
    if (value === undefined || !(value > 0)) continue;
    const minutes = /^h/.test(unit) ? value * 60 : value;
    if (minutes > MAX_STATED_EFFORT_MINUTES) continue;
    return Math.round(minutes);
  }
  return undefined;
}

function plausible(n: number | undefined, lo: number, hi: number): number | undefined {
  return n !== undefined && n >= lo && n <= hi ? n : undefined;
}

/**
 * Pulls sizing quantities out of an assignment description: "3 pages",
 * "1500 words", "10 problems", "exercises 1-15", "25 questions", "chapters 4-6",
 * "5 sources", and a duration when it is phrased as effort or a time limit
 * ("a 90-minute exam", "takes about 2 hours"). Ranges take their upper bound
 * ("2-3 pages" -> 3); lists count their items ("chapters 3 and 9" -> 2). Only
 * whole numbers count, so "Section 2.3" or "4.12" are never quantities. Word
 * numbers up to thirty are read.
 */
export function extractQuantities(text: string): Quantities {
  const q: Quantities = {};
  const t = text.replace(/\s+/g, " ");
  const pageUnit = "(?:pages?|pp\\.?|pgs?\\.?)";
  const problemUnit = "(?:problems?|exercises?|probs?\\.?)";
  const questionUnit = "(?:questions?)";
  const pages = plausible(countBeforeUnit(t, pageUnit) ?? unitBeforeList(t, pageUnit, 2), 1, 1000);
  if (pages) q.pages = pages;
  const words = plausible(countBeforeUnit(t, "(?:words?)"), 20, 50_000);
  if (words) q.words = words;
  const problems = plausible(countBeforeUnit(t, problemUnit) ?? unitBeforeList(t, problemUnit, 2), 1, 300);
  if (problems) q.problems = problems;
  const questions = plausible(countBeforeUnit(t, "(?:questions?|items|multiple[- ]choice)") ?? unitBeforeList(t, questionUnit, 2), 1, 500);
  if (questions) q.questions = questions;
  const minutes = statedEffortMinutes(t);
  if (minutes) q.minutes = minutes;
  const sources = plausible(countBeforeUnit(t, "(?:sources|references|citations|articles|peer[- ]reviewed)"), 1, 100);
  if (sources) q.sources = sources;
  const chapters = plausible(unitBeforeList(t, "(?:chapters?|chs?\\.)", 1), 1, 40);
  if (chapters) q.chapters = chapters;
  return q;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function shortHash(s: string): string {
  return sha256(s).slice(0, 16);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
