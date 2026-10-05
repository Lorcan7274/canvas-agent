/** The planned-blocks ICS feed any calendar app can subscribe to. */
import { Router } from "express";
import type { Services } from "../services.js";

export function feedRoutes(services: Services): Router {
  const r = Router();
  r.get("/feeds/plan/:token.ics", (req, res) => {
    const token = String(req.params["token"] ?? "");
    const userId = /^[a-f0-9]{32}$/.test(token) ? services.userForFeedToken(token) : undefined;
    if (!userId) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    res.setHeader("content-type", "text/calendar; charset=utf-8");
    res.setHeader("cache-control", "private, max-age=300");
    res.send(services.planFeedIcs(userId));
  });
  return r;
}
