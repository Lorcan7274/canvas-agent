/**
 * Canvas REST client. Works with a personal access token (server side) or a
 * logged-in session (`credentials: "include"`, with a caller-supplied fetch). Only GET.
 *
 * - Every request goes through the egress guard (`safeFetch`) unless a fetch is
 *   supplied: https, public addresses, no redirects, a deadline and a size cap.
 * - Follows `Link: <...>; rel="next"` pagination, on the instance's own origin only,
 *   so the token never travels to another host.
 * - Strips the `while(1);` anti-hijack prefix Canvas adds to cookie-authed JSON.
 * - Backs off on 429 / "Rate Limit Exceeded", which Canvas meters per token.
 * - Error messages carry the status code at most, never the response body.
 */
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, assertPublicHttpsUrl, readTextCapped, safeFetcher } from "../egress.js";

export class CanvasError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

export interface CanvasClientOptions {
  baseUrl: string;
  token?: string;
  /** Replaces the egress-guarded fetch (tests, a session-cookie fetch). Origin, redirect and size rules still apply. */
  fetch?: typeof fetch;
  /** Send cookies (extension content script / service worker). */
  withCredentials?: boolean;
  maxRetries?: number;
  /** Max pages followed per list call. 100 items per page. */
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Plain http and loopback Canvas (tests, the stub). Never in production. */
  allowHttpLoopback?: boolean;
  /** Per request. Default 15 s. */
  timeoutMs?: number;
  /** Per response body. Default 5 MB. */
  maxBytes?: number;
  /** Cancels every request in flight and every later one (a sync's deadline). */
  signal?: AbortSignal;
}

export type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;

export function normaliseBaseUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new CanvasError("that is not a Canvas address", 0, "");
  }
  return `${u.protocol}//${u.host}`;
}

export function stripXssiPrefix(text: string): string {
  return text.startsWith("while(1);") ? text.slice("while(1);".length) : text;
}

export function parseLinkNext(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return undefined;
}

function statusMessage(status: number): string {
  if (status === 401) return "Canvas rejected the token (401); it may have expired or been revoked";
  if (status === 403) return "Canvas refused access (403)";
  if (status === 404) return "Canvas could not find that (404)";
  return `Canvas returned ${status}`;
}

export class CanvasClient {
  readonly baseUrl: string;
  private readonly origin: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly withCredentials: boolean;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: CanvasClientOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl);
    const policy = opts.allowHttpLoopback ? { allowHttpLoopback: true } : {};
    this.origin = assertPublicHttpsUrl(this.baseUrl, policy).origin;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetchImpl = opts.fetch ?? safeFetcher({ ...policy, timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
    this.withCredentials = opts.withCredentials ?? false;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxPages = opts.maxPages ?? 20;
    this.signal = opts.signal;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  url(path: string, query?: Query): string {
    const u = new URL(path.startsWith("http") ? path : this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const x of v) u.searchParams.append(k.endsWith("[]") ? k : `${k}[]`, String(x));
        } else {
          u.searchParams.set(k, String(v));
        }
      }
    }
    return u.toString();
  }

  private async request(url: string): Promise<Response> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new CanvasError("Canvas sent a link that is not a URL", 0, "");
    }
    // The token goes to the instance it belongs to and nowhere else.
    if (target.origin !== this.origin) throw new CanvasError("Canvas pointed to another address; not followed", 0, target.pathname);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    let attempt = 0;
    for (;;) {
      if (this.signal?.aborted) throw new CanvasError("the Canvas sync was stopped (took too long)", 0, target.pathname);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const init: RequestInit = { method: "GET", headers, redirect: "manual", signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout };
      if (this.withCredentials) init.credentials = "include";
      const res = await this.fetchImpl(target.toString(), init);
      const throttled =
        res.status === 429 ||
        (res.status === 403 && (res.headers.get("x-rate-limit-remaining") !== null || /rate limit/i.test(await readTextCapped(res.clone(), 64 * 1024).catch(() => ""))));
      if (throttled && attempt < this.maxRetries) {
        attempt++;
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new CanvasError(`Canvas answered with a redirect (${res.status}); use the address your browser shows for Canvas`, res.status, target.pathname);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new CanvasError(statusMessage(res.status), res.status, target.pathname);
      }
      return res;
    }
  }

  private async json<T>(res: Response, url: string): Promise<T> {
    const text = await readTextCapped(res, this.maxBytes);
    try {
      return JSON.parse(stripXssiPrefix(text)) as T;
    } catch {
      // JSON.parse's message quotes the input; never pass it on.
      throw new CanvasError("Canvas returned something that is not JSON; check the Canvas address", res.status, new URL(url).pathname);
    }
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const url = this.url(path, query);
    return this.json<T>(await this.request(url), url);
  }

  async getAll<T>(path: string, query?: Query): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = this.url(path, { per_page: 100, ...query });
    let pages = 0;
    while (next && pages < this.maxPages) {
      const res = await this.request(next);
      const page = await this.json<T[] | T>(res, next);
      if (Array.isArray(page)) out.push(...page);
      else out.push(page);
      const link = parseLinkNext(res.headers.get("link"));
      next = link ? new URL(link, this.baseUrl).toString() : undefined;
      pages++;
    }
    return out;
  }

  self(): Promise<{ id: number; name: string; primary_email?: string; login_id?: string }> {
    return this.get("/api/v1/users/self");
  }

  courses(): Promise<unknown[]> {
    return this.getAll("/api/v1/courses", { enrollment_state: "active", "include[]": ["term"] });
  }

  plannerItems(startDate: string, endDate: string): Promise<unknown[]> {
    return this.getAll("/api/v1/planner/items", { start_date: startDate, end_date: endDate });
  }

  missingSubmissions(): Promise<unknown[]> {
    return this.getAll("/api/v1/users/self/missing_submissions", {
      "filter[]": ["submittable"],
      "include[]": ["course", "planner_overrides"],
    });
  }

  assignment(courseId: string, assignmentId: string): Promise<unknown> {
    return this.get(`/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}`, {
      "include[]": ["submission", "score_statistics"],
    });
  }

  quiz(courseId: string, quizId: string): Promise<unknown> {
    return this.get(`/api/v1/courses/${encodeURIComponent(courseId)}/quizzes/${encodeURIComponent(quizId)}`);
  }

  discussion(courseId: string, topicId: string): Promise<unknown> {
    return this.get(`/api/v1/courses/${encodeURIComponent(courseId)}/discussion_topics/${encodeURIComponent(topicId)}`);
  }
}
