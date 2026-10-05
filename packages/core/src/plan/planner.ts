/**
 * Places study blocks into free time. Earliest-deadline-first with a per-day
 * cap, a buffer before each due time, and either "early" (start as soon as
 * possible) or "even" (spread each item between now and its deadline).
 *
 * Pure: takes instants and returns instants. The caller supplies busy time
 * from whatever calendar it has.
 *
 * Rules, in the order they bind:
 * - Free time is the work windows (a window whose end is not after its start
 *   runs past midnight into the next day), minus busy time, minus every block
 *   that still occupies the calendar (`blockOccupies`), from `now` on.
 * - Blocks start on the grid (five minutes unless `gridMinutes` says otherwise)
 *   and are a whole number of grid steps long, between the minimum and maximum
 *   block length. An item needing less than the minimum gets one block of
 *   exactly what it needs; otherwise no block is shorter than the minimum, and a
 *   split that would leave a stub shorter than the minimum is avoided.
 * - Two blocks of the same item are at least `BREAK_MINUTES` apart, so one item
 *   never runs past the maximum block length without a break.
 * - The day cap counts per work-window day: time after midnight in a window
 *   that started the evening before counts toward that evening.
 * - Blocks end before `due - buffer` when they can. When they cannot, they may
 *   eat into the buffer; each such block is flagged `insideBuffer`.
 * - What still does not fit is reported with the hours short, unless what is
 *   left is shorter than the minimum block (not worth a block of its own).
 */
import type { Interval, Preferences, StudyBlock } from "../types.js";
import { addDaysToKey, isHHMM, isValidTimeZone, localDateKey, parseDateKey, parseHHMM, weekdayOfKey, zonedTimeToUtc } from "../tz.js";

export interface PlanItem {
  itemId: string;
  title: string;
  dueAt?: string;
  unlockAt?: string;
  hoursNeeded: number;
  /** Higher first among equal deadlines. */
  priority?: number;
  /**
   * Plan before everything with a deadline: missing or overdue work, passed
   * without `dueAt`, gets the first free time rather than what is left over.
   * Ties among these go by priority.
   */
  asap?: boolean;
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
  /** Block starts and lengths snap to this many minutes. Default 5. */
  gridMinutes?: number;
}

export interface ProposedBlock {
  itemId: string;
  title: string;
  start: string;
  end: string;
  minutes: number;
  /** True when the block ends after `due - buffer`. */
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
  /** Work-window date -> planned hours (including existing blocks). */
  dayLoad: Record<string, number>;
  freeHours: number;
  /** Work windows that could not be read (saved before validation), and similar. */
  warnings?: string[];
}

interface Slot {
  start: number;
  end: number;
  /** The local date the work window started on; the day cap counts per this key. */
  day: string;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Longest horizon the planner accepts. */
export const MAX_HORIZON_DAYS = 120;
/** Gap required between two blocks of the same item. */
export const BREAK_MINUTES = 30;

function toMs(iso: string, what: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) throw new RangeError(`${what} is not a valid date-time: ${iso}`);
  return t;
}

function ceilTo(ms: number, step: number): number {
  return Math.ceil(ms / step) * step;
}

function floorTo(ms: number, step: number): number {
  return Math.floor(ms / step) * step;
}

/** The one rule for whether a stored block still takes up time: busy for new blocks and counted in the day cap. */
export function blockOccupies(b: Pick<StudyBlock, "status">): boolean {
  return b.status !== "deleted";
}

function subtract(slots: Slot[], busy: Array<{ start: number; end: number }>): Slot[] {
  let out = slots;
  for (const b of busy) {
    if (!(b.end > b.start)) continue;
    const next: Slot[] = [];
    for (const s of out) {
      if (b.end <= s.start || b.start >= s.end) {
        next.push(s);
        continue;
      }
      if (b.start > s.start) next.push({ start: s.start, end: b.start, day: s.day });
      if (b.end < s.end) next.push({ start: b.end, end: s.end, day: s.day });
    }
    out = next;
  }
  return out;
}

/**
 * Problems with preferences, as messages; empty when they are usable. Pass the
 * merged preferences (current with the patch applied) so cross-field rules
 * (minimum block not above maximum) are checked.
 */
