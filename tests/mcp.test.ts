/**
 * The agent-facing contract: what a tool says in text and in structuredContent,
 * how it reads dates, what retries do, and the Google Calendar writes behind
 * the plan tools, against a fake Google.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer as createNetServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EstimateService, Sealer, Store, hashToken, saveItem, type LlmEstimator, type TaskCard, type WorkItem } from "@canvas-agent/core";
import { loadConfig } from "../apps/server/src/config.js";
import { Services, isoInZone, parseInstant } from "../apps/server/src/services.js";
import { createApp } from "../apps/server/src/app.js";
import { GoogleCalendar, GoogleError, eventIdForBlock } from "../apps/server/src/google/calendar.js";
import { startJobs } from "../apps/server/src/jobs.js";
import { startStubCanvas } from "@canvas-agent/stub-canvas";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = "America/New_York";

type Ev = { id: string; status: string; start: { dateTime: string }; end: { dateTime: string }; extendedProperties: { private: Record<string, string> } };

/** Google's token and Calendar endpoints, in memory, with switches for the failures that matter. */
function fakeGoogle() {
  const events = new Map<string, Ev>();
  const state = { refresh: "ok" as "ok" | "invalid_grant", failInserts: 0, loseInsertAnswers: 0, failDelete: false, failPatch: false, failGet: new Set<string>() };
  const reset = () => Object.assign(state, { refresh: "ok", failInserts: 0, loseInsertAnswers: 0, failDelete: false, failPatch: false, failGet: new Set<string>() });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (state.refresh === "invalid_grant") return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked. SECRET-DETAIL" }, { status: 400 });
      return Response.json({ access_token: "gat", expires_in: 3600 });
    }
    if (url.pathname === "/calendar/v3/freeBusy") return Response.json({ calendars: { primary: { busy: [] } } });
    const m = /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return new Response("not faked", { status: 500 });
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "POST") {
      if (state.failInserts > 0) {
        state.failInserts--;
        return new Response("{}", { status: 500 });
      }
      const body = JSON.parse(String(init?.body)) as Ev;
      if (events.has(body.id)) return Response.json({ error: { code: 409 } }, { status: 409 });
      const ev = { ...body, status: "confirmed" };
      events.set(body.id, ev);
      if (state.loseInsertAnswers > 0) {
        state.loseInsertAnswers--;
        return new Response("upstream timed out", { status: 504 }); // stored, but the answer never arrived
      }
      return Response.json(ev);
    }
    if (!id || !events.has(id)) return new Response("{}", { status: 404 });
    if (method === "GET") return state.failGet.has(id) ? new Response("{}", { status: 500 }) : Response.json(events.get(id));
    if (method === "DELETE") {
      if (state.failDelete) return new Response("{}", { status: 503 });
      events.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      if (state.failPatch) return new Response("{}", { status: 503 });
      Object.assign(events.get(id)!, JSON.parse(String(init?.body)));
      return Response.json(events.get(id));
    }
    return new Response("not faked", { status: 500 });
  }) as typeof fetch;
  return { google: new GoogleCalendar("cid", "csecret", fetchImpl), events, state, reset };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let http: Server;
let base: string;
let store: Store;
let services: Services;
const g = fakeGoogle();
const clients: Client[] = [];

beforeAll(async () => {
  store = new Store();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({ baseUrl: base, secretKey: "test-secret-key-0123456789", rateLimit: false, authMode: "dev", dbPath: ":memory:", useLlm: false });
  services = new Services(store, new Sealer(config.secretKey), config, new EstimateService(store), g.google);
  const app = createApp({ services, log: () => {} });
  http = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise<void>((r) => http.close(() => r()));
});

beforeEach(() => g.reset());

async function mcp(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ s: T; text: string; isError: boolean; raw: ToolResult }> {
  const raw = (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  return { s: raw.structuredContent as T, text: raw.content.map((c) => c.text).join("\n"), isError: raw.isError === true, raw };
}

let counter = 0;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A student with Google connected, every day open 07:00–23:00 in New York, and a few items. */
function student(opts: { google?: boolean } = {}) {
  const n = ++counter;
  const user = store.createUser(`s${n}@example.edu`, `S${n}`, {
    timezone: TZ,
    workWindows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "07:00", end: "23:00" })),
    maxHoursPerDay: 10,
  });
  if (opts.google !== false) {
    store.putGoogleAccount({ userId: user.id, email: null, refreshTokenSealed: services.sealer.seal("grt"), accessTokenSealed: null, accessExpiresAt: null, calendarId: "primary", scopes: null });
  }
  const key = services.createConnectorKey(user.id, "test");
  const add = (item: Partial<WorkItem> & { id: string; title: string }): WorkItem =>
    saveItem(store, user.id, { source: "canvas", host: "canvas.test", kind: "assignment", status: "open", courseId: "c1", courseCode: "CHEM 101", updatedAt: new Date().toISOString(), ...item });
  return { userId: user.id, key, add };
}

