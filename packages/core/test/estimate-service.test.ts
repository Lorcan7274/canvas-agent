import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ClaudeEstimator, TaskCardError, TaskCardSchema, taskCardFormat, taskCardPrompt, type LlmEstimator, type TaskCard } from "../src/estimate/llm.js";
import { EstimateService } from "../src/estimate/service.js";
import { TIME_BUCKETS } from "../src/estimate/calibrate.js";
import { Store, itemVersionHash } from "../src/store/db.js";
import { shortHash } from "../src/text.js";
import type { WorkItem } from "../src/types.js";

const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  shape: "paper",
  steps: ["read the prompt", "draft", "revise"],
  quantities: { pages: null, words: 1000, problems: null, questions: null, sources: null, stated_minutes: null },
  p50_hours: 2,
  p80_hours: 3,
  confidence: "medium",
  reasoning: "a 1000-word essay",
  ...over,
});

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "canvas:assignment:42",
  source: "canvas",
  host: "canvas.example.edu",
  kind: "assignment",
  title: "Essay 1",
  status: "open",
  courseId: "c1",
  dueAt: "2026-10-09T03:59:00Z",
  unlockAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  descriptionText: "Write 1000 words.",
  ...over,
});

class FakeLlm implements LlmEstimator {
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly answer: (i: WorkItem) => Promise<TaskCard | undefined>) {}
  async taskCard(i: WorkItem): Promise<TaskCard | undefined> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.answer(i);
    } finally {
      this.inFlight--;
    }
  }
}

const quiet = () => {};

function setup(llm?: LlmEstimator, clock = { t: Date.parse("2026-10-05T12:00:00Z") }) {
  const store = new Store();
  const user = store.createUser(null, null);
  const logs: Array<Record<string, unknown>> = [];
  const svc = new EstimateService(store, llm, { log: (_m, meta) => logs.push(meta), now: () => clock.t });
  return { store, user, svc, logs, clock };
}

describe("task card schema", () => {
  it("builds a structured-output format with the SDK helper and parses a card", () => {
    const format = zodOutputFormat(TaskCardSchema as never) as unknown as { type: string; schema: Record<string, unknown>; parse(s: string): TaskCard };
    expect(format.type).toBe("json_schema");
    expect(format.schema["type"]).toBe("object");
    expect(format.parse(JSON.stringify(card()))).toEqual(card());
    expect(taskCardFormat().parse(JSON.stringify(card()))).toEqual(card());
    expect(() => taskCardFormat().parse(JSON.stringify({ ...card(), p50_hours: "two" }))).toThrow();
  });
  it("keeps due and unlock dates out of the prompt", () => {
    const prompt = taskCardPrompt(item());
    expect(prompt).toContain("Essay 1");
    expect(prompt).not.toMatch(/2026|due|unlock/i);
  });
});

describe("ClaudeEstimator against a fake Messages API", () => {
  let server: Server;
  let baseURL: string;
  const bodies: Array<Record<string, unknown>> = [];
  let reply: (body: Record<string, unknown>) => Record<string, unknown> = () => ({});
  const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = JSON.parse(await read(req)) as Record<string, unknown>;
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply(body)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const message = (stop: string, text: string) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });

  it("asks for a structured task card and returns it", async () => {
    reply = () => message("end_turn", JSON.stringify(card()));
    const got = await new ClaudeEstimator({ apiKey: "test-key", baseURL }).taskCard(item());
    expect(got).toEqual(card());
    const body = bodies.at(-1)!;
    expect(body["model"]).toBe("claude-opus-5-5");
    expect((body["output_config"] as { format: { type: string } }).format.type).toBe("json_schema");
    expect(JSON.stringify(body["system"])).not.toContain("cache_control");
    expect(JSON.stringify(body["messages"])).not.toContain("2026-10-09");
  });
  it("names a refusal and an invalid card instead of returning nothing", async () => {
    reply = () => message("refusal", "");
    await expect(new ClaudeEstimator({ apiKey: "test-key", baseURL }).taskCard(item())).rejects.toMatchObject({ name: "TaskCardError", reason: "refusal" });
    reply = () => message("end_turn", JSON.stringify(card({ p50_hours: 3, p80_hours: 1 })));
    await expect(new ClaudeEstimator({ apiKey: "test-key", baseURL }).taskCard(item())).rejects.toBeInstanceOf(TaskCardError);
  });
});

