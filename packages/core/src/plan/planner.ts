/**
 * Places study blocks into free time. Earliest-deadline-first with a per-day
 * cap, a buffer before each due time, and either "early" (start as soon as
 * possible) or "even" (spread each item between now and its deadline).
 *
 * Pure: takes instants and returns instants. The caller supplies busy time
 * from whatever calendar it has.
 */
import type { Interval, Preferences, StudyBlock } from "../types.js";
import { addDaysToKey, localDateKey, parseDateKey, parseHHMM, zonedTimeToUtc } from "../tz.js";

export interface PlanItem {
  itemId: string;
  title: string;
  dueAt?: string;
  unlockAt?: string;
  hoursNeeded: number;
  /** Higher first among equal deadlines. */
  priority?: number;
}

export interface PlanInput {
  now: string;
  horizonStart: string;
  horizonEnd: string;
  items: PlanItem[];
  busy: Interval[];
  existingBlocks: StudyBlock[];
  prefs: Preferences;
  strategy?: "early" | "even";
}

export interface ProposedBlock {
  itemId: string;
  title: string;
  start: string;
  end: string;
  minutes: number;
  /** True when the block eats into the buffer before the due time. */
  insideBuffer: boolean;
}

export interface Unscheduled {
  itemId: string;
  title: string;
  hoursShort: number;
  reason: string;
}

export interface PlanResult {
  blocks: ProposedBlock[];
  unscheduled: Unscheduled[];
  /** Local date -> planned hours (including existing blocks). */
  dayLoad: Record<string, number>;
  freeHours: number;
}

interface Slot {
  start: number;
  end: number;
}

const MIN = 60_000;

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

function subtract(slots: Slot[], busy: Slot[]): Slot[] {
  let out = slots;
  for (const b of busy) {
    const next: Slot[] = [];
    for (const s of out) {
      if (b.end <= s.start || b.start >= s.end) {
        next.push(s);
        continue;
      }
      if (b.start > s.start) next.push({ start: s.start, end: b.start });
      if (b.end < s.end) next.push({ start: b.end, end: s.end });
    }
    out = next;
  }
  return out;
}

/** Free slots inside the work windows between horizonStart and horizonEnd. */
export function freeSlots(input: PlanInput): Slot[] {
  const { prefs } = input;
  const tz = prefs.timezone;
  const from = Math.max(toMs(input.horizonStart), toMs(input.now));
  const to = toMs(input.horizonEnd);
  const windows: Slot[] = [];
  let key = localDateKey(new Date(from), tz);
  const lastKey = localDateKey(new Date(to), tz);
  for (let guard = 0; guard < 400; guard++) {
    const { year, month, day } = parseDateKey(key);
    const weekday = zonedTimeToUtc(year, month, day, 12, 0, tz).getUTCDay();
    const localWeekday = new Date(zonedTimeToUtc(year, month, day, 12, 0, tz)).getTime();
    void localWeekday;
    const wd = weekdayInZone(year, month, day, tz) ?? weekday;
    for (const w of prefs.workWindows) {
      if (w.weekday !== wd) continue;
      const s = parseHHMM(w.start);
      const e = parseHHMM(w.end);
      const start = zonedTimeToUtc(year, month, day, s.hour, s.minute, tz).getTime();
      const end = zonedTimeToUtc(year, month, day, e.hour, e.minute, tz).getTime();
      if (end > start) windows.push({ start: Math.max(start, from), end: Math.min(end, to) });
    }
    if (key === lastKey) break;
    key = addDaysToKey(key, 1);
  }
  const busy: Slot[] = [
    ...input.busy.map((b) => ({ start: toMs(b.start), end: toMs(b.end) })),
    ...input.existingBlocks
      .filter((b) => b.status === "planned" || b.status === "kept" || b.status === "moved")
      .map((b) => ({ start: toMs(b.start), end: toMs(b.end) })),
  ];
  return subtract(
    windows.filter((w) => w.end > w.start),
    busy,
  )
    .filter((s) => s.end - s.start >= prefs.minBlockMinutes * MIN)
    .sort((a, b) => a.start - b.start);
}

function weekdayInZone(year: number, month: number, day: number, tz: string): number | undefined {
  const d = zonedTimeToUtc(year, month, day, 12, 0, tz);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name];
}

