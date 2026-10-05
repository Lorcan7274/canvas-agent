/**
 * A fake Canvas: the handful of REST endpoints the agent reads, with the
 * real quirks (Link pagination, `while(1);` on cookie-authed JSON, Canvas's
 * 401 bodies for a bad token and for a missing session, `X-Rate-Limit-Remaining`
 * on every API response, an optional one-off 429 or 403 "Rate Limit
 * Exceeded", descriptions withheld while an assignment is locked). Used by
 * tests, local development and directory reviewers.
 *
 * `fixtures` is live: a test may edit it (drop an assignment, move a date)
 * between syncs.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { makeFixtures, missingSubmissionsFor, plannerItemsFor, feedFor, type Fixtures } from "./fixtures.js";

export interface StubOptions {
  token?: string;
  feedToken?: string;
  base?: Date;
  /** Return 429 on the first request to a planner page, then succeed. */
  throttleOnce?: boolean;
  /** Return Canvas's 403 "Rate Limit Exceeded" on the first request to a planner page, then succeed. */
  rateLimit403Once?: boolean;
  /** Refuse every assignment detail with a plain 403 (not a throttle), as a school that restricts the API does. */
  forbidDetails?: boolean;
  perPage?: number;
}

export interface StubCanvas {
  server: Server;
  fixtures: Fixtures;
  origin: string;
  token: string;
  feedUrl: string;
  requests: string[];
  close(): Promise<void>;
}

export async function startStubCanvas(port = 0, opts: StubOptions = {}): Promise<StubCanvas> {
  const token = opts.token ?? "stub-token";
  const feedToken = opts.feedToken ?? "feedsecret";
  let origin = `http://127.0.0.1:${port}`;
  let fixtures = makeFixtures(opts.base ?? new Date(), origin);
  let throttled = !opts.throttleOnce;
  let rateLimited = !opts.rateLimit403Once;
  const requests: string[] = [];
  /** Canvas sends the remaining quota on every API response, throttled or not. */
  const quota = { "x-rate-limit-remaining": "699.7", "x-request-cost": "0.3" };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    try {
      handle(req, res, url);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  function authed(req: IncomingMessage): { ok: boolean; cookie: boolean } {
    const auth = req.headers.authorization;
    if (auth) return { ok: auth === `Bearer ${token}`, cookie: false };
    const cookie = req.headers.cookie ?? "";
    return { ok: /canvas_session=ok/.test(cookie), cookie: true };
  }

  function json(req: IncomingMessage, res: ServerResponse, body: unknown, cookie: boolean, extra: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    const accept = req.headers.accept ?? "";
    const prefix = cookie && !accept.includes("application/json") ? "while(1);" : "";
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...quota, ...extra }).end(prefix + text);
  }

  function error(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...quota, ...extra }).end(JSON.stringify(body));
  }

  function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, all: T[], cookie: boolean): void {
    // A real instance caps per_page; `opts.perPage` plays that cap so pagination gets exercised.
    const perPage = Math.min(opts.perPage ?? 100, Number(url.searchParams.get("per_page") ?? 10));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const links: string[] = [];
    const mk = (p: number, rel: string) => {
      const u = new URL(url.toString());
      u.searchParams.set("page", String(p));
      u.searchParams.set("per_page", String(perPage));
      return `<${u.toString()}>; rel="${rel}"`;
    };
    links.push(mk(page, "current"));
    if (page * perPage < all.length) links.push(mk(page + 1, "next"));
    links.push(mk(1, "first"));
    links.push(mk(Math.max(1, Math.ceil(all.length / perPage)), "last"));
    json(req, res, slice, cookie, { link: links.join(",") });
  }

  function handle(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const p = url.pathname;
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (p === `/feeds/calendars/user_${feedToken}.ics`) {
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" }).end(feedFor(fixtures, origin));
      return;
    }
    if (p.startsWith("/feeds/")) {
      res.writeHead(404).end("not found");
      return;
    }
    if (!p.startsWith("/api/v1/")) {
      res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>Stub Canvas</h1></body></html>");
      return;
    }
    const a = authed(req);
    if (!a.ok) {
      // Canvas's two answers: a bad bearer token, or no (expired) session cookie.
      if (a.cookie) error(res, 401, { status: "unauthenticated", errors: [{ message: "user authorization required" }] });
      else error(res, 401, { errors: [{ message: "Invalid access token." }] }, { "www-authenticate": 'Bearer realm="canvas-lms"' });
      return;
    }
    if (p === "/api/v1/users/self") return json(req, res, fixtures.user, a.cookie);
    if (p === "/api/v1/courses") return paginate(req, res, url, fixtures.courses, a.cookie);
    if (p === "/api/v1/planner/items") {
      if (!throttled) {
        throttled = true;
        res.writeHead(429, { "content-type": "application/json", "x-rate-limit-remaining": "0" }).end(JSON.stringify({ status: "throttled" }));
        return;
      }
      if (!rateLimited) {
        rateLimited = true;
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "x-rate-limit-remaining": "0", "x-request-cost": "0.3" }).end("403 Forbidden (Rate Limit Exceeded)");
        return;
      }
      const start = url.searchParams.get("start_date");
      const end = url.searchParams.get("end_date");
      const items = plannerItemsFor(fixtures, origin).filter((it) => {
        const d = (it as { plannable_date: string | null }).plannable_date;
        if (!d) return true;
        if (start && d < start) return false;
        if (end && d.slice(0, 10) > end.slice(0, 10)) return false;
        return true;
      });
      return paginate(req, res, url, items, a.cookie);
    }
    if (p === "/api/v1/users/self/missing_submissions") {
      const missing = missingSubmissionsFor(fixtures, url.searchParams.getAll("include[]").includes("planner_overrides"));
      return paginate(req, res, url, missing, a.cookie);
    }
    let m = p.match(/^\/api\/v1\/courses\/(\d+)\/assignments\/(\d+)$/);
    if (m) {
      if (opts.forbidDetails) {
        error(res, 403, { status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] });
        return;
      }
      const asg = fixtures.assignments.find((x) => x.id === Number(m![2]) && x.course_id === Number(m![1]));
      if (!asg) {
        error(res, 404, { errors: [{ message: "The specified resource does not exist." }] });
        return;
      }
      const include = url.searchParams.getAll("include[]");
      const body: Record<string, unknown> = { ...asg, locked_for_user: asg.locked_for_user === true };
      if (!include.includes("submission")) delete body["submission"];
      // Locked: Canvas keeps the brief back until the assignment opens.
      if (asg.locked_for_user) body["description"] = null;
      return json(req, res, body, a.cookie);
    }
    m = p.match(/^\/api\/v1\/courses\/(\d+)\/quizzes\/(\d+)$/);
    if (m) {
      const quiz = fixtures.quizzes.find((x) => x.id === Number(m![2]) && x.course_id === Number(m![1]));
      if (!quiz) {
        error(res, 404, { errors: [{ message: "The specified resource does not exist." }] });
        return;
      }
      return json(req, res, quiz, a.cookie);
    }
    error(res, 404, { errors: [{ message: "The specified resource does not exist." }] });
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  origin = `http://127.0.0.1:${actualPort}`;
  fixtures = makeFixtures(opts.base ?? new Date(), origin);

  return {
    server,
    fixtures,
    origin,
    token,
    feedUrl: `${origin}/feeds/calendars/user_${feedToken}.ics`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
