import { describe, expect, it } from "vitest";
import { BREAK_MINUTES, blockOccupies, hoursNeededInHorizon, planBlocks, preferenceErrors, type PlanInput, type PlanItem } from "../src/plan/planner.js";
import { DEFAULT_PREFERENCES, type BlockStatus, type Interval, type Preferences, type StudyBlock } from "../src/types.js";
import { addDaysToKey, localDateKey, parseDateKey, parseHHMM, weekdayOfKey, zonedParts, zonedTimeToUtc } from "../src/tz.js";

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
const MIN = 60_000;

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

const ms = (iso: string) => new Date(iso).getTime();
const total = (r: { blocks: Array<{ minutes: number }> }) => r.blocks.reduce((s, b) => s + b.minutes, 0);

describe("planBlocks", () => {
  it("places blocks inside work windows, before the buffered due time", () => {
    const r = planBlocks(
      input({
        items: [{ itemId: "a", title: "PS 5", dueAt: "2026-10-08T03:59:00.000Z" /* Wed 23:59 NY */, hoursNeeded: 3 }],
      }),
    );
    expect(r.unscheduled).toEqual([]);
    expect(total(r)).toBe(180);
    for (const b of r.blocks) {
      const p = zonedParts(new Date(b.start), prefs.timezone);
      expect(p.hour).toBeGreaterThanOrEqual(9);
      expect(ms(b.end)).toBeLessThanOrEqual(ms("2026-10-08T03:59:00.000Z") - 12 * 3_600_000);
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
      const overlapsBusy = ms(b.start) < ms("2026-10-05T23:00:00.000Z") && ms(b.end) > ms("2026-10-05T13:00:00.000Z");
      expect(overlapsBusy).toBe(false);
    }
    expect(total(r)).toBe(600);
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
    expect(r.blocks[0]?.itemId).toBe("soon");
  });

  it("spreads blocks with the even strategy", () => {
    const early = planBlocks(input({ items: [{ itemId: "a", title: "Project", dueAt: "2026-10-12T03:59:00.000Z", hoursNeeded: 6 }] }));
    const even = planBlocks(input({ items: [{ itemId: "a", title: "Project", dueAt: "2026-10-12T03:59:00.000Z", hoursNeeded: 6 }], strategy: "even" }));
    const days = (blocks: typeof early.blocks) => new Set(blocks.map((b) => b.start.slice(0, 10))).size;
    expect(days(even.blocks)).toBeGreaterThan(days(early.blocks));
    expect(total(even)).toBe(360);
  });

  it("marks already-due items", () => {
    const r = planBlocks(input({ items: [{ itemId: "a", title: "Old", dueAt: "2026-10-01T00:00:00.000Z", hoursNeeded: 1 }] }));
    expect(r.unscheduled[0]?.reason).toBe("already due");
  });

  // A2: one 09-21 Monday window, cap 8h, 6h due Thursday. Used to give 2h, a 2h block flagged inside the buffer, and 2h "short".
  it("fills one long free slot with several blocks, outside the buffer", () => {
    const monday: Preferences = { ...prefs, workWindows: [{ weekday: 1, start: "09:00", end: "21:00" }], maxHoursPerDay: 8, minBlockMinutes: 45 };
    const r = planBlocks(input({ prefs: monday, items: [{ itemId: "a", title: "A", dueAt: "2026-10-09T03:59:00.000Z", hoursNeeded: 6 }] }));
    expect(r.unscheduled).toEqual([]);
    expect(total(r)).toBe(360);
    expect(r.blocks.every((b) => !b.insideBuffer)).toBe(true);
    expect(r.blocks.map((b) => zonedParts(new Date(b.start), prefs.timezone).hour)).toEqual([9, 11, 14]);
  });

  it("never runs one item past the maximum block without a break", () => {
    const r = planBlocks(input({ prefs: { ...prefs, maxHoursPerDay: 12 }, items: [{ itemId: "a", title: "A", dueAt: "2026-10-12T03:59:00.000Z", hoursNeeded: 6 }] }));
    const sorted = [...r.blocks].sort((x, y) => ms(x.start) - ms(y.start));
    for (let i = 1; i < sorted.length; i++) expect(ms(sorted[i]!.start) - ms(sorted[i - 1]!.end)).toBeGreaterThanOrEqual(BREAK_MINUTES * MIN);
  });

  // A3: starts on the grid, no five-minute stubs, no "0h short".
  it("starts blocks on the five-minute grid and never leaves a stub", () => {
    const allDay: Preferences = { ...prefs, workWindows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:00" })), maxHoursPerDay: 8, minBlockMinutes: 45 };
    const now = "2026-10-06T04:37:18.470Z";
    for (const minutes of [125, 126, 30]) {
      const r = planBlocks(input({ now, horizonStart: now, prefs: allDay, items: [{ itemId: "a", title: "A", dueAt: "2026-10-11T03:59:00.000Z", hoursNeeded: minutes / 60 }] }));
      expect(r.unscheduled, `${minutes}`).toEqual([]);
      expect(total(r)).toBe(Math.ceil(minutes / 5) * 5);
      for (const b of r.blocks) {
        expect(ms(b.start) % (5 * MIN)).toBe(0);
        expect(ms(b.end) % (5 * MIN)).toBe(0);
        expect(b.minutes).toBeGreaterThanOrEqual(Math.min(45, minutes));
      }
    }
  });

  it("does not report a shortfall smaller than a block", () => {
    // 50 min needed, only 45-minute gaps before the deadline: one block, and the 5 minutes left are not a line in the report.
    const r = planBlocks(
      input({
        prefs: { ...prefs, minBlockMinutes: 45, bufferHoursBeforeDue: 0 },
        items: [{ itemId: "a", title: "A", dueAt: "2026-10-05T13:45:00.000Z", hoursNeeded: 50 / 60 }],
      }),
    );
    expect(total(r)).toBe(45);
    expect(r.unscheduled).toEqual([]);
  });

  // A4: a window that ends after midnight.
  it("reads a window that crosses midnight as running into the next day", () => {
    const night: Preferences = { ...prefs, workWindows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "21:00", end: "02:00" })) };
    const r = planBlocks(input({ prefs: night, horizonEnd: "2026-10-08T12:00:00.000Z", items: [{ itemId: "a", title: "A", dueAt: "2026-10-09T03:59:00.000Z", hoursNeeded: 8 }] }));
    expect(r.freeHours).toBe(15);
    expect(total(r)).toBe(480);
    expect(r.blocks.some((b) => zonedParts(new Date(b.end), prefs.timezone).hour < 3)).toBe(true);
    // The hour after midnight counts toward the evening it started in.
    expect(r.dayLoad["2026-10-05"]).toBe(4);
    expect(r.dayLoad["2026-10-06"]).toBe(4);
  });

  it("follows the zone across a DST change", () => {
    // New York springs forward at 02:00 on Sunday 8 March 2026: a 01:00-04:00 window is two hours long that night.
    const dst: Preferences = { ...prefs, workWindows: [{ weekday: 0, start: "01:00", end: "04:00" }], maxHoursPerDay: 8 };
    const r = planBlocks({ ...input({ prefs: dst }), now: "2026-03-07T12:00:00.000Z", horizonStart: "2026-03-07T12:00:00.000Z", horizonEnd: "2026-03-09T12:00:00.000Z" });
    expect(r.freeHours).toBe(2);
  });

  it("skips a work window it cannot read instead of failing the plan", () => {
    const bad: Preferences = { ...prefs, workWindows: [{ weekday: 1, start: "5pm", end: "21:00" }, { weekday: 1, start: "09:00", end: "12:00" }] };
    const r = planBlocks(input({ prefs: bad, items: [{ itemId: "a", title: "A", hoursNeeded: 1 }] }));
    expect(r.warnings?.[0]).toContain("5pm");
    expect(total(r)).toBe(60);
  });

  it("refuses a horizon over 120 days with a clear error", () => {
    expect(() => planBlocks(input({ horizonEnd: "2027-06-01T00:00:00.000Z" }))).toThrow(/120 days/);
  });

  it("treats a block marked done as taken time, and ignores unreadable busy intervals", () => {
    const done: StudyBlock = { id: "b1", itemId: "x", start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T15:00:00.000Z", minutes: 120, status: "done", createdAt: NOW, updatedAt: NOW };
    expect(blockOccupies(done)).toBe(true);
    expect(blockOccupies({ status: "deleted" })).toBe(false);
    const r = planBlocks(input({ existingBlocks: [done], busy: [{ start: "not a date", end: "2026-10-06T00:00:00Z" }], items: [{ itemId: "a", title: "A", dueAt: "2026-10-06T03:59:00.000Z", hoursNeeded: 4 }] }));
    for (const b of r.blocks) expect(ms(b.start) >= ms(done.end) || ms(b.end) <= ms(done.start)).toBe(true);
    expect(r.dayLoad["2026-10-05"]).toBe(4);
    expect(total(r)).toBe(120);
  });

  it("plans asap items (missing work, no due date) before anything with a deadline", () => {
    const r = planBlocks(
      input({
        prefs: { ...prefs, maxHoursPerDay: 2 },
        items: [
          { itemId: "soon", title: "Due tomorrow", dueAt: "2026-10-07T03:59:00.000Z", hoursNeeded: 2 },
          { itemId: "undated", title: "No date", hoursNeeded: 1 },
          { itemId: "missing-small", title: "Missing, 10 pts", hoursNeeded: 1, asap: true, priority: 10 },
          { itemId: "missing-big", title: "Missing, 50 pts", hoursNeeded: 1, asap: true, priority: 50 },
        ],
      }),
    );
    const first = [...r.blocks].sort((x, y) => ms(x.start) - ms(y.start)).map((b) => b.itemId);
    expect(first.slice(0, 2)).toEqual(["missing-big", "missing-small"]);
    // Without the flag, undated work still comes after dated work.
    expect(first.indexOf("undated")).toBeGreaterThan(first.indexOf("soon"));
    expect(r.blocks.filter((b) => b.itemId.startsWith("missing")).every((b) => !b.insideBuffer)).toBe(true);
  });

  it("says why an item that opens too late cannot be planned", () => {
    const r = planBlocks(input({ items: [{ itemId: "a", title: "A", unlockAt: "2026-10-20T00:00:00.000Z", hoursNeeded: 1 }] }));
    expect(r.unscheduled[0]?.reason).toBe("it opens after the end of the horizon");
  });
});

