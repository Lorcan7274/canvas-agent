/** Environment-driven configuration. Nothing here is secret-logged. */

export interface Config {
  port: number;
  host: string;
  /** Public origin, e.g. https://planner.example.com. Issuer for OAuth and the MCP resource. */
  baseUrl: string;
  secretKey: string;
  dbPath: string;
  /** dev: email-only login form. google: Sign in with Google. */
  authMode: "dev" | "google";
  google?: { clientId: string; clientSecret: string };
  anthropicApiKey?: string;
  useLlm: boolean;
  syncIntervalMinutes: number;
  allowedHosts?: string[];
  /** Hostnames of Canvas instances the extension may report for; empty = any. */
  canvasHostAllowlist: string[];
  logLevel: "debug" | "info" | "warn";
  /** Off in tests; the OAuth endpoints are rate limited otherwise. */
  rateLimit: boolean;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = Number(env("PORT") ?? 8787);
  const baseUrl = (env("BASE_URL") ?? `http://localhost:${port}`).replace(/\/$/, "");
  const secretKey = env("SECRET_KEY") ?? (process.env["NODE_ENV"] === "production" ? "" : "dev-secret-key-change-me");
  if (!secretKey) throw new Error("SECRET_KEY is required");
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const authModeEnv = env("AUTH_MODE");
  const authMode: Config["authMode"] = authModeEnv === "google" || (authModeEnv === undefined && clientId && clientSecret) ? "google" : "dev";
  if (authMode === "google" && !(clientId && clientSecret)) throw new Error("AUTH_MODE=google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const cfg: Config = {
    port,
    host: env("HOST") ?? "0.0.0.0",
    baseUrl,
    secretKey,
    dbPath: env("DB_PATH") ?? "./data/canvas-agent.sqlite",
    authMode,
    useLlm: (env("USE_LLM") ?? (env("ANTHROPIC_API_KEY") ? "true" : "false")) === "true",
    syncIntervalMinutes: Number(env("SYNC_INTERVAL_MINUTES") ?? 30),
    canvasHostAllowlist: (env("CANVAS_HOSTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    logLevel: (env("LOG_LEVEL") as Config["logLevel"]) ?? "info",
    rateLimit: (env("RATE_LIMIT") ?? "on") !== "off",
    ...overrides,
  };
  if (clientId && clientSecret && !cfg.google) cfg.google = { clientId, clientSecret };
  const key = env("ANTHROPIC_API_KEY");
  if (key && !cfg.anthropicApiKey) cfg.anthropicApiKey = key;
  const hosts = env("ALLOWED_HOSTS");
  if (hosts && !cfg.allowedHosts) cfg.allowedHosts = hosts.split(",").map((s) => s.trim());
  return cfg;
}
