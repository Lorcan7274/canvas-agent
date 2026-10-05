/**
 * A small iCalendar reader for Canvas calendar feeds and a writer for the
 * planned-blocks feed. Only what Canvas emits is handled: VEVENT with
 * DTSTART/DTEND/DTSTAMP, SUMMARY, DESCRIPTION, UID, URL, LOCATION, and
 * line folding per RFC 5545.
 */
import type { WorkItem } from "./types.js";
export interface IcsEvent {
    uid: string;
    summary: string;
    description?: string;
    url?: string;
    start?: string;
    end?: string;
    allDay: boolean;
    location?: string;
    raw: Record<string, string>;
}
export declare function escapeText(v: string): string;
/** Parses an iCalendar date or date-time. Floating times are treated as UTC. */
export declare function parseIcsDate(value: string, params: Record<string, string>): {
    iso: string;
    allDay: boolean;
} | undefined;
export declare function parseIcs(text: string): IcsEvent[];
/**
 * Canvas UIDs look like `event-assignment-123`, `event-calendar-event-45`,
 * `event-assignment-override-78` and summaries like `Homework 3 [CHEM 101]`.
 */
export declare function canvasFeedEventToItem(ev: IcsEvent, nowIso: string, host?: string): WorkItem | undefined;
export interface IcsWriteEvent {
    uid: string;
    start: string;
    end: string;
    summary: string;
    description?: string;
    url?: string;
}
export declare function writeIcs(calendarName: string, events: IcsWriteEvent[], nowIso?: string): string;
