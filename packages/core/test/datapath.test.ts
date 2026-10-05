import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type ItemRow } from "../src/store/db.js";
import { detailRetryDelayMs, needsDetails, pickDetailCandidates, saveItem } from "../src/sync.js";
import { CanvasClient, CanvasError, isThrottleResponse } from "../src/canvas/client.js";
import type { WorkItem } from "../src/types.js";

const NOW = "2026-10-05T12:00:00.000Z";
const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: `canvas:assignment:${id}`,
  source: "canvas",
  host: "canvas.example.edu",
  kind: "assignment",
  title: `A ${id}`,
  status: "open",
  assignmentId: id,
  courseId: "101",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});
const row = (i: WorkItem, over: Partial<ItemRow> = {}): ItemRow => ({
  item: i,
  versionHash: "v",
  detailsFetchedAt: null,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  detailsFailures: 0,
  detailsFailedAt: null,
  goneAt: null,
  ...over,
});

describe("needsDetails: one rule for the token sync and the extension (B6)", () => {
  it("fetches new, changed and newly unlocked work, and nothing finished", () => {
    expect(needsDetails(row(item("1")), NOW)).toBe(true);
    expect(needsDetails(row(item("1"), { detailsFetchedAt: "2026-10-02T00:00:00.000Z" }), NOW)).toBe(false);
    // Edited in Canvas after the last fetch (the extension path never refreshed these before).
    expect(needsDetails(row(item("1", { updatedAt: "2026-10-03T00:00:00Z" }), { detailsFetchedAt: "2026-10-02T00:00:00.000Z" }), NOW)).toBe(true);
    // Fetched while locked; it has unlocked since.
    expect(needsDetails(row(item("1", { unlockAt: "2026-10-04T00:00:00Z" }), { detailsFetchedAt: "2026-10-02T00:00:00.000Z" }), NOW)).toBe(true);
    expect(needsDetails(row(item("1", { unlockAt: "2026-10-09T00:00:00Z" }), { detailsFetchedAt: "2026-10-02T00:00:00.000Z" }), NOW)).toBe(false);
    for (const status of ["done", "dismissed", "graded", "submitted", "excused"] as const) expect(needsDetails(row(item("1", { status })), NOW), status).toBe(false);
    expect(needsDetails(row(item("1", { status: "missing" })), NOW)).toBe(true);
    expect(needsDetails(row(item("1", { courseId: undefined } as Partial<WorkItem>)), NOW)).toBe(false);
  });

  it("backs off after failures unless Canvas changed or unlocked the item", () => {
    const failedAt = "2026-10-05T11:30:00.000Z";
    expect(needsDetails(row(item("1"), { detailsFailures: 1, detailsFailedAt: failedAt }), NOW)).toBe(false);
    expect(needsDetails(row(item("1"), { detailsFailures: 1, detailsFailedAt: "2026-10-05T10:30:00.000Z" }), NOW)).toBe(true);
    expect(needsDetails(row(item("1"), { detailsFailures: 3, detailsFailedAt: "2026-10-05T00:00:00.000Z" }), NOW)).toBe(false);
    expect(needsDetails(row(item("1", { updatedAt: "2026-10-05T11:45:00Z" }), { detailsFailures: 3, detailsFailedAt: failedAt }), NOW)).toBe(true);
    expect(needsDetails(row(item("1", { unlockAt: "2026-10-05T11:50:00Z" }), { detailsFailures: 3, detailsFailedAt: failedAt }), NOW)).toBe(true);
    expect([1, 2, 3, 4, 5, 9].map((n) => detailRetryDelayMs(n) / 3_600_000)).toEqual([1, 4, 16, 64, 168, 168]);
  });

  it("orders candidates upcoming first, then undated, then past due", () => {
    const rows = [
      row(item("past-old", { dueAt: "2026-09-20T00:00:00Z" })),
      row(item("later", { dueAt: "2026-10-20T00:00:00Z" })),
      row(item("undated")),
      row(item("past-recent", { dueAt: "2026-10-04T00:00:00Z" })),
      row(item("soon", { dueAt: "2026-10-06T00:00:00Z" })),
      row(item("done", { dueAt: "2026-10-06T00:00:00Z", status: "submitted" })),
    ];
    expect(pickDetailCandidates(rows, NOW).map((r) => r.item.assignmentId)).toEqual(["soon", "later", "undated", "past-recent", "past-old"]);
    expect(pickDetailCandidates(rows, NOW, 2)).toHaveLength(2);
  });
});

