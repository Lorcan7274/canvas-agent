/**
 * Identity, sessions and the OAuth server under attack: each test is one of
 * the reviewed findings, exercised over HTTP against a real app.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EstimateService, Sealer, Store, hashToken } from "@canvas-agent/core";
import { loadConfig, type Config } from "../apps/server/src/config.js";
import { Services } from "../apps/server/src/services.js";
import { createApp } from "../apps/server/src/app.js";
import { GoogleCalendar } from "../apps/server/src/google/calendar.js";
import { safeNext } from "../apps/server/src/auth/login.js";
import { FAMILY_TTL_S } from "../apps/server/src/auth/oauth-provider.js";

const SECRET = "test-secret-key-0123456789-abcdefghij";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Running {
  base: string;
  store: Store;
  services: Services;
  close: () => Promise<void>;
}

const running: Running[] = [];

async function startApp(opts: { config?: Partial<Config>; fetchImpl?: typeof fetch; google?: GoogleCalendar } = {}): Promise<Running> {
  const store = new Store();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = loadConfig({ baseUrl: base, secretKey: SECRET, rateLimit: false, authMode: "dev", dbPath: ":memory:", useLlm: false, ...opts.config });
  const services = new Services(store, new Sealer(config.secretKey), config, new EstimateService(store), opts.google);
  const app = createApp({ services, log: () => {}, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const http = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  const r: Running = { base, store, services, close: () => new Promise<void>((done) => http.close(() => done())) };
  running.push(r);
  return r;
}

afterAll(async () => {
  for (const r of running) await r.close();
});

function sidFrom(res: Response, name = "sid"): string | undefined {
  const all = res.headers.getSetCookie();
  for (const c of all) {
    const m = new RegExp(`^${name.replace(/[$]/g, "\\$")}=([^;]*)`).exec(c);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

async function devLogin(base: string, email: string, headers: Record<string, string> = {}): Promise<{ res: Response; sid: string | undefined }> {
  const res = await fetch(`${base}/login/dev`, { method: "POST", redirect: "manual", headers: { ...FORM, ...headers }, body: new URLSearchParams({ email }) });
  return { res, sid: sidFrom(res) };
}

async function csrfOf(base: string, cookie: string, path = "/"): Promise<string> {
  const html = await fetch(`${base}${path}`, { headers: { cookie } }).then((r) => r.text());
  return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
}

// ---------------------------------------------------------------------------

describe("config refuses unsafe production setups", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses dev login on an https BASE_URL unless ALLOW_DEV_LOGIN=1", () => {
    expect(() => loadConfig({ baseUrl: "https://planner.example", secretKey: SECRET, authMode: "dev" })).toThrow(/dev login/);
    expect(loadConfig({ baseUrl: "https://planner.example", secretKey: SECRET, authMode: "dev", allowDevLogin: true }).authMode).toBe("dev");
    vi.stubEnv("ALLOW_DEV_LOGIN", "1");
    expect(loadConfig({ baseUrl: "https://planner.example", secretKey: SECRET, authMode: "dev" }).allowDevLogin).toBe(true);
  });

  it("refuses dev login under NODE_ENV=production, even when AUTH_MODE=dev is set beside Google credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "dev");
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret");
    vi.stubEnv("SECRET_KEY", SECRET);
    expect(() => loadConfig({ baseUrl: "http://localhost:8787" })).toThrow(/dev login/);
    vi.stubEnv("AUTH_MODE", "");
    expect(loadConfig({ baseUrl: "http://localhost:8787" }).authMode).toBe("google");
  });

  it("refuses placeholder and short SECRET_KEYs in production, and a missing one", () => {
    const google = { clientId: "cid", clientSecret: "csecret" };
    for (const weak of ["dev-secret-key-change-me", "change-me-to-a-long-random-string", "short-but-not-a-placeholder"]) {
      expect(() => loadConfig({ baseUrl: "https://planner.example", secretKey: weak, authMode: "google", google })).toThrow(/SECRET_KEY/);
    }
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SECRET_KEY", "");
    expect(() => loadConfig({ baseUrl: "https://planner.example", authMode: "google", google })).toThrow(/SECRET_KEY is required/);
    expect(loadConfig({ baseUrl: "https://planner.example", secretKey: SECRET, authMode: "google", google }).production).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("dev login", () => {
  let app: Running;
  beforeAll(async () => {
    app = await startApp();
  });

  it("refuses cross-site posts (login CSRF) and accepts same-origin ones", async () => {
    expect((await devLogin(app.base, "a@example.edu", { origin: "https://evil.example" })).res.status).toBe(403);
    expect((await devLogin(app.base, "a@example.edu", { "sec-fetch-site": "cross-site" })).res.status).toBe(403);
    expect((await devLogin(app.base, "a@example.edu", { "sec-fetch-site": "same-site" })).res.status).toBe(403);
    const ok = await devLogin(app.base, "a@example.edu", { origin: app.base, "sec-fetch-site": "same-origin" });
    expect(ok.res.status).toBe(302);
    expect(ok.sid).toBeTruthy();
  });

  it("never signs into an account that has a Google link", async () => {
    const victim = app.store.createUser("victim@example.edu", "Victim");
    app.store.putGoogleAccount({ userId: victim.id, email: victim.email, refreshTokenSealed: app.services.sealer.seal("rt"), accessTokenSealed: null, accessExpiresAt: null, calendarId: "primary", scopes: null });
    const { res, sid } = await devLogin(app.base, "victim@example.edu");
    expect(res.status).toBe(403);
    expect(sid).toBeUndefined();
  });

  it("only redirects to same-origin paths after sign-in", async () => {
    for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example", "/%0d%0aSet-Cookie:x", "\\\\evil.example"]) expect(safeNext(evil), evil).toMatch(/^\/(?!\/|\\)/);
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/authorize/consent?pending=abc")).toBe("/authorize/consent?pending=abc");
    const res = await fetch(`${app.base}/login/dev`, { method: "POST", redirect: "manual", headers: FORM, body: new URLSearchParams({ email: "n@example.edu", next: "/\\evil.example" }) });
    expect(res.headers.get("location")).toBe("/");
  });
});

// ---------------------------------------------------------------------------

describe("sessions", () => {
  let app: Running;
  beforeAll(async () => {
    app = await startApp();
  });

  it("stores only a hash of the session id and sets a locked-down cookie", async () => {
    const { res, sid } = await devLogin(app.base, "s@example.edu");
    const cookieLine = res.headers.getSetCookie().find((c) => c.startsWith("sid="))!;
    expect(cookieLine).toMatch(/HttpOnly/);
    expect(cookieLine).toMatch(/SameSite=Lax/);
    const raw = app.store.db.prepare("SELECT COUNT(*) AS n FROM login_sessions WHERE id = ?").get(sid!) as { n: number };
    const hashed = app.store.db.prepare("SELECT COUNT(*) AS n FROM login_sessions WHERE id = ?").get(hashToken(sid!)) as { n: number };
    expect(raw.n).toBe(0);
    expect(hashed.n).toBe(1);
  });

  it("ends a session left idle, and a stale cookie is just signed out", async () => {
    const { sid } = await devLogin(app.base, "idle@example.edu");
    const cookie = `sid=${sid}`;
    expect(await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text())).toContain("Signed in as");
    app.store.db.prepare("UPDATE login_sessions SET idle_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), hashToken(sid!));
    expect(await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text())).not.toContain("Signed in as");
  });

  it("logs out only on a POST with the CSRF token", async () => {
    const { sid } = await devLogin(app.base, "out@example.edu");
    const cookie = `sid=${sid}`;
    const confirm = await fetch(`${app.base}/logout`, { headers: { cookie }, redirect: "manual" });
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('action="/logout"');
    expect(app.services.store.userForLoginSession(hashToken(sid!))).toBeTruthy();
    const forged = await fetch(`${app.base}/logout`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie }, body: new URLSearchParams({ csrf: "0".repeat(32) }) });
    expect(forged.status).toBe(403);
    const csrf = await csrfOf(app.base, cookie, "/logout");
    const out = await fetch(`${app.base}/logout`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie }, body: new URLSearchParams({ csrf }) });
    expect(out.status).toBe(302);
    const cleared = out.headers.getSetCookie().find((c) => c.startsWith("sid="))!;
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/HttpOnly/);
    expect(app.services.store.userForLoginSession(hashToken(sid!))).toBeUndefined();
  });

  it("uses a __Host- Secure cookie on https", async () => {
    // The app listens on plain http here; BASE_URL is what decides the cookie.
    const httpsApp = await startApp({ config: { baseUrl: "https://planner.test", allowDevLogin: true } });
    const login = await fetch(`${httpsApp.base}/login/dev`, { method: "POST", redirect: "manual", headers: { ...FORM, origin: "https://planner.test" }, body: new URLSearchParams({ email: "h@example.edu" }) });
    expect(login.status).toBe(302);
    const line = login.headers.getSetCookie().find((c) => c.startsWith("__Host-sid="));
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/Path=\//);
    expect(line).toMatch(/HttpOnly/);
  });
});

// ---------------------------------------------------------------------------

/** Google's two endpoints, answering per authorization code. */
function fakeGoogle(): GoogleCalendar {
  const people: Record<string, { email: string; email_verified: boolean; name: string }> = {
    "code-attacker": { email: "attacker@example.edu", email_verified: true, name: "Attacker" },
    "code-victim": { email: "victim@example.edu", email_verified: true, name: "Victim" },
    "code-unverified": { email: "unverified@example.edu", email_verified: false, name: "Nobody" },
    "code-noscope": { email: "noscope@example.edu", email_verified: true, name: "Unticked" },
  };
  const FULL_SCOPE = "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://oauth2.googleapis.com/token") {
      const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
      if (!people[code]) return new Response("{}", { status: 400 });
      // "code-noscope" is a student who unticked the calendar permissions on Google's consent screen.
      return Response.json({ access_token: `gat-${code}`, expires_in: 3600, refresh_token: `grt-${code}`, scope: code === "code-noscope" ? "openid email" : FULL_SCOPE });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const who = people[auth.replace("Bearer gat-", "")];
      return who ? Response.json(who) : new Response("{}", { status: 401 });
    }
    return new Response("not faked", { status: 500 });
  }) as typeof fetch;
  return new GoogleCalendar("cid", "csecret", fakeFetch);
}

