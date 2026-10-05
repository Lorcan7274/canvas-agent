/**
 * The extension's service worker against the stub Canvas and the real planner
 * server, through a fake `chrome` and a fetch that attaches the Canvas session
 * cookie the way the browser would.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer as createNetServer } from "node:net";
import type { Server } from "node:http";
import { startStubCanvas, type StubCanvas } from "@canvas-agent/stub-canvas";
import { EstimateService, Sealer, Store, pairingCode } from "@canvas-agent/core";
import { loadConfig, type Config } from "../../server/src/config.js";
import { Services } from "../../server/src/services.js";
import { createApp } from "../../server/src/app.js";
import { REMOVED_BY_STUDENT, originPattern, scriptId, type ExtensionSettings, type OriginSync, type Reply } from "../src/shared.js";
import { canvasNet, fakeChrome, manifest, pageSender, redirectedTo, tabSender, type CanvasNet, type FakeChrome } from "./fake-chrome.js";

type Worker = typeof import("../src/worker.js");

/** The test's own requests to the planner, outside the browser's recorded network. */
const realFetch = globalThis.fetch;

const CANVAS = "https://school.instructure.com";
const OTHER = "https://other.instructure.com";
const VANITY = "https://canvas.school.edu";
const BETA = "https://school.beta.instructure.com";