export function preferenceErrors(prefs: Partial<Preferences>): string[] {
  const errors: string[] = [];
  if (prefs.timezone !== undefined && !isValidTimeZone(prefs.timezone)) errors.push(`unknown time zone ${prefs.timezone}`);
  if (prefs.workWindows !== undefined) {
    if (!Array.isArray(prefs.workWindows)) errors.push("work windows must be a list");
    else
      prefs.workWindows.forEach((w, i) => {
        const at = `work window ${i + 1}`;
        if (!Number.isInteger(w?.weekday) || w.weekday < 0 || w.weekday > 6) errors.push(`${at}: weekday must be 0 (Sunday) to 6 (Saturday)`);
        if (!isHHMM(w?.start)) errors.push(`${at}: start must be HH:MM, 24-hour (got ${String(w?.start)})`);
        if (!isHHMM(w?.end)) errors.push(`${at}: end must be HH:MM, 24-hour (got ${String(w?.end)})`);
        if (isHHMM(w?.start) && w.start === w.end) errors.push(`${at}: start and end are the same time`);
      });
  }
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (prefs.maxHoursPerDay !== undefined && !(num(prefs.maxHoursPerDay) && prefs.maxHoursPerDay > 0 && prefs.maxHoursPerDay <= 24)) errors.push("max hours per day must be more than 0 and at most 24");
  if (prefs.minBlockMinutes !== undefined && !(num(prefs.minBlockMinutes) && prefs.minBlockMinutes >= 5 && prefs.minBlockMinutes <= 720)) errors.push("minimum block must be 5 to 720 minutes");
  if (prefs.maxBlockMinutes !== undefined && !(num(prefs.maxBlockMinutes) && prefs.maxBlockMinutes >= 5 && prefs.maxBlockMinutes <= 720)) errors.push("maximum block must be 5 to 720 minutes");
  if (num(prefs.minBlockMinutes) && num(prefs.maxBlockMinutes) && prefs.minBlockMinutes! > prefs.maxBlockMinutes!) errors.push(`minimum block (${prefs.minBlockMinutes} min) is longer than the maximum block (${prefs.maxBlockMinutes} min)`);
  if (prefs.bufferHoursBeforeDue !== undefined && !(num(prefs.bufferHoursBeforeDue) && prefs.bufferHoursBeforeDue >= 0 && prefs.bufferHoursBeforeDue <= 168)) errors.push("buffer before due must be 0 to 168 hours");
  return errors;
}

/**
 * How much of an item's need belongs inside a horizon that ends before the
 * item's working time does: the share of the time between now and
 * `due - buffer` that the horizon covers. Due inside the horizon (or no due
 * date): all of it.
 */
export function hoursNeededInHorizon(hours: number, opts: { now: string; horizonEnd: string; dueAt?: string | undefined; bufferHours: number }): number {
  if (!opts.dueAt) return hours;
  const now = new Date(opts.now).getTime();
  const end = new Date(opts.horizonEnd).getTime();
  const workEnd = new Date(opts.dueAt).getTime() - opts.bufferHours * HOUR;
  if (!(workEnd > end) || !(end > now)) return hours;
  return hours * Math.min(1, (end - now) / (workEnd - now));
}

interface Windows {
  windows: Slot[];
  warnings: string[];
}