describe("Google sign-in is bound to the browser that started it", () => {
  let app: Running;
  beforeAll(async () => {
    app = await startApp({ config: { authMode: "google", google: { clientId: "cid", clientSecret: "csecret" } }, google: fakeGoogle() });
  });

  async function start(query: string, cookie?: string): Promise<{ state: string; nonce: string }> {
    const res = await fetch(`${app.base}/oauth/google/start?${query}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
    expect(res.status).toBe(302);
    const google = new URL(res.headers.get("location")!);
    expect(google.origin).toBe("https://accounts.google.com");
    return { state: google.searchParams.get("state")!, nonce: sidFrom(res, "gstate")! };
  }

  const callback = (state: string, code: string, cookie: string) => fetch(`${app.base}/oauth/google/callback?state=${state}&code=${code}`, { redirect: "manual", headers: { cookie } });

  async function signIn(code: string): Promise<string> {
    const { state, nonce } = await start("purpose=login");
    const res = await callback(state, code, `gstate=${nonce}`);
    expect(res.status).toBe(302);
    return `sid=${sidFrom(res)}`;
  }

  it("refuses a callback from a browser without the start cookie (forwarded callback or link)", async () => {
    const { state } = await start("purpose=login");
    const res = await callback(state, "code-attacker", "");
    expect(res.status).toBe(400);
    expect(sidFrom(res)).toBeUndefined();
    // and the state is spent, so the right browser cannot replay it either
    expect((await callback(state, "code-attacker", "gstate=whatever")).status).toBe(400);
  });

  it("signs in from the browser that started it", async () => {
    const cookie = await signIn("code-victim");
    expect(await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text())).toContain("victim@example.edu");
  });

  it("never lands a victim's calendar on the attacker's account", async () => {
    const attacker = await signIn("code-attacker");
    const victim = await signIn("code-victim");
    const attackerId = app.store.getUserByEmail("attacker@example.edu")!.id;
    const before = app.store.getGoogleAccount(attackerId)!.email;
    const { state, nonce } = await start("purpose=calendar", attacker);
    // The victim opens the attacker's Google link and consents: their browser has no nonce.
    expect((await callback(state, "code-victim", victim)).status).toBe(400);
    // Even with the nonce cookie planted, the account that started is not the one signed in.
    const second = await start("purpose=calendar", attacker);
    expect((await callback(second.state, "code-victim", `${victim}; gstate=${second.nonce}`)).status).toBe(400);
    expect(app.store.getGoogleAccount(attackerId)!.email).toBe(before);
    void nonce;
  });

  it("refuses an unverified Google email", async () => {
    const { state, nonce } = await start("purpose=login");
    const res = await callback(state, "code-unverified", `gstate=${nonce}`);
    expect(res.status).toBe(502);
    expect(sidFrom(res)).toBeUndefined();
    expect(app.store.getUserByEmail("unverified@example.edu")).toBeUndefined();
  });

  it("signs a student in but stores no calendar when the calendar scopes were unticked", async () => {
    const sid = await signIn("code-noscope");
    const user = app.store.getUserByEmail("noscope@example.edu")!;
    expect(app.store.getGoogleAccount(user.id)).toBeUndefined();
    // Connecting the calendar on purpose with the same half-grant is an error, not a silent "connected".
    const { state, nonce } = await start("purpose=calendar", sid);
    const res = await callback(state, "code-noscope", `${sid}; gstate=${nonce}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("calendar access");
    expect(app.store.getGoogleAccount(user.id)).toBeUndefined();
  });

  it("marks a Google account permanently, so the dev login refuses it even after the calendar link is gone", async () => {
    await signIn("code-victim");
    expect(app.store.getUserByEmail("victim@example.edu")!.signInProvider).toBe("google");
    // The guard itself lives behind the dev login, which only a dev-mode server exposes.
    const dev = await startApp();
    const user = dev.store.createUser("marked@example.edu", "Marked");
    dev.store.setSignInProvider(user.id, "google");
    expect(dev.store.getGoogleAccount(user.id)).toBeUndefined();
    const { res, sid } = await devLogin(dev.base, "marked@example.edu", { origin: dev.base, "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(403);
    expect(sid).toBeUndefined();
  });

  it("does not reflect Google's error into a URL", async () => {
    const { state, nonce } = await start("purpose=login");
    const res = await fetch(`${app.base}/oauth/google/callback?state=${state}&error=access_denied`, { redirect: "manual", headers: { cookie: `gstate=${nonce}` } });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(base: string, clientId: string, redirectUri: string, challenge: string, extra: Record<string, string> = {}): URL {
  const u = new URL(`${base}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u;
}

async function register(base: string, redirectUris: string[], name = "Test Assistant"): Promise<Response> {
  return fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none" }) });
}

async function mcpStatus(base: string, token: string): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
  });
  await res.text();
  return res.status;
}

async function tokenRequest(base: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, string> }> {
  const res = await fetch(`${base}/token`, { method: "POST", headers: FORM, body: new URLSearchParams(params) });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

describe("OAuth authorization server", () => {
  let app: Running;
  let cookie: string;
  beforeAll(async () => {
    app = await startApp();
    cookie = `sid=${(await devLogin(app.base, "oauth@example.edu")).sid}`;
  });

  /** Register, consent as the signed-in user, exchange the code. */
  async function connect(): Promise<{ clientId: string; access: string; refresh: string }> {
    const reg = (await (await register(app.base, ["https://assistant.example/cb"])).json()) as { client_id: string };
    const { verifier, challenge } = await pkce();
    const r1 = await fetch(authorizeUrl(app.base, reg.client_id, "https://assistant.example/cb", challenge), { redirect: "manual" });
    const consentUrl = new URL(r1.headers.get("location")!, app.base);
    const html = await fetch(consentUrl, { headers: { cookie } }).then((r) => r.text());
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;
    const allow = await fetch(`${app.base}/authorize/consent`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie }, body: new URLSearchParams({ csrf, pending, decision: "allow" }) });
    const code = new URL(allow.headers.get("location")!).searchParams.get("code")!;
    const t = await tokenRequest(app.base, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://assistant.example/cb" });
    expect(t.status).toBe(200);
    return { clientId: reg.client_id, access: t.body["access_token"]!, refresh: t.body["refresh_token"]! };
  }

  it("registers only https or loopback redirect URIs", async () => {
    expect((await register(app.base, ["https://assistant.example/cb"])).status).toBe(201);
    expect((await register(app.base, ["http://localhost:33418/callback"])).status).toBe(201);
    expect((await register(app.base, ["http://127.0.0.1:5000/cb"])).status).toBe(201);
    for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "myapp://cb", "https://a.example/cb#frag", "data:text/html,hi"]) {
      const res = await register(app.base, [bad]);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error, bad).toBe("invalid_client_metadata");
    }
  });

  it("rejects a resource other than this server's MCP endpoint", async () => {
    const reg = (await (await register(app.base, ["https://assistant.example/cb"])).json()) as { client_id: string };
    const { challenge } = await pkce();
    const res = await fetch(authorizeUrl(app.base, reg.client_id, "https://assistant.example/cb", challenge, { resource: "https://other.example/mcp" }), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const ok = await fetch(authorizeUrl(app.base, reg.client_id, "https://assistant.example/cb", challenge, { resource: `${app.base}/mcp` }), { redirect: "manual" });
    expect(new URL(ok.headers.get("location")!, app.base).pathname).toBe("/authorize/consent");
  });

  it("shows a registered client's name as unverified, with the redirect host, on an unframeable page", async () => {
    const reg = (await (await register(app.base, ["https://phish.example/cb"], "Claude")).json()) as { client_id: string };
    const { challenge } = await pkce();
    const r1 = await fetch(authorizeUrl(app.base, reg.client_id, "https://phish.example/cb", challenge), { redirect: "manual" });
    const page = await fetch(new URL(r1.headers.get("location")!, app.base), { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain("unverified");
    expect(html).toContain("<b>phish.example</b>");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("revokes the whole grant when a rotated refresh token is used again", async () => {
    const { clientId, access, refresh } = await connect();
    expect(await mcpStatus(app.base, access)).toBe(200);
    const r2 = await tokenRequest(app.base, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(r2.status).toBe(200);
    // rotation retires the previous access token
    expect(await mcpStatus(app.base, access)).toBe(401);
    expect(await mcpStatus(app.base, r2.body["access_token"]!)).toBe(200);
    // the old refresh token comes back (a thief, or a confused client): everything in the family dies
    const replay = await tokenRequest(app.base, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(replay.status).toBe(400);
    expect(replay.body["error"]).toBe("invalid_grant");
    expect(await mcpStatus(app.base, r2.body["access_token"]!)).toBe(401);
    expect((await tokenRequest(app.base, { grant_type: "refresh_token", refresh_token: r2.body["refresh_token"]!, client_id: clientId })).status).toBe(400);
  });

  it("never extends a grant past its absolute lifetime", async () => {
    const { clientId, refresh } = await connect();
    const row = app.store.getOAuthToken(hashToken(refresh))!;
    const end = Date.parse(row.familyExpiresAt!);
    expect(Math.abs(end - (Date.now() + FAMILY_TTL_S * 1000))).toBeLessThan(60_000);
    const r2 = await tokenRequest(app.base, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    const row2 = app.store.getOAuthToken(hashToken(r2.body["refresh_token"]!))!;
    expect(row2.familyExpiresAt).toBe(row.familyExpiresAt);
    expect(Date.parse(row2.expiresAt)).toBeLessThanOrEqual(end);
    app.store.db.prepare("UPDATE oauth_tokens SET family_expires_at = ? WHERE family = ?").run(new Date(Date.now() - 1000).toISOString(), row.family);
    const late = await tokenRequest(app.base, { grant_type: "refresh_token", refresh_token: r2.body["refresh_token"]!, client_id: clientId });
    expect(late.status).toBe(400);
  });

  it("accepts tokens for this resource only; old tokens without one count as this resource", async () => {
    const user = app.store.getUserByEmail("oauth@example.edu")!;
    const put = (token: string, resource: string | null) =>
      app.store.putOAuthToken({ tokenHash: hashToken(token), kind: "access", clientId: "c", userId: user.id, scope: null, resource, expiresAt: new Date(Date.now() + 600_000).toISOString(), family: `f-${token}` });
    put("at_legacy", null);
    put("at_other", "https://other.example/mcp");
    expect(await mcpStatus(app.base, "at_legacy")).toBe(200);
    expect(await mcpStatus(app.base, "at_other")).toBe(401);
  });

  it("lists connected assistants on the settings page and disconnects one", async () => {
    const { access } = await connect();
    const html = await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text());
    expect(html).toContain("Connected assistants");
    expect(html).toContain("Test Assistant (unverified name; assistant.example)");
    const family = app.store.getOAuthToken(hashToken(access))!.family;
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    // another user's grant cannot be revoked by naming its family
    const other = app.store.createUser("other@example.edu", "Other");
    app.store.putOAuthToken({ tokenHash: hashToken("at_x"), kind: "access", clientId: "c", userId: other.id, scope: null, resource: null, expiresAt: new Date(Date.now() + 600_000).toISOString(), family: "other-family" });
    await fetch(`${app.base}/settings/grant/delete`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie }, body: new URLSearchParams({ csrf, family: "other-family" }) });
    expect(app.store.getOAuthToken(hashToken("at_x"))).toBeTruthy();
    const res = await fetch(`${app.base}/settings/grant/delete`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie }, body: new URLSearchParams({ csrf, family }) });
    expect(res.status).toBe(302);
    expect(await mcpStatus(app.base, access)).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe("Client ID Metadata Documents", () => {
  let app: Running;
  const calls: Array<{ url: string; redirect?: RequestRedirect; signal: boolean }> = [];
  const doc = (url: string, extra: Record<string, unknown> = {}) => ({ client_id: url, client_name: "Good Assistant", redirect_uris: ["https://good.example/cb"], token_endpoint_auth_method: "none", ...extra });

  beforeAll(async () => {
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}), signal: !!init?.signal });
      const host = new URL(url).host;
      if (host === "redir.example") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/secret" } });
      if (host === "big.example") return new Response(JSON.stringify({ ...doc(url), padding: "x".repeat(20_000) }));
      if (host === "js.example") return Response.json(doc(url, { redirect_uris: ["javascript:alert(1)"] }));
      if (host === "http.example") return Response.json(doc(url, { redirect_uris: ["http://evil.example/cb"] }));
      if (host === "pkjwt.example") return Response.json(doc(url, { token_endpoint_auth_method: "private_key_jwt" }));
      if (host === "liar.example") return Response.json(doc("https://good.example/client.json"));
      return Response.json(doc(url));
    }) as typeof fetch;
    app = await startApp({ fetchImpl: fakeFetch });
  });

  const authorize = async (clientId: string) => {
    const { challenge } = await pkce();
    return fetch(authorizeUrl(app.base, clientId, "https://good.example/cb", challenge), { redirect: "manual" });
  };

  it("fetches without following redirects, with a timeout", async () => {
    const res = await authorize("https://good.example/client.json");
    expect(res.status).toBe(302);
    const call = calls.find((c) => c.url === "https://good.example/client.json")!;
    expect(call.redirect).toBe("manual");
    expect(call.signal).toBe(true);
    expect((await authorize("https://redir.example/client.json")).status).toBe(400);
  });

  it("rejects oversized documents, bad redirect URIs, mismatched ids, and IP-literal hosts", async () => {
    for (const id of ["https://big.example/c.json", "https://js.example/c.json", "https://http.example/c.json", "https://liar.example/c.json"]) {
      const res = await authorize(id);
      expect(res.status, id).toBe(400);
      expect(((await res.json()) as { error: string }).error, id).toBe("invalid_client");
    }
    const before = calls.length;
    for (const id of ["https://127.0.0.1/c.json", "https://[::1]/c.json", "https://localhost/c.json", "https://good.example/"]) expect((await authorize(id)).status, id).toBe(400);
    expect(calls.length).toBe(before);
  });

  it("rejects private_key_jwt instead of downgrading it to a public client", async () => {
    const res = await authorize("https://pkjwt.example/client.json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toContain("private_key_jwt");
  });

  it("names the document's host on the consent page", async () => {
    const cookie = `sid=${(await devLogin(app.base, "cimd@example.edu")).sid}`;
    const res = await authorize("https://good.example/client.json");
    const html = await fetch(new URL(res.headers.get("location")!, app.base), { headers: { cookie } }).then((r) => r.text());
    expect(html).toContain("as described by <b>good.example</b>");
    expect(html).not.toContain("unverified");
  });

  it("keeps a bounded cache", async () => {
    const count = (url: string) => calls.filter((c) => c.url === url).length;
    for (let i = 0; i <= 200; i++) await authorize(`https://lru${i}.example/c.json`);
    expect(count("https://lru200.example/c.json")).toBe(1);
    await authorize("https://lru200.example/c.json");
    expect(count("https://lru200.example/c.json")).toBe(1); // cached
    await authorize("https://lru0.example/c.json");
    expect(count("https://lru0.example/c.json")).toBe(2); // evicted, fetched again
  });
});

// ---------------------------------------------------------------------------

describe("settings page secrets and headers", () => {
  let app: Running;
  let cookie: string;
  beforeAll(async () => {
    app = await startApp();
    cookie = `sid=${(await devLogin(app.base, "keys@example.edu")).sid}`;
  });

  const post = async (path: string, fields: Record<string, string>) => {
    const csrf = await csrfOf(app.base, cookie);
    return fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie }, body: new URLSearchParams({ csrf, ...fields }) });
  };

  it("shows a new connector key once, in the page body, never in a URL", async () => {
    const res = await post("/settings/key", { label: "laptop", expires_days: "30" });
    expect(res.headers.get("location")).toBe("/");
    const first = await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text());
    const key = /<pre>(ck_[A-Za-z0-9_-]+)<\/pre>/.exec(first)?.[1];
    expect(key).toBeTruthy();
    const again = await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text());
    expect(again).not.toContain(key!);
    expect(await mcpStatus(app.base, key!)).toBe(200);
  });

  it("ignores messages planted in the query string", async () => {
    const html = await fetch(`${app.base}/?flash=Your+account+is+locked&secret=ck_planted&error=call+us`, { headers: { cookie } }).then((r) => r.text());
    expect(html).not.toContain("locked");
    expect(html).not.toContain("ck_planted");
    expect(html).not.toContain("call us");
  });

  it("enforces a connector key's expiry", async () => {
    await post("/settings/key", { label: "short", expires_days: "30" });
    const html = await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text());
    const key = /<pre>(ck_[A-Za-z0-9_-]+)<\/pre>/.exec(html)![1]!;
    const row = app.store.getConnectorKeyByHash(hashToken(key))!;
    expect(Math.abs(Date.parse(row.expiresAt!) - (Date.now() + 30 * 86_400_000))).toBeLessThan(60_000);
    expect(await mcpStatus(app.base, key)).toBe(200);
    app.store.setConnectorKeyExpiry(row.userId, row.id, new Date(Date.now() - 1000).toISOString());
    expect(await mcpStatus(app.base, key)).toBe(401);
    expect((await post("/settings/key", { label: "x", expires_days: "9999" })).status).toBe(302);
    expect(await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text())).toContain("pick an expiry");
  });

  it("sends no-store, no-referrer, nosniff and an anti-framing CSP on pages", async () => {
    for (const path of ["/", "/login"]) {
      const res = await fetch(`${app.base}${path}`, { headers: { cookie } });
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy"), path).toContain("default-src 'none'");
    }
  });

  it("accepts only an https custom assistant URL", async () => {
    const prefs = { timezone: "UTC", max_hours_per_day: "4", min_block_minutes: "45", max_block_minutes: "120", buffer_hours_before_due: "12", work_windows: "Mon 17:00-22:00", assistant: "custom" };
    await post("/settings/prefs", { ...prefs, assistant_url: "javascript:alert(1)" });
    const user = app.store.getUserByEmail("keys@example.edu")!;
    expect(app.store.getUser(user.id)!.prefs.assistantUrl).toBeUndefined();
    await post("/settings/prefs", { ...prefs, assistant_url: "http://assistant.example/" });
    expect(app.store.getUser(user.id)!.prefs.assistantUrl).toBeUndefined();
    await post("/settings/prefs", { ...prefs, assistant_url: "https://assistant.example/chat" });
    expect(app.store.getUser(user.id)!.prefs.assistantUrl).toBe("https://assistant.example/chat");
  });

  it("does not turn a non-web item URL into a link", async () => {
    const user = app.store.getUserByEmail("keys@example.edu")!;
    app.store.upsertItem(
      user.id,
      { id: "manual:evil", source: "manual", kind: "assignment", title: "Evil link item", url: "javascript:alert(document.cookie)", dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), status: "open", updatedAt: new Date().toISOString() },
      "v1",
    );
    const html = await fetch(`${app.base}/`, { headers: { cookie } }).then((r) => r.text());
    expect(html).toContain("Evil link item");
    expect(html).not.toContain("javascript:alert");
  });
});