interface Planner {
  base: string;
  store: Store;
  newUser(): { id: string; code(): string };
  close(): Promise<void>;
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

async function startPlanner(overrides: Partial<Config> = {}): Promise<Planner> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = loadConfig({ baseUrl: base, secretKey: "extension-test-secret-0123456789", rateLimit: false, authMode: "dev", dbPath: ":memory:", useLlm: false, ...overrides });
  const store = new Store();
  const services = new Services(store, new Sealer(config.secretKey), config, new EstimateService(store));
  const app = createApp({ services, log: () => {} });
  const http = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  let n = 0;
  return {
    base,
    store,
    newUser() {
      const id = store.createUser(`student${++n}@example.edu`, "Sam", { timezone: "America/New_York" }).id;
      return {
        id,
        code() {
          const c = pairingCode();
          store.createPairingCode(id, c);
          return c;
        },
      };
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

let stub: StubCanvas;
let planner: Planner;
let fake: FakeChrome;
let net: CanvasNet;
let worker: Worker;

beforeAll(async () => {
  stub = await startStubCanvas(0);
  planner = await startPlanner();
});
afterAll(async () => {
  await planner.close();
  await stub.close();
});

/** A worker starting on the current browser state (the previous one, if any, is dead). */
async function boot(): Promise<void> {
  fake.kill();
  vi.resetModules();
  worker = await import("../src/worker.js");
  await worker.start();
}

beforeEach(async () => {
  fake = fakeChrome();
  net = canvasNet(stub.origin, [CANVAS, OTHER, VANITY, BETA, "https://school.test.instructure.com", "https://community.instructure.com", "https://www.instructure.com"]);
  for (const o of [CANVAS, OTHER, VANITY, BETA]) net.signedIn.add(o);
  vi.stubGlobal("chrome", fake.chrome);
  vi.stubGlobal("fetch", net.fetch);
  await boot();
});
afterEach(async () => {
  await worker.settled();
  vi.unstubAllGlobals();
});

const settings = (): ExtensionSettings => (fake.local.get("settings") as ExtensionSettings | undefined) ?? { canvasOrigins: [] };
const lastSync = (origin = CANVAS): OriginSync => settings().lastSync![origin]!;
const plannerRequests = () => net.requests.filter((r) => r.url.includes("/api/v1/planner/items")).length;
const canvasRequests = () => net.requests.filter((r) => r.canvas).length;

/** Moves an origin's last result back in time, as if `ms` had passed. */
function age(origin: string, ms: number): void {
  const s = settings();
  const last = s.lastSync?.[origin];
  if (!last) return;
  last.at = new Date(Date.parse(last.at) - ms).toISOString();
  if (last.retryAt) last.retryAt = new Date(Date.parse(last.retryAt) - ms).toISOString();
  fake.local.set("settings", s);
}

async function pair(p: Planner = planner): Promise<{ id: string }> {
  const user = p.newUser();
  await fake.chrome.permissions.request({ origins: [originPattern(p.base)] });
  const reply = await fake.message<Reply>({ type: "pair", serverUrl: p.base, code: user.code(), name: "Chrome" }, pageSender());
  expect(reply).toMatchObject({ ok: true });
  await worker.settled();
  return user;
}

async function openCanvas(origin = CANVAS): Promise<Reply> {
  const reply = await fake.message<Reply>({ type: "canvas-page", origin }, tabSender(origin));
  await worker.settled();
  return reply;
}

async function syncButton(origin = CANVAS): Promise<Reply> {
  const reply = await fake.message<Reply>({ type: "sync-now" }, tabSender(origin));
  await worker.settled();
  return reply;
}

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(test()).toBe(true);
}

describe("the extension's service worker", () => {
  it("pairs, confirms Canvas, syncs, and reads details four at a time, posting each batch as it lands", async () => {
    const user = await pair();
    expect(settings()).toMatchObject({ serverUrl: planner.base, canvasOrigins: [] });
    expect(settings().deviceToken).toMatch(/^dv_/);

    const reply = await openCanvas();
    expect(reply).toMatchObject({ ok: true });
    expect(settings().canvasOrigins).toEqual([CANVAS]);
    const last = lastSync();
    expect(last.ok).toBe(true);
    const details = Number(/^synced \d+ items, (\d+) details$/.exec(last.message)?.[1]);
    expect(details).toBeGreaterThan(worker.DETAIL_CONCURRENCY);

    // The server has the snapshot and every detail it asked for.
    expect(planner.store.listCanvasAccounts(user.id).map((a) => [a.baseUrl, a.kind])).toEqual([[CANVAS, "session"]]);
    const rows = planner.store.listItems(user.id, { includeUndated: true });
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => r.detailsFetchedAt).length).toBeGreaterThanOrEqual(details);
    const token = settings().deviceToken!;
    const wanted = (await realFetch(`${planner.base}/api/ingest/wanted`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())) as { wanted: unknown[] };
    expect(wanted.wanted).toEqual([]);

    // Canvas: GET with the session only; the planner: the device token, never cookies.
    const canvas = net.requests.filter((r) => r.canvas);
    expect(canvas.every((r) => r.method === "GET" && r.credentials === "include" && !r.authorization)).toBe(true);
    expect(net.requests.filter((r) => !r.canvas).every((r) => r.credentials === "omit")).toBe(true);

    // At most four detail requests at once, one post per batch, progress per batch, lock released.
    expect(net.maxDetailsInFlight).toBeGreaterThan(1);
    expect(net.maxDetailsInFlight).toBeLessThanOrEqual(worker.DETAIL_CONCURRENCY);
    const beats = fake.writes.map(([area, items]) => (area === "session" ? (items[`sync:${CANVAS}`] as { phase: string; done?: number; total?: number } | undefined) : undefined)).filter((b) => b?.phase === "details");
    const total = beats.at(-1)!.total!;
    expect(beats.map((b) => b!.done)).toEqual(Array.from({ length: Math.ceil(total / 4) }, (_, i) => Math.min((i + 1) * 4, total)));
    const posts = net.requests.filter((r) => r.method === "POST" && r.url === `${planner.base}/api/ingest`);
    expect(posts.length).toBe(1 + beats.length);
    // The first post read the whole planner list, so it carries its window; detail posts never do.
    const plannerQuery = new URL(net.requests.find((r) => r.url.includes("/api/v1/planner/items"))!.url).searchParams;
    expect(posts[0]!.json!["plannerWindow"]).toEqual({ start: plannerQuery.get("start_date"), end: plannerQuery.get("end_date") });
    expect(posts.slice(1).every((p) => p.json!["plannerWindow"] === undefined && (p.json!["plannerItems"] as unknown[]).length === 0)).toBe(true);
    expect(posts.slice(1).every((p) => (p.json!["detailFailures"] as unknown[] | undefined)?.length === 0)).toBe(true);
    // Work marked done in Canvas is not reported as missing.
    expect(new URL(net.requests.find((r) => r.url.includes("/missing_submissions"))!.url).searchParams.getAll("include[]")).toEqual(["course", "planner_overrides"]);
    expect(net.requests.some((r) => !r.canvas && r.url.startsWith(`${planner.base}/api/ingest/wanted?baseUrl=${encodeURIComponent(CANVAS)}`))).toBe(true);
    expect(fake.session.has(`sync:${CANVAS}`)).toBe(false);
    expect(fake.badge).toEqual({ text: "", title: worker.DEFAULT_TITLE });
  });

  it("runs one sync per origin however many tabs and buttons ask at once", async () => {
    await pair();
    await Promise.all([openCanvas(), openCanvas(), openCanvas()]);
    expect(plannerRequests()).toBe(1);
    age(CANVAS, worker.MIN_INTERVAL_MS);
    await Promise.all([openCanvas(), syncButton(), openCanvas(), fake.message({ type: "sync-now" }, pageSender())]);
    await worker.settled();
    expect(plannerRequests()).toBe(2);
    // Fresh again: a page load does not sync, the button does.
    await openCanvas();
    expect(plannerRequests()).toBe(2);
    await syncButton();
    expect(plannerRequests()).toBe(3);
  });

  it("leaves a sync to the worker that holds the lock, even after this one restarts", async () => {
    await pair();
    await openCanvas();
    age(CANVAS, worker.MIN_INTERVAL_MS);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let gated = 0;
    net.gate = (url) => (url.pathname === "/api/v1/planner/items" && gated++ === 0 ? held : undefined);
    const first = worker;
    void fake.message({ type: "canvas-page", origin: CANVAS }, tabSender(CANVAS));
    await until(() => plannerRequests() === 2);

    await boot(); // the browser restarted the worker; storage.session still has the lock
    await openCanvas();
    expect(plannerRequests()).toBe(2);
    release();
    await first.settled();
    expect(fake.session.has(`sync:${CANVAS}`)).toBe(false);
    net.gate = undefined;

    // A lock with no heartbeat for LOCK_STALE_MS is a dead worker's.
    age(CANVAS, worker.MIN_INTERVAL_MS);
    fake.session.set(`sync:${CANVAS}`, { instance: "gone", id: "x", at: Date.now() - worker.LOCK_STALE_MS - 1, phase: "details" });
    await openCanvas();
    expect(plannerRequests()).toBe(3);
    // A live-looking lock from another worker blocks page loads, but not the Sync button.
    age(CANVAS, worker.MIN_INTERVAL_MS);
    fake.session.set(`sync:${CANVAS}`, { instance: "gone", id: "y", at: Date.now(), phase: "details" });
    await openCanvas();
    expect(plannerRequests()).toBe(3);
    await syncButton();
    expect(plannerRequests()).toBe(4);
  });

  it("backs off after failures: a minute while signed out, doubling from two minutes otherwise", async () => {
    await pair();
    await openCanvas();
    age(CANVAS, worker.MIN_INTERVAL_MS);
    net.signedIn.delete(CANVAS);
    await openCanvas();
    let last = lastSync();
    expect(last).toMatchObject({ ok: false, message: "not signed in to Canvas", failures: 1 });
    expect(Date.parse(last.retryAt!) - Date.parse(last.at)).toBe(worker.SIGNED_OUT_RETRY_MS);
    expect(fake.badge.text).toBe("!");
    expect(fake.badge.title).toContain("school.instructure.com: not signed in to Canvas");
    const n = canvasRequests();
    await openCanvas();
    expect(canvasRequests()).toBe(n);
    age(CANVAS, worker.SIGNED_OUT_RETRY_MS);
    await openCanvas();
    expect(canvasRequests()).toBe(n + 1); // one /users/self, still signed out
    expect(lastSync().failures).toBe(2);

    // Signed in again; then the planner server fails, and each retry waits twice as long.
    net.signedIn.add(CANVAS);
    await syncButton();
    expect(lastSync()).toMatchObject({ ok: true });
    expect(lastSync().failures).toBeUndefined();
    net.intercept = (url) => (url.pathname === "/api/ingest" ? Response.json({ error: "down for maintenance" }, { status: 503 }) : undefined);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      age(CANVAS, i === 0 ? worker.MIN_INTERVAL_MS : delays.at(-1)!);
      await openCanvas();
      last = lastSync();
      expect(last).toMatchObject({ ok: false, failures: i + 1 });
      expect(last.message).toBe("planner server 503: down for maintenance");
      delays.push(Date.parse(last.retryAt!) - Date.parse(last.at));
    }
    expect(delays).toEqual([worker.BACKOFF_BASE_MS, 2 * worker.BACKOFF_BASE_MS, 4 * worker.BACKOFF_BASE_MS]);
    const before = plannerRequests();
    age(CANVAS, delays.at(-1)! / 2);
    await openCanvas();
    expect(plannerRequests()).toBe(before);
    net.intercept = undefined;
    await syncButton();
    expect(lastSync().ok).toBe(true);
    expect(fake.badge).toEqual({ text: "", title: worker.DEFAULT_TITLE });
  });