describe("time inputs", () => {
  it("reads instants with an offset and dates in the student's zone, and nothing else", () => {
    expect(parseInstant("2026-10-07T18:00:00-04:00", TZ, "from")).toBe("2026-10-07T22:00:00.000Z");
    expect(parseInstant("2026-10-07T18:00:00+0400", TZ, "from")).toBe("2026-10-07T14:00:00.000Z");
    expect(parseInstant("2026-10-07T18:00Z", TZ, "from")).toBe("2026-10-07T18:00:00.000Z");
    expect(parseInstant("2026-10-07", TZ, "from")).toBe("2026-10-07T04:00:00.000Z");
    expect(parseInstant("2026-10-07", TZ, "to", { edge: "end" })).toBe("2026-10-08T04:00:00.000Z");
    for (const bad of ["next monday", "2026-13-45", "2026-02-30", "2026-10-07T18:00", "2026-10-07T25:00:00Z", ""]) {
      expect(() => parseInstant(bad, TZ, "from"), bad).toThrow(/from must be an ISO 8601 date-time with an offset.*or a date like 2026-10-07 \(read in America\/New_York\)/);
    }
    expect(() => parseInstant("2026-10-07", TZ, "start", { dateOnly: false })).toThrow(/start must be an ISO 8601 date-time with an offset, like/);
  });

  it("writes instants back with the student's offset", () => {
    expect(isoInZone("2026-10-07T22:00:00.000Z", TZ)).toBe("2026-10-07T18:00:00-04:00");
    expect(isoInZone("2026-12-07T22:00:00.000Z", TZ)).toBe("2026-12-07T17:00:00-05:00");
    expect(isoInZone("2026-10-07T22:00:00.000Z", "Asia/Kolkata")).toBe("2026-10-08T03:30:00+05:30");
    expect(isoInZone("2026-10-07T22:00:00.000Z", "UTC")).toBe("2026-10-07T22:00:00Z");
  });
});

