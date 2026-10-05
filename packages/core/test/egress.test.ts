import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { EgressError, assertPublicHttpsUrl, isBlockedAddress, safeFetch } from "../src/egress.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "fd00::1",
    "fc12:3456::1",
    "fe80::1%eth0",
    "ff02::1",
    "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
  it("opens loopback, and only loopback, under the test policy", () => {
    expect(isBlockedAddress("127.0.0.1", true)).toBe(false);
    expect(isBlockedAddress("::1", true)).toBe(false);
    expect(isBlockedAddress("169.254.169.254", true)).toBe(true);
    expect(isBlockedAddress("10.0.0.1", true)).toBe(true);
  });
});

describe("assertPublicHttpsUrl", () => {
  it.each([
    "http://canvas.example.edu",
    "https://127.0.0.1",
    "https://2130706433/", // 127.0.0.1 as one number
    "https://0x7f.1/",
    "https://[::1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/",
    "https://localhost/",
    "https://intranet/",
    "https://metadata.google.internal/",
    "https://user:pass@canvas.example.edu/",
    "https://canvas.example.edu:8443/",
    "file:///etc/passwd",
    "gopher://canvas.example.edu/",
    "not a url",
  ])("refuses %s", (u) => {
    expect(() => assertPublicHttpsUrl(u)).toThrow(EgressError);
  });
  it("accepts a public https name or address", () => {
    expect(assertPublicHttpsUrl("https://canvas.example.edu/x").hostname).toBe("canvas.example.edu");
    expect(assertPublicHttpsUrl("https://93.184.216.34/").hostname).toBe("93.184.216.34");
  });
  it("allows http on loopback only with the test policy", () => {
    expect(assertPublicHttpsUrl("http://127.0.0.1:3999/", { allowHttpLoopback: true }).port).toBe("3999");
    expect(() => assertPublicHttpsUrl("http://canvas.example.edu/", { allowHttpLoopback: true })).toThrow(EgressError);
    expect(() => assertPublicHttpsUrl("http://10.0.0.1/", { allowHttpLoopback: true })).toThrow(EgressError);
  });
});

describe("safeFetch against a local server", () => {
  let server: Server;
  let origin: string;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ""}`);
      if (req.url === "/ok") return res.writeHead(200, { "content-type": "text/plain" }).end("hello");
      if (req.url === "/post") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => res.writeHead(200).end(`${req.headers["content-type"]}|${body}`));
        return;
      }
      if (req.url === "/to-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      if (req.url === "/to-ok") return res.writeHead(302, { location: "/ok" }).end();
      if (req.url === "/big") return res.writeHead(200).end("x".repeat(2 * 1024 * 1024));
      if (req.url === "/big-chunked") {
        res.writeHead(200);
        for (let i = 0; i < 64; i++) res.write("y".repeat(64 * 1024));
        return res.end();
      }
      if (req.url === "/drip") {
        res.writeHead(200, { "content-type": "text/calendar" });
        const t = setInterval(() => res.write("."), 50);
        res.on("close", () => clearInterval(t));
        return;
      }
      res.writeHead(404).end("internal secret page");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const loop = { allowHttpLoopback: true } as const;

  it("refuses a loopback server without the test policy, before any request is sent", async () => {
    const before = hits.length;
    await expect(safeFetch(`${origin}/ok`)).rejects.toMatchObject({ code: "blocked" });
    // A name that resolves to loopback is caught at connect time.
    await expect(safeFetch("https://localhost/ok")).rejects.toBeInstanceOf(EgressError);
    expect(hits.length).toBe(before);
  });

  it("checks the address actually connected to, so a public name that resolves to a private address is refused", async () => {
    const port = Number(new URL(origin).port);
    const before = hits.length;
    // DNS rebinding: the name passes the URL check, the answer is internal.
    const rebinding = (_h: string, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
    await expect(safeFetch(`https://canvas.example.edu/ok`, {}, { resolve: rebinding })).rejects.toMatchObject({ code: "blocked" });
    const mixed = (_h: string, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]);
    await expect(safeFetch(`https://canvas.example.edu/ok`, {}, { resolve: mixed })).rejects.toMatchObject({ code: "blocked" });
    // Under the test policy loopback answers are allowed, private ones still are not.
    const toLoopback = (_h: string, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
    const ok = await safeFetch(`http://localhost:${port}/ok`, {}, { allowHttpLoopback: true, resolve: toLoopback });
    expect(await ok.text()).toBe("hello");
    const toMetadata = (_h: string, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: "169.254.169.254", family: 4 }]);
    await expect(safeFetch(`http://localhost:${port}/ok`, {}, { allowHttpLoopback: true, resolve: toMetadata })).rejects.toMatchObject({ code: "blocked" });
    expect(hits.length).toBe(before + 1);
  });

  it("fetches under the test policy and returns a normal Response", async () => {
    const res = await safeFetch(`${origin}/ok`, {}, loop);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("sends POST bodies", async () => {
    const res = await safeFetch(`${origin}/post`, { method: "POST", body: new URLSearchParams({ a: "1" }) }, loop);
    expect(await res.text()).toBe("application/x-www-form-urlencoded;charset=UTF-8|a=1");
  });

  it("refuses redirects by default, and re-checks every hop when following", async () => {
    await expect(safeFetch(`${origin}/to-ok`, {}, loop)).rejects.toMatchObject({ code: "redirect" });
    await expect(safeFetch(`${origin}/to-metadata`, {}, { ...loop, maxRedirects: 3 })).rejects.toMatchObject({ code: "blocked" });
    const followed = await safeFetch(`${origin}/to-ok`, {}, { ...loop, maxRedirects: 3 });
    expect(await followed.text()).toBe("hello");
  });

  it("caps the body, declared or streamed", async () => {
    await expect(safeFetch(`${origin}/big`, {}, { ...loop, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: "too_large" });
    await expect(safeFetch(`${origin}/big-chunked`, {}, { ...loop, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("gives up on a server that drips its body", async () => {
    const t0 = Date.now();
    await expect(safeFetch(`${origin}/drip`, {}, { ...loop, timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("never puts the response body in an error", async () => {
    const res = await safeFetch(`${origin}/nope`, {}, loop);
    expect(res.status).toBe(404);
    const err = await safeFetch(`${origin}/to-metadata`, {}, { ...loop, maxRedirects: 1 }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("169.254");
  });
});
