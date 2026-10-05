/**
 * Turns raw Canvas JSON (planner items, assignments, quizzes, courses) into
 * WorkItems. The same code runs on a token sync and on an extension snapshot,
 * so both paths produce identical rows.
 */
import type { Course, ItemKind, WorkItem } from "../types.js";
export declare function normaliseCourse(raw: unknown): Course | undefined;
export declare function itemIdFor(kind: ItemKind, canvasId: string, assignmentId?: string): string;
export interface NormaliseContext {
    baseUrl: string;
    courses: Map<string, Course>;
    now: string;
}
export declare function hostOf(baseUrl: string): string;
export declare function normalisePlannerItem(raw: unknown, ctx: NormaliseContext): WorkItem | undefined;
/** Merges a full Assignment object into an item (or builds one from it). */
export declare function applyAssignment(raw: unknown, ctx: NormaliseContext, existing?: WorkItem): WorkItem | undefined;
export declare function applyQuiz(raw: unknown, item: WorkItem): WorkItem;
/** Items that carry nothing a student acts on: dismissed, past events already over. */
export declare function isActionable(item: WorkItem, nowIso: string): boolean;
