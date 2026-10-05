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
  minutes?: number;
  chapters?: number;
  sources?: number;
}

const NUM = "(\\d{1,4}(?:[.,]\\d{1,3})?)";
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

function toNumber(raw: string): number | undefined {
  const w = WORD_NUMBERS[raw.toLowerCase()];
  if (w !== undefined) return w;
  const n = Number(raw.replace(",", ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pulls "3 pages", "1500 words", "10 problems", "25 questions", "45 minutes",
 * "chapters 4-6", "5 sources" out of an assignment description. Ranges take
 * their upper bound ("2-3 pages" -> 3). Word numbers up to thirty are read.
 */
export function extractQuantities(text: string): Quantities {
  const q: Quantities = {};
  const t = text.replace(/\s+/g, " ");
  const numOrWord = `(${NUM}|${Object.keys(WORD_NUMBERS).join("|")})`;
  const range = `${numOrWord}(?:\\s*(?:-|–|to)\\s*${numOrWord})?`;
  const grab = (unit: string): number | undefined => {
    const re = new RegExp(`\\b${range}[\\s-]*(?:double[- ]spaced[\\s,-]*|single[- ]spaced[\\s,-]*)?${unit}\\b`, "i");
    const m = t.match(re);
    if (!m) return undefined;
    const hi = m[4] ?? m[1];
    return hi ? toNumber(hi) : undefined;
  };
  const pages = grab("(?:pages?|pp\\.?|pgs?)");
  if (pages) q.pages = pages;
  const words = grab("(?:words?)");
  if (words) q.words = words;
  const problems = grab("(?:problems?|exercises?|prob\\.?)");
  if (problems) q.problems = problems;
  const questions = grab("(?:questions?|items|multiple[- ]choice)");
  if (questions) q.questions = questions;
  const minutes = grab("(?:minutes?|mins?)");
  if (minutes) q.minutes = minutes;
  const hours = grab("(?:hours?|hrs?)");
  if (hours && !q.minutes) q.minutes = hours * 60;
  const sources = grab("(?:sources|references|citations|peer[- ]reviewed)");
  if (sources) q.sources = sources;
  const ch = t.match(/\bchapters?\s*(\d{1,3})(?:\s*(?:-|–|to|and|&)\s*(\d{1,3}))?/i);
  if (ch) {
    const a = Number(ch[1]);
    const b = ch[2] ? Number(ch[2]) : a;
    q.chapters = Math.max(1, Math.abs(b - a) + 1);
  }
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