describe("preferenceErrors", () => {
  it("accepts the defaults and a window that crosses midnight", () => {
    expect(preferenceErrors(DEFAULT_PREFERENCES)).toEqual([]);
    expect(preferenceErrors({ workWindows: [{ weekday: 5, start: "21:00", end: "02:00" }] })).toEqual([]);
  });
  it("names what is wrong", () => {
    expect(preferenceErrors({ workWindows: [{ weekday: 1, start: "5pm", end: "21:00" }] })[0]).toContain("HH:MM");
    expect(preferenceErrors({ workWindows: [{ weekday: 7, start: "09:00", end: "09:00" }] })).toHaveLength(2);
    expect(preferenceErrors({ minBlockMinutes: 200, maxBlockMinutes: 60 })[0]).toContain("longer than the maximum");
    expect(preferenceErrors({ timezone: "Mars/Olympus" })).toEqual(["unknown time zone Mars/Olympus"]);
    expect(preferenceErrors({ maxHoursPerDay: 0, bufferHoursBeforeDue: -1 })).toHaveLength(2);
  });
});

describe("hoursNeededInHorizon", () => {
  it("pro-rates work due after the horizon by the share of working time it covers", () => {
    const opts = { now: NOW, horizonEnd: END, bufferHours: 0 };
    expect(hoursNeededInHorizon(10, { ...opts, dueAt: "2026-10-08T00:00:00Z" })).toBe(10);
    expect(hoursNeededInHorizon(10, { ...opts, dueAt: "2026-10-19T12:00:00Z" })).toBeCloseTo(5, 9);
    expect(hoursNeededInHorizon(10, opts)).toBe(10);
  });
});

