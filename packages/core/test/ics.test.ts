import { describe, expect, it } from "vitest";
import { canvasFeedEventToItem, parseIcs, writeIcs } from "../src/ics.js";

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
