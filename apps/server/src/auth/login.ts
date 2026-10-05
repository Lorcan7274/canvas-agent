/**
 * People signing in to the settings page or approving an assistant's
 * connection: a dev form (email only) or Sign in with Google. Google sign-in
 * also captures the calendar consent, so one screen connects everything.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { hashToken, randomToken, safeEqual } from "@canvas-agent/core";
import type { Config } from "../config.js";
import type { Services } from "../services.js";
import type { SqliteOAuthProvider, PendingAuthorization } from "./oauth-provider.js";
import { esc, page } from "../ui.js";
import { createHash } from "node:crypto";
import { GOOGLE_SCOPES } from "../google/calendar.js";
import { consentLimiter, loginLimiter } from "../ratelimit.js";

declare module "express-serve-static-core" {
  interface Request {
    loginUserId?: string;
    /** The raw session cookie value (the store only ever sees its hash). */
    sid?: string;
  }
}

/** Absolute lifetime of a settings-page session, and how long it survives unused. */
export const SESSION_TTL_DAYS = 14;
export const SESSION_IDLE_MINUTES = 3 * 24 * 60;
const GOOGLE_NONCE_TTL_S = 15 * 60;

function secure(cfg: Config): boolean {
  return cfg.baseUrl.startsWith("https://");
}

/** `__Host-` pins the cookie to this exact origin (Secure, Path=/, no Domain) when we are on https. */
export function sessionCookieName(cfg: Config): string {
  return secure(cfg) ? "__Host-sid" : "sid";
}

function nonceCookieName(cfg: Config): string {
  return secure(cfg) ? "__Host-gstate" : "gstate";
}

function cookie(cfg: Config, name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure(cfg) ? "; Secure" : ""}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // a malformed cookie is just not ours
    }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

export function csrfFor(sid: string, secret: string): string {
  return hashToken(`csrf:${sid}:${secret}`).slice(0, 32);
}

