/**
 * A small iCalendar reader for Canvas calendar feeds and a writer for the
 * planned-blocks feed. Only what Canvas emits is handled: VEVENT with
 * DTSTART/DTEND/DTSTAMP, SUMMARY, DESCRIPTION, UID, URL, LOCATION, and
 * line folding per RFC 5545 (75 octets, continuation lines start with a space).
 *
 * Times: `...Z` is UTC; `TZID=` is honoured when it names an IANA zone; a
 * floating time is read in the calendar's X-WR-TIMEZONE, else the zone the
 * caller passes (the student's), else UTC. A DATE value (`VALUE=DATE`) keeps
 * its calendar date: Canvas writes assignments due at 23:59 as all-day
 * events, and `canvasFeedEventToItem` turns them back into 23:59 local.
 */
import type { ItemKind, WorkItem } from "./types.js";
import { htmlToText, shortHash } from "./text.js";
import { isValidTimeZone, zonedTimeToUtc } from "./tz.js";
import { UNTITLED } from "./canvas/normalize.js";

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  url?: string;
  /** ISO instant. For a DATE value: midnight of that date in the parse zone. */
  start?: string;
  end?: string;
  /** `YYYY-MM-DD` when DTSTART is a DATE value (an all-day event). */
  startDate?: string;
  /** `YYYY-MM-DD` when DTEND is a DATE value; exclusive, as RFC 5545 says. */
  endDate?: string;
  allDay: boolean;
  location?: string;
  /** LAST-MODIFIED, else DTSTAMP, as an ISO instant. */
  stamp?: string;
  raw: Record<string, string>;
}

export interface IcsParseOptions {
  /** Zone for floating times and DATE values when the calendar names none. Default UTC. */
  timeZone?: string;
}

function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** One pass, so `\\n` stays a backslash followed by "n" (`C:\new`), not a newline. */
function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

export function escapeText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** An http(s) URL in canonical form (the URL parser drops CR, LF and tabs), or undefined. */
export function safeHttpUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function zoneOr(tz: string | undefined, fallback: string): string {
  const z = tz?.trim().replace(/^"(.*)"$/, "$1");
  return z && isValidTimeZone(z) ? z : fallback;
}

function validDate(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Parses an iCalendar date or date-time. `date` is set for a DATE value.
 * Floating times and DATE values are read in `defaultTimeZone` (UTC unless given).
 */
export function parseIcsDate(value: string, params: Record<string, string>, defaultTimeZone = "UTC"): { iso: string; allDay: boolean; date?: string } | undefined {
  const v = value.trim();
  const fallback = zoneOr(defaultTimeZone, "UTC");
  if (params["VALUE"] === "DATE" || /^\d{8}$/.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return undefined;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDate(y, mo, d)) return undefined;
    return { iso: zonedTimeToUtc(y, mo, d, 0, 0, fallback).toISOString(), allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || sec > 60) return undefined;
  const ms = m[7] ? Date.UTC(y, mo - 1, d, h, mi, sec) : zonedTimeToUtc(y, mo, d, h, mi, zoneOr(params["TZID"], fallback)).getTime() + sec * 1000;
  return { iso: new Date(ms).toISOString(), allDay: false };
}

export function parseIcs(text: string, opts: IcsParseOptions = {}): IcsEvent[] {
  const events: IcsEvent[] = [];
  let zone = zoneOr(opts.timeZone, "UTC");
  let cur: Record<string, string> | null = null;
  let curParams: Record<string, Record<string, string>> = {};
  /** Components inside a VEVENT (VALARM): their properties are not the event's. */
  let nested = 0;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      curParams = {};
      nested = 0;
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const date = (k: string) => (cur![k] ? parseIcsDate(cur![k], curParams[k] ?? {}, zone) : undefined);
        const start = date("DTSTART");
        const end = date("DTEND");
        const stamp = date("LAST-MODIFIED") ?? date("DTSTAMP");
        const ev: IcsEvent = {
          uid: (cur["UID"] ?? "").trim(),
          summary: unescapeText(cur["SUMMARY"] ?? ""),
          allDay: start?.allDay ?? false,
          raw: cur,
        };
        if (cur["DESCRIPTION"]) ev.description = unescapeText(cur["DESCRIPTION"]);
        if (cur["URL"]) ev.url = cur["URL"];
        if (cur["LOCATION"]) ev.location = unescapeText(cur["LOCATION"]);
        if (start) ev.start = start.iso;
        if (end) ev.end = end.iso;
        if (start?.date) ev.startDate = start.date;
        if (end?.date) ev.endDate = end.date;
        if (stamp && !stamp.allDay) ev.stamp = stamp.iso;
        events.push(ev);
      }
      cur = null;
      continue;
    }
    if (cur && line.startsWith("BEGIN:")) {
      nested++;
      continue;
    }
    if (cur && line.startsWith("END:")) {
      nested = Math.max(0, nested - 1);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    if (!name) continue;
    const key = name.toUpperCase();
    if (!cur) {
      // Calendar level: the zone its floating times are written in.
      if (key === "X-WR-TIMEZONE") zone = zoneOr(value, zone);
      continue;
    }
    if (nested) continue;
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    cur[key] = value;
    curParams[key] = params;
  }
  return events;
}

