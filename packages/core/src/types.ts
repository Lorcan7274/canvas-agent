/**
 * Domain model shared by the server, the extension ingest path and the tests.
 *
 * Every piece of student work is a WorkItem, whatever Canvas calls it and
 * whichever credential it arrived through. Ids are stable across sources so
 * that the calendar feed, a token sync and an extension sync all land on the
 * same row: `canvas:assignment:123`, `canvas:quiz:45`, `canvas:event:9`.
 */

export type ItemKind =
  | "assignment"
  | "quiz"
  | "discussion"
  | "page"
  | "event"
  | "peer_review"
  | "note"
  | "other";

export type ItemStatus =
  | "open"
  | "submitted"
  | "graded"
  | "late"
  | "missing"
  | "excused"
  | "done" // student marked it complete in the Canvas planner
  | "dismissed"; // student dismissed it from the Canvas planner

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
  canvasType?: string; // the Canvas plannable_type or object kind, verbatim
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
  /** For calendar events: when it ends, so the planner can treat it as busy time. */
  endAt?: string;
  /** For calendar events: an all-day event (a holiday, a reading day); dueAt..endAt spans whole days, not busy hours. */
  allDay?: boolean;
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

/** `llm_failed` is only ever stored (a negative cache entry for a task card), never returned by an estimate. */
export type EstimateBasis = "heuristic" | "llm" | "calibrated" | "logged" | "llm_failed";

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
  /** Log-space spread behind p80 (p80 = p50 · e^(0.8416·sigma)). Stored with a task card. */
  sigma?: number;
  /** For an `llm_failed` entry: when asking the model again is worth it. */
  retryAfter?: string;
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
  start: string; // "HH:MM" local
  end: string; // "HH:MM" local
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

export const DEFAULT_PREFERENCES: Preferences = {
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
  /**
   * The planner range `plannerItems` covers (`YYYY-MM-DD`, as sent to Canvas).
   * Send it only when the planner list was read to its last page: the server
   * then marks items in that range that Canvas no longer lists as gone.
   */
  plannerWindow?: { start: string; end: string };
  /** Assignment ids from the wanted list whose detail fetch failed, so the server backs off on them. */
  detailFailures?: string[];
}