describe("EstimateService", () => {
  it("never waits on the model unless asked", async () => {
    const llm = new FakeLlm(async () => card());
    const { svc, user } = setup(llm);
    const e = await svc.estimate(user.id, item());
    expect(e.basis).toBe("heuristic");
    expect(llm.calls).toBe(0);
    expect((await svc.estimate(user.id, item(), { useLlm: false })).basis).toBe("heuristic");
    expect(llm.calls).toBe(0);
  });

  it("remembers a failure per item version and retries only after its time", async () => {
    const llm = new FakeLlm(async () => {
      throw Object.assign(new Error("overloaded"), { status: 529 });
    });
    const { svc, user, logs, clock } = setup(llm);
    for (let i = 0; i < 5; i++) expect((await svc.estimate(user.id, item(), { useLlm: true })).basis).toBe("heuristic");
    expect(llm.calls).toBe(1);
    expect(logs[0]).toMatchObject({ itemId: "canvas:assignment:42", reason: "http 529", retryInMinutes: 15 });
    clock.t += 16 * 60_000;
    await svc.estimate(user.id, item(), { useLlm: true });
    expect(llm.calls).toBe(2);
    // A changed brief is a new version: asked at once.
    await svc.estimate(user.id, item({ descriptionText: "Write 2000 words." }), { useLlm: true });
    expect(llm.calls).toBe(3);
  });

  it("waits a week after a refusal and a day after an empty answer", async () => {
    const refuse = new FakeLlm(async () => {
      throw new TaskCardError("refusal", "declined");
    });
    const a = setup(refuse);
    await a.svc.estimate(a.user.id, item(), { useLlm: true });
    a.clock.t += 6 * 86_400_000;
    await a.svc.estimate(a.user.id, item(), { useLlm: true });
    expect(refuse.calls).toBe(1);
    a.clock.t += 2 * 86_400_000;
    await a.svc.estimate(a.user.id, item(), { useLlm: true });
    expect(refuse.calls).toBe(2);

    const empty = new FakeLlm(async () => undefined);
    const b = setup(empty);
    await b.svc.estimate(b.user.id, item(), { useLlm: true });
    await b.svc.estimate(b.user.id, item(), { useLlm: true });
    expect(empty.calls).toBe(1);
    expect(b.logs[0]).toMatchObject({ reason: "invalid" });
  });

  it("asks once for concurrent reads of the same item", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new FakeLlm(async () => {
      await gate;
      return card();
    });
    const { svc, user } = setup(llm);
    const both = Promise.all([svc.estimate(user.id, item(), { useLlm: true }), svc.estimate(user.id, item(), { useLlm: true })]);
    release();
    const [x, y] = await both;
    expect(llm.calls).toBe(1);
    expect(x.basis).toBe("llm");
    expect(y.basis).toBe("llm");
  });

  it("warms task cards in the background with bounded concurrency, then reads them without waiting", async () => {
    const llm = new FakeLlm(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return card();
    });
    const { svc, user } = setup(llm);
    const items = Array.from({ length: 10 }, (_, i) => item({ id: `canvas:assignment:${i}`, title: `Essay ${i}` }));
    const r = await svc.warmTaskCards([...items, item({ id: "canvas:event:1", kind: "event" })], { concurrency: 3, max: 8 });
    expect(r).toEqual({ asked: 8, created: 8, failed: 0, skipped: 3 });
    expect(llm.maxInFlight).toBeLessThanOrEqual(3);
    expect(llm.maxInFlight).toBeGreaterThan(1);
    expect((await svc.estimate(user.id, items[0]!)).basis).toBe("llm");
    expect(svc.needsTaskCard(items[0]!)).toBe(false);
    expect(svc.needsTaskCard(items[9]!)).toBe(true);
    const again = await svc.warmTaskCards(items);
    expect(again.asked).toBe(2);
    expect(llm.calls).toBe(10);
  });

  it("takes the spread from the stored card, whether it was just made or cached", async () => {
    const llm = new FakeLlm(async () => card({ p50_hours: 2, p80_hours: 3 }));
    const { svc, store, user } = setup(llm);
    const fresh = await svc.estimate(user.id, item(), { useLlm: true });
    const cached = await svc.estimate(user.id, item());
    expect(fresh.sigma).toBeCloseTo(Math.log(1.5) / 0.8416, 9);
    expect(cached.sigma).toBe(fresh.sigma);
    expect(cached.p80Hours).toBe(3);
    // A card stored before sigma was kept: derived from its p50/p80.
    const key = `canvas.example.edu|canvas:assignment:42|${itemVersionHash(item(), shortHash)}`;
    const { sigma: _drop, ...old } = store.getPrior(key)!;
    store.putPrior(key, old);
    expect((await svc.estimate(user.id, item())).sigma).toBeCloseTo(Math.log(1.5) / 0.8416, 9);
  });

  it("holds a card's p50 to 80 hours and never stores heuristic priors", async () => {
    const llm = new FakeLlm(async () => card({ p50_hours: 400, p80_hours: 600 }));
    const { svc, store, user } = setup(llm);
    const e = await svc.estimate(user.id, item(), { useLlm: true });
    expect(e.p50Hours).toBe(80);
    expect(e.reasoning).toContain("held to 80h");
    await svc.estimate(user.id, item({ id: "canvas:assignment:7", title: "PS 1" }));
    const kinds = (store.db.prepare("SELECT json FROM priors").all() as Array<{ json: string }>).map((r) => (JSON.parse(r.json) as { basis: string }).basis);
    expect(kinds).toEqual(["llm"]);
  });

  it("estimates many items like one, reading the student's data once", async () => {
    const { svc, store, user } = setup();
    const items = [item(), item({ id: "canvas:assignment:2", title: "Problem Set 2", descriptionText: "10 problems", courseId: "c2" })];
    for (const i of items) store.upsertItem(user.id, i, itemVersionHash(i, shortHash));
    store.addActual(user.id, { itemId: "canvas:assignment:9", courseId: "c2", minutes: 240, source: "exact", estimatedHours: 2 });
    const many = await svc.estimateMany(user.id, items);
    for (const i of items) expect(many.get(i.id)).toEqual(await svc.estimate(user.id, i));
    expect(many.get("canvas:assignment:2")?.basis).toBe("calibrated");
  });

  it("reads a logged bucket as a bucket, counts a re-logged item once, and can ignore the log", async () => {
    const { svc, store, user } = setup();
    const i = item();
    const before = await svc.estimate(user.id, i);
    store.addActual(user.id, { itemId: i.id, courseId: "c1", minutes: TIME_BUCKETS["2-4h"]!, source: "bucket", estimatedHours: before.p50Hours });
    const logged = await svc.estimate(user.id, i);
    expect(logged.basis).toBe("logged");
    expect(logged.reasoning).toBe("you logged 2-4h");
    expect(logged.p50Hours).toBeGreaterThanOrEqual(2);
    expect(logged.p50Hours).toBeLessThanOrEqual(4);
    const shown = await svc.estimate(user.id, i, { ignoreLogged: true });
    expect(shown.basis).not.toBe("logged");
    expect(shown.priorP50Hours).toBe(before.p50Hours);

    store.addActual(user.id, { itemId: i.id, courseId: "c1", minutes: 200, source: "exact", estimatedHours: before.p50Hours });
    const other = await svc.estimate(user.id, item({ id: "canvas:assignment:5", title: "Essay 5" }));
    expect(other.calibrationSamples).toBe(1);
  });

  it("does not read five short quizzes answered <1h as a slow student", async () => {
    const { svc, store, user } = setup();
    for (let n = 0; n < 5; n++) store.addActual(user.id, { itemId: `canvas:quiz:${n}`, courseId: "c1", minutes: TIME_BUCKETS["<1h"]!, source: "bucket", estimatedHours: 0.25 });
    const e = await svc.estimate(user.id, item({ kind: "quiz", title: "Quiz 9", quiz: { timeLimitMinutes: 10 } }));
    expect(e.basis).toBe("calibrated");
    expect(e.reasoning).toContain("×1.00");
  });
});
