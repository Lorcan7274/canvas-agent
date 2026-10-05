/** Time-zone arithmetic on Intl alone, so the planner needs no date library. */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (local wall clock minus UTC). */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(new Date(ms), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0) - Math.floor(ms / 1000) * 1000;
}

const FOURTEEN_HOURS = 14 * 3_600_000;

/**
 * The UTC instant for a wall-clock time in `tz`.
 *
 * The two offsets in force fourteen hours either side of the wall time give at
 * most two candidate instants. When both read back as that wall time the clock
 * was set back (an overlap) and the earlier instant wins; when neither does the
 * time was skipped (a gap) and the later candidate wins, which moves the time
 * forward by the size of the gap (London 2026-03-29 01:30 -> 02:30 BST).
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const candidates = [...new Set([wall - offsetAt(wall - FOURTEEN_HOURS, tz), wall - offsetAt(wall + FOURTEEN_HOURS, tz)])];
  const exact = candidates.filter((t) => t + offsetAt(t, tz) === wall);
  return new Date(exact.length ? Math.min(...exact) : Math.max(...candidates));
}

export function localDateKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
}

export function addDaysToKey(key: string, days: number): string {
  const { year, month, day } = parseDateKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

/** Weekday of a `YYYY-MM-DD` date key, 0 = Sunday. A calendar date has a weekday in every zone. */
export function weekdayOfKey(key: string): number {
  const { year, month, day } = parseDateKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Strict "HH:MM", 24-hour, two digits each: what preferences accept. */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isHHMM(s: unknown): s is string {
  return typeof s === "string" && HHMM_RE.test(s);
}

/** Reads "HH:MM" (or "H:MM", for preferences saved before validation). Throws on anything else. */
export function parseHHMM(s: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) throw new Error(`bad time ${s}: use HH:MM, 24-hour`);
  return { hour, minute };
}

/** Formats an instant for a human in the given zone: "Tue 7 Oct, 17:00". */
export function formatLocal(iso: string, tz: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}
