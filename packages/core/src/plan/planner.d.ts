/**
 * Places study blocks into free time. Earliest-deadline-first with a per-day
 * cap, a buffer before each due time, and either "early" (start as soon as
 * possible) or "even" (spread each item between now and its deadline).
 *
 * Pure: takes instants and returns instants. The caller supplies busy time
 * from whatever calendar it has.
 */
import type { Interval, Preferences, StudyBlock } from "../types.js";
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
/** Free slots inside the work windows between horizonStart and horizonEnd. */
export declare function freeSlots(input: PlanInput): Slot[];
export declare function planBlocks(input: PlanInput): PlanResult;
export {};
