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

const tokenClient = (s: StubCanvas, sleep: () => Promise<void> = async () => {}) => new CanvasClient({ baseUrl: s.origin, token: s.token, sleep, allowHttpLoopback: true });
const dueOf = (s: StubCanvas, id: number) => s.fixtures.assignments.find((a) => a.id === id)!.due_at!;

describe("feed and token on the same assignment (B1)", () => {
  it("keeps the API's exact time when the feed only knows the date", async () => {
    const store = new Store();
    const user = store.createUser(null, null, { timezone: "America/New_York" });
    await syncWithClient(store, user.id, tokenClient(stub));
    await syncFeed(store, user.id, stub.feedUrl, { allowHttpLoopback: true, timezone: "America/New_York" });
    // 1001 is due 23:59 UTC, which the feed writes as a bare date.
    expect(store.getItem(user.id, "canvas:assignment:1001")!.item.dueAt).toBe(dueOf(stub, 1001));
    // A timed due (14:00) comes through the feed as an instant and agrees.
    expect(store.getItem(user.id, "canvas:assignment:3003")!.item.dueAt).toBe(dueOf(stub, 3003));
    await syncWithClient(store, user.id, tokenClient(stub));
    await syncFeed(store, user.id, stub.feedUrl, { allowHttpLoopback: true, timezone: "America/New_York" });
    expect(store.getItem(user.id, "canvas:assignment:1001")!.item.dueAt).toBe(dueOf(stub, 1001));
  });

  it("reads a date-only due as 23:59 in the student's zone for a feed-only student", async () => {
    const store = new Store();
    const user = store.createUser(null, null, {});
    const report = await syncFeed(store, user.id, stub.feedUrl, { allowHttpLoopback: true, timezone: "America/New_York" });
    expect(report.errors).toEqual([]);
    const date = dueOf(stub, 1001).slice(0, 10);
    const local = new Date(new Date(`${date}T23:59:00Z`).getTime() + 4 * 3_600_000).toISOString(); // EDT is UTC-4 in the stub's season
    const due = store.getItem(user.id, "canvas:assignment:1001")!.item.dueAt!;
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(due))).toBe(`${date}, 23:59`);
    expect(Math.abs(new Date(due).getTime() - new Date(local).getTime())).toBeLessThanOrEqual(3_600_000);
    const event = store.getItem(user.id, "canvas:event:8801")!.item;
    expect(event.endAt).toBe(stub.fixtures.events[0]!.end_at);
    // An unchanged feed writes nothing the second time.
    const before = store.listItems(user.id).map((r) => r.lastSeenAt);
    await new Promise((r) => setTimeout(r, 5));
    await syncFeed(store, user.id, stub.feedUrl, { allowHttpLoopback: true, timezone: "America/New_York" });
    expect(store.listItems(user.id).map((r) => r.lastSeenAt)).toEqual(before);
  });
});

describe("the shapes real Canvas sends (D7, B4, B6, B10)", () => {
  it("reads every planner type and submission state, and keeps a New Quiz a quiz", async () => {
    const store = new Store();
    const user = store.createUser(null, null, {});
    const report = await syncWithClient(store, user.id, tokenClient(stub));
    expect(report.errors).toEqual([]);
    const get = (id: string) => store.getItem(user.id, id);
    expect(get("canvas:assignment:3006")!.item.status).toBe("done");
    // Only missing_submissions returns it (older than the planner range); the dismissal still counts.
    expect(get("canvas:assignment:3007")!.item.status).toBe("dismissed");
    expect(get("canvas:assignment:2005")!.item).toMatchObject({ status: "submitted", late: true });
    expect(get("canvas:assignment:2006")!.item.status).toBe("excused");
    expect(get("canvas:assignment:3005")!.item.status).toBe("submitted");
    expect(get("canvas:page:77")!.item.kind).toBe("page");
    expect(get("canvas:note:12")!.item.kind).toBe("note");
    expect(get("canvas:peer_review:4401")!.item.kind).toBe("peer_review");
    expect(get("canvas:discussion:7003")!.item.title).toBe("(untitled)");
    expect(store.listItems(user.id).some((r) => r.item.canvasId === "6001")).toBe(false); // the announcement
    expect(get("canvas:event:8801")!.item).toMatchObject({ endAt: stub.fixtures.events[0]!.end_at, allDay: false });

    const newQuiz = get("canvas:assignment:2004")!;
    expect(newQuiz.item).toMatchObject({ kind: "quiz", isExternalTool: true });
    // Locked: the brief is withheld, so the fetch is not counted as done; it backs off instead.
    const locked = get("canvas:assignment:3008")!;
    expect(locked.detailsFetchedAt).toBeNull();
    expect(locked.detailsFailures).toBe(1);
    expect(locked.item.descriptionText).toBeUndefined();

    const detailGets = () => stub.requests.filter((r) => /\/assignments\/\d+/.test(r)).length;
    const before = detailGets();
    await syncWithClient(store, user.id, tokenClient(stub));
    expect(detailGets()).toBe(before);
    expect(get("canvas:assignment:2004")!.item.kind).toBe("quiz");
    expect(get("canvas:assignment:2004")!.versionHash).toBe(newQuiz.versionHash);
  });
});

