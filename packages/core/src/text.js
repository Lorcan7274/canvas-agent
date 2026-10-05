/** Small text helpers: HTML to text, quantity extraction, hashing. */
import { createHash } from "node:crypto";
const ENTITIES = {
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
export function htmlToText(html) {
    if (!html)
        return "";
    let s = html;
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n");
    s = s.replace(/<li[^>]*>/gi, "• ");
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
        if (code[0] === "#") {
            const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : m;
        }
        return ENTITIES[code.toLowerCase()] ?? m;
    });
    s = s.replace(/[ \t\f\v]+/g, " ");
    s = s.replace(/ *\n */g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
}
export function truncate(s, max) {
    if (s.length <= max)
        return s;
    return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
const NUM = "(\\d{1,4}(?:[.,]\\d{1,3})?)";
const WORD_NUMBERS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};
function toNumber(raw) {
    const w = WORD_NUMBERS[raw.toLowerCase()];
    if (w !== undefined)
        return w;
    const n = Number(raw.replace(",", ""));
    return Number.isFinite(n) ? n : undefined;
}
/**
 * Pulls "3 pages", "1500 words", "10 problems", "25 questions", "45 minutes",
 * "chapters 4-6", "5 sources" out of an assignment description. Ranges take
 * their upper bound ("2-3 pages" -> 3). Word numbers up to thirty are read.
 */
export function extractQuantities(text) {
    const q = {};
    const t = text.replace(/\s+/g, " ");
    const numOrWord = `(${NUM}|${Object.keys(WORD_NUMBERS).join("|")})`;
    const range = `${numOrWord}(?:\\s*(?:-|–|to)\\s*${numOrWord})?`;
    const grab = (unit) => {
        const re = new RegExp(`\\b${range}[\\s-]*(?:double[- ]spaced[\\s,-]*|single[- ]spaced[\\s,-]*)?${unit}\\b`, "i");
        const m = t.match(re);
        if (!m)
            return undefined;
        const hi = m[4] ?? m[1];
        return hi ? toNumber(hi) : undefined;
    };
    const pages = grab("(?:pages?|pp\\.?|pgs?)");
    if (pages)
        q.pages = pages;
    const words = grab("(?:words?)");
    if (words)
        q.words = words;
    const problems = grab("(?:problems?|exercises?|prob\\.?)");
    if (problems)
        q.problems = problems;
    const questions = grab("(?:questions?|items|multiple[- ]choice)");
    if (questions)
        q.questions = questions;
    const minutes = grab("(?:minutes?|mins?)");
    if (minutes)
        q.minutes = minutes;
    const hours = grab("(?:hours?|hrs?)");
    if (hours && !q.minutes)
        q.minutes = hours * 60;
    const sources = grab("(?:sources|references|citations|peer[- ]reviewed)");
    if (sources)
        q.sources = sources;
    const ch = t.match(/\bchapters?\s*(\d{1,3})(?:\s*(?:-|–|to|and|&)\s*(\d{1,3}))?/i);
    if (ch) {
        const a = Number(ch[1]);
        const b = ch[2] ? Number(ch[2]) : a;
        q.chapters = Math.max(1, Math.abs(b - a) + 1);
    }
    return q;
}
export function sha256(s) {
    return createHash("sha256").update(s).digest("hex");
}
export function shortHash(s) {
    return sha256(s).slice(0, 16);
}
export function slugify(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
//# sourceMappingURL=text.js.map