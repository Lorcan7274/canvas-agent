/** Time-zone arithmetic on Intl alone, so the planner needs no date library. */
export interface ZonedParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: number;
}
export declare function isValidTimeZone(tz: string): boolean;
export declare function zonedParts(date: Date, tz: string): ZonedParts;
/** The UTC instant for a wall-clock time in `tz`. Resolves DST gaps forward. */
export declare function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date;
export declare function localDateKey(date: Date, tz: string): string;
export declare function parseDateKey(key: string): {
    year: number;
    month: number;
    day: number;
};
export declare function addDaysToKey(key: string, days: number): string;
export declare function parseHHMM(s: string): {
    hour: number;
    minute: number;
};
/** Formats an instant for a human in the given zone: "Tue 7 Oct, 17:00". */
export declare function formatLocal(iso: string, tz: string): string;
