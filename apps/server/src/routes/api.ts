/** JSON routes used by the browser extension. */
import { Router, type Request, type Response, type NextFunction } from "express";
import { hashToken, ingestSnapshot, normaliseBaseUrl, pickDetailCandidates, projectCanvasSnapshot, type CanvasSnapshot } from "@canvas-agent/core";
import type { Services } from "../services.js";

declare module "express-serve-static-core" {
  interface Request {
    deviceUserId?: string;
  }
}

export function requireDevice(services: Services) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const userId = token.startsWith("dv_") ? services.store.userForDeviceToken(hashToken(token)) : undefined;
    if (!userId) {
      res.status(401).json({ error: "invalid device token" });
      return;
    }
    req.deviceUserId = userId;
    next();
  };
}

/** chrome-extension://<id>, moz-extension://<uuid>, safari-web-extension://<uuid>. */
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[A-Za-z0-9-]{1,64}$/;

/**
 * CORS for the extension on /api/*: its pages and worker are cross-origin to
 * this server. Bearer tokens only, no cookies, so no credentials are allowed.
 * Exported so app.ts can mount it ahead of anything else on /api.
 */
export function extensionCors(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/")) return next();
  const origin = req.headers.origin;
  if (typeof origin === "string" && EXTENSION_ORIGIN.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-max-age", "600");
  }
  res.vary("Origin");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function apiRoutes(services: Services): Router {
  const r = Router();
  r.use(extensionCors);

  r.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "canvas-agent", time: new Date().toISOString() });
  });

  r.post("/api/pair", (req, res) => {
    const body = req.body as { code?: string; name?: string };
    const code = String(body?.code ?? "").trim().slice(0, 64);
    if (!code) {
      res.status(400).json({ error: "code required" });
      return;
    }
    const userId = services.store.redeemPairingCode(code);
    if (!userId) {
      res.status(400).json({ error: "that pairing code is not valid; generate a new one on the settings page" });
      return;
    }
    const token = services.createDeviceToken(userId, body.name ? String(body.name).slice(0, 80) : null);
    res.json({ deviceToken: token });
  });

  r.get("/api/me", requireDevice(services), (req, res) => {
    const user = services.userOrThrow(req.deviceUserId!);
    res.json({
      userId: user.id,
      name: user.name,
      assistant: user.prefs.assistant,
      assistantUrl: user.prefs.assistantUrl ?? null,
      accounts: services.store.listCanvasAccounts(user.id).map((a) => ({ baseUrl: a.baseUrl, kind: a.kind, lastSyncAt: a.lastSyncAt })),
    });
  });

  // app.ts parses this body (after the device check); the projection below drops
  // every field the normaliser does not read and caps every list and string.
  r.post("/api/ingest", requireDevice(services), (req, res) => {
    const body = req.body as CanvasSnapshot | undefined;
    if (!body || typeof body !== "object" || typeof body.baseUrl !== "string" || !Array.isArray(body.plannerItems)) {
      res.status(400).json({ error: "expected { baseUrl, fetchedAt, courses, plannerItems, assignments?, quizzes?, missingSubmissions? }" });
      return;
    }
    const userId = req.deviceUserId!;
    let account;
    try {
      account = services.addSessionAccount(userId, body.baseUrl);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message.slice(0, 200) });
      return;
    }
    try {
      const snap = projectCanvasSnapshot({ ...body, baseUrl: account.baseUrl });
      const report = ingestSnapshot(services.store, userId, { ...snap, fetchedAt: snap.fetchedAt || new Date().toISOString() });
      services.store.markSync(account.id, report.errors.length ? report.errors.join("; ").slice(0, 500) : null, true);
      res.json({ ok: true, ...report });
    } catch {
      res.status(400).json({ error: "the snapshot could not be read" });
    }
  });

  /**
   * Which detail fetches the extension should do next, by the same rule as the
   * token sync (`needsDetails`: new, changed, unlocked, not backing off after a
   * failure), upcoming work first. `?baseUrl=` limits it to one Canvas.
   */
  r.get("/api/ingest/wanted", requireDevice(services), (req, res) => {
    const userId = req.deviceUserId!;
    const baseUrl = req.query["baseUrl"];
    let host: string | undefined;
    if (baseUrl !== undefined) {
      try {
        if (typeof baseUrl !== "string") throw new Error("baseUrl");
        host = new URL(normaliseBaseUrl(baseUrl)).host;
      } catch {
        res.status(400).json({ error: "baseUrl must be the Canvas address, e.g. https://canvas.school.edu" });
        return;
      }
    }
    const nowIso = new Date().toISOString();
    const rows = services.store.listItems(userId, { from: new Date(Date.now() - 7 * 86_400_000).toISOString() }).filter((r) => host === undefined || r.item.host === host);
    const wanted = pickDetailCandidates(rows, nowIso, 40).map((r) => ({ courseId: r.item.courseId, assignmentId: r.item.assignmentId, quizId: r.item.quizId ?? null }));
    res.json({ wanted });
  });

  return r;
}