  it("reads a sign-in page, an HTML answer or a blocked SSO redirect as signed out", async () => {
    await pair();
    await openCanvas();
    net.intercept = (url) => (url.origin === CANVAS ? redirectedTo(`${CANVAS}/login/saml`, "<!doctype html><title>Sign in</title>", "text/html") : undefined);
    await syncButton();
    expect(lastSync()).toMatchObject({ ok: false, message: "not signed in to Canvas" });
    net.intercept = (url) => (url.origin === CANVAS ? new Response("<html><body>Portal</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) : undefined);
    await syncButton();
    expect(lastSync()).toMatchObject({ ok: false, message: "not signed in to Canvas" });
    net.intercept = (url) => {
      if (url.origin === CANVAS) throw new TypeError("Failed to fetch");
      return undefined;
    };
    await syncButton();
    expect(lastSync().message).toMatch(/sign-in page/);
    expect(Date.parse(lastSync().retryAt!) - Date.parse(lastSync().at)).toBe(worker.SIGNED_OUT_RETRY_MS);
  });

  it("never registers Instructure's own sites, beta or test copies, or an address that does not answer like Canvas", async () => {
    await pair();
    for (const origin of [BETA, "https://school.test.instructure.com", "https://community.instructure.com", "https://www.instructure.com"]) {
      await openCanvas(origin);
    }
    expect(canvasRequests()).toBe(0);
    expect(settings().canvasOrigins).toEqual([]);

    // Signed out, /users/self is a 401: the origin waits for a page where the student is signed in.
    net.signedIn.delete(CANVAS);
    await openCanvas();
    expect(settings().canvasOrigins).toEqual([]);
    // An HTML answer to /users/self is not Canvas either.
    net.signedIn.add(CANVAS);
    net.intercept = (url) => (url.pathname === "/api/v1/users/self" ? new Response("<html></html>", { headers: { "content-type": "text/html" } }) : undefined);
    await openCanvas();
    expect(settings().canvasOrigins).toEqual([]);
    net.intercept = undefined;

    // A school's own address without the permission is not even asked.
    const n = canvasRequests();
    await openCanvas(VANITY);
    expect(canvasRequests()).toBe(n);
    // A tab claiming another origin than its own.
    expect(await fake.message({ type: "canvas-page", origin: CANVAS }, tabSender(OTHER))).toMatchObject({ ok: false });
    expect(settings().canvasOrigins).toEqual([]);

    await openCanvas();
    expect(settings().canvasOrigins).toEqual([CANVAS]);
  });

  it("stops syncing a Canvas the server refuses, until the student adds it back", async () => {
    const strict = await startPlanner({ canvasHostAllowlist: ["school.edu"] });
    try {
      await pair(strict);
      await openCanvas();
      expect(settings().canvasOrigins).toEqual([]);
      expect(settings().ignoredOrigins?.[CANVAS]).toBe("the planner server does not accept this Canvas address");
      expect(settings().lastSync?.[CANVAS]).toBeUndefined();
      const n = canvasRequests();
      await openCanvas();
      expect(canvasRequests()).toBe(n);
      // Pairing again (perhaps with another server) forgets the refusal, not the student's own removals.
      await fake.message({ type: "remove-origin", origin: OTHER }, pageSender());
      await pair();
      expect(settings().ignoredOrigins).toEqual({ [OTHER]: REMOVED_BY_STUDENT });
      await openCanvas();
      expect(settings().canvasOrigins).toEqual([CANVAS]);
    } finally {
      await strict.close();
    }
  });

  it("adds and removes a school's own address, and forgets everything", async () => {
    await pair();
    await openCanvas();
    // Not signed in there yet: refused, and the permission handed back.
    net.signedIn.delete(VANITY);
    await fake.chrome.permissions.request({ origins: [originPattern(VANITY)] });
    const refused = await fake.message<Reply>({ type: "add-origin", origin: VANITY }, pageSender());
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toMatch(/could not confirm Canvas at https:\/\/canvas\.school\.edu \(not signed in to Canvas\)/);
    expect(await fake.chrome.permissions.contains({ origins: [originPattern(VANITY)] })).toBe(false);

    net.signedIn.add(VANITY);
    await fake.chrome.permissions.request({ origins: [originPattern(VANITY)] });
    const added = await fake.message<Reply>({ type: "add-origin", origin: VANITY }, pageSender());
    expect(added).toMatchObject({ ok: true });
    await worker.settled();
    expect(fake.scripts.get(scriptId(VANITY))?.matches).toEqual(["https://canvas.school.edu/*"]);
    expect(settings().canvasOrigins).toEqual([CANVAS, VANITY]);
    expect(lastSync(VANITY).ok).toBe(true);

    // The browser lost the dynamic script: the next worker start puts it back.
    fake.scripts.clear();
    await boot();
    expect(fake.scripts.has(scriptId(VANITY))).toBe(true);

    expect(await fake.message({ type: "remove-origin", origin: VANITY }, pageSender())).toMatchObject({ ok: true });
    expect(fake.scripts.size).toBe(0);
    expect(await fake.chrome.permissions.contains({ origins: [originPattern(VANITY)] })).toBe(false);
    expect(settings().canvasOrigins).toEqual([CANVAS]);
    expect(settings().ignoredOrigins).toEqual({ [VANITY]: REMOVED_BY_STUDENT });
    expect(settings().lastSync?.[VANITY]).toBeUndefined();

    // A removed *.instructure.com origin is not registered again by its own pages (the content script still runs there).
    await fake.message({ type: "remove-origin", origin: CANVAS }, pageSender());
    const n = canvasRequests();
    await openCanvas();
    expect(canvasRequests()).toBe(n);
    expect(settings().canvasOrigins).toEqual([]);

    const forgot = await fake.message<Reply>({ type: "forget" }, pageSender());
    expect(forgot).toMatchObject({ ok: true, status: { paired: false, canvasOrigins: [] } });
    expect(fake.local.size).toBe(0);
    expect(fake.session.size).toBe(0);
    expect(fake.scripts.size).toBe(0);
    expect((await fake.chrome.permissions.getAll()).origins).toEqual(manifest.host_permissions);
    expect(fake.badge).toEqual({ text: "", title: worker.UNPAIRED_TITLE });
  });

  it("drops what a sync was doing when the student forgets everything mid-sync", async () => {
    await pair();
    await openCanvas();
    age(CANVAS, worker.MIN_INTERVAL_MS);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    net.gate = (url) => (url.pathname === "/api/v1/planner/items" ? held : undefined);
    void fake.message({ type: "sync-now" }, tabSender(CANVAS));
    await until(() => plannerRequests() === 2);
    await fake.message({ type: "forget" }, pageSender());
    release();
    await worker.settled();
    expect(fake.local.size).toBe(0);
    expect(fake.session.size).toBe(0);
  });

  it("takes pairing, adding, removal and forgetting only from the extension's own pages", async () => {
    await pair();
    await openCanvas();
    for (const msg of [{ type: "forget" }, { type: "remove-origin", origin: CANVAS }, { type: "pair", serverUrl: "https://evil.example", code: "AAAA-BBBB-CCCC" }, { type: "add-origin", origin: OTHER }]) {
      expect(await fake.message(msg, tabSender(CANVAS))).toMatchObject({ ok: false, error: "only the extension's options page can do that" });
    }
    expect(settings()).toMatchObject({ serverUrl: planner.base, canvasOrigins: [CANVAS] });
    // A Canvas tab sees its own origin's status, not the server address or other origins.
    const st = await fake.message<Reply>({ type: "get-status" }, tabSender(CANVAS));
    expect(st.ok && st.status.serverUrl).toBe(undefined);
    expect(st.ok && Object.keys(st.status.lastSync)).toEqual([CANVAS]);
    // The dashboard button opens the assistant.
    await fake.message({ type: "open-assistant" }, tabSender(CANVAS));
    expect(fake.opened.tabs).toEqual([expect.stringMatching(/^https:\/\/claude\.ai\/new\?q=Plan%20my%20week/)]);
  });

  it("opens the options page from the toolbar until there is something to sync, then syncs everything", async () => {
    fake.clickAction();
    await worker.settled();
    expect(fake.opened.options).toBe(1);
    expect(fake.badge.title).toBe(worker.UNPAIRED_TITLE);
    await pair();
    fake.clickAction();
    await worker.settled();
    expect(fake.opened.options).toBe(2);
    await openCanvas();
    fake.clickAction();
    await worker.settled();
    expect(fake.opened.options).toBe(2);
    expect(plannerRequests()).toBe(2); // forced, although the first sync is fresh
  });

  it("creates the alarm at worker start when the browser lost it, leaves it alone otherwise, and syncs on it", async () => {
    expect(fake.alarms.get(worker.SYNC_ALARM)?.periodInMinutes).toBe(worker.SYNC_PERIOD_MINUTES);
    const creates = fake.alarmCreates;
    await boot();
    expect(fake.alarmCreates).toBe(creates);
    fake.alarms.clear(); // Firefox does not keep alarms across a restart
    await boot();
    expect(fake.alarms.has(worker.SYNC_ALARM)).toBe(true);

    await pair();
    await openCanvas();
    age(CANVAS, worker.MIN_INTERVAL_MS);
    fake.fireAlarm(worker.SYNC_ALARM);
    await worker.settled();
    expect(plannerRequests()).toBe(2);
  });

  it("keeps each origin's result, and one origin's success does not clear another's warning", async () => {
    await pair();
    await openCanvas(CANVAS);
    await openCanvas(OTHER);
    expect(settings().canvasOrigins).toEqual([CANVAS, OTHER]);
    // Both finish at once: neither result is lost to the other's write.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    net.intercept = async (url) => {
      if (url.pathname !== "/api/me") return undefined;
      waiting++;
      await held;
      return undefined;
    };
    const both = Promise.all([syncButton(CANVAS), syncButton(OTHER)]);
    await until(() => waiting === 2);
    const before = { [CANVAS]: lastSync(CANVAS).at, [OTHER]: lastSync(OTHER).at };
    await new Promise((resolve) => setTimeout(resolve, 2));
    release();
    await both;
    net.intercept = undefined;
    expect(lastSync(CANVAS).at).not.toBe(before[CANVAS]);
    expect(lastSync(OTHER).at).not.toBe(before[OTHER]);

    net.signedIn.delete(OTHER);
    await Promise.all([syncButton(CANVAS), syncButton(OTHER)]);
    expect(lastSync(CANVAS).ok).toBe(true);
    expect(lastSync(OTHER)).toMatchObject({ ok: false, message: "not signed in to Canvas" });
    expect(fake.badge.text).toBe("!");
    expect(fake.badge.title).toBe("Planner for Canvas: other.instructure.com: not signed in to Canvas");
    await syncButton(CANVAS);
    expect(fake.badge.text).toBe("!");
    net.signedIn.add(OTHER);
    await syncButton(OTHER);
    expect(fake.badge).toEqual({ text: "", title: worker.DEFAULT_TITLE });
  });

  it("stops reading details when Canvas throttles, keeps what it read, and says so", async () => {
    await pair();
    let details = 0;
    net.intercept = (url) => {
      if (url.origin !== CANVAS || !/\/assignments\/\d+$/.test(url.pathname)) return undefined;
      if (++details <= worker.DETAIL_CONCURRENCY) return undefined;
      return new Response("403 Forbidden (Rate Limit Exceeded)", { status: 403, headers: { "content-type": "text/plain", "x-rate-limit-remaining": "0" } });
    };
    await openCanvas();
    expect(lastSync()).toMatchObject({ ok: true, message: expect.stringMatching(/, 4 details; Canvas asked us to slow down, the rest next sync$/) });
    expect(details).toBe(2 * worker.DETAIL_CONCURRENCY);

    // A 403 that is not a throttle skips that item only, and the server is told so it backs off on it.
    age(CANVAS, worker.MIN_INTERVAL_MS);
    let forbidden: string | undefined;
    net.intercept = (url) => {
      const m = /\/assignments\/(\d+)$/.exec(url.pathname);
      if (url.origin !== CANVAS || !m || (forbidden && forbidden !== m[1])) return undefined;
      forbidden = m[1];
      return Response.json({ status: "unauthorized" }, { status: 403 });
    };
    await openCanvas();
    expect(lastSync().ok).toBe(true);
    expect(lastSync().message).not.toMatch(/slow down/);
    const failures = net.requests.flatMap((r) => (r.json?.["detailFailures"] as string[] | undefined) ?? []);
    expect(failures).toEqual([forbidden]);
    const token = settings().deviceToken!;
    const wanted = (await realFetch(`${planner.base}/api/ingest/wanted?baseUrl=${encodeURIComponent(CANVAS)}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())) as { wanted: Array<{ assignmentId: string }> };
    expect(wanted.wanted.map((w) => String(w.assignmentId))).not.toContain(forbidden);
  });

  it("sends the planner window only when it read the planner list to its last page", async () => {
    await pair();
    // A Canvas that always has another page: the extension stops at 20 and must not claim the list is complete.
    net.intercept = (url) => {
      if (url.origin !== CANVAS || url.pathname !== "/api/v1/planner/items") return undefined;
      const next = new URL(url.href);
      next.searchParams.set("page", String(Number(url.searchParams.get("page") ?? 1) + 1));
      return new Response("[]", { headers: { "content-type": "application/json", link: `<${next.href}>; rel="next"` } });
    };
    await openCanvas();
    expect(lastSync().ok).toBe(true);
    expect(net.requests.filter((r) => r.url.includes("/api/v1/planner/items")).length).toBe(20);
    const first = net.requests.find((r) => r.method === "POST" && r.url === `${planner.base}/api/ingest`)!;
    expect(first.json!["plannerWindow"]).toBeUndefined();
  });
});
