import { describe, expect, it } from "vitest";
import { canvasFeedEventToItem, parseIcs, parseIcsDate, writeIcs } from "../src/ics.js";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:event-assignment-1002",
  "DTSTAMP:20261001T100000Z",
  "DTSTART:20261011T235900Z",
  "DTEND:20261011T235900Z",
  "SUMMARY:Lab Report 3: Titration [CHEM 101]",
  "DESCRIPTION:Write a lab report (4-5 pages\\, double-spaced) covering purpose\\,",
  "  method and data.",
  "URL:https://canvas.example.edu/courses/101/assignments/1002",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-calendar-event-8801",
  "DTSTART;VALUE=DATE:20261015",
  "SUMMARY:Reading day",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  it("unfolds lines and unescapes text", () => {
    const [a, b] = parseIcs(FEED);
    expect(a?.uid).toBe("event-assignment-1002");
    expect(a?.description).toBe("Write a lab report (4-5 pages, double-spaced) covering purpose, method and data.");
    expect(a?.start).toBe("2026-10-11T23:59:00.000Z");
    expect(b?.allDay).toBe(true);
    expect(b?.start).toBe("2026-10-15T00:00:00.000Z");
  });
});

describe("canvasFeedEventToItem", () => {
  it("maps assignment UIDs to the shared item id and lifts the course code", () => {
    const [ev] = parseIcs(FEED);
    const item = canvasFeedEventToItem(ev!, "2026-10-05T00:00:00.000Z", "canvas.example.edu")!;
    expect(item.id).toBe("canvas:assignment:1002");
    expect(item.title).toBe("Lab Report 3: Titration");
    expect(item.courseCode).toBe("CHEM 101");
    expect(item.kind).toBe("assignment");
    expect(item.dueAt).toBe("2026-10-11T23:59:00.000Z");
    expect(item.host).toBe("canvas.example.edu");
    expect(item.descriptionText).toContain("4-5 pages");
  });
  it("maps calendar events", () => {
    const [, ev] = parseIcs(FEED);
    const item = canvasFeedEventToItem(ev!, "2026-10-05T00:00:00.000Z")!;
    expect(item.id).toBe("canvas:event:8801");
    expect(item.kind).toBe("event");
  });
});

describe("writeIcs", () => {
  it("round-trips through the parser", () => {
    const text = writeIcs("Study blocks", [
      { uid: "block-1@canvas-agent", start: "2026-10-07T21:00:00.000Z", end: "2026-10-07T22:30:00.000Z", summary: "Study: Essay 2, Social Stratification", description: "Line one\nline two; with, commas" },
    ]);
    const [ev] = parseIcs(text);
    expect(ev?.summary).toBe("Study: Essay 2, Social Stratification");
    expect(ev?.description).toBe("Line one\nline two; with, commas");
    expect(ev?.start).toBe("2026-10-07T21:00:00.000Z");
    expect(ev?.end).toBe("2026-10-07T22:30:00.000Z");
  });
});

describe("ICS safety", () => {
  it("escapes a lone CR so it cannot start a new property", () => {
    const ics = writeIcs("x", [{ uid: "u1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", summary: "a\rX-INJECTED:1", description: "b\rATTENDEE:mailto:x@y" }]);
    expect(ics).not.toMatch(/\r(?!\n)/);
    expect(ics.split("\r\n").some((l) => l.startsWith("X-INJECTED") || l.startsWith("ATTENDEE"))).toBe(false);
  });
  it("writes only http(s) URLs, canonicalised so CR/LF cannot inject lines", () => {
    const bad = writeIcs("x", [{ uid: "u1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", summary: "s", url: "javascript:alert(1)" }]);
    expect(bad).not.toContain("URL:");
    const crlf = writeIcs("x", [{ uid: "u1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", summary: "s", url: "https://canvas.example.edu/a\r\nX-INJECTED:1" }]);
    expect(crlf.split("\r\n").some((l) => l.startsWith("X-INJECTED"))).toBe(false);
  });
  it("ignores non-http URLs in a Canvas feed", () => {
    const [ev] = parseIcs(FEED.replace("URL:https://canvas.example.edu/courses/101/assignments/1002", "URL:javascript:alert(1)"));
    expect(canvasFeedEventToItem(ev!, "2026-10-01T00:00:00Z")?.url).toBeUndefined();
  });
  it("never splits a surrogate pair when folding", () => {
    const ics = writeIcs("x", [{ uid: "u1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", summary: "a".repeat(63) + "😀".repeat(20) }]);
    for (const line of ics.split("\r\n")) expect(line).not.toMatch(/[\ud800-\udbff]$|^ ?[\udc00-\udfff]/);
  });
});

