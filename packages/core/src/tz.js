/** Time-zone arithmetic on Intl alone, so the planner needs no date library. */
const fmtCache = new Map();
function formatter(tz) {
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
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function isValidTimeZone(tz) {
    try {
        formatter(tz);
        return true;
    }
    catch {
        return false;
    }
}
export function zonedParts(date, tz) {
    const parts = formatter(tz).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "0";
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
/** The UTC instant for a wall-clock time in `tz`. Resolves DST gaps forward. */
export function zonedTimeToUtc(year, month, day, hour, minute, tz) {
    let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    for (let i = 0; i < 3; i++) {
        const p = zonedParts(new Date(guess), tz);
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
        const diff = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - asUtc;
        if (diff === 0)
            break;
        guess += diff;
    }
    return new Date(guess);
}
export function localDateKey(date, tz) {
    const p = zonedParts(date, tz);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function parseDateKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
}
export function addDaysToKey(key, days) {
    const { year, month, day } = parseDateKey(key);
    const d = new Date(Date.UTC(year, month - 1, day + days));
    return d.toISOString().slice(0, 10);
}
export function parseHHMM(s) {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m)
        throw new Error(`bad time ${s}`);
    return { hour: Number(m[1]), minute: Number(m[2]) };
}
/** Formats an instant for a human in the given zone: "Tue 7 Oct, 17:00". */
export function formatLocal(iso, tz) {
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
//# sourceMappingURL=tz.js.map