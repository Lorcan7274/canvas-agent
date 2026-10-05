/**
 * Domain model shared by the server, the extension ingest path and the tests.
 *
 * Every piece of student work is a WorkItem, whatever Canvas calls it and
 * whichever credential it arrived through. Ids are stable across sources so
 * that the calendar feed, a token sync and an extension sync all land on the
 * same row: `canvas:assignment:123`, `canvas:quiz:45`, `canvas:event:9`.
 */
export const DEFAULT_PREFERENCES = {
    timezone: "UTC",
    workWindows: [
        { weekday: 0, start: "13:00", end: "21:00" },
        { weekday: 1, start: "17:00", end: "22:00" },
        { weekday: 2, start: "17:00", end: "22:00" },
        { weekday: 3, start: "17:00", end: "22:00" },
        { weekday: 4, start: "17:00", end: "22:00" },
        { weekday: 5, start: "15:00", end: "20:00" },
        { weekday: 6, start: "10:00", end: "18:00" },
    ],
    maxHoursPerDay: 5,
    minBlockMinutes: 45,
    maxBlockMinutes: 120,
    bufferHoursBeforeDue: 12,
    assistant: "claude",
};
//# sourceMappingURL=types.js.map