/** A same-origin path to return to after signing in; anything else (//host, /\host, control characters) becomes "/". */
export function safeNext(next: unknown): string {
  const s = typeof next === "string" ? next : "/";
  if (!s.startsWith("/") || s.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  try {
    const u = new URL(s, "http://same.invalid");
    if (u.origin !== "http://same.invalid") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

/** True unless the browser says this request came from another site (login CSRF). Non-browser clients send neither header. */
export function sameOrigin(req: Request, cfg: Config): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== new URL(cfg.baseUrl).origin) return false;
  return true;
}

export function loginMiddleware(services: Services) {
  const name = sessionCookieName(services.config);
  return (req: Request, _res: Response, next: NextFunction): void => {
    const sid = parseCookies(req.headers.cookie)[name];
    if (sid) {
      const userId = services.store.userForLoginSession(hashToken(sid), SESSION_IDLE_MINUTES);
      if (userId) {
        req.loginUserId = userId;
        req.sid = sid;
      }
    }
    next();
  };
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (req.loginUserId) {
    next();
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export function requireCsrf(services: Services) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = (req.body as Record<string, unknown> | undefined)?.["csrf"];
    if (!req.sid || typeof token !== "string" || !safeEqual(token, csrfFor(req.sid, services.config.secretKey))) {
      res.status(403).type("text/plain").send("bad csrf token; reload the page and try again");
      return;
    }
    next();
  };
}

// ---- one-time messages for the settings page, kept server-side so secrets never ride in a URL ----

export interface Flash {
  flash?: string;
  error?: string;
  /** Shown once: a connector key or a pairing code. */
  secret?: string;
  secretHelp?: string;
}

const flashKey = (sid: string) => `flash:${hashToken(sid)}`;

export function putFlash(services: Services, sid: string, msg: Flash): void {
  services.store.takePendingLogin(flashKey(sid)); // at most one waiting
  services.store.putPendingLogin(flashKey(sid), { kind: "flash", sealed: services.sealer.seal(JSON.stringify(msg)) }, 5);
}

export function takeFlash(services: Services, sid: string): Flash {
  const row = services.store.takePendingLogin<{ kind: string; sealed: string }>(flashKey(sid));
  if (!row || row.kind !== "flash") return {};
  try {
    return JSON.parse(services.sealer.open(row.sealed)) as Flash;
  } catch {
    return {};
  }
}

function setSession(services: Services, req: Request, res: Response, userId: string): void {
  if (req.sid) services.store.deleteLoginSession(hashToken(req.sid));
  const sid = randomToken(32);
  services.store.createLoginSession(userId, hashToken(sid), SESSION_TTL_DAYS, SESSION_IDLE_MINUTES);
  res.append("set-cookie", cookie(services.config, sessionCookieName(services.config), sid, SESSION_TTL_DAYS * 86_400));
}

export function loginRoutes(services: Services, provider: SqliteOAuthProvider): Router {
  const r = Router();
  const cfg = services.config;

  r.get("/login", (req, res) => {
    const next = safeNext(req.query["next"]);
    if (req.loginUserId) {
      res.redirect(next);
      return;
    }
    const body =
      cfg.authMode === "google"
        ? `<h1>Sign in</h1><p class="muted">Your Google account signs you in and connects your calendar for study blocks.</p>
           <p><a href="/oauth/google/start?purpose=login&next=${encodeURIComponent(next)}"><button class="primary">Continue with Google</button></a></p>`
        : `<h1>Sign in</h1><p class="muted">Development mode: any email creates an account. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for real sign-in.</p>
           <form method="post" action="/login/dev"><input type="hidden" name="next" value="${esc(next)}"><label>Email</label><input name="email" type="email" required autofocus><button class="primary" type="submit">Sign in</button></form>`;
    res.type("html").send(page("Sign in", body, { nav: false }));
  });

  r.post("/login/dev", loginLimiter(cfg), (req, res) => {
    if (cfg.authMode !== "dev") {
      res.status(404).end();
      return;
    }
    if (!sameOrigin(req, cfg)) {
      res.status(403).type("text/plain").send(`cross-site sign-in refused; open ${cfg.baseUrl}/login`);
      return;
    }
    const body = req.body as Record<string, unknown>;
    const email = String(body["email"] ?? "").trim().toLowerCase();
    if (!email.includes("@") || email.length > 254) {
      res.status(400).type("text/plain").send("email required");
      return;
    }
    const existing = services.store.getUserByEmail(email);
    // An account that signs in with Google is never reachable by typing its email.
    if (existing && services.store.getGoogleAccount(existing.id)) {
      res.status(403).type("text/plain").send("that account signs in with Google");
      return;
    }
    const user = existing ?? services.store.createUser(email, email.split("@")[0] ?? null);
    setSession(services, req, res, user.id);
    res.redirect(safeNext(body["next"]));
  });

  r.get("/logout", (req, res) => {
    if (!req.sid) {
      res.redirect("/login");
      return;
    }
    res
      .type("html")
      .send(
        page(
          "Sign out",
          `<h1>Sign out?</h1><form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrfFor(req.sid, cfg.secretKey)}"><button class="primary" type="submit">Sign out</button></form><p><a href="/">Back to settings</a></p>`,
          { nav: false },
        ),
      );
  });

  const clearSession = (res: Response) => res.append("set-cookie", cookie(cfg, sessionCookieName(cfg), "", 0));
  r.post(
    "/logout",
    (req, res, next) => {
      if (req.sid) {
        next();
        return;
      }
      clearSession(res);
      res.redirect("/login");
    },
    requireCsrf(services),
    (req, res) => {
      services.store.deleteLoginSession(hashToken(req.sid!));
      clearSession(res);
      res.redirect("/login");
    },
  );

  // ---- Google: sign-in and calendar consent in one flow -------------------
  // The state names a server-side entry; a nonce cookie ties it to the browser that started it,
  // so a Google link or callback URL forwarded to someone else does nothing.

  r.get("/oauth/google/start", consentLimiter(cfg), (req, res) => {
    if (!services.google) {
      res.status(404).type("text/plain").send("Google is not configured on this server");
      return;
    }
    const purpose = req.query["purpose"] === "calendar" ? "calendar" : "login";
    if (purpose === "calendar" && !req.loginUserId) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    const state = randomToken(16);
    const nonce = randomToken(24);
    // PKCE with Google too: the code is useless without the verifier, which only this server holds.
    const verifier = randomToken(32);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    services.store.putPendingLogin(state, {
      kind: "google",
      purpose,
      next: safeNext(req.query["next"]),
      userId: req.loginUserId ?? null,
      nonceHash: hashToken(nonce),
      verifierSealed: services.sealer.seal(verifier),
    });
    res.append("set-cookie", cookie(cfg, nonceCookieName(cfg), nonce, GOOGLE_NONCE_TTL_S));
    res.redirect(services.google.authUrl(`${cfg.baseUrl}/oauth/google/callback`, state, GOOGLE_SCOPES, challenge));
  });

  r.get("/oauth/google/callback", consentLimiter(cfg), async (req, res) => {
    const google = services.google;
    if (!google) {
      res.status(404).end();
      return;
    }
    const failed = (status: number, message: string) =>
      res.status(status).type("html").send(page("Google sign-in failed", `<h1>Google sign-in failed</h1><p>${esc(message)}</p><p><a href="/login">Try again</a></p>`, { nav: false }));
    const state = String(req.query["state"] ?? "");
    const pending = services.store.takePendingLogin<{ kind: string; purpose: "login" | "calendar"; next: string; userId: string | null; nonceHash?: string; verifierSealed?: string }>(state);
    const nonce = parseCookies(req.headers.cookie)[nonceCookieName(cfg)];
    res.append("set-cookie", cookie(cfg, nonceCookieName(cfg), "", 0));
    if (!pending || pending.kind !== "google") {
      failed(400, "That sign-in expired. Start again.");
      return;
    }
    if (!nonce || !pending.nonceHash || !safeEqual(hashToken(nonce), pending.nonceHash)) {
      failed(400, "That sign-in was started in another browser or tab. Start again from this one.");
      return;
    }
    if (pending.purpose === "calendar" && (!pending.userId || pending.userId !== req.loginUserId)) {
      failed(400, "You are no longer signed in as the account that asked to connect Google Calendar. Sign in and start again.");
      return;
    }
    if (req.query["error"]) {
      failed(400, `Google did not connect (${String(req.query["error"]).slice(0, 64)}).`);
      return;
    }
    try {
      const verifier = pending.verifierSealed ? services.sealer.open(pending.verifierSealed) : undefined;
      const tokens = await google.exchangeCode(String(req.query["code"] ?? ""), `${cfg.baseUrl}/oauth/google/callback`, verifier);
      const info = await google.userInfo(tokens.access_token);
      const email = info.email?.toLowerCase();
      if ((info as { email_verified?: unknown }).email_verified === false) throw new Error("Google says this email address is not verified");
      let userId = pending.userId;
      if (!userId) {
        if (!email) throw new Error("Google did not return an email");
        userId = (services.store.getUserByEmail(email) ?? services.store.createUser(email, info.name ?? null)).id;
        setSession(services, req, res, userId);
      }
      const existing = services.store.getGoogleAccount(userId);
      const refresh = tokens.refresh_token ?? (existing ? services.sealer.open(existing.refreshTokenSealed) : undefined);
      if (refresh) {
        services.store.putGoogleAccount({
          userId,
          email: email ?? existing?.email ?? null,
          refreshTokenSealed: services.sealer.seal(refresh),
          accessTokenSealed: services.sealer.seal(tokens.access_token),
          accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          calendarId: existing?.calendarId ?? "primary",
          scopes: tokens.scope ?? null,
        });
      }
      res.redirect(safeNext(pending.next));
    } catch (e) {
      failed(502, (e as Error).message);
    }
  });

  // ---- consent for assistants connecting over OAuth ---------------------

  r.get("/authorize/consent", requireLogin, (req, res) => {
    const pendingId = String(req.query["pending"] ?? "");
    const pending = services.store.peekPendingLogin<PendingAuthorization>(pendingId);
    if (!pending || pending.kind !== "authorize") {
      res.status(400).type("html").send(page("Expired", `<h1>That request expired</h1><p>Start the connection again from your assistant.</p>`, { nav: false }));
      return;
    }
    const user = services.userOrThrow(req.loginUserId!);
    const redirect = new URL(pending.redirectUri);
    const local = redirect.protocol === "http:";
    const name = pending.clientName ?? pending.clientUri ?? pending.clientId;
    let who: string;
    if (pending.clientKind === "metadata") {
      const host = new URL(pending.clientId).host;
      who = `<p><b>${esc(name)}</b>, as described by <b>${esc(host)}</b>, wants to read your Canvas workload and estimates, and save study blocks, as <b>${esc(user.email ?? user.name ?? user.id)}</b>.</p>`;
    } else {
      who = `<p>An app calling itself <b>${esc(name)}</b> wants to read your Canvas workload and estimates, and save study blocks, as <b>${esc(user.email ?? user.name ?? user.id)}</b>.</p>
      <p class="warn">That name is unverified: any app can register under any name.</p>`;
    }
    const where = local
      ? `<p>Allowing sends you back to <b>a program on this computer</b> (${esc(redirect.host)}).</p>`
      : `<p>Allowing sends you, and access to your planner, to <b>${esc(redirect.host)}</b>.</p>`;
    const body = `<h1>Connect your planner</h1>
      ${who}
      <div class="card">${where}<p class="muted">Only allow if you started this from your assistant just now and recognise that address.</p></div>
      <form method="post" action="/authorize/consent"><input type="hidden" name="csrf" value="${csrfFor(req.sid!, cfg.secretKey)}"><input type="hidden" name="pending" value="${esc(pendingId)}">
        <button class="primary" name="decision" value="allow" type="submit">Allow</button> <button name="decision" value="deny" type="submit">Deny</button></form>
      <p class="muted">Not you? <a href="/logout">Sign out</a></p>`;
    res.type("html").send(page("Connect", body, { nav: false }));
  });

  r.post("/authorize/consent", consentLimiter(cfg), requireLogin, requireCsrf(services), (req, res) => {
    const body = req.body as Record<string, unknown>;
    const pendingId = String(body["pending"] ?? "");
    const url = body["decision"] === "allow" ? provider.issueCode(pendingId, req.loginUserId!) : provider.denyCode(pendingId);
    if (!url) {
      res.status(400).type("text/plain").send("request expired");
      return;
    }
    res.redirect(url);
  });

  return r;
}