describe("the server's declared surface", () => {
  it("declares fixed lists, scopes per tool, and a profile with an output schema", async () => {
    const s = student();
    const client = await mcp(s.key);
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(false);
    expect(caps?.prompts?.listChanged).toBe(false);
    expect(client.getInstructions()).toContain(`${base}/`);
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    const profile = byName.get("get_profile")!;
    expect(profile._meta?.["securitySchemes"]).toEqual([{ type: "oauth2", scopes: [] }]);
    expect(profile._meta?.["openai/profile"]).toBe(true);
    expect((profile.outputSchema as { required?: string[] }).required).toEqual(["id"]);
    for (const w of ["commit_plan", "clear_plan", "remove_blocks", "move_block", "log_time", "set_preferences"]) expect(byName.get(w)!._meta?.["securitySchemes"], w).toEqual([{ type: "oauth2", scopes: ["plan:write"] }]);
    for (const r of ["get_workload", "get_assignment", "propose_plan", "get_plan", "get_preferences"]) expect(byName.get(r)!._meta?.["securitySchemes"], r).toEqual([{ type: "oauth2", scopes: ["workload:read"] }]);
    // Every input is described for the model.
    for (const t of tools) {
      for (const [prop, schema] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) expect(schema.description, `${t.name}.${prop}`).toBeTruthy();
    }
    const p = await call<{ id: string; email: string }>(client, "get_profile");
    expect(p.s.id).toBe(s.userId);
    expect(JSON.parse(p.text)).toEqual(p.s);
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const s = student();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${s.key}` },
      body: '{"jsonrpc":"2.0", "id": 1, "method": ',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("refuses writes to a token without plan:write, in a form the client can step up from", async () => {
    const s = student();
    store.putOAuthToken({ tokenHash: hashToken("at_readonly_token"), kind: "access", clientId: "c-ro", userId: s.userId, scope: "workload:read", resource: `${base}/mcp`, expiresAt: iso(HOUR), family: "fam-ro" });
    const client = await mcp("at_readonly_token");
    expect((await call(client, "get_workload")).isError).toBe(false);
    const item = s.add({ id: "canvas:assignment:ro1", title: "Read-only test", dueAt: iso(3 * DAY) });
    const denied = await call(client, "commit_plan", { blocks: [{ item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) }] });
    expect(denied.isError).toBe(true);
    const challenge = (denied.raw._meta?.["mcp/www_authenticate"] as string[])[0]!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="plan:write"');
    expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect(store.listBlocks(s.userId)).toHaveLength(0);
  });
});

describe("get_workload", () => {
  it("puts ids and exact instants in the text, missing work first, events and undated work apart", async () => {
    const s = student();
    const lab = s.add({ id: "canvas:assignment:w1", title: "Lab report 2", dueAt: iso(3 * DAY), pointsPossible: 20 });
    const old = s.add({ id: "canvas:assignment:w2", title: "Problem set 1", dueAt: iso(-10 * DAY), status: "missing" });
    const ev = s.add({ id: "canvas:event:w3", kind: "event", title: "Review session", dueAt: iso(2 * DAY), endAt: iso(2 * DAY + 1.5 * HOUR) });
    const journal = s.add({ id: "canvas:assignment:w4", title: "Reading journal" });
    s.add({ id: "canvas:assignment:w5", title: "Graded one", dueAt: iso(-2 * DAY), status: "graded" });
    const client = await mcp(s.key);
    const w = await call<{ timezone: string; items: Array<{ id: string; estimate: { p50Hours: number } }>; events: Array<{ id: string; end: string }>; undated: Array<{ id: string }>; p50Hours: number; total: number }>(client, "get_workload");
    expect(w.s.timezone).toBe(TZ);
    expect(w.s.items.map((i) => i.id)).toEqual([old.id, lab.id]);
    expect(w.s.events.map((e) => e.id)).toEqual([ev.id]);
    expect(w.s.events[0]!.end).toBe(ev.endAt);
    expect(w.s.undated.map((i) => i.id)).toEqual([journal.id]);
    expect(w.s.p50Hours).toBe(w.s.items.reduce((a, i) => a + i.estimate.p50Hours, 0));
    expect(w.text).toContain(`times in ${TZ}`);
    expect(w.text).toContain(`${lab.id} · due ${isoInZone(lab.dueAt!, TZ)}`);
    expect(w.text.indexOf("Missing")).toBeLessThan(w.text.indexOf(lab.id));
    expect(w.text.indexOf(old.id)).toBeLessThan(w.text.indexOf(lab.id));
    expect(w.text).toMatch(/No due date \(1\):\n- canvas:assignment:w4/);
    expect(w.text).toContain(`- ${ev.id} · ${isoInZone(ev.dueAt!, TZ)}→${isoInZone(ev.endAt!, TZ)}`);

    // An explicit period is that period: a date is the student's whole day.
    const today = isoInZone(new Date().toISOString(), TZ).slice(0, 10);
    const later = await call<{ items: Array<{ id: string }>; from: string }>(client, "get_workload", { from: today });
    expect(later.s.items.map((i) => i.id)).toEqual([lab.id]);
    expect(later.s.from).toBe(parseInstant(today, TZ, "from"));
  });

  it("pages with limit and nextFrom", async () => {
    const s = student();
    for (let i = 0; i < 4; i++) s.add({ id: `canvas:assignment:p${i}`, title: `Item ${i}`, dueAt: iso((i + 1) * DAY) });
    const client = await mcp(s.key);
    const first = await call<{ items: Array<{ id: string }>; total: number; nextFrom: string }>(client, "get_workload", { limit: 3 });
    expect(first.s.items.map((i) => i.id)).toEqual(["canvas:assignment:p0", "canvas:assignment:p1", "canvas:assignment:p2"]);
    expect(first.s.total).toBe(4);
    expect(first.text).toContain(`from=${first.s.nextFrom}`);
    const rest = await call<{ items: Array<{ id: string }>; nextFrom?: string }>(client, "get_workload", { from: first.s.nextFrom, limit: 3 });
    expect(rest.s.items.map((i) => i.id)).toEqual(["canvas:assignment:p3"]);
    expect(rest.s.nextFrom).toBeUndefined();
  });

  it("refuses dates it cannot read, saying what it wants", async () => {
    const s = student();
    const client = await mcp(s.key);
    const bad = await call(client, "get_workload", { from: "next monday" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("2026-10-07T18:00:00-04:00");
    const impossible = await call(client, "propose_plan", { to: "2026-13-45" });
    expect(impossible.isError).toBe(true);
    const backwards = await call(client, "propose_plan", { busy: [{ start: iso(2 * DAY), end: iso(DAY) }] });
    expect(backwards.isError).toBe(true);
    expect(backwards.text).toMatch(/busy\[0\]: end .* must be after start/);
    const floating = await call(client, "commit_plan", { blocks: [{ item_id: "x", start: "2026-10-07T18:00", end: "2026-10-07T19:00" }] });
    expect(floating.isError).toBe(true);
    expect(floating.text).toContain("offset");
  });
});

describe("propose_plan", () => {
  it("plans missing work, avoids Canvas events, and explains every requested item it does not plan", async () => {
    const s = student();
    const due = s.add({ id: "canvas:assignment:q1", title: "Essay draft", dueAt: iso(3 * DAY), pointsPossible: 50 });
    const missing = s.add({ id: "canvas:assignment:q2", title: "Late lab", dueAt: iso(-4 * DAY), status: "missing" });
    const ev = s.add({ id: "canvas:event:q3", kind: "event", title: "Review session", dueAt: iso(DAY), endAt: iso(DAY + 6 * HOUR) });
    const done = s.add({ id: "canvas:assignment:q4", title: "Handed in", dueAt: iso(2 * DAY), status: "graded" });
    const client = await mcp(s.key);
    const p = await call<{ blocks: Array<{ itemId: string; start: string; end: string }>; unscheduled: Array<{ itemId: string; reason: string }>; canvasEvents: number; timezone: string }>(client, "propose_plan", {
      item_ids: [due.id, missing.id, ev.id, done.id, "canvas:assignment:nope"],
    });
    expect(p.isError).toBe(false);
    expect(p.s.timezone).toBe(TZ);
    expect(new Set(p.s.blocks.map((b) => b.itemId))).toEqual(new Set([due.id, missing.id]));
    const reasons = Object.fromEntries(p.s.unscheduled.map((u) => [u.itemId, u.reason]));
    expect(reasons["canvas:assignment:nope"]).toMatch(/no such item/);
    expect(reasons[ev.id]).toMatch(/calendar event/);
    expect(reasons[done.id]).toMatch(/already graded/);
    expect(p.s.canvasEvents).toBe(1);
    for (const b of p.s.blocks) expect(Date.parse(b.end) <= Date.parse(ev.dueAt!) || Date.parse(b.start) >= Date.parse(ev.endAt!), `${b.start} overlaps the event`).toBe(true);
    const first = p.s.blocks[0]!;
    expect(p.text).toContain(`- ${first.itemId} ${isoInZone(first.start, TZ)}→${isoInZone(first.end, TZ)}`);
  });

  it("gives work due after the horizon only the horizon's share", async () => {
    const s = student();
    const big = s.add({ id: "canvas:assignment:r1", title: "Research paper", descriptionText: "Write a 5000 word research paper with 10 sources.", dueAt: iso(30 * DAY), pointsPossible: 200 });
    const client = await mcp(s.key);
    const est = (await call<{ estimate: { p50Hours: number } }>(client, "get_assignment", { item_id: big.id })).s.estimate.p50Hours;
    const p = await call<{ blocks: Array<{ minutes: number }>; unscheduled: Array<{ reason: string }> }>(client, "propose_plan", { item_ids: [big.id] });
    const planned = p.s.blocks.reduce((a, b) => a + b.minutes, 0) / 60;
    // 7 of the ~29.5 days before the buffer: about a quarter, never the whole thing.
    expect(planned).toBeLessThan(est * 0.4);
    if (!p.s.blocks.length) expect(p.s.unscheduled[0]?.reason).toMatch(/after this horizon/);
  });
});

describe("commit_plan", () => {
  it("saves once however often it is retried, under event ids derived from the blocks", async () => {
    const s = student();
    s.add({ id: "canvas:assignment:c1", title: "Worksheet", dueAt: iso(4 * DAY) });
    const client = await mcp(s.key);
    const p = await call<{ blocks: Array<{ itemId: string; start: string; end: string }> }>(client, "propose_plan");
    const blocks = p.s.blocks.slice(0, 2).map((b) => ({ item_id: b.itemId, start: isoInZone(b.start, TZ), end: isoInZone(b.end, TZ) }));
    expect(blocks.length).toBeGreaterThan(0);
    const first = await call<{ saved: number; duplicates: number; inCalendar: number; calendar: string; created: Array<{ blockId: string }> }>(client, "commit_plan", { blocks });
    expect(first.s).toMatchObject({ saved: blocks.length, duplicates: 0, inCalendar: blocks.length, calendar: "google" });
    for (const c of first.s.created) expect(g.events.has(eventIdForBlock(c.blockId))).toBe(true);
    const eventsBefore = g.events.size;
    const again = await call<{ saved: number; duplicates: number; created: Array<{ blockId: string; alreadySaved?: boolean }> }>(client, "commit_plan", { blocks });
    expect(again.isError).toBe(false);
    expect(again.s.saved).toBe(0);
    expect(again.s.duplicates).toBe(blocks.length);
    expect(again.s.created.map((c) => c.blockId)).toEqual(first.s.created.map((c) => c.blockId));
    expect(again.text).toMatch(new RegExp(`^Saved 0 new block\\(s\\); ${blocks.length} already saved, not duplicated\\. ${blocks.length} in Google Calendar\\.`));
    expect(store.listBlocks(s.userId).filter((b) => b.status !== "deleted")).toHaveLength(blocks.length);
    expect(g.events.size).toBe(eventsBefore);
  });

  it("reports a partial Google failure by count, and a retry repairs it, adopting an event whose answer was lost", async () => {
    const s = student();
    const item = s.add({ id: "canvas:assignment:c2", title: "Quiz prep", dueAt: iso(5 * DAY) });
    const client = await mcp(s.key);
    const blocks = [
      { item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) },
      { item_id: item.id, start: iso(2 * DAY), end: iso(2 * DAY + HOUR) },
    ];
    g.state.failInserts = 1; // the first insert fails outright
    g.state.loseInsertAnswers = 1; // the second is stored by Google but its answer is lost
    const first = await call<{ saved: number; inCalendar: number; errors: string[] }>(client, "commit_plan", { blocks });
    expect(first.s.saved).toBe(2);
    expect(first.s.inCalendar).toBe(0);
    expect(first.s.errors).toHaveLength(2);
    expect(first.text).toContain("0 in Google Calendar, 2 only in the calendar feed");
    expect(first.text).not.toContain("added them to Google Calendar");
    const retry = await call<{ saved: number; duplicates: number; inCalendar: number; errors: string[] }>(client, "commit_plan", { blocks });
    expect(retry.s).toMatchObject({ saved: 0, duplicates: 2, inCalendar: 2, errors: [] });
    const saved = store.listBlocks(s.userId);
    expect(saved).toHaveLength(2);
    for (const b of saved) expect(b.calendarEventId).toBe(eventIdForBlock(b.id));
    expect([...g.events.values()].filter((e) => saved.some((b) => e.extendedProperties.private["canvasAgentBlock"] === b.id))).toHaveLength(2);
  });

  it("is an error when nothing is saved, and takes at most 40 blocks", async () => {
    const s = student();
    const client = await mcp(s.key);
    const none = await call(client, "commit_plan", { blocks: [{ item_id: "canvas:assignment:unknown", start: iso(DAY), end: iso(DAY + HOUR) }] });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("Nothing was saved");
    const many = Array.from({ length: 41 }, (_, i) => ({ item_id: "x", start: iso(DAY + i * HOUR), end: iso(DAY + (i + 0.5) * HOUR) }));
    expect((await call(client, "commit_plan", { blocks: many })).isError).toBe(true);
  });

  it("replace_existing swaps the future plan for an item, keeping blocks committed again", async () => {
    const s = student();
    const item = s.add({ id: "canvas:assignment:c3", title: "Lab", dueAt: iso(6 * DAY) });
    const client = await mcp(s.key);
    const a = { item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) };
    const b = { item_id: item.id, start: iso(2 * DAY), end: iso(2 * DAY + HOUR) };
    const c = { item_id: item.id, start: iso(3 * DAY), end: iso(3 * DAY + HOUR) };
    await call(client, "commit_plan", { blocks: [a, b] });
    const r = await call<{ saved: number; duplicates: number; replaced: number }>(client, "commit_plan", { blocks: [b, c], replace_existing: true });
    expect(r.s).toMatchObject({ saved: 1, duplicates: 1, replaced: 1 });
    expect(store.listBlocks(s.userId).filter((x) => x.status !== "deleted").map((x) => x.start)).toEqual([b.start, c.start].map((t) => new Date(t).toISOString()));
  });
});

describe("clear_plan, get_plan, move_block, remove_blocks", () => {
  it("clears from now on and keeps a block whose event Google would not delete", async () => {
    const s = student();
    const item = s.add({ id: "canvas:assignment:k1", title: "Problem set", dueAt: iso(5 * DAY) });
    const past = store.addBlock(s.userId, { itemId: item.id, start: iso(-3 * HOUR), end: iso(-2 * HOUR), minutes: 60 });
    const client = await mcp(s.key);
    await call(client, "commit_plan", { blocks: [{ item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) }, { item_id: item.id, start: iso(2 * DAY), end: iso(2 * DAY + HOUR) }] });
    g.state.failDelete = true;
    const failed = await call<{ cleared: number; failed: Array<{ blockId: string; reason: string }>; statuses: string[] }>(client, "clear_plan");
    expect(failed.s.cleared).toBe(0);
    expect(failed.s.failed).toHaveLength(2);
    expect(failed.s.statuses).toEqual(["planned", "moved"]);
    expect(failed.text).toContain("Kept 2 block(s)");
    expect(store.listBlocks(s.userId).filter((b) => b.status === "planned")).toHaveLength(3);
    g.state.failDelete = false;
    const ok = await call<{ cleared: number; removedEvents: number; failed: unknown[] }>(client, "clear_plan");
    expect(ok.s).toMatchObject({ cleared: 2, removedEvents: 2, failed: [] });
    expect(store.getBlock(s.userId, past.id)?.status).toBe("planned");
  });

  it("shows saved blocks, moves one with its event, and removes by id", async () => {
    const s = student();
    const item = s.add({ id: "canvas:assignment:m1", title: "Reading", dueAt: iso(6 * DAY) });
    const client = await mcp(s.key);
    const committed = await call<{ created: Array<{ blockId: string }> }>(client, "commit_plan", { blocks: [{ item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) }] });
    const blockId = committed.s.created[0]!.blockId;
    const plan = await call<{ blocks: Array<{ blockId: string; itemId: string; inCalendar: boolean; status: string }> }>(client, "get_plan");
    expect(plan.s.blocks).toEqual([expect.objectContaining({ blockId, itemId: item.id, inCalendar: true, status: "planned" })]);
    expect(plan.text).toContain(`- ${blockId} · ${item.id} `);

    const at = Math.ceil((Date.now() + 2 * DAY) / 60_000) * 60_000;
    const start = new Date(at).toISOString();
    const end = new Date(at + 1.5 * HOUR).toISOString();
    g.state.failPatch = true;
    const refused = await call(client, "move_block", { block_id: blockId, start, end });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("nothing was changed");
    expect(store.getBlock(s.userId, blockId)?.start).not.toBe(start);
    g.state.failPatch = false;
    const moved = await call<{ block: { start: string; minutes: number }; calendarUpdated: boolean }>(client, "move_block", { block_id: blockId, start: isoInZone(start, TZ), end: isoInZone(end, TZ) });
    expect(moved.s.calendarUpdated).toBe(true);
    expect(moved.s.block).toMatchObject({ start, minutes: 90 });
    expect(g.events.get(eventIdForBlock(blockId))?.start.dateTime).toBe(start);

    const removed = await call<{ removed: string[]; failed: Array<{ blockId: string }> }>(client, "remove_blocks", { block_ids: [blockId, "nope"] });
    expect(removed.s.removed).toEqual([blockId]);
    expect(removed.s.failed.map((f) => f.blockId)).toEqual(["nope"]);
    expect(g.events.has(eventIdForBlock(blockId))).toBe(false);
    const twice = await call<{ alreadyRemoved: string[] }>(client, "remove_blocks", { block_ids: [blockId] });
    expect(twice.isError).toBe(false);
    expect(twice.s.alreadyRemoved).toEqual([blockId]);
    const detail = await call<{ blocks: unknown[] }>(client, "get_assignment", { item_id: item.id });
    expect(detail.s.blocks).toEqual([]);
    expect(detail.text).toContain("Nothing planned yet.");
  });
});

describe("log_time and check-ins", () => {
  it("removes blocks still ahead, closes past ones, reports the estimate shown, and counts a retry once", async () => {
    const s = student();
    const before = s.add({ id: "canvas:assignment:l0", title: "Earlier set", dueAt: iso(-3 * DAY), status: "submitted" });
    const item = s.add({ id: "canvas:assignment:l1", title: "Problem set 6", dueAt: iso(2 * DAY) });
    // One earlier log in the course, three times the prior, so the calibrated estimate differs from the prior.
    const prior0 = services.estimates.quickPrior(s.userId, before).estimate.p50Hours;
    store.addActual(s.userId, { itemId: before.id, host: "canvas.test", courseId: "c1", minutes: Math.round(prior0 * 3 * 60), source: "exact", estimatedHours: prior0 });
    const past = store.addBlock(s.userId, { itemId: item.id, start: iso(-2 * HOUR), end: iso(-HOUR), minutes: 60 });
    const client = await mcp(s.key);
    const committed = await call<{ created: Array<{ blockId: string }> }>(client, "commit_plan", { blocks: [{ item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) }] });
    const future = committed.s.created[0]!.blockId;
    const shown = (await call<{ items: Array<{ id: string; estimate: { p50Hours: number; basis: string } }> }>(client, "get_workload")).s.items.find((i) => i.id === item.id)!.estimate;
    expect(shown.basis).toBe("calibrated");

    const r = await call<{ minutes: number; estimateWas: number; blocksClosed: number; blocksRemoved: number; duplicate: boolean }>(client, "log_time", { item_id: item.id, bucket: "1-2h" });
    expect(r.s).toMatchObject({ minutes: 90, estimateWas: shown.p50Hours, blocksClosed: 1, blocksRemoved: 1, duplicate: false });
    expect(store.getBlock(s.userId, past.id)?.status).toBe("done");
    expect(store.getBlock(s.userId, future)?.status).toBe("deleted");
    expect(g.events.has(eventIdForBlock(future))).toBe(false);
    // Calibration compares with the prior, not with the calibrated number.
    const prior = services.estimates.quickPrior(s.userId, item).estimate.p50Hours;
    expect(store.listActuals(s.userId).find((a) => a.itemId === item.id)?.estimatedHours).toBe(prior);

    const retry = await call<{ duplicate: boolean }>(client, "log_time", { item_id: item.id, bucket: "1-2h" });
    expect(retry.s.duplicate).toBe(true);
    expect(retry.text).toContain("not counted twice");
    expect(store.listActuals(s.userId).filter((a) => a.itemId === item.id)).toHaveLength(1);
  });

  it("asks about the last three weeks only, newest first, with the estimate the student saw", async () => {
    const s = student();
    s.add({ id: "canvas:assignment:h1", title: "Two days ago", dueAt: iso(-2 * DAY), status: "submitted" });
    s.add({ id: "canvas:assignment:h2", title: "Five days ago", dueAt: iso(-5 * DAY), status: "graded" });
    s.add({ id: "canvas:assignment:h3", title: "A month ago", dueAt: iso(-30 * DAY), status: "submitted" });
    s.add({ id: "canvas:assignment:h4", title: "Untouched", dueAt: iso(-1 * DAY) });
    expect(services.pendingCheckIns(s.userId).map((c) => c.itemId)).toEqual(["canvas:assignment:h1", "canvas:assignment:h2"]);
    const client = await mcp(s.key);
    const w = await call<{ checkIns: Array<{ itemId: string; estimateP50: number }> }>(client, "get_workload");
    expect(w.s.checkIns.map((c) => c.itemId)).toEqual(["canvas:assignment:h1", "canvas:assignment:h2"]);
    for (const c of w.s.checkIns) expect(c.estimateP50).toBeGreaterThan(0);
    expect(w.text).toContain("- canvas:assignment:h1 · Two days ago");
  });
});

describe("preferences", () => {
  it("refuses times and block sizes the planner cannot use", async () => {
    const s = student();
    const client = await mcp(s.key);
    expect((await call(client, "set_preferences", { work_windows: [{ weekday: 1, start: "5pm", end: "22:00" }] })).isError).toBe(true);
    const crossed = await call(client, "set_preferences", { min_block_minutes: 200, max_block_minutes: 60 });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toMatch(/minimum block/);
    expect(() => services.setPreferences(s.userId, { workWindows: [{ weekday: 1, start: "17:00", end: "17:00" }] })).toThrow(/same/);
    expect(() => services.setPreferences(s.userId, { maxBlockMinutes: 30, minBlockMinutes: 45 })).toThrow(/minimum block/);
    // A window past midnight is fine.
    expect(services.setPreferences(s.userId, { workWindows: [{ weekday: 5, start: "21:00", end: "02:00" }] }).workWindows).toHaveLength(1);
  });
});

describe("Google Calendar upkeep", () => {
  it("disconnects an account whose refresh token Google refuses, and says so", async () => {
    const s = student();
    s.add({ id: "canvas:assignment:g1", title: "Essay", dueAt: iso(3 * DAY) });
    g.state.refresh = "invalid_grant";
    const client = await mcp(s.key);
    const p = await call<{ notes: string[]; busySource: string }>(client, "propose_plan");
    expect(p.s.busySource).toBe("none");
    expect(p.s.notes.join(" ")).toMatch(/disconnected; reconnect it on the settings page/);
    expect(p.text).not.toContain("SECRET-DETAIL");
    expect(store.getGoogleAccount(s.userId)).toBeUndefined();
  });

  it("keeps reconciling past an event it cannot read", async () => {
    const s = student();
    const item = s.add({ id: "canvas:assignment:g2", title: "Lab", dueAt: iso(5 * DAY) });
    const client = await mcp(s.key);
    const c = await call<{ created: Array<{ blockId: string }> }>(client, "commit_plan", { blocks: [{ item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) }, { item_id: item.id, start: iso(2 * DAY), end: iso(2 * DAY + HOUR) }] });
    const [a, b] = c.s.created.map((x) => x.blockId);
    g.state.failGet = new Set([eventIdForBlock(a!)]);
    g.events.delete(eventIdForBlock(b!)); // the student deleted this one in Google
    const stats = await services.reconcileGoogle(s.userId);
    expect(stats).toMatchObject({ errors: 1, deleted: 1 });
    expect(store.getBlock(s.userId, b!)?.status).toBe("deleted");
    expect(store.getBlock(s.userId, a!)?.status).toBe("planned");
  });

  it("asks for consent only when told to, and keeps only the token endpoint's error code", async () => {
    expect(new URL(g.google.authUrl("https://p.example/cb", "st")).searchParams.get("prompt")).toBe("consent");
    expect(new URL(g.google.authUrl("https://p.example/cb", "st", undefined, undefined, { consent: false })).searchParams.has("prompt")).toBe(false);
    g.state.refresh = "invalid_grant";
    const err = (await g.google.refresh("x").catch((e: unknown) => e)) as GoogleError;
    expect(err).toBeInstanceOf(GoogleError);
    expect(err.code).toBe("invalid_grant");
    expect(err.message).toBe("google token endpoint 400 (invalid_grant)");
  });
});

describe("model task cards", () => {
  it("are built by the jobs, two at a time, and never awaited by a read", async () => {
    const st = new Store();
    let calls = 0;
    let running = 0;
    let peak = 0;
    const llm: LlmEstimator = {
      async taskCard(): Promise<TaskCard> {
        calls++;
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { shape: "problem_set", steps: ["read", "solve", "check"], quantities: { pages: null, words: null, problems: 10, questions: null, sources: null, stated_minutes: null }, p50_hours: 3, p80_hours: 4.5, confidence: "medium", reasoning: "ten problems" };
      },
    };
    const config = loadConfig({ baseUrl: "http://127.0.0.1:1", secretKey: "test-secret-key-0123456789", rateLimit: false, authMode: "dev", dbPath: ":memory:", useLlm: true });
    const svc = new Services(st, new Sealer(config.secretKey), config, new EstimateService(st, llm, { log: () => {} }));
    const user = st.createUser("llm@example.edu", "L", { timezone: TZ });
    const add = (item: Partial<WorkItem> & { id: string; title: string }) => saveItem(st, user.id, { source: "canvas", host: "canvas.test", kind: "assignment", status: "open", updatedAt: new Date().toISOString(), ...item });
    for (let i = 0; i < 3; i++) add({ id: `canvas:assignment:t${i}`, title: `Set ${i}`, dueAt: iso((i + 1) * DAY) });
    add({ id: "canvas:assignment:far", title: "Far away", dueAt: iso(60 * DAY) });
    add({ id: "canvas:event:t", kind: "event", title: "Lecture", dueAt: iso(DAY) });
    add({ id: "canvas:assignment:done", title: "Done", dueAt: iso(DAY), status: "graded" });

    const before = await svc.workload(user.id);
    expect(calls).toBe(0);
    expect(before.items.every((i) => i.estimate.basis === "heuristic")).toBe(true);

    const jobs = startJobs(svc, 60, () => {});
    await jobs.runOnce();
    jobs.stop();
    expect(calls).toBe(3);
    expect(peak).toBeLessThanOrEqual(2);
    const after = await svc.workload(user.id);
    expect(after.items.filter((i) => i.id.startsWith("canvas:assignment:t")).map((i) => i.estimate.basis)).toEqual(["llm", "llm", "llm"]);
    expect((await svc.warmEstimates(user.id)).asked).toBe(0);
  });
});

describe("Canvas accounts", () => {
  it("reads the calendar feed's all-day due dates as 23:59 in the student's zone", async () => {
    const stub = await startStubCanvas(0);
    try {
      const st = new Store();
      const config = loadConfig({ baseUrl: "http://127.0.0.1:1", secretKey: "test-secret-key-0123456789", rateLimit: false, authMode: "dev", dbPath: ":memory:", useLlm: false, allowLoopbackEgress: true });
      const svc = new Services(st, new Sealer(config.secretKey), config, new EstimateService(st));
      const user = st.createUser("feed@example.edu", "F", { timezone: TZ });
      const account = svc.addFeedAccount(user.id, stub.feedUrl);
      const report = await svc.syncAccount(account);
      expect(report.errors).toEqual([]);
      const item = st.getItem(user.id, "canvas:assignment:1001")?.item;
      expect(item?.dueAt).toBeTruthy();
      expect(isoInZone(item!.dueAt!, TZ).slice(11, 16)).toBe("23:59");
    } finally {
      await stub.close();
    }
  });

  it("removing an account removes its items' plan, and their Google events where Google allows", async () => {
    const s = student();
    const account = store.upsertCanvasAccount({ userId: s.userId, baseUrl: "https://canvas.test", kind: "session" });
    const item = s.add({ id: "canvas:assignment:x1", title: "Going away", dueAt: iso(5 * DAY) });
    const kept = store.addBlock(s.userId, { itemId: item.id, start: iso(-2 * DAY), end: iso(-2 * DAY + HOUR), minutes: 60 });
    store.updateBlock(s.userId, kept.id, { status: "kept" });
    const client = await mcp(s.key);
    const c = await call<{ created: Array<{ blockId: string }> }>(client, "commit_plan", { blocks: [{ item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) }, { item_id: item.id, start: iso(2 * DAY), end: iso(2 * DAY + HOUR) }] });
    const [a, b] = c.s.created.map((x) => x.blockId);
    g.state.failDelete = true;
    const r = await services.removeCanvasAccount(s.userId, account.id);
    expect(r).toMatchObject({ removedItems: 1, blocksRemoved: 2, removedEvents: 0 });
    expect(r.warnings.join(" ")).toMatch(/could not be/);
    expect(store.getItem(s.userId, item.id)).toBeUndefined();
    expect(store.getBlock(s.userId, a!)?.status).toBe("deleted");
    expect(store.getBlock(s.userId, b!)?.status).toBe("deleted");
    expect(store.getBlock(s.userId, kept.id)?.status).toBe("kept");
    expect(services.planFeedIcs(s.userId)).not.toContain(a!);
  });

  it("does not plan or commit work Canvas stopped listing", async () => {
    const s = student();
    const item = s.add({ id: "canvas:assignment:x2", title: "Unpublished", dueAt: iso(3 * DAY) });
    store.markItemsGone(s.userId, [item.id]);
    const client = await mcp(s.key);
    const p = await call<{ blocks: unknown[]; unscheduled: Array<{ itemId: string; reason: string }> }>(client, "propose_plan", { item_ids: [item.id] });
    expect(p.s.blocks).toEqual([]);
    expect(p.s.unscheduled).toEqual([expect.objectContaining({ itemId: item.id, reason: "no longer listed in Canvas" })]);
    const commit = await call<{ errors: string[] }>(client, "commit_plan", { blocks: [{ item_id: item.id, start: iso(DAY), end: iso(DAY + HOUR) }] });
    expect(commit.isError).toBe(true);
    expect(commit.s.errors[0]).toContain("no longer listed in Canvas");
  });
});
