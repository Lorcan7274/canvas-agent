import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStubCanvas, type StubCanvas } from "@canvas-agent/stub-canvas";
import { CanvasClient, EstimateService, Store, ingestSnapshot, syncFeed, syncWithClient } from "@canvas-agent/core";

let stub: StubCanvas;

beforeAll(async () => {
  stub = await startStubCanvas(0, { perPage: 4, throttleOnce: true });
});
afterAll(async () => {
  await stub.close();
});

describe("token sync against the stub Canvas", () => {
  it("pulls courses, planner items, details and quiz facts, surviving pagination and a 429", async () => {
    const store = new Store();
    const user = store.createUser("sam@example.edu", "Sam", {});
    const client = new CanvasClient({ baseUrl: stub.origin, token: stub.token, sleep: async () => {}, allowHttpLoopback: true });
    const report = await syncWithClient(store, user.id, client);
    expect(report.courses).toBe(3);
    expect(report.errors).toEqual([]);
    expect(report.items).toBeGreaterThanOrEqual(11);

    const items = store.listItems(user.id);
    const quiz = items.find((r) => r.item.id === "canvas:assignment:1003")!.item;
    expect(quiz.kind).toBe("quiz");
    expect(quiz.quiz?.timeLimitMinutes).toBe(30);
    expect(quiz.courseCode).toBe("CHEM 101");

    const essay = items.find((r) => r.item.id === "canvas:assignment:2001")!.item;
    expect(essay.descriptionText).toContain("1500-word");
    expect(essay.rubricCriteria).toBe(4);
    expect(essay.peerReviews).toBe(true);

    const missing = items.find((r) => r.item.id === "canvas:assignment:3004")!.item;
    expect(missing.status).toBe("missing");

    const graded = items.find((r) => r.item.id === "canvas:assignment:1000")!.item;
    expect(graded.status).toBe("graded");

    const event = items.find((r) => r.item.id === "canvas:event:8801")!.item;
    expect(event.kind).toBe("event");

    // Pagination was exercised: more than one planner page was requested.
    expect(stub.requests.filter((r) => r.includes("/api/v1/planner/items")).length).toBeGreaterThan(2);
  });

  it("does not refetch unchanged details on a second sync", async () => {
    const store = new Store();
    const user = store.createUser(null, null, {});
    const client = new CanvasClient({ baseUrl: stub.origin, token: stub.token, sleep: async () => {}, allowHttpLoopback: true });
    await syncWithClient(store, user.id, client);
    const before = stub.requests.filter((r) => /\/assignments\/\d+/.test(r)).length;
    await syncWithClient(store, user.id, client);
    const after = stub.requests.filter((r) => /\/assignments\/\d+/.test(r)).length;
    // Only the missing-submissions path re-applies assignment objects; detail GETs are skipped.
    expect(after).toBe(before);
  });
});

describe("feed sync", () => {
  it("creates thin items that a later token sync enriches without losing the feed's due dates", async () => {
    const store = new Store();
    const user = store.createUser(null, null, {});
    const feed = await syncFeed(store, user.id, stub.feedUrl, { allowHttpLoopback: true });
    expect(feed.items).toBeGreaterThanOrEqual(10);
    const thin = store.getItem(user.id, "canvas:assignment:2001")!.item;
    expect(thin.source).toBe("feed");
    expect(thin.courseCode).toBe("SOC 110");
    expect(thin.pointsPossible).toBeUndefined();

    const client = new CanvasClient({ baseUrl: stub.origin, token: stub.token, sleep: async () => {}, allowHttpLoopback: true });
    await syncWithClient(store, user.id, client);
    const rich = store.getItem(user.id, "canvas:assignment:2001")!.item;
    expect(rich.source).toBe("canvas");
    expect(rich.pointsPossible).toBe(100);

    await syncFeed(store, user.id, stub.feedUrl, { allowHttpLoopback: true });
    const again = store.getItem(user.id, "canvas:assignment:2001")!.item;
    expect(again.pointsPossible).toBe(100);
    expect(again.source).toBe("canvas");
  });
});

describe("extension snapshot ingest", () => {
  it("accepts raw Canvas JSON read with a session cookie", async () => {
    const cookieFetch: typeof fetch = (input, init) =>
      fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: "canvas_session=ok" } });
    const client = new CanvasClient({ baseUrl: stub.origin, fetch: cookieFetch, withCredentials: true, sleep: async () => {}, allowHttpLoopback: true });
    const courses = await client.courses();
    const plannerItems = await client.plannerItems("2026-01-01", "2027-12-31");
    const assignments: Record<string, unknown> = {};
    assignments["2001"] = await client.assignment("202", "2001");
    const quizzes: Record<string, unknown> = { "501": await client.quiz("101", "501") };
    assignments["1003"] = await client.assignment("101", "1003");

    const store = new Store();
    const user = store.createUser(null, null, {});
    const report = ingestSnapshot(store, user.id, { baseUrl: stub.origin, fetchedAt: new Date().toISOString(), courses, plannerItems, assignments, quizzes });
    expect(report.courses).toBe(3);
    expect(report.detailsFetched).toBe(2);
    const quiz = store.getItem(user.id, "canvas:assignment:1003")!.item;
    expect(quiz.quiz?.questionCount).toBe(15);
  });

  it("strips the while(1); prefix when Accept is not JSON", async () => {
    const res = await fetch(`${stub.origin}/api/v1/users/self`, { headers: { cookie: "canvas_session=ok" } });
    const text = await res.text();
    expect(text.startsWith("while(1);")).toBe(true);
  });
});

describe("estimates over synced items", () => {
  it("produces heuristic priors and calibrates from a logged actual", async () => {
    const store = new Store();
    const user = store.createUser(null, null, {});
    const client = new CanvasClient({ baseUrl: stub.origin, token: stub.token, sleep: async () => {}, allowHttpLoopback: true });
    await syncWithClient(store, user.id, client);
    const svc = new EstimateService(store);
    const ps5 = store.getItem(user.id, "canvas:assignment:1001")!.item;
    const first = await svc.estimate(user.id, ps5);
    expect(first.basis).toBe("heuristic");
    expect(first.p50Hours).toBe(3.75);

    const hw6 = store.getItem(user.id, "canvas:assignment:3002")!.item;
    const hwEst = await svc.estimate(user.id, hw6);
    store.addActual(user.id, { itemId: hw6.id, courseId: hw6.courseId, minutes: Math.round(hwEst.p50Hours * 60 * 2), source: "exact", estimatedHours: hwEst.p50Hours });

    const second = await svc.estimate(user.id, ps5);
    expect(second.basis).toBe("calibrated");
    expect(second.p50Hours).toBeGreaterThan(first.p50Hours);

    const logged = await svc.estimate(user.id, hw6);
    expect(logged.basis).toBe("logged");
  });
});