/** `YYYY-MM-DD` at a wall-clock time in `tz`, as an ISO instant. */
function atLocal(date: string, hour: number, minute: number, tz: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return zonedTimeToUtc(y ?? 1970, m ?? 1, d ?? 1, hour, minute, tz).toISOString();
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

/**
 * Canvas UIDs look like `event-assignment-123`, `event-calendar-event-45`,
 * `event-assignment-override-78` and summaries like `Homework 3 [CHEM 101]`.
 *
 * An override UID carries the override's id, not the assignment's; the
 * assignment id comes from the URL's `#assignment_<id>` when Canvas gives
 * one, else the row is keyed by the override. A date-only due date (Canvas
 * writes 23:59 dues that way) becomes 23:59 in `timezone`, the student's zone.
 * An event without a UID gets a stable id from its summary and start.
 */
export function canvasFeedEventToItem(ev: IcsEvent, nowIso: string, host?: string, timezone = "UTC"): WorkItem | undefined {
  const tz = zoneOr(timezone, "UTC");
  const uid = ev.uid || `nouid-${shortHash(`${ev.summary}|${ev.startDate ?? ev.start ?? ""}`)}`;
  const fromUrl = ev.url?.match(/#assignment_(\d+)\s*$/)?.[1];
  let canvasType = "calendar_event";
  let kind: ItemKind = "event";
  let id: string;
  let canvasId: string;
  let m: RegExpMatchArray | null;
  if ((m = uid.match(/^event-assignment-override-(\d+)/))) {
    kind = "assignment";
    if (fromUrl) {
      canvasType = "assignment";
      canvasId = fromUrl;
      id = `canvas:assignment:${fromUrl}`;
    } else {
      canvasType = "assignment_override";
      canvasId = m[1]!;
      id = `canvas:event:override-${m[1]}`;
    }
  } else if ((m = uid.match(/^event-assignment-(\d+)/))) {
    canvasType = "assignment";
    kind = "assignment";
    canvasId = m[1]!;
    id = `canvas:assignment:${canvasId}`;
  } else if ((m = uid.match(/^event-calendar-event-(\d+)/))) {
    canvasId = m[1]!;
    id = `canvas:event:${canvasId}`;
  } else if ((m = uid.match(/^event-(?:planner-note|note)-(\d+)/))) {
    canvasType = "planner_note";
    kind = "note";
    canvasId = m[1]!;
    id = `canvas:note:${canvasId}`;
  } else {
    canvasId = uid;
    id = `canvas:event:${uid}`;
  }
  const titleMatch = ev.summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  const title = (titleMatch?.[1] ?? ev.summary).trim();
  const courseCode = titleMatch?.[2]?.trim();
  const item: WorkItem = {
    id,
    source: "feed",
    canvasType,
    canvasId,
    kind,
    title: title || UNTITLED,
    status: "open",
    updatedAt: ev.stamp ?? nowIso,
  };
  if (host) item.host = host;
  if (courseCode) item.courseCode = courseCode;
  const url = safeHttpUrl(ev.url);
  if (url) item.url = url;
  if (ev.startDate) {
    // All day: a due date means "by the end of that day"; an event spans its days.
    item.dueAt = kind === "event" ? atLocal(ev.startDate, 0, 0, tz) : atLocal(ev.startDate, 23, 59, tz);
    if (kind === "event") {
      item.endAt = atLocal(ev.endDate && ev.endDate > ev.startDate ? ev.endDate : nextDay(ev.startDate), 0, 0, tz);
      item.allDay = true;
    }
  } else if (ev.start) {
    item.dueAt = ev.start;
    if (kind === "event" && ev.end && ev.end > ev.start) item.endAt = ev.end;
    if (kind === "event") item.allDay = false;
  }
  if (ev.description) {
    const text = htmlToText(ev.description);
    if (text) {
      item.descriptionText = text;
      item.descriptionChars = text.length;
    }
  }
  return item;
}

export interface IcsWriteEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
  description?: string;
  url?: string;
}

function fmtUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** RFC 5545 folding: at most 75 octets of UTF-8 per line, cut only between code points. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = utf8Length(ch);
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

export function writeIcs(calendarName: string, events: IcsWriteEvent[], nowIso = new Date().toISOString()): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//canvas-agent//planned study blocks//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold(`X-WR-CALNAME:${escapeText(calendarName)}`),
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(fold(`UID:${escapeText(e.uid)}`));
    lines.push(`DTSTAMP:${fmtUtc(nowIso)}`);
    lines.push(`DTSTART:${fmtUtc(e.start)}`);
    lines.push(`DTEND:${fmtUtc(e.end)}`);
    lines.push(fold(`SUMMARY:${escapeText(e.summary)}`));
    if (e.description) lines.push(fold(`DESCRIPTION:${escapeText(e.description)}`));
    const url = safeHttpUrl(e.url);
    if (url) lines.push(fold(`URL:${url}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
