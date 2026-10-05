/**
 * A small iCalendar reader for Canvas calendar feeds and a writer for the
 * planned-blocks feed. Only what Canvas emits is handled: VEVENT with
 * DTSTART/DTEND/DTSTAMP, SUMMARY, DESCRIPTION, UID, URL, LOCATION, and
 * line folding per RFC 5545.
 */
import type { WorkItem } from "./types.js";
import { htmlToText } from "./text.js";

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  url?: string;
  start?: string;
  end?: string;
  allDay: boolean;
  location?: string;
  raw: Record<string, string>;
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

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
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

/** Parses an iCalendar date or date-time. Floating times are treated as UTC. */
export function parseIcsDate(value: string, params: Record<string, string>): { iso: string; allDay: boolean } | undefined {
  const v = value.trim();
  if (params["VALUE"] === "DATE" || /^\d{8}$/.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return undefined;
    return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`, allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}.000Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return { iso: d.toISOString(), allDay: false };
}

export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;
  let curParams: Record<string, Record<string, string>> = {};
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      curParams = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const start = cur["DTSTART"] ? parseIcsDate(cur["DTSTART"], curParams["DTSTART"] ?? {}) : undefined;
        const end = cur["DTEND"] ? parseIcsDate(cur["DTEND"], curParams["DTEND"] ?? {}) : undefined;
        const ev: IcsEvent = {
          uid: cur["UID"] ?? "",
          summary: unescapeText(cur["SUMMARY"] ?? ""),
          allDay: start?.allDay ?? false,
          raw: cur,
        };
        if (cur["DESCRIPTION"]) ev.description = unescapeText(cur["DESCRIPTION"]);
        if (cur["URL"]) ev.url = cur["URL"];
        if (cur["LOCATION"]) ev.location = unescapeText(cur["LOCATION"]);
        if (start) ev.start = start.iso;
        if (end) ev.end = end.iso;
        events.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    if (!name) continue;
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    const key = name.toUpperCase();
    cur[key] = value;
    curParams[key] = params;
  }
  return events;
}

/**
 * Canvas UIDs look like `event-assignment-123`, `event-calendar-event-45`,
 * `event-assignment-override-78` and summaries like `Homework 3 [CHEM 101]`.
 */
export function canvasFeedEventToItem(ev: IcsEvent, nowIso: string, host?: string): WorkItem | undefined {
  const uid = ev.uid;
  let canvasType = "calendar_event";
  let canvasId: string | undefined;
  let m = uid.match(/^event-assignment(?:-override)?-(\d+)/);
  if (m) {
    canvasType = "assignment";
    canvasId = m[1];
  } else if ((m = uid.match(/^event-calendar-event-(\d+)/))) {
    canvasType = "calendar_event";
    canvasId = m[1];
  } else if ((m = uid.match(/^event-(?:planner-note|note)-(\d+)/))) {
    canvasType = "planner_note";
    canvasId = m[1];
  } else {
    canvasId = uid || undefined;
  }
  const titleMatch = ev.summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  const title = (titleMatch?.[1] ?? ev.summary).trim();
  const courseCode = titleMatch?.[2]?.trim();
  const kind = canvasType === "assignment" ? "assignment" : canvasType === "planner_note" ? "note" : "event";
  const idType = canvasType === "calendar_event" ? "event" : canvasType === "planner_note" ? "note" : canvasType;
  const item: WorkItem = {
    id: `canvas:${idType}:${canvasId ?? uid}`,
    source: "feed",
    canvasType,
    kind,
    title: title || "(untitled)",
    status: "open",
    updatedAt: nowIso,
  };
  if (host) item.host = host;
  if (canvasId) item.canvasId = canvasId;
  if (courseCode) item.courseCode = courseCode;
  const url = safeHttpUrl(ev.url);
  if (url) item.url = url;
  if (ev.start) item.dueAt = ev.start;
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

function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    // Never split a surrogate pair across the fold.
    const cut = /[\ud800-\udbff]/.test(rest[72]!) ? 72 : 73;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function writeIcs(calendarName: string, events: IcsWriteEvent[], nowIso = new Date().toISOString()): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//canvas-agent//planned study blocks//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
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