const cal = (...events: string[][]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

describe("all-day dues (B1)", () => {
  const ics = cal(["UID:event-assignment-1001", "DTSTAMP:20261002T100000Z", "DTSTART;VALUE=DATE:20261010", "SUMMARY:PS 5 [CHEM 101]", "URL;VALUE=URI:https://canvas.example.edu/calendar?include_contexts=course_101&month=10&year=2026#assignment_1001"]);
  it("flags a DATE value and keeps its calendar date", () => {
    const [ev] = parseIcs(ics);
    expect(ev).toMatchObject({ allDay: true, startDate: "2026-10-10", start: "2026-10-10T00:00:00.000Z", stamp: "2026-10-02T10:00:00.000Z" });
    expect(parseIcsDate("20261010", { VALUE: "DATE" })).toEqual({ iso: "2026-10-10T00:00:00.000Z", allDay: true, date: "2026-10-10" });
    expect(parseIcsDate("20261345", { VALUE: "DATE" })).toBeUndefined();
  });
  it("reads a date-only due as 23:59 in the student's zone, and DTSTAMP as the change time", () => {
    const [ev] = parseIcs(ics, { timeZone: "America/New_York" });
    const item = canvasFeedEventToItem(ev!, "2026-10-05T00:00:00.000Z", "canvas.example.edu", "America/New_York")!;
    expect(item.dueAt).toBe("2026-10-11T03:59:00.000Z");
    expect(item.updatedAt).toBe("2026-10-02T10:00:00.000Z");
    expect(item.id).toBe("canvas:assignment:1001");
    expect(canvasFeedEventToItem(ev!, "2026-10-05T00:00:00.000Z", undefined, "Asia/Tokyo")!.dueAt).toBe("2026-10-10T14:59:00.000Z");
    expect(canvasFeedEventToItem(ev!, "2026-10-05T00:00:00.000Z", undefined, "Not/AZone")!.dueAt).toBe("2026-10-10T23:59:00.000Z");
  });
  it("gives calendar events an end: DTEND, or the next midnight for an all-day one", () => {
    const [timed, allDay, span] = parseIcs(
      cal(
        ["UID:event-calendar-event-8801", "DTSTART:20261016T170000Z", "DTEND:20261016T183000Z", "SUMMARY:Review"],
        ["UID:event-calendar-event-8802", "DTSTART;VALUE=DATE:20261020", "SUMMARY:Reading day"],
        ["UID:event-calendar-event-8803", "DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261023", "SUMMARY:Field trip"],
      ),
    );
    expect(canvasFeedEventToItem(timed!, "x")).toMatchObject({ kind: "event", dueAt: "2026-10-16T17:00:00.000Z", endAt: "2026-10-16T18:30:00.000Z", allDay: false });
    expect(canvasFeedEventToItem(allDay!, "x", undefined, "America/New_York")).toMatchObject({ dueAt: "2026-10-20T04:00:00.000Z", endAt: "2026-10-21T04:00:00.000Z", allDay: true });
    expect(canvasFeedEventToItem(span!, "x")).toMatchObject({ dueAt: "2026-10-21T00:00:00.000Z", endAt: "2026-10-23T00:00:00.000Z" });
  });
});

describe("ICS reading details (B9)", () => {
  it("unescapes in one pass, so an escaped backslash before n stays", () => {
    const [ev] = parseIcs(cal(["UID:u1", "SUMMARY:Path C:\\\\new\\, then\\nnext\\Nline\;"]));
    expect(ev?.summary).toBe("Path C:\\new, then\nnext\nline;");
  });
  it("honours TZID, X-WR-TIMEZONE and the caller's zone for floating times", () => {
    const [tzid] = parseIcs(cal(["UID:u1", "DTSTART;TZID=America/New_York:20261010T090000", "SUMMARY:a"]));
    expect(tzid?.start).toBe("2026-10-10T13:00:00.000Z");
    const [quoted] = parseIcs(cal(["UID:u1", 'DTSTART;TZID="Europe/London":20261010T090000', "SUMMARY:a"]));
    expect(quoted?.start).toBe("2026-10-10T08:00:00.000Z");
    const [floating] = parseIcs(cal(["UID:u1", "DTSTART:20261010T090000", "SUMMARY:a"]), { timeZone: "America/Chicago" });
    expect(floating?.start).toBe("2026-10-10T14:00:00.000Z");
    const declared = parseIcs(["BEGIN:VCALENDAR", "X-WR-TIMEZONE:Asia/Tokyo", "BEGIN:VEVENT", "UID:u1", "DTSTART:20261010T090000", "END:VEVENT", "END:VCALENDAR"].join("\r\n"), { timeZone: "America/Chicago" });
    expect(declared[0]?.start).toBe("2026-10-10T00:00:00.000Z");
    const [unknown] = parseIcs(cal(["UID:u1", "DTSTART;TZID=Eastern Standard Time:20261010T090000", "SUMMARY:a"]));
    expect(unknown?.start).toBe("2026-10-10T09:00:00.000Z");
    const [utc] = parseIcs(cal(["UID:u1", "DTSTART;TZID=America/New_York:20261010T090000Z", "SUMMARY:a"]));
    expect(utc?.start).toBe("2026-10-10T09:00:00.000Z");
  });
  it("gives UID-less events distinct, stable ids", () => {
    const text = cal(["DTSTART:20261010T090000Z", "SUMMARY:Office hours"], ["DTSTART:20261011T090000Z", "SUMMARY:Office hours"]);
    const ids = parseIcs(text).map((e) => canvasFeedEventToItem(e, "x")!.id);
    expect(new Set(ids).size).toBe(2);
    expect(parseIcs(text).map((e) => canvasFeedEventToItem(e, "y")!.id)).toEqual(ids);
    expect(ids[0]).toMatch(/^canvas:event:nouid-/);
  });
  it("keys an assignment override by the assignment in its URL, or by the override", () => {
    const [withUrl, bare] = parseIcs(
      cal(
        ["UID:event-assignment-override-78", "DTSTART:20261012T170000Z", "SUMMARY:Lab 3 [CHEM 101]", "URL;VALUE=URI:https://canvas.example.edu/calendar?include_contexts=course_101&month=10&year=2026#assignment_1002"],
        ["UID:event-assignment-override-79", "DTSTART:20261012T170000Z", "SUMMARY:Lab 4 [CHEM 101]"],
      ),
    );
    expect(canvasFeedEventToItem(withUrl!, "x")).toMatchObject({ id: "canvas:assignment:1002", kind: "assignment", canvasId: "1002" });
    expect(canvasFeedEventToItem(bare!, "x")).toMatchObject({ id: "canvas:event:override-79", kind: "assignment", canvasType: "assignment_override" });
  });
  it("ignores properties of components nested in an event (VALARM)", () => {
    const [ev] = parseIcs(cal(["UID:u1", "SUMMARY:Exam", "DESCRIPTION:Room 101", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM"]));
    expect(ev?.description).toBe("Room 101");
    expect(ev?.summary).toBe("Exam");
  });
});

describe("ICS folding (B9)", () => {
  it("folds at 75 octets of UTF-8 and never inside a code point", () => {
    const summary = "Lecture notes — résumé ".repeat(6) + "😀".repeat(30) + "中文".repeat(20);
    const ics = writeIcs("Study blocks ✓", [{ uid: "u1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", summary, description: "x".repeat(200) }]);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8"), line).toBeLessThanOrEqual(75);
    expect(ics).not.toContain("\ufffd");
    const [ev] = parseIcs(ics);
    expect(ev?.summary).toBe(summary);
    expect(ev?.description).toBe("x".repeat(200));
  });
});