/** Work windows as instants, per local day, from the day before `from` (for windows that run past midnight) to `to`. */
function workWindows(prefs: Preferences, from: number, to: number): Windows {
  const tz = prefs.timezone;
  const warnings: string[] = [];
  const parsed: Array<{ weekday: number; s: { hour: number; minute: number }; e: { hour: number; minute: number } }> = [];
  for (const w of prefs.workWindows) {
    try {
      parsed.push({ weekday: w.weekday, s: parseHHMM(w.start), e: parseHHMM(w.end) });
    } catch (err) {
      warnings.push(`skipped a work window: ${(err as Error).message}`);
    }
  }
  const windows: Slot[] = [];
  const lastKey = localDateKey(new Date(to), tz);
  let key = addDaysToKey(localDateKey(new Date(from), tz), -1);
  for (;;) {
    const wd = weekdayOfKey(key);
    const { year, month, day } = parseDateKey(key);
    for (const w of parsed) {
      if (w.weekday !== wd) continue;
      const start = zonedTimeToUtc(year, month, day, w.s.hour, w.s.minute, tz).getTime();
      const endsNextDay = w.e.hour * 60 + w.e.minute <= w.s.hour * 60 + w.s.minute;
      const ek = endsNextDay ? parseDateKey(addDaysToKey(key, 1)) : { year, month, day };
      if (endsNextDay && w.e.hour === w.s.hour && w.e.minute === w.s.minute) continue; // empty window
      const end = zonedTimeToUtc(ek.year, ek.month, ek.day, w.e.hour, w.e.minute, tz).getTime();
      const s = Math.max(start, from);
      const e = Math.min(end, to);
      if (e > s) windows.push({ start: s, end: e, day: key });
    }
    if (key >= lastKey) break;
    key = addDaysToKey(key, 1);
  }
  windows.sort((a, b) => a.start - b.start);
  // Overlapping windows (09-12 and 10-14, or last night's 21-02 and this morning's 00-03) are one stretch of time.
  const merged: Slot[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return { windows: merged, warnings };
}

interface Frame {
  from: number;
  to: number;
  grid: number;
  windows: Slot[];
  warnings: string[];
}

function frame(input: PlanInput): Frame {
  const grid = Math.max(1, Math.round(input.gridMinutes ?? 5)) * MIN;
  const now = toMs(input.now, "now");
  const from = ceilTo(Math.max(toMs(input.horizonStart, "horizon start"), now), grid);
  const to = toMs(input.horizonEnd, "horizon end");
  if (to - from > MAX_HORIZON_DAYS * DAY) throw new RangeError(`the planning horizon is longer than ${MAX_HORIZON_DAYS} days; plan a shorter period`);
  const { windows, warnings } = to > from ? workWindows(input.prefs, from, to) : { windows: [], warnings: [] };
  return { from, to, grid, windows, warnings };
}

function occupied(input: PlanInput): Array<{ start: number; end: number }> {
  return [
    ...input.busy.map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() })),
    ...input.existingBlocks.filter(blockOccupies).map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() })),
  ].filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
}

/** Slot with its start moved up to the grid; dropped when that leaves nothing. */
function gridSlots(slots: Slot[], grid: number): Slot[] {
  const out: Slot[] = [];
  for (const s of slots) {
    const start = ceilTo(s.start, grid);
    if (s.end - start >= grid) out.push({ start, end: s.end, day: s.day });
  }
  return out;
}

/** Free slots inside the work windows between horizonStart and horizonEnd, starting on the grid. */
export function freeSlots(input: PlanInput): Slot[] {
  const f = frame(input);
  const minBlock = input.prefs.minBlockMinutes * MIN;
  return gridSlots(subtract(f.windows, occupied(input)), f.grid)
    .filter((s) => s.end - s.start >= minBlock)
    .sort((a, b) => a.start - b.start);
}

interface Placement {
  start: number;
  take: number;
  day: string;
  /** False when taking this leaves a stub shorter than the minimum block. */
  clean: boolean;
}

