import { describe, expect, it } from "vitest";
import { isHHMM, parseHHMM, weekdayOfKey, zonedParts, zonedTimeToUtc } from "../src/tz.js";

const local = (d: Date, tz: string) => {
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe("zonedTimeToUtc", () => {
  it.each([
    // [zone, wall time, expected instant, what it reads as locally]
    ["America/New_York", [2026, 10, 5, 9, 0], "2026-10-05T13:00:00.000Z", "2026-10-05 09:00"],
    ["Asia/Kathmandu", [2026, 10, 5, 9, 0], "2026-10-05T03:15:00.000Z", "2026-10-05 09:00"],
    // Gaps resolve forward, east and west of UTC.
    ["Europe/London", [2026, 3, 29, 1, 30], "2026-03-29T01:30:00.000Z", "2026-03-29 02:30"],
    ["Africa/Cairo", [2026, 4, 24, 0, 0], "2026-04-23T22:00:00.000Z", "2026-04-24 01:00"],
    ["America/New_York", [2026, 3, 8, 2, 30], "2026-03-08T07:30:00.000Z", "2026-03-08 03:30"],
    // Overlaps take the earlier instant.
    ["Europe/London", [2026, 10, 25, 1, 30], "2026-10-25T00:30:00.000Z", "2026-10-25 01:30"],
    ["America/New_York", [2026, 11, 1, 1, 30], "2026-11-01T05:30:00.000Z", "2026-11-01 01:30"],
  ] as const)("%s %j", (tz, [y, m, d, h, mi], iso, reads) => {
    const t = zonedTimeToUtc(y, m, d, h, mi, tz);
    expect(t.toISOString()).toBe(iso);
    expect(local(t, tz)).toBe(reads);
  });
});

describe("date keys and times", () => {
  it("gives a date key its weekday without a zone", () => {
    expect(weekdayOfKey("2026-10-05")).toBe(1);
    expect(weekdayOfKey("2026-03-08")).toBe(0);
  });
  it("accepts strict HH:MM for preferences and reads older H:MM", () => {
    expect(isHHMM("09:00")).toBe(true);
    expect(isHHMM("23:59")).toBe(true);
    for (const bad of ["9:00", "24:00", "12:60", "5pm", "", 9]) expect(isHHMM(bad)).toBe(false);
    expect(parseHHMM("9:30")).toEqual({ hour: 9, minute: 30 });
    expect(() => parseHHMM("5pm")).toThrow(/HH:MM/);
    expect(() => parseHHMM("25:00")).toThrow();
  });
});
