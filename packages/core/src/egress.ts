/**
 * Outbound HTTP for addresses a user typed (Canvas instances, calendar feeds,
 * OAuth client metadata) and for fixed third-party APIs. One place enforces:
 *
 * - https only, on the default port, no credentials in the URL;
 * - public addresses only, checked on the address the socket actually
 *   connects to (a guarded DNS lookup), so DNS rebinding cannot slip past;
 * - no silent redirects: refused by default, or re-checked hop by hop;
 * - a deadline over connect, headers and body, and a byte cap on the body.
 *
 * Errors carry a short generic message and never the response body.
 * `allowHttpLoopback` (tests, the stub Canvas) additionally allows plain http
 * and loopback addresses; private, link-local and metadata ranges stay closed.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export type EgressErrorCode = "blocked" | "redirect" | "timeout" | "too_large" | "network";

export class EgressError extends Error {
  constructor(
    message: string,
    public readonly code: EgressErrorCode,
  ) {
    super(message);
    this.name = "EgressError";
  }
}

export interface EgressPolicy {
  /** Allow plain http and loopback addresses (127.0.0.0/8, ::1). Tests and local development only. */
  allowHttpLoopback?: boolean;
}

export interface SafeFetchOptions extends EgressPolicy {
  /** Deadline for the whole exchange, body included. Default 15 s. */
  timeoutMs?: number;
  /** Largest body accepted, after decompression. Default 5 MB. */
  maxBytes?: number;
  /** Redirects followed, each re-checked. Default 0: a redirect is an error. */
  maxRedirects?: number;
  /** Replaces DNS (tests). The answers are checked exactly like real ones. */
  resolve?: Resolver;
}