export function planBlocks(input: PlanInput): PlanResult {
  const prefs = input.prefs;
  const tz = prefs.timezone;
  const strategy = input.strategy ?? "early";
  const f = frame(input);
  const grid = f.grid;
  const now = f.from;
  const horizonEnd = f.to;
  const bufferMs = Math.max(0, prefs.bufferHoursBeforeDue) * HOUR;
  const minBlock = Math.max(grid, ceilTo(prefs.minBlockMinutes * MIN, grid));
  const maxBlock = Math.max(minBlock, floorTo(prefs.maxBlockMinutes * MIN, grid));
  const dayCap = Math.max(0, prefs.maxHoursPerDay) * HOUR;
  const breakMs = ceilTo(BREAK_MINUTES * MIN, grid);
  const warnings = [...f.warnings];

  let slots = gridSlots(subtract(f.windows, occupied(input)), grid).sort((a, b) => a.start - b.start);
  const freeMs = slots.filter((s) => s.end - s.start >= minBlock).reduce((a, s) => a + (s.end - s.start), 0);
  const realNow = toMs(input.now, "now");

  // The day an instant counts toward: the window containing it, else its local date.
  const dayOf = (ms: number): string => f.windows.find((w) => w.start <= ms && ms < w.end)?.day ?? localDateKey(new Date(ms), tz);
  const load: Record<string, number> = {};
  const runs = new Map<string, Array<{ start: number; end: number }>>();
  const addRun = (itemId: string, start: number, end: number) => {
    const list = runs.get(itemId) ?? [];
    list.push({ start, end });
    runs.set(itemId, list);
  };
  for (const b of input.existingBlocks) {
    if (!blockOccupies(b)) continue;
    const start = new Date(b.start).getTime();
    const end = new Date(b.end).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const k = dayOf(start);
    load[k] = (load[k] ?? 0) + Math.max(0, end - start);
    addRun(b.itemId, start, end);
  }

  const blocks: ProposedBlock[] = [];
  const unscheduled: Unscheduled[] = [];

  const items = [...input.items]
    .filter((i) => i.hoursNeeded > 0 && Number.isFinite(i.hoursNeeded))
    .sort((a, b) => {
      if (!!a.asap !== !!b.asap) return a.asap ? -1 : 1;
      if (a.asap && b.asap) return (b.priority ?? 0) - (a.priority ?? 0);
      const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      if (da !== db) return da - db;
      return (b.priority ?? 0) - (a.priority ?? 0);
    });

  /** Where in `slot` a block of this item could go, between `earliest` and `latest`, and how long. */
  const placementIn = (slot: Slot, itemId: string, earliest: number, latest: number, remaining: number, want: number, need: number, target?: number): Placement | undefined => {
    let start = ceilTo(Math.max(slot.start, earliest), grid);
    let end = Math.min(slot.end, latest);
    // Keep a break between this item's blocks.
    for (let guard = 0; guard < 8; guard++) {
      let moved = false;
      for (const r of runs.get(itemId) ?? []) {
        if (r.end <= start && start < r.end + breakMs) {
          start = ceilTo(r.end + breakMs, grid);
          moved = true;
        }
        if (r.start >= start && r.start - breakMs < end) end = Math.min(end, r.start - breakMs);
        if (r.start < start && r.end > start) {
          start = ceilTo(r.end + breakMs, grid);
          moved = true;
        }
      }
      if (!moved) break;
    }
    const room = floorTo(end - start, grid);
    if (room <= 0) return undefined;
    const day = slot.day;
    const dayLeft = floorTo(dayCap - (load[day] ?? 0), grid);
    // Only an item that needs less than a minimum block in total gets a shorter block.
    const smallest = Math.min(minBlock, need);
    if (remaining < smallest || dayLeft < smallest || room < smallest) return undefined;
    let take = Math.min(remaining, want, room, maxBlock, dayLeft);
    if (take < smallest) return undefined;
    let clean = true;
    const tail = remaining - take;
    if (tail > 0 && tail < minBlock) {
      // Leave a stub of at least a minimum block, or take everything when it fits.
      if (remaining <= Math.min(room, maxBlock, dayLeft)) take = remaining;
      else if (remaining - minBlock >= minBlock) take = Math.min(take, remaining - minBlock);
      else clean = false;
    }
    // Even: slide the block toward its target inside the free stretch.
    if (target !== undefined) start = Math.min(Math.max(start, ceilTo(target - take / 2, grid)), floorTo(end - take, grid));
    return { start, take, day, clean };
  };

  const place = (item: PlanItem, earliest: number, latest: number, remainingMs: number, need: number, due: number | undefined): number => {
    let remaining = remainingMs;
    let cursor = earliest;
    for (let guard = 0; remaining > 0 && guard < 500; guard++) {
      // Even: aim at the first of k evenly spaced targets between the cursor and the deadline.
      const k = Math.max(1, Math.ceil(remaining / maxBlock));
      const want = strategy === "even" ? ceilTo(Math.ceil(remaining / k), grid) : remaining;
      const target = cursor + Math.max(0, latest - cursor) / (2 * k);
      const options: Placement[] = [];
      for (const s of slots) {
        if (s.end <= earliest || s.start >= latest) continue;
        const p = placementIn(s, item.itemId, earliest, latest, remaining, want, need, strategy === "even" ? target : undefined);
        if (p) options.push(p);
      }
      if (!options.length) break;
      const pool = options.some((o) => o.clean) ? options.filter((o) => o.clean) : options;
      const score = (o: Placement) => (strategy === "even" ? Math.abs(o.start + o.take / 2 - target) : o.start);
      const best = pool.reduce((a, b) => (score(b) < score(a) ? b : a));
      const blockEnd = best.start + best.take;
      blocks.push({
        itemId: item.itemId,
        title: item.title,
        start: new Date(best.start).toISOString(),
        end: new Date(blockEnd).toISOString(),
        minutes: best.take / MIN,
        insideBuffer: due !== undefined && blockEnd > due - bufferMs,
      });
      load[best.day] = (load[best.day] ?? 0) + best.take;
      addRun(item.itemId, best.start, blockEnd);
      remaining -= best.take;
      cursor = Math.max(cursor, blockEnd);
      slots = subtract(slots, [{ start: best.start, end: blockEnd }]).filter((s) => s.end > s.start);
    }
    return remaining;
  };

  for (const item of items) {
    const due = item.dueAt ? new Date(item.dueAt).getTime() : undefined;
    if (due !== undefined && !Number.isFinite(due)) {
      unscheduled.push({ itemId: item.itemId, title: item.title, hoursShort: item.hoursNeeded, reason: "the due date could not be read" });
      continue;
    }
    if (due !== undefined && due <= realNow) {
      unscheduled.push({ itemId: item.itemId, title: item.title, hoursShort: item.hoursNeeded, reason: "already due" });
      continue;
    }
    if (due !== undefined && due <= now) {
      unscheduled.push({ itemId: item.itemId, title: item.title, hoursShort: item.hoursNeeded, reason: "due before the planning period starts" });
      continue;
    }
    const unlock = item.unlockAt ? new Date(item.unlockAt).getTime() : NaN;
    const earliest = Math.max(now, Number.isFinite(unlock) ? unlock : now);
    const hardLatest = due !== undefined ? Math.min(due, horizonEnd) : horizonEnd;
    const softLatest = due !== undefined ? Math.min(due - bufferMs, horizonEnd) : horizonEnd;
    const need = ceilTo(Math.round(item.hoursNeeded * 3600) * 1000, grid); // whole seconds first: 125/60 h is not 125 min in floating point
    let remaining = need;
    if (softLatest > earliest) remaining = place(item, earliest, softLatest, remaining, need, due);
    if (remaining > 0 && hardLatest > Math.max(softLatest, earliest)) remaining = place(item, earliest, hardLatest, remaining, need, due);
    if (remaining > 0 && remaining < Math.min(minBlock, need)) {
      // A stub shorter than a block: add it to one of this item's blocks when there is room right after it.
      remaining = extendOne(item.itemId, remaining, hardLatest, due);
    }
    if (remaining >= Math.min(minBlock, need)) {
      const reason =
        earliest >= hardLatest
          ? due !== undefined && earliest >= due
            ? "it opens after the due date"
            : "it opens after the end of the horizon"
          : due !== undefined && due <= horizonEnd
            ? "not enough free time before the due date"
            : "not enough free time in the horizon";
      unscheduled.push({ itemId: item.itemId, title: item.title, hoursShort: Math.ceil((remaining / HOUR) * 4) / 4, reason });
    }
  }

  function extendOne(itemId: string, remaining: number, latest: number, due: number | undefined): number {
    for (const b of blocks) {
      if (b.itemId !== itemId) continue;
      const start = new Date(b.start).getTime();
      const end = new Date(b.end).getTime();
      const newEnd = end + remaining;
      const day = dayOf(start);
      if (newEnd > latest || newEnd - start > maxBlock || dayCap - (load[day] ?? 0) < remaining) continue;
      if (!slots.some((s) => s.start <= end && s.end >= newEnd)) continue;
      if ((runs.get(itemId) ?? []).some((r) => r.start !== start && r.start < newEnd + breakMs && r.start >= end)) continue;
      b.end = new Date(newEnd).toISOString();
      b.minutes += remaining / MIN;
      b.insideBuffer = due !== undefined && newEnd > due - bufferMs;
      const run = (runs.get(itemId) ?? []).find((r) => r.start === start);
      if (run) run.end = newEnd;
      load[day] = (load[day] ?? 0) + remaining;
      slots = subtract(slots, [{ start: end, end: newEnd }]).filter((s) => s.end > s.start);
      return 0;
    }
    return remaining;
  }

  blocks.sort((a, b) => a.start.localeCompare(b.start));
  const dayLoad: Record<string, number> = {};
  for (const [k, v] of Object.entries(load)) if (v > 0) dayLoad[k] = Math.round((v / HOUR) * 4) / 4;
  const out: PlanResult = { blocks, unscheduled, dayLoad, freeHours: Math.round((freeMs / HOUR) * 4) / 4 };
  if (warnings.length) out.warnings = warnings;
  return out;
}