export function planBlocks(input: PlanInput): PlanResult {
  const prefs = input.prefs;
  const tz = prefs.timezone;
  const strategy = input.strategy ?? "early";
  let slots = freeSlots(input);
  const freeHours = slots.reduce((a, s) => a + (s.end - s.start), 0) / 3_600_000;
  const dayLoad: Record<string, number> = {};
  for (const b of input.existingBlocks) {
    if (b.status === "deleted") continue;
    const k = localDateKey(new Date(b.start), tz);
    dayLoad[k] = (dayLoad[k] ?? 0) + b.minutes / 60;
  }
  const blocks: ProposedBlock[] = [];
  const unscheduled: Unscheduled[] = [];
  const now = toMs(input.now);
  const horizonEnd = toMs(input.horizonEnd);
  const bufferMs = prefs.bufferHoursBeforeDue * 3_600_000;
  const minBlock = prefs.minBlockMinutes * MIN;
  const maxBlock = prefs.maxBlockMinutes * MIN;
  const dayCap = prefs.maxHoursPerDay * 60;

  const items = [...input.items]
    .filter((i) => i.hoursNeeded > 0)
    .sort((a, b) => {
      const da = a.dueAt ? toMs(a.dueAt) : Infinity;
      const db = b.dueAt ? toMs(b.dueAt) : Infinity;
      if (da !== db) return da - db;
      return (b.priority ?? 0) - (a.priority ?? 0);
    });

  const place = (item: PlanItem, earliest: number, latest: number, remainingMs: number, insideBuffer: boolean): number => {
    let remaining = remainingMs;
    const candidates = slots.filter((s) => s.end > earliest && s.start < latest);
    const order = strategy === "even" ? evenOrder(candidates, earliest, latest, remaining, maxBlock) : candidates;
    for (const slot of order) {
      if (remaining <= 0) break;
      const start = Math.max(slot.start, earliest);
      const end = Math.min(slot.end, latest);
      if (end - start < Math.min(minBlock, remaining)) continue;
      const dayKey = localDateKey(new Date(start), tz);
      const dayLeft = dayCap - (dayLoad[dayKey] ?? 0) * 60;
      if (dayLeft < Math.min(prefs.minBlockMinutes, remaining / MIN)) continue;
      let take = Math.min(remaining, end - start, maxBlock, dayLeft * MIN);
      take = Math.floor(take / (5 * MIN)) * 5 * MIN; // five-minute grid
      if (take <= 0) continue;
      if (take < minBlock && take < remaining) continue;
      const blockEnd = start + take;
      blocks.push({
        itemId: item.itemId,
        title: item.title,
        start: new Date(start).toISOString(),
        end: new Date(blockEnd).toISOString(),
        minutes: take / MIN,
        insideBuffer,
      });
      dayLoad[dayKey] = (dayLoad[dayKey] ?? 0) + take / 60_000 / 60;
      remaining -= take;
      slots = subtract(slots, [{ start, end: blockEnd }]).filter((s) => s.end - s.start >= minBlock);
    }
    return remaining;
  };

  for (const item of items) {
    const due = item.dueAt ? toMs(item.dueAt) : undefined;
    const earliest = Math.max(now, item.unlockAt ? toMs(item.unlockAt) : 0);
    const hardLatest = due ? Math.min(due, horizonEnd) : horizonEnd;
    const softLatest = due ? Math.min(due - bufferMs, horizonEnd) : horizonEnd;
    const need = Math.round(item.hoursNeeded * 60) * MIN;
    if (due !== undefined && due <= now) {
      unscheduled.push({ itemId: item.itemId, title: item.title, hoursShort: item.hoursNeeded, reason: "already due" });
      continue;
    }
    let remaining = place(item, earliest, softLatest, need, false);
    if (remaining > 0 && hardLatest > softLatest) remaining = place(item, earliest, hardLatest, remaining, true);
    if (remaining > 0) {
      unscheduled.push({
        itemId: item.itemId,
        title: item.title,
        hoursShort: Math.round((remaining / 3_600_000) * 4) / 4,
        reason: due && due < horizonEnd ? "not enough free time before the due date" : "not enough free time in the horizon",
      });
    }
  }

  blocks.sort((a, b) => toMs(a.start) - toMs(b.start));
  return { blocks, unscheduled, dayLoad: roundLoad(dayLoad), freeHours: Math.round(freeHours * 4) / 4 };
}

/** Reorders candidate slots so blocks land near evenly spaced targets. */
function evenOrder(slots: Slot[], earliest: number, latest: number, remaining: number, maxBlock: number): Slot[] {
  const k = Math.max(1, Math.ceil(remaining / maxBlock));
  const span = Math.max(1, latest - earliest);
  const targets: number[] = [];
  for (let i = 0; i < k; i++) targets.push(earliest + (span * (i + 0.5)) / k);
  const picked = new Set<Slot>();
  const out: Slot[] = [];
  for (const t of targets) {
    let best: Slot | undefined;
    let bestD = Infinity;
    for (const s of slots) {
      if (picked.has(s)) continue;
      const d = t < s.start ? s.start - t : t > s.end ? t - s.end : 0;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      picked.add(best);
      out.push(best);
    }
  }
  for (const s of slots) if (!picked.has(s)) out.push(s);
  return out;
}

function roundLoad(load: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(load)) out[k] = Math.round(v * 4) / 4;
  return out;
}