export type Resolver = (hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// ---- address checks ---------------------------------------------------

function parseV4(s: string): number[] | undefined {
  const parts = s.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const out = parts.map(Number);
  return out.every((n) => n <= 255) ? out : undefined;
}

function v4Blocked(b: number[], allowLoopback: boolean): boolean {
  const [a = 0, c = 0, d = 0] = b;
  if (a === 127) return !allowLoopback;
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && c >= 64 && c <= 127) || // CGNAT
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && (d === 0 || d === 2)) || // IETF assignments, TEST-NET-1
    (a === 192 && c === 88 && d === 99) || // 6to4 relay
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) || // benchmarking
    (a === 198 && c === 51 && d === 100) || // TEST-NET-2
    (a === 203 && c === 0 && d === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Eight 16-bit groups, or undefined when `s` is not an IPv6 address. */
function parseV6(input: string): number[] | undefined {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return undefined;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseV4(dotted[2]!);
    if (!v4) return undefined;
    s = `${dotted[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 ? (halves[1] ? halves[1].split(":") : []) : undefined;
  const groups = tail === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

function embeddedV4(g: number[], hi: number): number[] {
  return [g[hi]! >> 8, g[hi]! & 0xff, g[hi + 1]! >> 8, g[hi + 1]! & 0xff];
}

function v6Blocked(g: number[], allowLoopback: boolean): boolean {
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(7) && g[7] === 1) return !allowLoopback; // ::1
  if (zeroTo(8)) return true; // ::
  if (zeroTo(5) && g[5] === 0xffff) return v4Blocked(embeddedV4(g, 6), allowLoopback); // v4-mapped
  if (zeroTo(6)) return v4Blocked(embeddedV4(g, 6), allowLoopback); // v4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || g[3] !== 0 || g[4] !== 0 || g[5] !== 0 || v4Blocked(embeddedV4(g, 6), false); // NAT64
  if (g[0] === 0x2002) return v4Blocked(embeddedV4(g, 1), false); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  // Everything else outside global unicast (2000::/3) is ULA, link-local, site-local, multicast or reserved.
  return (g[0]! & 0xe000) !== 0x2000;
}

/** True for loopback, private, link-local, CGNAT, ULA, multicast, reserved and embedded-v4 forms of those. */
export function isBlockedAddress(address: string, allowLoopback = false): boolean {
  const v4 = parseV4(address);
  if (v4) return v4Blocked(v4, allowLoopback);
  const v6 = parseV6(address);
  if (v6) return v6Blocked(v6, allowLoopback);
  return true; // not an address at all
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = parseV4(h);
  if (v4) return v4[0] === 127;
  const v6 = parseV6(h);
  return !!v6 && v6.slice(0, 7).every((x) => x === 0) && v6[7] === 1;
}

/**
 * Throws unless `input` is an https URL on the default port whose host is a
 * name (with a dot) or a public IP literal. DNS is checked at connect time by
 * `safeFetch`. Returns the parsed URL.
 */
export function assertPublicHttpsUrl(input: string | URL, policy: EgressPolicy = {}): URL {
  let u: URL;
  try {
    u = new URL(String(input));
  } catch {
    throw new EgressError("that is not a valid URL", "blocked");
  }
  const loopbackOk = policy.allowHttpLoopback === true && isLoopbackHostname(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopbackOk)) throw new EgressError("the address must start with https://", "blocked");
  if (u.username || u.password) throw new EgressError("the address must not contain a user name or password", "blocked");
  if (u.port && !loopbackOk) throw new EgressError("the address must use the standard https port", "blocked");
  if (loopbackOk) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new EgressError("that address is not on the public internet", "blocked");
    return u;
  }
  if (!host.includes(".") || isLoopbackHostname(host) || /\.(local|internal|lan|home\.arpa)\.?$/i.test(host)) {
    throw new EgressError("that address is not on the public internet", "blocked");
  }
  return u;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(allowLoopback: boolean, resolve?: Resolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const done = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (err) return callback(err, "", 0);
      const list = addresses ?? [];
      if (!list.length) return callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 0);
      // Every answer must be public: a mixed answer would let the connection pick the private one.
      if (list.some((a) => isBlockedAddress(a.address, allowLoopback))) {
        return callback(new EgressError("that address is not on the public internet", "blocked") as NodeJS.ErrnoException, "", 0);
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    };
    if (resolve) resolve(hostname, done);
    else dnsLookup(hostname, { ...options, all: true }, (err, addresses) => done(err, addresses as LookupAddress[]));
  };
}

// Dedicated pools, one per policy, so a socket opened under one policy (or by
// other code in the process) is never reused for a request under another.
const agents = new Map<string, HttpAgent>();
function agentFor(protocol: string, allowLoopback: boolean): HttpAgent {
  const key = `${protocol}|${allowLoopback}`;
  let a = agents.get(key);
  if (!a) {
    a = protocol === "https:" ? new HttpsAgent({ keepAlive: true, maxSockets: 16 }) : new HttpAgent({ keepAlive: true, maxSockets: 16 });
    agents.set(key, a);
  }
  return a;
}

// ---- fetching ---------------------------------------------------------

function bodyBytes(body: RequestInit["body"] | undefined, headers: Headers): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return Buffer.from(body.toString());
  }
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new TypeError("safeFetch: unsupported body type");
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

interface Hop {
  status: number;
  location?: string;
  response?: Response;
}

function exchange(url: URL, method: string, headers: Headers, body: Buffer | undefined, signal: AbortSignal, maxBytes: number, allowLoopback: boolean, resolver?: Resolver): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    let req: ReturnType<typeof httpRequest> | undefined;
    const finish = (err: unknown, hop?: Hop) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (err) {
        req?.destroy();
        reject(err instanceof EgressError ? err : new EgressError("the server could not be reached", "network"));
      } else resolve(hop!);
    };
    const onAbort = () => finish(new EgressError("the request timed out", "timeout"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    const h: Record<string, string> = {};
    headers.forEach((v, k) => (h[k] = v));
    h["accept-encoding"] ??= "gzip, deflate, br";
    h["user-agent"] ??= "canvas-agent/0.1";
    if (body) h["content-length"] = String(body.length);
    const opts: RequestOptions = {
      method,
      headers: h,
      // A custom resolver gets no pooled sockets: they would be shared with real DNS answers.
      agent: resolver ? false : agentFor(url.protocol, allowLoopback),
      lookup: guardedLookup(allowLoopback, resolver) as RequestOptions["lookup"],
    };
    const onResponse = (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        return finish(null, { status, location });
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) return finish(new EgressError("the response was too large", "too_large"));
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
      let stream: NodeJS.ReadableStream = res;
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(createGunzip());
      else if (enc === "deflate") stream = res.pipe(createInflate());
      else if (enc === "br") stream = res.pipe(createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) finish(new EgressError("the response was too large", "too_large"));
        else chunks.push(c);
      });
      stream.on("error", (e) => finish(e));
      res.on("error", (e) => finish(e));
      res.on("aborted", () => finish(new EgressError("the connection was closed early", "network")));
      stream.on("end", () => {
        if (settled) return;
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || k === "content-encoding" || k === "content-length") continue;
          for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
        }
        let response: Response;
        try {
          response = new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: out });
        } catch {
          return finish(new EgressError("the server sent an unusable response", "network"));
        }
        finish(null, { status, response });
      });
    };
    try {
      req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, opts, onResponse);
    } catch (e) {
      return finish(e);
    }
    req.on("error", (e) => finish(e));
    req.end(body);
  });
}

/**
 * fetch() for untrusted or external addresses. Returns a Response whose body
 * is already read and within `maxBytes`. Throws `EgressError` for a refused
 * address, a refused redirect, a timeout, an oversized body or a network error.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  const allowLoopback = opts.allowHttpLoopback === true;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 0;
  let url = assertPublicHttpsUrl(input, opts);
  let method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  let body = bodyBytes(init.body, headers);
  for (let hop = 0; ; hop++) {
    const r = await exchange(url, method, headers, body, signal, maxBytes, allowLoopback, opts.resolve);
    if (r.response) return r.response;
    if (hop >= maxRedirects) throw new EgressError("the server answered with a redirect, which is not followed", "redirect");
    let next: URL;
    try {
      next = new URL(r.location!, url);
    } catch {
      throw new EgressError("the server answered with a bad redirect", "redirect");
    }
    next = assertPublicHttpsUrl(next, opts);
    if (next.origin !== url.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
    }
    url = next;
  }
}

/** Reads a Response body as text, refusing more than `maxBytes` (for responses that did not come from safeFetch). */
export async function readTextCapped(res: Response, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new EgressError("the response was too large", "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A `typeof fetch` bound to an egress policy, for clients that take a fetch implementation. */
export function safeFetcher(opts: SafeFetchOptions = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => safeFetch(input instanceof Request ? input.url : input, init ?? {}, opts)) as typeof fetch;
}
