/**
 * Per-IP rate limits for the routes that take a guessable or brute-forceable
 * secret (pairing codes, feed tokens) or create sessions. `config.rateLimit`
 * off (tests) turns every limiter into a pass-through.
 */
import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { Config } from "./config.js";

export interface LimitOptions {
  windowMinutes: number;
  limit: number;
  /** Count only failed answers (status >= 400): right for endpoints a guesser hammers and a real client rarely fails. */
  failuresOnly?: boolean;
}

const pass: RequestHandler = (_req, _res, next) => next();

export function limiter(cfg: Pick<Config, "rateLimit">, opts: LimitOptions): RequestHandler {
  if (!cfg.rateLimit) return pass;
  return rateLimit({
    windowMs: opts.windowMinutes * 60_000,
    limit: opts.limit,
    skipSuccessfulRequests: opts.failuresOnly ?? false,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type("text/plain").send("too many requests; wait a few minutes and try again");
    },
  });
}

/** POST /login/dev: creating sessions. */
export const loginLimiter = (cfg: Pick<Config, "rateLimit">): RequestHandler => limiter(cfg, { windowMinutes: 15, limit: 20 });
/** POST /api/pair: codes are 60-bit and self-locking, but failed guesses still cost the guesser. */
export const pairLimiter = (cfg: Pick<Config, "rateLimit">): RequestHandler => limiter(cfg, { windowMinutes: 15, limit: 10, failuresOnly: true });
/** POST /authorize/consent and the Google sign-in round trip. */
export const consentLimiter = (cfg: Pick<Config, "rateLimit">): RequestHandler => limiter(cfg, { windowMinutes: 15, limit: 30 });
/** GET /feeds/…: calendar apps share egress IPs across many users, so only unknown tokens count. */
export const feedLimiter = (cfg: Pick<Config, "rateLimit">): RequestHandler => limiter(cfg, { windowMinutes: 15, limit: 30, failuresOnly: true });
