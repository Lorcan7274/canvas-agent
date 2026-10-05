/**
 * End to end: stub Canvas → server → MCP client, plus the OAuth flow an
 * assistant performs, the extension's pairing and ingest, and the plan feed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startStubCanvas, type StubCanvas } from "@canvas-agent/stub-canvas";
import { EstimateService, Sealer, Store, parseIcs } from "@canvas-agent/core";
import { loadConfig } from "../apps/server/src/config.js";
import { Services } from "../apps/server/src/services.js";
import { createApp } from "../apps/server/src/app.js";

let stub: StubCanvas;
let http: Server;
let base: string;
let services: Services;
let userId: string;
let connectorKey: string;

/** The app needs its public URL before it listens, so reserve a port first. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  stub = await startStubCanvas(0);
  const store = new Store();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({ baseUrl: base, secretKey: "test-secret-key-0123456789", rateLimit: false, authMode: "dev", dbPath: ":memory:", useLlm: false, allowLoopbackEgress: true });
  services = new Services(store, new Sealer(config.secretKey), config, new EstimateService(store));
  const app = createApp({ services, log: () => {} });
  http = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  const user = store.createUser("sam@example.edu", "Sam", { timezone: "America/New_York" });
  userId = user.id;
  services.addTokenAccount(userId, stub.origin, stub.token);
  await services.syncUser(userId);
  connectorKey = services.createConnectorKey(userId, "test");
});

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  await stub.close();
});

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

describe("MCP over a connector key", () => {
  it("rejects a missing or bad token with a 401 and resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
    const meta = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json() as Promise<{ resource: string; authorization_servers: string[] }>);
    expect(meta.resource).toBe(`${base}/mcp`);
    expect(new URL(meta.authorization_servers[0]!).origin).toBe(base);
  });

  it("lists annotated tools and prompts", async () => {
    const client = await mcpClient(connectorKey);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["clear_plan", "commit_plan", "get_assignment", "get_plan", "get_preferences", "get_profile", "get_workload", "log_time", "move_block", "propose_plan", "remove_blocks", "set_preferences"]);
    // Both directories want every hint stated, not inferred from defaults.
    const expected: Record<string, [readOnly: boolean, destructive: boolean, idempotent: boolean]> = {
      get_workload: [true, false, true],
      get_assignment: [true, false, true],
      propose_plan: [true, false, true],
      get_plan: [true, false, true],
      get_preferences: [true, false, true],
      get_profile: [true, false, true],
      commit_plan: [false, false, true],
      clear_plan: [false, true, true],
      remove_blocks: [false, true, true],
      move_block: [false, true, true],
      log_time: [false, false, false],
      set_preferences: [false, false, true],
    };
    for (const t of tools.tools) {
      expect(t.title ?? t.annotations?.title, t.name).toBeTruthy();
      const a = t.annotations ?? {};
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) expect(typeof a[hint], `${t.name} ${hint}`).toBe("boolean");
      expect([a.readOnlyHint, a.destructiveHint, a.idempotentHint], t.name).toEqual(expected[t.name]);
      expect(a.openWorldHint, t.name).toBe(false);
    }
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(["plan_my_week", "weekly_checkin", "whats_due"]);
    await client.close();
  });

  it("runs the planning loop: workload → propose → commit → feed → log_time", async () => {
    const client = await mcpClient(connectorKey);
    const workload = structured<{ items: Array<{ id: string; title: string; estimate: { p50Hours: number } }>; warnings: string[] }>(await client.callTool({ name: "get_workload", arguments: {} }));
    expect(workload.items.length).toBeGreaterThanOrEqual(6);
    expect(workload.items.find((i) => i.id === "canvas:assignment:1003")?.estimate.p50Hours).toBe(1);

    const detail = structured<{ item: { title: string }; estimate: { steps: string[] } }>(await client.callTool({ name: "get_assignment", arguments: { item_id: "canvas:assignment:2001" } }));
    expect(detail.item.title).toContain("Essay 2");
    expect(detail.estimate.steps.length).toBeGreaterThan(2);

    const proposal = structured<{ blocks: Array<{ itemId: string; start: string; end: string; minutes: number }>; unscheduled: unknown[]; busySource: string }>(
      await client.callTool({ name: "propose_plan", arguments: { busy: [{ start: new Date(Date.now() + 3_600_000).toISOString(), end: new Date(Date.now() + 7_200_000).toISOString() }] } }),
    );
    expect(proposal.busySource).toBe("provided");
    expect(proposal.blocks.length).toBeGreaterThan(0);

    const first = proposal.blocks.slice(0, 2);
    const commit = structured<{ created: Array<{ itemId: string }>; calendar: string }>(
      await client.callTool({ name: "commit_plan", arguments: { blocks: first.map((b) => ({ item_id: b.itemId, start: b.start, end: b.end })) } }),
    );
    expect(commit.created).toHaveLength(2);
    expect(commit.calendar).toBe("ics");

    // The feed link is a capability: it is on the settings page, never in a tool result.
    expect(JSON.stringify(commit)).not.toContain("/feeds/plan/");
    const ics = await fetch(services.planFeedUrl(userId)).then((r) => r.text());
    expect(parseIcs(ics)).toHaveLength(2);
    expect(parseIcs(ics)[0]?.summary).toMatch(/^Study: /);

    const after = structured<{ items: Array<{ id: string; plannedMinutes: number }> }>(await client.callTool({ name: "get_workload", arguments: {} }));
    const planned = after.items.find((i) => i.id === first[0]!.itemId)!;
    expect(planned.plannedMinutes).toBeGreaterThan(0);

    // The committed blocks are still ahead: logging finished work removes them rather than marking them done.
    const logged = structured<{ minutes: number; blocksClosed: number; blocksRemoved: number }>(await client.callTool({ name: "log_time", arguments: { item_id: first[0]!.itemId, bucket: "2-4h" } }));
    expect(logged.minutes).toBe(180);
    expect(logged.blocksClosed).toBe(0);
    expect(logged.blocksRemoved).toBe(first.filter((b) => b.itemId === first[0]!.itemId).length);

    // clear_plan removes exactly what is left of the plan from now on.
    const left = first.filter((b) => b.itemId !== first[0]!.itemId).length;
    const cleared = structured<{ cleared: number; failed: unknown[] }>(await client.callTool({ name: "clear_plan", arguments: {} }));
    expect(cleared.cleared).toBe(left);
    expect(cleared.failed).toEqual([]);
    expect(parseIcs(await fetch(services.planFeedUrl(userId)).then((r) => r.text()))).toHaveLength(0);
    const again = structured<{ cleared: number }>(await client.callTool({ name: "clear_plan", arguments: {} }));
    expect(again.cleared).toBe(0);

    const prefs = structured<{ timezone: string }>(await client.callTool({ name: "set_preferences", arguments: { timezone: "Europe/Dublin", max_hours_per_day: 3 } }));
    expect(prefs.timezone).toBe("Europe/Dublin");
    await expect(client.callTool({ name: "set_preferences", arguments: { timezone: "Mars/Olympus" } })).resolves.toMatchObject({ isError: true });
    await client.close();
  });
});

describe("OAuth: an assistant connects with dynamic registration and PKCE", () => {
  it("registers, authorizes through login + consent, exchanges the code, refreshes, and calls a tool", async () => {
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(meta["client_id_metadata_document_supported"]).toBe(true);
    expect(meta["code_challenge_methods_supported"]).toContain("S256");

    const reg = await fetch(String(meta["registration_endpoint"]), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test Assistant", redirect_uris: ["https://assistant.example/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    }).then((r) => r.json() as Promise<{ client_id: string }>);
    expect(reg.client_id).toBeTruthy();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL(String(meta["authorization_endpoint"]));
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", reg.client_id);
    authUrl.searchParams.set("redirect_uri", "https://assistant.example/callback");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", "xyz");
    authUrl.searchParams.set("resource", `${base}/mcp`);
    const r1 = await fetch(authUrl, { redirect: "manual" });
    expect(r1.status).toBe(302);
    const consentUrl = new URL(r1.headers.get("location")!, base);
    expect(consentUrl.pathname).toBe("/authorize/consent");

    // Not signed in: consent bounces to login.
    const r2 = await fetch(consentUrl, { redirect: "manual" });
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toContain("/login?next=");

    // Dev login creates the session.
    const login = await fetch(`${base}/login/dev`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "oauth@example.edu", next: consentUrl.pathname + consentUrl.search }),
    });
    expect(login.status).toBe(302);
    const sid = /sid=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    expect(sid).toBeTruthy();
    const cookie = `sid=${sid}`;

    const consentPage = await fetch(consentUrl, { headers: { cookie } }).then((r) => r.text());
    expect(consentPage).toContain("Test Assistant");
    const csrf = /name="csrf" value="([^"]+)"/.exec(consentPage)?.[1];
    const pending = /name="pending" value="([^"]+)"/.exec(consentPage)?.[1];
    expect(csrf && pending).toBeTruthy();

    const allow = await fetch(`${base}/authorize/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ csrf: csrf!, pending: pending!, decision: "allow" }),
    });
    expect(allow.status).toBe(302);
    const redirect = new URL(allow.headers.get("location")!);
    expect(redirect.origin).toBe("https://assistant.example");
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code")!;
    expect(code).toMatch(/^ac_/);

    const tokens = await fetch(String(meta["token_endpoint"]), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://assistant.example/callback", resource: `${base}/mcp` }),
    }).then((r) => r.json() as Promise<{ access_token: string; refresh_token: string; token_type: string }>);
    expect(tokens.access_token).toMatch(/^at_/);
    expect(tokens.token_type.toLowerCase()).toBe("bearer");

    // A reused code must fail.
    const reuse = await fetch(String(meta["token_endpoint"]), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://assistant.example/callback" }),
    });
    expect(reuse.status).toBe(400);

    const client = await mcpClient(tokens.access_token);
    const profile = structured<{ email: string }>(await client.callTool({ name: "get_profile", arguments: {} }));
    expect(profile.email).toBe("oauth@example.edu");
    await client.close();

    const refreshed = await fetch(String(meta["token_endpoint"]), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }),
    }).then((r) => r.json() as Promise<{ access_token: string; refresh_token: string }>);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    // The old refresh token was rotated out.
    const stale = await fetch(String(meta["token_endpoint"]), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }),
    });
    expect(stale.status).toBe(400);
  });
});

describe("extension pairing and ingest", () => {
  it("pairs with a code, ingests a session snapshot, and reports what details it wants", async () => {
    const page = await fetch(`${base}/login/dev`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "ext@example.edu" }) });
    const sid = /sid=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1];
    const settings = await fetch(`${base}/`, { headers: { cookie: `sid=${sid}` } }).then((r) => r.text());
    const csrf = /name="csrf" value="([^"]+)"/.exec(settings)?.[1]!;
    const pair = await fetch(`${base}/settings/pair`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `sid=${sid}` }, body: new URLSearchParams({ csrf }) });
    // The code is shown once on the page, never carried in the redirect URL.
    expect(pair.headers.get("location")).toBe("/");
    const shown = await fetch(`${base}/`, { headers: { cookie: `sid=${sid}` } }).then((r) => r.text());
    const code = /<pre>([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})<\/pre>/.exec(shown)?.[1]!;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const paired = await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Chrome on laptop" }) }).then((r) => r.json() as Promise<{ deviceToken: string }>);
    expect(paired.deviceToken).toMatch(/^dv_/);
    const again = await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    expect(again.status).toBe(400);

    const cookieFetch = (path: string) => fetch(`${stub.origin}${path}`, { headers: { cookie: "canvas_session=ok", accept: "application/json" } }).then((r) => r.json());
    const snapshot = {
      baseUrl: stub.origin,
      fetchedAt: new Date().toISOString(),
      courses: await cookieFetch("/api/v1/courses?per_page=100"),
      plannerItems: await cookieFetch("/api/v1/planner/items?start_date=2026-01-01&end_date=2027-12-31&per_page=100"),
    };
    const ingest = await fetch(`${base}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${paired.deviceToken}` }, body: JSON.stringify(snapshot) }).then((r) => r.json() as Promise<{ ok: boolean; items: number }>);
    expect(ingest.ok).toBe(true);
    expect(ingest.items).toBeGreaterThan(5);

    const wanted = await fetch(`${base}/api/ingest/wanted`, { headers: { authorization: `Bearer ${paired.deviceToken}` } }).then((r) => r.json() as Promise<{ wanted: Array<{ courseId: string; assignmentId: string }> }>);
    expect(wanted.wanted.length).toBeGreaterThan(3);

    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${paired.deviceToken}` } }).then((r) => r.json() as Promise<{ assistant: string; accounts: Array<{ kind: string }> }>);
    expect(me.assistant).toBe("claude");
    expect(me.accounts.some((a) => a.kind === "session")).toBe(true);

    const nope = await fetch(`${base}/api/me`, { headers: { authorization: "Bearer dv_nope" } });
    expect(nope.status).toBe(401);
  });
});