// ---- seeded property test ------------------------------------------------

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Work windows as instants, computed independently of the planner: [start, end, day key], merged where they overlap. */
function windowInstants(p: Preferences, from: number, to: number): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  let key = addDaysToKey(localDateKey(new Date(from), p.timezone), -1);
  const last = addDaysToKey(localDateKey(new Date(to), p.timezone), 1);
  for (; key <= last; key = addDaysToKey(key, 1)) {
    const d = parseDateKey(key);
    for (const w of p.workWindows) {
      if (w.weekday !== weekdayOfKey(key)) continue;
      const s = parseHHMM(w.start);
      const e = parseHHMM(w.end);
      const next = e.hour * 60 + e.minute <= s.hour * 60 + s.minute ? parseDateKey(addDaysToKey(key, 1)) : d;
      out.push([zonedTimeToUtc(d.year, d.month, d.day, s.hour, s.minute, p.timezone).getTime(), zonedTimeToUtc(next.year, next.month, next.day, e.hour, e.minute, p.timezone).getTime(), key]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number, string]> = [];
  for (const w of out) {
    const m = merged[merged.length - 1];
    if (m && w[0] <= m[1]) m[1] = Math.max(m[1], w[1]);
    else merged.push([...w]);
  }
  return merged;
}

describe("planBlocks properties (seeded)", () => {
  const zones = ["America/New_York", "Europe/London", "Asia/Kathmandu", "Australia/Lord_Howe", "UTC", "America/Los_Angeles", "Africa/Cairo"];
  // Around DST changes and ordinary weeks.
  const anchors = ["2026-03-06T00:00:00Z", "2026-03-27T00:00:00Z", "2026-04-22T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-23T00:00:00Z", "2026-10-30T00:00:00Z", "2026-06-15T00:00:00Z"];
  const statuses: BlockStatus[] = ["planned", "kept", "moved", "done", "deleted"];
  const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  it("never overlaps, stays in windows and before deadlines, honours the cap, and flags the buffer exactly", () => {
    const r = rng(424242);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (let trial = 0; trial < 250; trial++) {
      const tz = pick(zones);
      const now = new Date(ms(pick(anchors)) + r() * 3 * 86_400_000).toISOString();
      const nowMs = ms(now);
      const horizonEnd = new Date(nowMs + int(2, 21) * 86_400_000 + int(0, 23) * 3_600_000).toISOString();
      const minBlock = int(1, 18) * 5;
      const p: Preferences = {
        ...DEFAULT_PREFERENCES,
        timezone: tz,
        workWindows: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
          Array.from({ length: int(0, 2) }, () => {
            const start = int(0, 95) * 15;
            return { weekday, start: hhmm(start), end: hhmm(start + int(4, 40) * 15) };
          }),
        ),
        maxHoursPerDay: int(1, 10),
        minBlockMinutes: minBlock,
        maxBlockMinutes: minBlock + int(0, 24) * 5,
        bufferHoursBeforeDue: int(0, 24),
      };
      const randomInterval = (): Interval => {
        const s = nowMs + r() * (ms(horizonEnd) - nowMs);
        return { start: new Date(s).toISOString(), end: new Date(s + int(10, 300) * MIN).toISOString() };
      };
      const busy = Array.from({ length: int(0, 10) }, randomInterval);
      const existing: StudyBlock[] = Array.from({ length: int(0, 5) }, (_, i) => {
        const iv = randomInterval();
        return { id: `e${i}`, itemId: `x${i}`, ...iv, minutes: (ms(iv.end) - ms(iv.start)) / MIN, status: pick(statuses), createdAt: now, updatedAt: now };
      });
      const items: PlanItem[] = Array.from({ length: int(1, 8) }, (_, i) => {
        const it: PlanItem = { itemId: `i${i}`, title: `Item ${i}`, hoursNeeded: Math.round((0.1 + r() * 10) * 100) / 100 };
        const due = r();
        if (due < 0.85) it.dueAt = new Date(nowMs + (due - 0.1) * 25 * 86_400_000).toISOString();
        if (r() < 0.2) it.unlockAt = new Date(nowMs + r() * 5 * 86_400_000).toISOString();
        return it;
      });
      const strategy = r() < 0.5 ? "early" : "even";
      const result = planBlocks({ now, horizonStart: now, horizonEnd, items, busy, existingBlocks: existing, prefs: p, strategy });
      const ctx = `trial ${trial} (${tz}, ${strategy})`;
      const windows = windowInstants(p, nowMs, ms(horizonEnd));
      const taken = [...busy, ...existing.filter((b) => b.status !== "deleted")].map((b) => [ms(b.start), ms(b.end)] as const);
      const blocks = result.blocks.map((b) => ({ ...b, s: ms(b.start), e: ms(b.end) }));
      const perItem = new Map<string, number>();
      const newPerDay = new Set<string>();
      for (const b of blocks) {
        const item = items.find((i) => i.itemId === b.itemId)!;
        const need = Math.ceil(Math.round(item.hoursNeeded * 3600) / 300) * 5;
        expect(b.e - b.s, ctx).toBe(b.minutes * MIN);
        expect(b.s % (5 * MIN), ctx).toBe(0);
        expect(b.minutes, ctx).toBeGreaterThanOrEqual(Math.min(p.minBlockMinutes, need));
        expect(b.minutes, ctx).toBeLessThanOrEqual(p.maxBlockMinutes);
        expect(b.s, ctx).toBeGreaterThanOrEqual(nowMs);
        expect(b.e, ctx).toBeLessThanOrEqual(ms(horizonEnd));
        if (item.unlockAt) expect(b.s, ctx).toBeGreaterThanOrEqual(ms(item.unlockAt));
        if (item.dueAt) {
          expect(b.e, ctx).toBeLessThanOrEqual(ms(item.dueAt));
          expect(b.insideBuffer, ctx).toBe(b.e > ms(item.dueAt) - p.bufferHoursBeforeDue * 3_600_000);
        } else expect(b.insideBuffer, ctx).toBe(false);
        const w = windows.find(([s, e]) => s <= b.s && b.e <= e);
        expect(w, `${ctx}: block ${b.start}-${b.end} outside every window`).toBeDefined();
        newPerDay.add(w![2]);
        for (const [s, e] of taken) expect(b.s < e && b.e > s, `${ctx}: block over busy/existing`).toBe(false);
        perItem.set(b.itemId, (perItem.get(b.itemId) ?? 0) + b.minutes);
      }
      for (let i = 0; i < blocks.length; i++)
        for (let j = i + 1; j < blocks.length; j++) expect(blocks[i]!.s < blocks[j]!.e && blocks[i]!.e > blocks[j]!.s, `${ctx}: blocks overlap`).toBe(false);
      for (const [id, minutes] of perItem) {
        const item = items.find((i) => i.itemId === id)!;
        expect(minutes, ctx).toBeLessThanOrEqual(Math.ceil(Math.round(item.hoursNeeded * 3600) / 300) * 5);
      }
      for (const day of newPerDay) expect(result.dayLoad[day] ?? 0, `${ctx}: ${day}`).toBeLessThanOrEqual(p.maxHoursPerDay + 0.125);
      for (const u of result.unscheduled) expect(u.hoursShort, ctx).toBeGreaterThan(0);
    }
  });
});