describe("the item store (B3, B8)", () => {
  it("filters on due_at in SQL, in one time format, and leaves gone rows out until they come back", () => {
    const store = new Store();
    const u = store.createUser(null, null);
    saveItem(store, u.id, item("1", { dueAt: "2026-10-07T23:59:00Z" }));
    saveItem(store, u.id, item("2", { dueAt: "2026-10-07T23:59:00.000Z" }));
    saveItem(store, u.id, item("3"));
    const ids = (o: Parameters<Store["listItems"]>[1]) => store.listItems(u.id, o).map((r) => r.item.assignmentId);
    // Both spellings of the same instant sit on the boundary.
    expect(ids({ from: "2026-10-07T23:59:00.000Z", to: "2026-10-07T23:59:00Z", includeUndated: false })).toEqual(["1", "2"]);
    expect(ids({ to: "2026-10-01T00:00:00Z" })).toEqual(["3"]);
    store.markItemsGone(u.id, ["canvas:assignment:1"]);
    expect(ids({})).toEqual(["2", "3"]);
    expect(ids({ includeGone: true })).toEqual(["1", "2", "3"]);
    expect(store.getItem(u.id, "canvas:assignment:1")?.goneAt).toBeTruthy();
    saveItem(store, u.id, item("1", { dueAt: "2026-10-07T23:59:00Z" }));
    expect(store.getItem(u.id, "canvas:assignment:1")?.goneAt).toBeNull();
  });

  it("writes nothing for an unchanged item, and resets the retry count on a fetch", () => {
    const store = new Store();
    const u = store.createUser(null, null);
    const a = item("1", { dueAt: "2026-10-07T23:59:00Z" });
    expect(store.upsertItem(u.id, a, "v1")).toBe(true);
    expect(store.upsertItem(u.id, { ...a }, "v1")).toBe(false);
    expect(store.upsertItem(u.id, { ...a, title: "renamed" }, "v1")).toBe(true);
    store.markDetailsFailed(u.id, [a.id]);
    store.markDetailsFailed(u.id, [a.id]);
    expect(store.getItem(u.id, a.id)).toMatchObject({ detailsFailures: 2 });
    expect(store.upsertItem(u.id, { ...a, title: "renamed" }, "v1", { detailsFetched: true })).toBe(true);
    expect(store.getItem(u.id, a.id)).toMatchObject({ detailsFailures: 0, detailsFailedAt: null });
    expect(store.getItem(u.id, a.id)?.detailsFetchedAt).toBeTruthy();
  });

  it("migrates an older file: user_version, new columns, due_at in one format", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-agent-"));
    const path = join(dir, "old.db");
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE items (user_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL, source TEXT NOT NULL,
        version_hash TEXT NOT NULL, details_fetched_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (user_id, id));`);
      old.prepare("INSERT INTO items VALUES ('u', 'canvas:assignment:1', ?, '2026-10-07T23:59:00Z', 'open', 'canvas', 'v', NULL, 'x', 'x')").run(JSON.stringify(item("1", { dueAt: "2026-10-07T23:59:00Z" })));
      old.close();
      const store = new Store(path);
      expect(store.schemaVersion()).toBe(1);
      expect(store.db.prepare("SELECT due_at FROM items").get()).toEqual({ due_at: "2026-10-07T23:59:00.000Z" });
      expect(store.getItem("u", "canvas:assignment:1")).toMatchObject({ detailsFailures: 0, goneAt: null });
      store.close();
      const again = new Store(path);
      expect(again.schemaVersion()).toBe(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removing an account removes that Canvas's items unless another account reads it", () => {
    const store = new Store();
    const u = store.createUser(null, null);
    const token = store.upsertCanvasAccount({ userId: u.id, baseUrl: "https://canvas.example.edu", kind: "token", secretSealed: "x" });
    const feed = store.upsertCanvasAccount({ userId: u.id, baseUrl: "https://canvas.example.edu", kind: "feed", secretSealed: "y" });
    const other = store.upsertCanvasAccount({ userId: u.id, baseUrl: "https://other.instructure.com", kind: "token", secretSealed: "z" });
    saveItem(store, u.id, item("1"));
    saveItem(store, u.id, item("9", { host: "other.instructure.com" }));
    store.upsertCourse(u.id, { id: "101", name: "Chem", code: "CHEM 101" });
    expect(store.deleteCanvasAccount(u.id, token.id)).toEqual([]); // the feed still reads it
    expect(store.getItem(u.id, "canvas:assignment:1")).toBeDefined();
    expect(store.deleteCanvasAccount("someone-else", feed.id)).toEqual([]);
    expect(store.getCanvasAccount(feed.id)).toBeDefined();
    expect(store.deleteCanvasAccount(u.id, feed.id)).toEqual(["canvas:assignment:1"]);
    expect(store.getItem(u.id, "canvas:assignment:1")).toBeUndefined();
    expect(store.getItem(u.id, "canvas:assignment:9")).toBeDefined();
    expect(store.listCourses(u.id)).toHaveLength(1);
    expect(store.deleteCanvasAccount(u.id, other.id)).toEqual(["canvas:assignment:9"]);
    expect(store.listCourses(u.id)).toHaveLength(0);
  });
});

describe("Canvas throttling (B2)", () => {
  const answer = (status: number, body: string) => () =>
    Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json", "x-rate-limit-remaining": "650.5" } }));

  it("tells a throttle from a refusal by the body, not the quota header Canvas always sends", () => {
    expect(isThrottleResponse(429, "")).toBe(true);
    expect(isThrottleResponse(403, "403 Forbidden (Rate Limit Exceeded)")).toBe(true);
    expect(isThrottleResponse(403, '{"status":"unauthorized","errors":[{"message":"user not authorized to perform that action"}]}')).toBe(false);
  });

  it("does not retry a plain 403, and gives up on a lasting throttle with a throttled error", async () => {
    let sleeps = 0;
    const refused = new CanvasClient({ baseUrl: "https://canvas.example.edu", fetch: answer(403, '{"errors":[{"message":"user not authorized to perform that action"}]}'), sleep: async () => void sleeps++ });
    const e1 = (await refused.get("/api/v1/x").catch((e: unknown) => e)) as CanvasError;
    expect(e1.status).toBe(403);
    expect(e1.throttled).toBe(false);
    expect(sleeps).toBe(0);
    let calls = 0;
    const limited = new CanvasClient({
      baseUrl: "https://canvas.example.edu",
      maxRetries: 2,
      fetch: () => {
        calls++;
        return answer(403, "403 Forbidden (Rate Limit Exceeded)")();
      },
      sleep: async () => void sleeps++,
    });
    const e2 = (await limited.get("/api/v1/x").catch((e: unknown) => e)) as CanvasError;
    expect(e2.throttled).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toBe(2);
    expect(e2.message).not.toContain("Forbidden (Rate");
  });
});
