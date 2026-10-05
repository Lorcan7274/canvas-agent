/**
 * Getting work into the store: from a calendar feed, from a token, or from a
 * snapshot the extension took with the student's session. All three end in
 * `mergeItem`, so the richest data wins and nothing regresses.
 */
import type { CanvasSnapshot, WorkItem } from "./types.js";
import { CanvasClient } from "./canvas/client.js";
import { Store } from "./store/db.js";
export interface SyncReport {
    courses: number;
    items: number;
    detailsFetched: number;
    errors: string[];
}
/** Field-level merge: a thinner source never erases what a richer one stored. */
export declare function mergeItem(existing: WorkItem | undefined, incoming: WorkItem): WorkItem;
export declare function saveItem(store: Store, userId: string, incoming: WorkItem, opts?: {
    detailsFetched?: boolean;
}): WorkItem;
export declare function syncFeed(store: Store, userId: string, feedUrl: string, fetchImpl?: typeof fetch): Promise<SyncReport>;
export declare function syncWithClient(store: Store, userId: string, client: CanvasClient): Promise<SyncReport>;
export declare function ingestSnapshot(store: Store, userId: string, snap: CanvasSnapshot): SyncReport;
