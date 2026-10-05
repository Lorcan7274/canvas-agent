import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ClaudeEstimator, EstimateService, Sealer, Store } from "@canvas-agent/core";
import { loadConfig } from "./config.js";
import { GoogleCalendar } from "./google/calendar.js";
import { Services } from "./services.js";
import { createApp } from "./app.js";
import { startJobs } from "./jobs.js";

const config = loadConfig();
if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const store = new Store(config.dbPath);
const sealer = new Sealer(config.secretKey);
const llm = config.useLlm ? new ClaudeEstimator(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}) : undefined;
const estimates = new EstimateService(store, llm);
const google = config.google ? new GoogleCalendar(config.google.clientId, config.google.clientSecret) : undefined;
const services = new Services(store, sealer, config, estimates, google);
const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);
const app = createApp({ services, log });

const server = app.listen(config.port, config.host, () => {
  log(`canvas-agent listening on ${config.host}:${config.port}, public ${config.baseUrl}`);
  log(`auth: ${config.authMode}; google calendar: ${google ? "on" : "off"}; model estimates: ${llm ? "on" : "off (heuristic)"}; db: ${config.dbPath}`);
  if (config.secretKey === "dev-secret-key-change-me") log("warning: using the development SECRET_KEY; set SECRET_KEY before exposing this server");
});

const jobs = startJobs(services, config.syncIntervalMinutes, log);
void jobs.runOnce().catch((e) => log(`initial sync: ${(e as Error).message}`));

const shutdown = () => {
  jobs.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
