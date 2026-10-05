import { htmlToText } from "./text.js";
function unfold(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const out = [];
    for (const line of lines) {
        if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
            out[out.length - 1] += line.slice(1);
        }
        else {
            out.push(line);
        }
    }
    return out;
}
function unescapeText(v) {
    return v
        .replace(/\\n/gi, "\n")
        .replace(/\\,/g, ",")
        .replace(/\\;/g, ";")
        .replace(/\\\\/g, "\\");
}
export function escapeText(v) {
    return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
/** Parses an iCalendar date or date-time. Floating times are treated as UTC. */
export function parseIcsDate(value, params) {
    const v = value.trim();
    if (params["VALUE"] === "DATE" || /^\d{8}$/.test(v)) {
        const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (!m)
            return undefined;
        return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`, allDay: true };
    }
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
    if (!m)
        return undefined;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}.000Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return undefined;
    return { iso: d.toISOString(), allDay: false };
}
export function parseIcs(text) {
    const events = [];
    let cur = null;
    let curParams = {};
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
                const ev = {
                    uid: cur["UID"] ?? "",
                    summary: unescapeText(cur["SUMMARY"] ?? ""),
                    allDay: start?.allDay ?? false,
                    raw: cur,
                };
                if (cur["DESCRIPTION"])
                    ev.description = unescapeText(cur["DESCRIPTION"]);
                if (cur["URL"])
                    ev.url = cur["URL"];
                if (cur["LOCATION"])
                    ev.location = unescapeText(cur["LOCATION"]);
                if (start)
                    ev.start = start.iso;
                if (end)
                    ev.end = end.iso;
                events.push(ev);
            }
            cur = null;
            continue;
        }
        if (!cur)
            continue;
        const idx = line.indexOf(":");
        if (idx < 0)
            continue;
        const head = line.slice(0, idx);
        const value = line.slice(idx + 1);
        const [name, ...paramParts] = head.split(";");
        if (!name)
            continue;
        const params = {};
        for (const p of paramParts) {
            const eq = p.indexOf("=");
            if (eq > 0)
                params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
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
export function canvasFeedEventToItem(ev, nowIso, host) {
    const uid = ev.uid;
    let canvasType = "calendar_event";
    let canvasId;
    let m = uid.match(/^event-assignment(?:-override)?-(\d+)/);
    if (m) {
        canvasType = "assignment";
        canvasId = m[1];
    }
    else if ((m = uid.match(/^event-calendar-event-(\d+)/))) {
        canvasType = "calendar_event";
        canvasId = m[1];
    }
    else if ((m = uid.match(/^event-(?:planner-note|note)-(\d+)/))) {
        canvasType = "planner_note";
        canvasId = m[1];
    }
    else {
        canvasId = uid || undefined;
    }
    const titleMatch = ev.summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    const title = (titleMatch?.[1] ?? ev.summary).trim();
    const courseCode = titleMatch?.[2]?.trim();
    const kind = canvasType === "assignment" ? "assignment" : canvasType === "planner_note" ? "note" : "event";
    const idType = canvasType === "calendar_event" ? "event" : canvasType === "planner_note" ? "note" : canvasType;
    const item = {
        id: `canvas:${idType}:${canvasId ?? uid}`,
        source: "feed",
        canvasType,
        kind,
        title: title || "(untitled)",
        status: "open",
        updatedAt: nowIso,
    };
    if (host)
        item.host = host;
    if (canvasId)
        item.canvasId = canvasId;
    if (courseCode)
        item.courseCode = courseCode;
    if (ev.url)
        item.url = ev.url;
    if (ev.start)
        item.dueAt = ev.start;
    if (ev.description) {
        const text = htmlToText(ev.description);
        if (text) {
            item.descriptionText = text;
            item.descriptionChars = text.length;
        }
    }
    return item;
}
function fmtUtc(iso) {
    return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function fold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 73) {
        out.push(rest.slice(0, 73));
        rest = " " + rest.slice(73);
    }
    out.push(rest);
    return out.join("\r\n");
}
export function writeIcs(calendarName, events, nowIso = new Date().toISOString()) {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//canvas-agent//planned study blocks//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        `X-WR-CALNAME:${escapeText(calendarName)}`,
    ];
    for (const e of events) {
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:${e.uid}`);
        lines.push(`DTSTAMP:${fmtUtc(nowIso)}`);
        lines.push(`DTSTART:${fmtUtc(e.start)}`);
        lines.push(`DTEND:${fmtUtc(e.end)}`);
        lines.push(fold(`SUMMARY:${escapeText(e.summary)}`));
        if (e.description)
            lines.push(fold(`DESCRIPTION:${escapeText(e.description)}`));
        if (e.url)
            lines.push(fold(`URL:${e.url}`));
        lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
}
//# sourceMappingURL=ics.js.map