describe("throttles and refusals (B2)", () => {
  it("retries Canvas's 403 Rate Limit Exceeded", async () => {
    const s = await startStubCanvas(0, { rateLimit403Once: true });
    try {
      let sleeps = 0;
      const store = new Store();
      const user = store.createUser(null, null, {});
      const report = await syncWithClient(store, user.id, tokenClient(s, async () => void sleeps++));
      expect(report.errors).toEqual([]);
      expect(sleeps).toBe(1);
      expect(report.items).toBeGreaterThan(10);
    } finally {
      await s.close();
    }
  });

  it("does not retry a plain 403, counts failed fetches against the budget and backs off on them", async () => {
    const s = await startStubCanvas(0, { forbidDetails: true });
    try {
      // Enough open work to exceed the 40-fetch budget.
      const template = s.fixtures.assignments.find((a) => a.id === 3002)!;
      for (let i = 0; i < 60; i++) s.fixtures.assignments.push({ ...template, id: 5000 + i, name: `Extra ${i}`, due_at: new Date(Date.now() + (i + 1) * 3_600_000).toISOString() });
      let sleeps = 0;
      const store = new Store();
      const user = store.createUser(null, null, {});
      const detailGets = () => s.requests.filter((r) => /\/assignments\/\d+/.test(r)).length;
      const report = await syncWithClient(store, user.id, tokenClient(s, async () => void sleeps++));
      expect(sleeps).toBe(0);
      expect(detailGets()).toBe(40);
      // Soonest due first: the extras due within the hour were asked for, the far ones were not.
      expect(s.requests.some((r) => r.includes("/assignments/5000"))).toBe(true);
      expect(s.requests.some((r) => r.includes("/assignments/5059"))).toBe(false);
      expect(report.errors.length).toBeLessThanOrEqual(4);
      expect(report.errors.join(" ")).toMatch(/403/);
      expect(store.getItem(user.id, "canvas:assignment:5000")!.detailsFailures).toBe(1);
      const mark = s.requests.length;
      await syncWithClient(store, user.id, tokenClient(s));
      // The 40 that failed wait an hour; the rest get their turn.
      const asked = s.requests.slice(mark).filter((r) => /\/assignments\/\d+/.test(r));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.length).toBeLessThanOrEqual(40);
      expect(asked.some((r) => r.includes("/assignments/5000?"))).toBe(false);
      expect(asked.some((r) => r.includes("/assignments/5059?"))).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("work Canvas stops listing (B3)", () => {
  it("marks deleted assignments and events gone after a token sync, and brings them back", async () => {
    const s = await startStubCanvas(0, {});
    try {
      const store = new Store();
      const user = store.createUser(null, null, {});
      await syncWithClient(store, user.id, tokenClient(s));
      const ids = () => store.listItems(user.id).map((r) => r.item.id);
      expect(ids()).toContain("canvas:assignment:3002");
      const hw6 = s.fixtures.assignments.splice(s.fixtures.assignments.findIndex((a) => a.id === 3002), 1)[0]!;
      const event = s.fixtures.events.splice(0, 1)[0]!;
      const report = await syncWithClient(store, user.id, tokenClient(s));
      expect(report.removed).toBe(2);
      expect(ids()).not.toContain("canvas:assignment:3002");
      expect(ids()).not.toContain("canvas:event:8801");
      expect(store.getItem(user.id, "canvas:assignment:3002")!.goneAt).toBeTruthy();
      // Older work outside the planner range stays.
      expect(ids()).toContain("canvas:assignment:3007");
      s.fixtures.assignments.push(hw6);
      s.fixtures.events.push(event);
      await syncWithClient(store, user.id, tokenClient(s));
      expect(ids()).toContain("canvas:assignment:3002");
      expect(ids()).toContain("canvas:event:8801");
    } finally {
      await s.close();
    }
  });

  it("marks feed rows gone when the feed drops them", async () => {
    const s = await startStubCanvas(0, {});
    try {
      const store = new Store();
      const user = store.createUser(null, null, {});
      await syncFeed(store, user.id, s.feedUrl, { allowHttpLoopback: true });
      s.fixtures.assignments.splice(s.fixtures.assignments.findIndex((a) => a.id === 1002), 1);
      const report = await syncFeed(store, user.id, s.feedUrl, { allowHttpLoopback: true });
      expect(report.removed).toBe(1);
      expect(store.listItems(user.id).map((r) => r.item.id)).not.toContain("canvas:assignment:1002");
      expect(store.listItems(user.id).map((r) => r.item.id)).toContain("canvas:assignment:1001");
    } finally {
      await s.close();
    }
  });

  it("sweeps an extension snapshot only when it says which range it covers", async () => {
    const cookieFetch: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: "canvas_session=ok" } });
    const client = new CanvasClient({ baseUrl: stub.origin, fetch: cookieFetch, withCredentials: true, sleep: async () => {}, allowHttpLoopback: true });
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const plannerItems = await client.plannerItems(day(-14), day(120));
    const store = new Store();
    const user = store.createUser(null, null, {});
    const base = { baseUrl: stub.origin, fetchedAt: new Date().toISOString(), courses: [] as unknown[] };
    ingestSnapshot(store, user.id, { ...base, plannerItems });
    const fewer = plannerItems.filter((p) => (p as { plannable_id: number }).plannable_id !== 3002);
    expect(ingestSnapshot(store, user.id, { ...base, plannerItems: fewer }).removed).toBeUndefined();
    expect(store.listItems(user.id).map((r) => r.item.id)).toContain("canvas:assignment:3002");
    const report = ingestSnapshot(store, user.id, { ...base, plannerItems: fewer, plannerWindow: { start: day(-14), end: day(120) }, detailFailures: ["1001"] });
    expect(report.removed).toBe(1);
    expect(store.listItems(user.id).map((r) => r.item.id)).not.toContain("canvas:assignment:3002");
    expect(store.getItem(user.id, "canvas:assignment:1001")!.detailsFailures).toBe(1);
  });
});
