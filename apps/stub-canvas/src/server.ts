/**
 * A fake Canvas: the handful of REST endpoints the agent reads, with the
 * real quirks (Link pagination, `while(1);` on cookie-authed JSON, 401 on a
 * bad token, an optional one-off 429). Used by tests, local development and
 * directory reviewers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { makeFixtures, plannerItemsFor, feedFor, type Fixtures } from "./fixtures.js";

export interface StubOptions {
  token?: string;
  feedToken?: string;
  base?: Date;
  /** Return 429 on the first request to a planner page, then succeed. */
  throttleOnce?: boolean;
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
  const requests: string[] = [];

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
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-request-cost": "0.3", ...extra }).end(prefix + text);
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
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "Invalid access token." }] }));
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
      const missing = fixtures.assignments
        .filter((x) => x.submission?.missing)
        .map((x) => ({ ...x, course: fixtures.courses.find((c) => c.id === x.course_id) }));
      return paginate(req, res, url, missing, a.cookie);
    }
    let m = p.match(/^\/api\/v1\/courses\/(\d+)\/assignments\/(\d+)$/);
    if (m) {
      const asg = fixtures.assignments.find((x) => x.id === Number(m![2]) && x.course_id === Number(m![1]));
      if (!asg) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      const include = url.searchParams.getAll("include[]");
      const body: Record<string, unknown> = { ...asg };
      if (!include.includes("submission")) delete body["submission"];
      return json(req, res, body, a.cookie);
    }
    m = p.match(/^\/api\/v1\/courses\/(\d+)\/quizzes\/(\d+)$/);
    if (m) {
      const quiz = fixtures.quizzes.find((x) => x.id === Number(m![2]) && x.course_id === Number(m![1]));
      if (!quiz) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      return json(req, res, quiz, a.cookie);
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "not found" }] }));
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