// ---------------------------------------------------------------------------

describe("request limits", () => {
  let app: Running;
  beforeAll(async () => {
    app = await startApp();
  });

  it("refuses large bodies before authentication, but takes a big snapshot from a paired device", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(200_000) } });
    const mcp = await fetch(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: big });
    expect(mcp.status).toBe(413);
    const snapshot = JSON.stringify({ baseUrl: "https://canvas.example.edu", fetchedAt: new Date().toISOString(), courses: [], plannerItems: [], pad: "x".repeat(1_000_000) });
    const anon = await fetch(`${app.base}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer dv_nope" }, body: snapshot });
    expect(anon.status).toBe(401);
    const user = app.store.createUser("dev@example.edu", "Dev");
    const device = app.services.createDeviceToken(user.id, "test");
    const ok = await fetch(`${app.base}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${device}` }, body: snapshot });
    expect(ok.status).not.toBe(413);
    expect(ok.status).not.toBe(401);
  });

  it("answers only to loopback Host names on a loopback BASE_URL (DNS rebinding)", async () => {
    const port = new URL(app.base).port;
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/healthz", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await status(`127.0.0.1:${port}`)).toBe(200);
    expect(await status(`localhost:${port}`)).toBe(200);
    expect(await status(`rebind.evil.example:${port}`)).toBe(421);
  });

  it("rate limits dev login, pairing guesses and feed-token guesses", async () => {
    const limited = await startApp({ config: { rateLimit: true } });
    const statuses = async (n: number, f: () => Promise<Response>) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = await f();
        await r.arrayBuffer();
        out.push(r.status);
      }
      return out;
    };
    const logins = await statuses(21, () => fetch(`${limited.base}/login/dev`, { method: "POST", redirect: "manual", headers: FORM, body: new URLSearchParams({ email: "rl@example.edu" }) }));
    expect(logins.slice(0, 20).every((s) => s === 302)).toBe(true);
    expect(logins[20]).toBe(429);
    const pairs = await statuses(11, () => fetch(`${limited.base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "AAAAAA" }) }));
    expect(pairs.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(pairs[10]).toBe(429);
    const feeds = await statuses(31, () => fetch(`${limited.base}/feeds/plan/${"0".repeat(32)}.ics`));
    expect(feeds.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(feeds[30]).toBe(429);
  });
});

// ---------------------------------------------------------------------------

describe("store migration", () => {
  it("adds the new columns to a database file created before them, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-agent-"));
    const path = join(dir, "old.sqlite");
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE connector_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL, last_used_at TEXT);
        CREATE TABLE oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT, resource TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, family TEXT NOT NULL);
        CREATE TABLE login_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
        INSERT INTO connector_keys VALUES ('k1', 'u1', 'h1', 'old key', '2026-01-01T00:00:00.000Z', NULL);`);
      old.close();
      for (let i = 0; i < 2; i++) {
        const store = new Store(path);
        const cols = (table: string) => (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        expect(cols("connector_keys")).toContain("expires_at");
        expect(cols("oauth_tokens")).toEqual(expect.arrayContaining(["used_at", "family_expires_at"]));
        expect(cols("login_sessions")).toContain("idle_expires_at");
        expect(store.getConnectorKeyByHash("h1")).toEqual({ id: "k1", userId: "u1", expiresAt: null });
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
