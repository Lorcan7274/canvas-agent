/**
 * Domain model shared by the server, the extension ingest path and the tests.
 *
 * Every piece of student work is a WorkItem, whatever Canvas calls it and
 * whichever credential it arrived through. Ids are stable across sources so
 * that the calendar feed, a token sync and an extension sync all land on the
 * same row: `canvas:assignment:123`, `canvas:quiz:45`, `canvas:event:9`.
 */
export type ItemKind = "assignment" | "quiz" | "discussion" | "page" | "event" | "peer_review" | "note" | "other";
export type ItemStatus = "open" | "submitted" | "graded" | "late" | "missing" | "excused" | "done" | "dismissed";
export type ItemSource = "canvas" | "feed" | "manual";
export interface Course {
    id: string;
    name: string;
    code: string;
    termName?: string;
    termEndsAt?: string;
}
export interface QuizFacts {
    timeLimitMinutes?: number;
    questionCount?: number;
    allowedAttempts?: number;
    quizType?: string;
}
export interface WorkItem {
    id: string;
    source: ItemSource;
    /** Hostname of the Canvas instance, e.g. `canvas.school.edu`. */
    host?: string;
    canvasType?: string;
    canvasId?: string;
    /** Set when the item is graded through an assignment (quizzes, discussions). */
    assignmentId?: string;
    quizId?: string;
    late?: boolean;
    courseId?: string;
    courseCode?: string;
    courseName?: string;
    kind: ItemKind;
    title: string;
    url?: string;
    dueAt?: string;
    unlockAt?: string;
    lockAt?: string;
    pointsPossible?: number;
    submissionTypes?: string[];
    allowedAttempts?: number;
    descriptionText?: string;
    descriptionChars?: number;
    rubricCriteria?: number;
    peerReviews?: boolean;
    isGroup?: boolean;
    isExternalTool?: boolean;
    quiz?: QuizFacts;
    status: ItemStatus;
    submittedAt?: string;
    score?: number;
    markedComplete?: boolean;
    dismissed?: boolean;
    /** When Canvas last changed the object, or when we last saw it. */
    updatedAt: string;
}
export type EstimateBasis = "heuristic" | "llm" | "calibrated" | "logged";
export interface Estimate {
    itemId: string;
    p50Hours: number;
    p80Hours: number;
    basis: EstimateBasis;
    confidence: "low" | "medium" | "high";
    reasoning?: string;
    steps?: string[];
    /** Hash of the item fields the estimate was derived from. */
    versionHash: string;
    createdAt: string;
}
export interface Actual {
    id: string;
    itemId: string;
    minutes: number;
    source: "bucket" | "exact" | "calendar";
    createdAt: string;
}
export type BlockStatus = "planned" | "kept" | "moved" | "deleted" | "done";
export interface StudyBlock {
    id: string;
    itemId: string;
    start: string;
    end: string;
    minutes: number;
    status: BlockStatus;
    calendarEventId?: string;
    calendarId?: string;
    createdAt: string;
    updatedAt: string;
}
export interface Interval {
    start: string;
    end: string;
}
export interface WorkWindow {
    /** 0 = Sunday ... 6 = Saturday, matching Date#getDay. */
    weekday: number;
    start: string;
    end: string;
}
export interface Preferences {
    timezone: string;
    workWindows: WorkWindow[];
    maxHoursPerDay: number;
    minBlockMinutes: number;
    maxBlockMinutes: number;
    /** Finish this many hours before the due time. */
    bufferHoursBeforeDue: number;
    /** Which assistant the "Plan my week" button opens. */
    assistant: "claude" | "chatgpt" | "custom";
    assistantUrl?: string;
}
export declare const DEFAULT_PREFERENCES: Preferences;
/** What the extension posts after reading Canvas with the student's session. */
export interface CanvasSnapshot {
    baseUrl: string;
    fetchedAt: string;
    courses: unknown[];
    plannerItems: unknown[];
    missingSubmissions?: unknown[];
    /** Keyed by assignment id, only for items whose details were fetched. */
    assignments?: Record<string, unknown>;
    /** Keyed by quiz id. */
    quizzes?: Record<string, unknown>;
}
