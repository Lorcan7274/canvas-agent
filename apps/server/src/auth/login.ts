/**
 * People signing in to the settings page or approving an assistant's
 * connection: a dev form (email only) or Sign in with Google. Google sign-in
 * also captures the calendar consent, so one screen connects everything.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { hashToken, randomToken } from "@canvas-agent/core";
import type { Services } from "../services.js";
import type { SqliteOAuthProvider, PendingAuthorization } from "./oauth-provider.js";
import { esc, page } from "../ui.js";
import { GOOGLE_SCOPES } from "../google/calendar.js";

declare module "express-serve-static-core" {
  interface Request {
    loginUserId?: string;
    sid?: string;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function csrfFor(sid: string, secret: string): string {
  return hashToken(`csrf:${sid}:${secret}`).slice(0, 32);
}

function safeNext(next: unknown): string {
  const s = typeof next === "string" ? next : "/";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

export function loginMiddleware(services: Services) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const sid = parseCookies(req.headers.cookie)["sid"];
    if (sid) {
      const userId = services.store.userForLoginSession(sid);
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
    if (!req.sid || token !== csrfFor(req.sid, services.config.secretKey)) {
      res.status(403).type("text/plain").send("bad csrf token; reload the page and try again");
      return;
    }
    next();
  };
}

function setSession(services: Services, res: Response, userId: string): void {
  const sid = randomToken(24);
  services.store.createLoginSession(userId, sid);
  const secure = services.config.baseUrl.startsWith("https://");
  res.setHeader("set-cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? "; Secure" : ""}`);
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

  r.post("/login/dev", (req, res) => {
    if (cfg.authMode !== "dev") {
      res.status(404).end();
      return;
    }
    const body = req.body as Record<string, unknown>;
    const email = String(body["email"] ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      res.status(400).type("text/plain").send("email required");
      return;
    }
    const user = services.store.getUserByEmail(email) ?? services.store.createUser(email, email.split("@")[0] ?? null);
    setSession(services, res, user.id);
    res.redirect(safeNext(body["next"]));
  });

  r.get("/logout", (req, res) => {
    if (req.sid) services.store.deleteLoginSession(req.sid);
    res.setHeader("set-cookie", "sid=; Path=/; Max-Age=0");
    res.redirect("/login");
  });

  // ---- Google: sign-in and calendar consent in one flow -------------------

  r.get("/oauth/google/start", (req, res) => {
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
    services.store.putPendingLogin(state, { kind: "google", purpose, next: safeNext(req.query["next"]), userId: req.loginUserId ?? null });
    res.redirect(services.google.authUrl(`${cfg.baseUrl}/oauth/google/callback`, state, GOOGLE_SCOPES));
  });

  r.get("/oauth/google/callback", async (req, res) => {
    const google = services.google;
    if (!google) {
      res.status(404).end();
      return;
    }
    const state = String(req.query["state"] ?? "");
    const pending = services.store.takePendingLogin<{ kind: string; purpose: "login" | "calendar"; next: string; userId: string | null }>(state);
    if (!pending || pending.kind !== "google") {
      res.status(400).type("text/plain").send("login expired; start again");
      return;
    }
    if (req.query["error"]) {
      res.redirect(`/?error=${encodeURIComponent(String(req.query["error"]))}`);
      return;
    }
    try {
      const tokens = await google.exchangeCode(String(req.query["code"] ?? ""), `${cfg.baseUrl}/oauth/google/callback`);
      const info = await google.userInfo(tokens.access_token);
      const email = info.email?.toLowerCase();
      let userId = pending.userId;
      if (!userId) {
        if (!email) throw new Error("Google did not return an email");
        userId = (services.store.getUserByEmail(email) ?? services.store.createUser(email, info.name ?? null)).id;
        setSession(services, res, userId);
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
      res.redirect(pending.next || "/");
    } catch (e) {
      res.status(502).type("html").send(page("Google sign-in failed", `<h1>Google sign-in failed</h1><p>${esc((e as Error).message)}</p><p><a href="/login">Try again</a></p>`, { nav: false }));
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
    const name = pending.clientName ?? pending.clientUri ?? pending.clientId;
    const body = `<h1>Connect your planner</h1>
      <p><b>${esc(name)}</b> wants to read your Canvas workload and estimates, and save study blocks, as <b>${esc(user.email ?? user.name ?? user.id)}</b>.</p>
      <p class="muted">Redirects to ${esc(new URL(pending.redirectUri).origin)}</p>
      <form method="post" action="/authorize/consent"><input type="hidden" name="csrf" value="${csrfFor(req.sid!, cfg.secretKey)}"><input type="hidden" name="pending" value="${esc(pendingId)}">
        <button class="primary" name="decision" value="allow" type="submit">Allow</button> <button name="decision" value="deny" type="submit">Deny</button></form>
      <p class="muted">Not you? <a href="/logout">Sign out</a></p>`;
    res.type("html").send(page("Connect", body, { nav: false }));
  });

  r.post("/authorize/consent", requireLogin, requireCsrf(services), (req, res) => {
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
