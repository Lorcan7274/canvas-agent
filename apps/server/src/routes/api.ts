/** JSON routes used by the browser extension. */
import { Router, type Request, type Response, type NextFunction } from "express";
import { hashToken, ingestSnapshot, type CanvasSnapshot } from "@canvas-agent/core";
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

export function apiRoutes(services: Services): Router {
  const r = Router();

  r.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "canvas-agent", time: new Date().toISOString() });
  });

  r.post("/api/pair", (req, res) => {
    const body = req.body as { code?: string; name?: string };
    const code = String(body?.code ?? "").trim();
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
      planFeedUrl: services.planFeedUrl(user.id),
      accounts: services.store.listCanvasAccounts(user.id).map((a) => ({ baseUrl: a.baseUrl, kind: a.kind, lastSyncAt: a.lastSyncAt })),
    });
  });

  r.post("/api/ingest", requireDevice(services), (req, res) => {
    const snap = req.body as CanvasSnapshot;
    if (!snap || typeof snap.baseUrl !== "string" || !Array.isArray(snap.plannerItems)) {
      res.status(400).json({ error: "expected { baseUrl, fetchedAt, courses, plannerItems, assignments?, quizzes?, missingSubmissions? }" });
      return;
    }
    const userId = req.deviceUserId!;
    try {
      const account = services.addSessionAccount(userId, snap.baseUrl);
      const report = ingestSnapshot(services.store, userId, { ...snap, baseUrl: account.baseUrl, fetchedAt: snap.fetchedAt || new Date().toISOString() });
      services.store.markSync(account.id, report.errors.length ? report.errors.join("; ") : null);
      res.json({ ok: true, ...report });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** Which detail fetches the extension should do next: assignment-backed items without details. */
  r.get("/api/ingest/wanted", requireDevice(services), (req, res) => {
    const userId = req.deviceUserId!;
    const wanted = services.store
      .listItems(userId, { from: new Date(Date.now() - 7 * 86_400_000).toISOString() })
      .filter((r) => r.item.assignmentId && r.item.courseId && !r.detailsFetchedAt && !["done", "dismissed", "graded"].includes(r.item.status))
      .slice(0, 40)
      .map((r) => ({ courseId: r.item.courseId, assignmentId: r.item.assignmentId, quizId: r.item.quizId ?? null }));
    res.json({ wanted });
  });

  return r;
}
