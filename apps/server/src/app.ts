/** Wires the HTTP app: OAuth server, MCP endpoint, extension API, feeds, pages. */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Services } from "./services.js";
import { MCP_SCOPES, TokenVerifier, userIdOf } from "./auth/bearer.js";
import { SqliteOAuthProvider } from "./auth/oauth-provider.js";
import { loginMiddleware, loginRoutes } from "./auth/login.js";
import { buildMcpServer } from "./mcp/server.js";
import { apiRoutes, extensionCors, requireDevice } from "./routes/api.js";
import { feedRoutes } from "./routes/feeds.js";
import { settingsRoutes } from "./routes/settings.js";
import { feedLimiter, pairLimiter } from "./ratelimit.js";
import { noStore, securityHeaders } from "./ui.js";

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Host headers we answer: ALLOWED_HOSTS if set; on a loopback BASE_URL, loopback names only (DNS rebinding); otherwise any. */
function hostAllowlist(baseUrl: URL, configured: string[] | undefined): string[] | undefined {
  if (configured?.length) return configured.map((h) => h.toLowerCase());
  if (!LOOPBACK.includes(baseUrl.hostname)) return undefined;
  return LOOPBACK.map((h) => (baseUrl.port ? `${h}:${baseUrl.port}` : h));
}

export interface AppDeps {
  services: Services;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export function createApp({ services, fetchImpl = fetch, log = console.error }: AppDeps): Express {
  const cfg = services.config;
  const issuer = new URL(cfg.baseUrl);
  const mcpUrl = new URL(cfg.baseUrl + "/mcp");
  const verifier = new TokenVerifier(services.store, mcpUrl);
  const provider = new SqliteOAuthProvider(services.store, verifier, fetchImpl);

  const app = express();
  app.disable("x-powered-by");
  if (cfg.baseUrl.startsWith("https://")) app.set("trust proxy", 1);
  app.use(securityHeaders);
  const hosts = hostAllowlist(issuer, cfg.allowedHosts);
  if (hosts) {
    app.use((req, res, next) => {
      const host = (req.headers.host ?? "").toLowerCase();
      if (hosts.includes(host) || hosts.includes(host.replace(/:\d+$/, ""))) next();
      else res.status(421).type("text/plain").send("unknown host");
    });
  }
  // The extension is cross-origin to this server; answer its preflights before any
  // limiter or parser so 401/413/429 responses carry the CORS headers too.
  app.use(extensionCors);
  // Bodies are parsed before anyone is authenticated, so keep them small. The extension's
  // snapshot upload is the one big body, parsed only once its device token checks out
  // (the projection in /api/ingest caps everything, so 4 MB is plenty).
  const json = express.json({ limit: "100kb" });
  app.use((req, res, next) => (req.path === "/api/ingest" ? next() : json(req, res, next)));
  app.post("/api/ingest", requireDevice(services), express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  // Authorization-server metadata, with the CIMD flag the SDK's router does not emit yet.
  const metadata = createOAuthMetadata({ provider, issuerUrl: issuer, scopesSupported: MCP_SCOPES, serviceDocumentationUrl: new URL(cfg.baseUrl + "/") });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({ ...metadata, client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"] });
  });
  const rl = cfg.rateLimit ? {} : { rateLimit: false as const };
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: mcpUrl,
      scopesSupported: MCP_SCOPES,
      resourceName: "Canvas planner",
      serviceDocumentationUrl: new URL(cfg.baseUrl + "/"),
      authorizationOptions: rl,
      tokenOptions: rl,
      clientRegistrationOptions: rl,
      revocationOptions: rl,
    }),
  );

  // ---- MCP ---------------------------------------------------------------
  const bearer = requireBearerAuth({ verifier, expectedResource: mcpUrl, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post("/mcp", bearer, async (req, res) => {
    const userId = userIdOf(req.auth);
    const server = buildMcpServer(services, userId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`mcp: ${(e as Error).message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; use POST" }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // ---- extension API, feeds, pages ----------------------------------------
  app.post("/api/pair", pairLimiter(cfg));
  app.use("/feeds", feedLimiter(cfg));
  app.use(apiRoutes(services));
  app.use(feedRoutes(services));
  app.use(noStore);
  app.use(loginMiddleware(services));
  app.use(loginRoutes(services, provider));
  app.use(settingsRoutes(services));

  app.use((err: Error & { status?: number; expose?: boolean }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    // Client mistakes the body parser reports (too large, malformed JSON) stay 4xx; everything else is ours.
    if (typeof err.status === "number" && err.status >= 400 && err.status < 500) {
      // Parser messages quote the body; say only what kind of mistake it was.
      res.status(err.status).type("text/plain").send(err.status === 413 ? "body too large" : "bad request");
      return;
    }
    log(`http: ${err.message}`);
    res.status(500).type("text/plain").send("internal error");
  });
  return app;
}
