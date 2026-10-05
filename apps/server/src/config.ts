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
  /** Off in tests; the OAuth endpoints, logins, pairing and feeds are rate limited otherwise. */
  rateLimit: boolean;
  /** NODE_ENV=production or an https BASE_URL: dev login and weak keys are refused. */
  production: boolean;
  /** ALLOW_DEV_LOGIN=1: dev login even in production, for a private test deployment. */
  allowDevLogin: boolean;
  /** EGRESS_ALLOW_LOOPBACK=1: Canvas/feed URLs may be plain http on loopback (tests, the stub Canvas). Never in production. */
  allowLoopbackEgress: boolean;
}

/** Values from our own docs and defaults; a server running on one has no secret at all. */
export const PLACEHOLDER_SECRET_KEYS = ["dev-secret-key-change-me", "change-me-to-a-long-random-string"];
export const DEV_SECRET_KEY = "dev-secret-key-change-me";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = Number(env("PORT") ?? 8787);
  const baseUrl = (overrides.baseUrl ?? env("BASE_URL") ?? `http://localhost:${port}`).replace(/\/$/, "");
  const production = overrides.production ?? (process.env["NODE_ENV"] === "production" || baseUrl.startsWith("https://"));
  const secretKey = env("SECRET_KEY") ?? (production ? "" : DEV_SECRET_KEY);
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const authModeEnv = env("AUTH_MODE");
  const authMode: Config["authMode"] = authModeEnv === "google" || (authModeEnv === undefined && clientId && clientSecret) ? "google" : "dev";
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
    production,
    allowDevLogin: env("ALLOW_DEV_LOGIN") === "1",
    allowLoopbackEgress: env("EGRESS_ALLOW_LOOPBACK") === "1",
    ...overrides,
  };
  cfg.baseUrl = cfg.baseUrl.replace(/\/$/, "");
  if (clientId && clientSecret && !cfg.google) cfg.google = { clientId, clientSecret };
  const key = env("ANTHROPIC_API_KEY");
  if (key && !cfg.anthropicApiKey) cfg.anthropicApiKey = key;
  const hosts = env("ALLOWED_HOSTS");
  if (hosts && !cfg.allowedHosts) cfg.allowedHosts = hosts.split(",").map((s) => s.trim()).filter(Boolean);
  validateConfig(cfg);
  return cfg;
}

/** Refuses the configurations that would let anyone sign in as anyone, or that seal secrets under a published key. */
export function validateConfig(cfg: Config): void {
  if (!cfg.secretKey) throw new Error("SECRET_KEY is required");
  if (cfg.production) {
    if (PLACEHOLDER_SECRET_KEYS.includes(cfg.secretKey)) throw new Error("SECRET_KEY is a placeholder value; generate one with: openssl rand -base64 48");
    if (cfg.secretKey.length < 32) throw new Error("SECRET_KEY must be at least 32 characters in production");
  }
  if (cfg.authMode === "google" && !cfg.google) throw new Error("AUTH_MODE=google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  if (cfg.production && cfg.allowLoopbackEgress) throw new Error("EGRESS_ALLOW_LOOPBACK is for local development and tests; it is refused in production");
  if (cfg.authMode === "dev" && cfg.production && !cfg.allowDevLogin) {
    throw new Error(
      "dev login (any email signs in) is refused in production (NODE_ENV=production or an https BASE_URL). Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or ALLOW_DEV_LOGIN=1 for a private test deployment",
    );
  }
}
