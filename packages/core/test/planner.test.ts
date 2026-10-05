import { describe, expect, it } from "vitest";
import { planBlocks, type PlanInput } from "../src/plan/planner.js";
import { DEFAULT_PREFERENCES, type Preferences } from "../src/types.js";
import { zonedParts } from "../src/tz.js";

const prefs: Preferences = {
  ...DEFAULT_PREFERENCES,
  timezone: "America/New_York",
  // Every day 09:00-21:00 for predictable capacity.
  workWindows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "21:00" })),
  maxHoursPerDay: 4,
  minBlockMinutes: 30,
  maxBlockMinutes: 120,
  bufferHoursBeforeDue: 12,
};

// Monday 5 Oct 2026, 08:00 New York (12:00Z).
const NOW = "2026-10-05T12:00:00.000Z";
const END = "2026-10-12T12:00:00.000Z";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  now: NOW,
  horizonStart: NOW,
  horizonEnd: END,
  items: [],
  busy: [],
  existingBlocks: [],
  prefs,
  ...over,
});

describe("planBlocks", () => {
  it("places blocks inside work windows, before the buffered due time", () => {
    const r = planBlocks(
      input({
        items: [{ itemId: "a", title: "PS 5", dueAt: "2026-10-08T03:59:00.000Z" /* Wed 23:59 NY */, hoursNeeded: 3 }],
      }),
    );
    expect(r.unscheduled).toEqual([]);
    const total = r.blocks.reduce((s, b) => s + b.minutes, 0);
    expect(total).toBe(180);
    for (const b of r.blocks) {
      const p = zonedParts(new Date(b.start), prefs.timezone);
      expect(p.hour).toBeGreaterThanOrEqual(9);
      expect(new Date(b.end).getTime()).toBeLessThanOrEqual(new Date("2026-10-08T03:59:00.000Z").getTime() - 12 * 3_600_000);
      expect(b.insideBuffer).toBe(false);
    }
  });

  it("respects busy time and the daily cap", () => {
    const r = planBlocks(
      input({
        items: [{ itemId: "a", title: "Essay", dueAt: "2026-10-10T03:59:00.000Z", hoursNeeded: 10 }],
        busy: [{ start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T23:00:00.000Z" }], // Monday 09-19 NY busy
      }),
    );
    for (const [day, hours] of Object.entries(r.dayLoad)) {
      expect(hours, day).toBeLessThanOrEqual(4);
    }
    for (const b of r.blocks) {
      const overlapsBusy = new Date(b.start).getTime() < new Date("2026-10-05T23:00:00.000Z").getTime() && new Date(b.end).getTime() > new Date("2026-10-05T13:00:00.000Z").getTime();
      expect(overlapsBusy).toBe(false);
    }
    expect(r.blocks.reduce((s, b) => s + b.minutes, 0)).toBe(600);
  });

  it("reports what cannot fit and eats into the buffer first", () => {
    const r = planBlocks(
      input({
        items: [{ itemId: "a", title: "Big", dueAt: "2026-10-06T03:59:00.000Z" /* tonight */, hoursNeeded: 9 }],
      }),
    );
    expect(r.unscheduled).toHaveLength(1);
    expect(r.unscheduled[0]?.hoursShort).toBeGreaterThan(0);
    expect(r.blocks.some((b) => b.insideBuffer)).toBe(true);
  });

  it("schedules earlier deadlines first", () => {
    const r = planBlocks(
      input({
        items: [
          { itemId: "late", title: "Later", dueAt: "2026-10-11T03:59:00.000Z", hoursNeeded: 2 },
          { itemId: "soon", title: "Sooner", dueAt: "2026-10-07T03:59:00.000Z", hoursNeeded: 2 },
        ],
      }),
    );
    const first = r.blocks[0];
    expect(first?.itemId).toBe("soon");
  });

  it("spreads blocks with the even strategy", () => {
    const early = planBlocks(input({ items: [{ itemId: "a", title: "Project", dueAt: "2026-10-12T03:59:00.000Z", hoursNeeded: 6 }] }));
    const even = planBlocks(input({ items: [{ itemId: "a", title: "Project", dueAt: "2026-10-12T03:59:00.000Z", hoursNeeded: 6 }], strategy: "even" }));
    const days = (blocks: typeof early.blocks) => new Set(blocks.map((b) => b.start.slice(0, 10))).size;
    expect(days(even.blocks)).toBeGreaterThanOrEqual(days(early.blocks));
    expect(even.blocks.reduce((s, b) => s + b.minutes, 0)).toBe(360);
  });

  it("marks already-due items", () => {
    const r = planBlocks(input({ items: [{ itemId: "a", title: "Old", dueAt: "2026-10-01T00:00:00.000Z", hoursNeeded: 1 }] }));
    expect(r.unscheduled[0]?.reason).toBe("already due");
  });
});
