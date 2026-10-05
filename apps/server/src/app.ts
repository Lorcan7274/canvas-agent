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
import { apiRoutes } from "./routes/api.js";
import { feedRoutes } from "./routes/feeds.js";
import { settingsRoutes } from "./routes/settings.js";

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
  app.use(express.json({ limit: "8mb" }));
  app.use(express.urlencoded({ extended: false }));

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
  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
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
  app.use(apiRoutes(services));
  app.use(feedRoutes(services));
  app.use(loginMiddleware(services));
  app.use(loginRoutes(services, provider));
  app.use(settingsRoutes(services));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log(`http: ${err.message}`);
    if (res.headersSent) return;
    res.status(500).type("text/plain").send("internal error");
  });
  return app;
}
