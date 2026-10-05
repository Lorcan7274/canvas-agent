/**
 * The service worker's logic; background.ts wires it up at start, and the
 * tests run it against a fake `chrome`. It reads Canvas with the student's own
 * session (GET only) and posts what the planner needs to their server.
 *
 * Only the fields the planner reads leave the browser (`projectCanvasSnapshot`):
 * no submission bodies, comments, attachments, LTI parameters or preview links.
 *
 * Orchestration:
 * - One sync per origin at a time: the in-flight promise per origin, plus a lock
 *   in `chrome.storage.session` that outlives a restarted worker and goes stale
 *   LOCK_STALE_MS after its last heartbeat.
 * - Automatic syncs (page loads, the alarm) run at most every MIN_INTERVAL_MS
 *   after a success. After a failure they wait until `retryAt`: one minute when
 *   Canvas says the student is signed out (one cheap request), otherwise
 *   exponential from two minutes to two hours. The Sync button skips the wait.
 * - Details are read DETAIL_CONCURRENCY at a time. Each batch is posted as soon
 *   as it is read, so a sync cut short keeps what it fetched, and progress goes
 *   to session storage per batch. That storage call also keeps the worker
 *   alive: an extension API call resets its idle timer, a fetch does not.
 * - Every settings write goes through one queue in this worker; the options
 *   page and content script only read, and ask by message.
 */
import { projectCanvasSnapshot } from "../../../packages/core/src/canvas/project.js";
import type { CanvasSnapshot } from "../../../packages/core/src/types.js";
import {
  REMOVED_BY_STUDENT,
  assistantUrl,
  canvasOriginRefusal,
  isInstructureCanvas,
  loadSettings,
  originPattern,
  scriptId,
  serverOrigin,
  type ExtensionSettings,
  type FailureKind,
  type Message,
  type OriginSync,
  type Reply,
  type Status,
} from "./shared.js";

export const SYNC_ALARM = "planner-sync";
export const SYNC_PERIOD_MINUTES = 30;
export const MIN_INTERVAL_MS = 10 * 60_000;
export const DETAIL_BUDGET = 40;
export const DETAIL_CONCURRENCY = 4;
export const LOCK_STALE_MS = 2 * 60_000;
export const SIGNED_OUT_RETRY_MS = 60_000;
export const BACKOFF_BASE_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 2 * 60 * 60_000;
export const DEFAULT_TITLE = "Planner for Canvas: sync now";
export const UNPAIRED_TITLE = "Planner for Canvas: not paired yet, click to set up";

/** This worker's life; a lock from another instance belongs to a worker that is gone. */
const INSTANCE = crypto.randomUUID();
/** Bumped by "Forget everything" and by pairing again: syncs started before stop writing. */
let generation = 0;

class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
  ) {
    super(message);
  }
}
class Cancelled extends Error {}

// ---- settings: one writer ------------------------------------------------

let writes: Promise<unknown> = Promise.resolve();

/** Read-modify-write, serialised, so concurrent syncs cannot drop each other's results. */
function update(fn: (s: ExtensionSettings) => void): Promise<ExtensionSettings> {
  const run = writes.then(async () => {
    const s = await loadSettings();
    fn(s);
    await chrome.storage.local.set({ settings: s });
    return s;
  });
  writes = run.catch(() => undefined);
  return run;
}

function wipe(): Promise<void> {
  const run = writes.then(() => chrome.storage.local.clear());
  writes = run.catch(() => undefined);
  return run;
}

const paired = (s: ExtensionSettings): boolean => !!(s.serverUrl && s.deviceToken);

// ---- badge ---------------------------------------------------------------

let painting: Promise<unknown> = Promise.resolve();

/** Badge and title from every origin's last result, so one origin's success cannot hide another's failure. */
export function refreshBadge(): Promise<void> {
  const run = painting.then(async () => {
    const s = await loadSettings();
    if (!paired(s)) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: UNPAIRED_TITLE });
      return;
    }
    const problems = s.canvasOrigins.flatMap((o) => {
      const last = s.lastSync?.[o];
      return last && !last.ok ? [`${new URL(o).host}: ${last.message}`] : [];
    });
    await chrome.action.setBadgeText({ text: problems.length ? "!" : "" });
    await chrome.action.setTitle({ title: problems.length ? `Planner for Canvas: ${problems.join("; ")}`.slice(0, 300) : DEFAULT_TITLE });
  });
  painting = run.catch(() => undefined);
  return run;
}

// ---- Canvas --------------------------------------------------------------

const signedOut = () => new SyncError("not signed in to Canvas", "signed-out");

/**
 * One GET with the student's session. A sign-in page, an SSO redirect or any
 * other HTML answer means "not signed in", never a JSON parse error.
 */
async function canvasRequest(origin: string, url: string, label: string): Promise<{ body: unknown; next?: string }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", credentials: "include", headers: { accept: "application/json" } });
  } catch {
    // A redirect to the school's sign-in host fails here too: the extension has no permission for it.
    throw new SyncError("could not reach Canvas (offline, or Canvas sent you to your school's sign-in page)", "signed-out");
  }
  if (res.status === 401) throw signedOut();
  if (res.redirected) {
    let landed: URL | undefined;
    try {
      landed = new URL(res.url);
    } catch {
      landed = undefined;
    }
    if (!landed || landed.origin !== origin || !landed.pathname.startsWith("/api/")) throw signedOut();
  }
  const text = await res.text();
  // Canvas throttles with 403 "Rate Limit Exceeded" as well as 429; any other 403 is just forbidden.
  if (res.status === 429 || (res.status === 403 && /rate limit exceeded/i.test(text))) throw new SyncError("Canvas asked us to slow down; will retry later", "rate");
  if (!res.ok) throw new SyncError(`Canvas ${res.status} for ${label}`, "error");
  if (!/json/i.test(res.headers.get("content-type") ?? "")) throw signedOut();
  let body: unknown;
  try {
    body = JSON.parse(text.startsWith("while(1);") ? text.slice(9) : text);
  } catch {
    throw new SyncError(`Canvas sent something that is not JSON for ${label}`, "error");
  }
  const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
  // Follow pages on this Canvas only; the session cookie stays where it belongs.
  const next = m?.[1] ? new URL(m[1], origin) : undefined;
  return next && next.origin === origin ? { body, next: next.toString() } : { body };
}

async function canvasGet<T>(origin: string, path: string): Promise<T> {
  return (await canvasRequest(origin, origin + path, path.split("?")[0]!)).body as T;
}

const MAX_PAGES = 20;

/** Every page of a list (up to MAX_PAGES), and whether it was read to its last page (no `rel="next"` left). */
async function canvasGetAll<T>(origin: string, path: string, onPage: () => Promise<void>): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  const label = path.split("?")[0]!;
  let url: string | undefined = origin + path + (path.includes("?") ? "&" : "?") + "per_page=100";
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const got: { body: unknown; next?: string } = await canvasRequest(origin, url, label);
    if (!Array.isArray(got.body)) throw new SyncError(`Canvas sent something unexpected for ${label}`, "error");
    items.push(...(got.body as T[]));
    url = got.next;
    await onPage();
  }
  return { items, complete: url === undefined };
}

/** Canvas answers /api/v1/users/self with the student, as JSON: that, and the page's own markup, is what makes an origin Canvas. */
async function confirmCanvas(origin: string): Promise<void> {
  const me = await canvasGet<{ id?: unknown }>(origin, "/api/v1/users/self");
  if (!me || typeof me !== "object" || (typeof me.id !== "number" && typeof me.id !== "string")) throw new SyncError("that does not answer like Canvas", "error");
}

/** Canvas ids from the server's wanted list: digits (or Canvas's shard~id form), nothing that could change the path. */
const CANVAS_ID = /^\d+(~\d+)?$/;

interface Wanted {
  courseId: string;
  assignmentId: string;
  quizId: string | null;
  baseUrl?: string;
}

// ---- the planner server ---------------------------------------------------

interface SyncCtx {
  origin: string;
  s: ExtensionSettings;
  token: string;
  lock: string;
  gen: number;
}

async function server<T>(s: ExtensionSettings, method: string, path: string, body?: unknown): Promise<T> {
  const origin = serverOrigin(s.serverUrl ?? "");
  if (!origin) throw new SyncError("the planner server address must be https; pair again from the options page", "unpaired");
  const init: RequestInit = { method, headers: { authorization: `Bearer ${s.deviceToken}`, "content-type": "application/json" }, credentials: "omit" };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${origin}${path}`, init);
  } catch {
    throw new SyncError("could not reach the planner server", "error");
  }
  if (res.status === 401) throw new SyncError("the planner server rejected this device; pair again from the options page", "unpaired");
  const data = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!res.ok) {
    const said = typeof data?.error === "string" ? data.error.slice(0, 160) : "";
    // The server's CANVAS_HOSTS allowlist (or its https rule) refuses this Canvas outright.
    if (res.status === 400 && /not allowed on this server|must be https/i.test(said)) throw new SyncError("the planner server does not accept this Canvas address", "refused");
    throw new SyncError(`planner server ${res.status}${said ? `: ${said}` : ""}`, "error");
  }
  if (data === undefined) throw new SyncError("the planner server sent something that is not JSON", "error");
  return data as T;
}

// ---- the lock --------------------------------------------------------------

interface Lock {
  instance: string;
  id: string;
  at: number;
  phase: string;
  done?: number;
  total?: number;
}
const lockKey = (origin: string) => `sync:${origin}`;

async function readLock(origin: string): Promise<Lock | undefined> {
  const key = lockKey(origin);
  return ((await chrome.storage.session.get(key)) as Record<string, Lock | undefined>)[key];
}

/** The lock, unless a live one is held. A forced sync takes over one left by an earlier worker: only one runs at a time. */
async function takeLock(origin: string, force: boolean): Promise<string | undefined> {
  const cur = await readLock(origin);
  if (cur && Date.now() - cur.at < LOCK_STALE_MS && !(force && cur.instance !== INSTANCE)) return undefined;
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [lockKey(origin)]: { instance: INSTANCE, id, at: Date.now(), phase: "starting" } satisfies Lock });
  return id;
}

/** Progress and heartbeat in one write; stops a sync that "Forget everything" or a new pairing overtook. */
async function beat(ctx: SyncCtx, phase: string, done?: number, total?: number): Promise<void> {
  if (ctx.gen !== generation) throw new Cancelled();
  const lock: Lock = { instance: INSTANCE, id: ctx.lock, at: Date.now(), phase };
  if (done !== undefined) lock.done = done;
  if (total !== undefined) lock.total = total;
  await chrome.storage.session.set({ [lockKey(ctx.origin)]: lock });
}

async function releaseLock(origin: string, id: string): Promise<void> {
  if ((await readLock(origin))?.id === id) await chrome.storage.session.remove(lockKey(origin));
}

// ---- syncing ----------------------------------------------------------------

const inflight = new Map<string, Promise<OriginSync | undefined>>();
/** Syncs started without waiting for them (page loads, pairing). */
const detached = new Set<Promise<unknown>>();

function inBackground(p: Promise<unknown>): void {
  const tracked = p.catch(() => undefined).finally(() => detached.delete(tracked));
  detached.add(tracked);
}

/** Resolves when every sync this worker started has finished. */
export async function settled(): Promise<void> {
  while (inflight.size || detached.size) await Promise.allSettled([...inflight.values(), ...detached]);
}

function retryDelay(kind: FailureKind, failures: number): number {
  if (kind === "signed-out") return SIGNED_OUT_RETRY_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

function due(last: OriginSync | undefined, now = Date.now()): boolean {
  if (!last) return true;
  if (last.ok) return now - Date.parse(last.at) >= MIN_INTERVAL_MS;
  return !last.retryAt || now >= Date.parse(last.retryAt);
}

export function syncOrigin(origin: string, force: boolean): Promise<OriginSync | undefined> {
  const running = inflight.get(origin);
  if (running) return running;
  const p: Promise<OriginSync | undefined> = runSync(origin, force).finally(() => {
    if (inflight.get(origin) === p) inflight.delete(origin);
  });
  inflight.set(origin, p);
  return p;
}

export async function syncAll(force: boolean): Promise<void> {
  const s = await loadSettings();
  for (const origin of s.canvasOrigins) await syncOrigin(origin, force);
}

async function runSync(origin: string, force: boolean): Promise<OriginSync | undefined> {
  const s = await loadSettings();
  if (!paired(s) || !s.canvasOrigins.includes(origin)) return undefined;
  const last = s.lastSync?.[origin];
  if (!force && !due(last)) return last;
  const gen = generation;
  const lock = await takeLock(origin, force);
  if (!lock) return last; // another sync holds it, perhaps from a worker that was restarted
  const ctx: SyncCtx = { origin, s, token: s.deviceToken!, lock, gen };
  try {
    return await record(ctx, true, await syncSteps(ctx));
  } catch (e) {
    if (e instanceof Cancelled) return undefined;
    const err = e instanceof SyncError ? e : new SyncError(`sync failed: ${(e as Error).message}`, "error");
    if (err.kind === "refused") {
      await ignoreOrigin(origin, err.message, ctx);
      return undefined;
    }
    return await record(ctx, false, err.message, err.kind);
  } finally {
    await releaseLock(origin, lock);
  }
}

async function record(ctx: SyncCtx, ok: boolean, message: string, kind: FailureKind = "error"): Promise<OriginSync | undefined> {
  if (ctx.gen !== generation) return undefined;
  let entry: OriginSync | undefined;
  await update((s) => {
    // Forgotten, paired elsewhere or removed meanwhile: this result belongs to nobody.
    if (s.deviceToken !== ctx.token || !s.canvasOrigins.includes(ctx.origin)) return;
    const prev = s.lastSync?.[ctx.origin];
    const now = Date.now();
    entry = { at: new Date(now).toISOString(), ok, message };
    if (!ok) {
      entry.failures = (prev && !prev.ok ? (prev.failures ?? 1) : 0) + 1;
      entry.retryAt = new Date(now + retryDelay(kind, entry.failures)).toISOString();
    }
    s.lastSync = { ...s.lastSync, [ctx.origin]: entry };
  });
  await refreshBadge();
  return entry;
}

async function syncSteps(ctx: SyncCtx): Promise<string> {
  const { origin, s } = ctx;
  await canvasGet(origin, "/api/v1/users/self");
  await beat(ctx, "courses");
  const today = Date.now();
  const start = new Date(today - 14 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(today + 120 * 86_400_000).toISOString().slice(0, 10);
  const { items: courses } = await canvasGetAll(origin, "/api/v1/courses?enrollment_state=active&include[]=term", () => beat(ctx, "courses"));
  const planner = await canvasGetAll(origin, `/api/v1/planner/items?start_date=${start}&end_date=${end}`, () => beat(ctx, "planner"));
  const plannerItems = planner.items;
  let missingSubmissions: unknown[] = [];
  try {
    // planner_overrides: work the student marked done in Canvas is not reported as missing.
    missingSubmissions = (await canvasGetAll(origin, "/api/v1/users/self/missing_submissions?filter[]=submittable&include[]=course&include[]=planner_overrides", () => beat(ctx, "missing"))).items;
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    // some instances restrict this endpoint; the planner view is enough
  }
  const fetchedAt = new Date().toISOString();
  const snapshot: CanvasSnapshot = { baseUrl: origin, fetchedAt, courses, plannerItems, missingSubmissions };
  // Only a planner list read to its last page tells the server what Canvas no longer lists.
  if (planner.complete) snapshot.plannerWindow = { start, end };
  await server(s, "POST", "/api/ingest", projectCanvasSnapshot(snapshot));
  await beat(ctx, "posted");

  // Second pass: details the server has not got yet, a batch at a time, each batch posted as it lands.
  const { wanted } = await server<{ wanted: Wanted[] }>(s, "GET", `/api/ingest/wanted?baseUrl=${encodeURIComponent(origin)}`);
  const todo = (Array.isArray(wanted) ? wanted : [])
    .filter((w) => (!w.baseUrl || w.baseUrl === origin) && CANVAS_ID.test(String(w.courseId)) && CANVAS_ID.test(String(w.assignmentId)) && (w.quizId === null || w.quizId === undefined || CANVAS_ID.test(String(w.quizId))))
    .slice(0, DETAIL_BUDGET);
  let details = 0;
  let note = "";
  for (let i = 0; i < todo.length; i += DETAIL_CONCURRENCY) {
    const batch = todo.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (w) => {
        const assignment = await canvasGet(origin, `/api/v1/courses/${w.courseId}/assignments/${w.assignmentId}?include[]=submission`);
        let quiz: unknown;
        try {
          if (w.quizId) quiz = await canvasGet(origin, `/api/v1/courses/${w.courseId}/quizzes/${w.quizId}`);
        } catch (e) {
          // A quiz Canvas will not show (unpublished, deleted) leaves the assignment's own details worth keeping.
          if (e instanceof SyncError && (e.kind === "signed-out" || e.kind === "rate")) throw e;
        }
        return { w, assignment, quiz };
      }),
    );
    const assignments: Record<string, unknown> = {};
    const quizzes: Record<string, unknown> = {};
    const detailFailures: string[] = [];
    let stop: SyncError | undefined;
    results.forEach((r, j) => {
      if (r.status === "fulfilled") {
        assignments[r.value.w.assignmentId] = r.value.assignment;
        if (r.value.w.quizId && r.value.quiz !== undefined) quizzes[r.value.w.quizId] = r.value.quiz;
      } else if (r.reason instanceof SyncError && (r.reason.kind === "signed-out" || r.reason.kind === "rate")) {
        stop ??= r.reason; // not the item's fault: no failure recorded
      } else {
        // A 404, one forbidden item: the server backs off on it (1 h, 4 h, 16 h…) unless it changes.
        detailFailures.push(String(batch[j]!.assignmentId));
      }
    });
    const n = Object.keys(assignments).length;
    if (n || detailFailures.length) {
      // No plannerWindow on these posts: an empty planner list here says nothing about what Canvas lists.
      await server(s, "POST", "/api/ingest", projectCanvasSnapshot({ baseUrl: origin, fetchedAt, courses: [], plannerItems: [], assignments, quizzes, detailFailures }));
      details += n;
    }
    await beat(ctx, "details", i + batch.length, todo.length);
    if (stop?.kind === "signed-out") throw stop;
    if (stop) {
      note = "; Canvas asked us to slow down, the rest next sync";
      break;
    }
  }

  const me = await server<{ assistant?: unknown; assistantUrl?: unknown }>(s, "GET", "/api/me");
  await update((cur) => {
    if (cur.deviceToken !== ctx.token) return;
    cur.assistant = me.assistant === "chatgpt" || me.assistant === "custom" ? me.assistant : "claude";
    cur.assistantUrl = typeof me.assistantUrl === "string" ? me.assistantUrl : null;
  });
  return `synced ${plannerItems.length} items, ${details} details${note}`;
}

// ---- origins ----------------------------------------------------------------

/** Probes in flight, so tabs loading at once ask Canvas once. */
const probing = new Map<string, Promise<void>>();

/** A Canvas page opened: sync a known origin, or confirm a new one with a JSON /api/v1/users/self before registering it. */
async function onCanvasPage(origin: string): Promise<void> {
  const s = await loadSettings();
  if (s.canvasOrigins.includes(origin)) {
    inBackground(syncOrigin(origin, false));
    return;
  }
  if (canvasOriginRefusal(origin) || s.ignoredOrigins?.[origin]) return;
  const running = probing.get(origin);
  if (running) return running;
  const probe = (async () => {
    if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] }))) return;
    try {
      await confirmCanvas(origin);
    } catch {
      return; // not Canvas, or not signed in yet: the next page load asks again
    }
    const gen = generation;
    await update((cur) => {
      if (gen === generation && !cur.canvasOrigins.includes(origin) && !cur.ignoredOrigins?.[origin]) cur.canvasOrigins.push(origin);
    });
    inBackground(syncOrigin(origin, false));
  })().finally(() => probing.delete(origin));
  probing.set(origin, probe);
  return probe;
}

/** Options page, after it got the host permission: confirm the address is Canvas, then register it. */
async function addOrigin(raw: string): Promise<string> {
  const origin = new URL(raw).origin;
  const refusal = canvasOriginRefusal(origin);
  if (refusal) throw new Error(refusal);
  if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] }))) throw new Error("permission to read that address was not granted");
  try {
    await confirmCanvas(origin);
  } catch (e) {
    await dropAccess(origin);
    throw new Error(`could not confirm Canvas at ${origin} (${(e as Error).message}). Sign in to Canvas there in another tab, then add it again`);
  }
  if (!isInstructureCanvas(origin)) {
    const id = scriptId(origin);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (!existing.length) await chrome.scripting.registerContentScripts([{ id, matches: [originPattern(origin)], js: ["content.js"], runAt: "document_idle" }]);
  }
  await update((s) => {
    if (s.ignoredOrigins) delete s.ignoredOrigins[origin];
    if (!s.canvasOrigins.includes(origin)) s.canvasOrigins.push(origin);
  });
  inBackground(syncOrigin(origin, true));
  return `Added ${origin}; the first sync has started.`;
}

/** The content script and host permission of a school's own Canvas address; *.instructure.com keeps the manifest's. */
async function dropAccess(origin: string): Promise<void> {
  if (isInstructureCanvas(origin)) return;
  try {
    const id = scriptId(origin);
    if ((await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    // not registered
  }
  try {
    await chrome.permissions.remove({ origins: [originPattern(origin)] });
  } catch {
    // a required permission, or already gone
  }
}

/** Never synced or registered again on its own; the options page can add it back. */
async function ignoreOrigin(origin: string, reason: string, ctx?: SyncCtx): Promise<void> {
  if (ctx && ctx.gen !== generation) return;
  inflight.delete(origin);
  await update((s) => {
    s.canvasOrigins = s.canvasOrigins.filter((o) => o !== origin);
    if (s.lastSync) delete s.lastSync[origin];
    s.ignoredOrigins = { ...s.ignoredOrigins, [origin]: reason };
  });
  await dropAccess(origin);
  await refreshBadge();
}

/** At worker start: scripts for a school's own address, in case the browser did not keep them (Firefox may not). */
async function ensureContentScripts(): Promise<void> {
  const s = await loadSettings();
  const have = new Set((await chrome.scripting.getRegisteredContentScripts()).map((x) => x.id));
  for (const origin of s.canvasOrigins) {
    if (isInstructureCanvas(origin) || have.has(scriptId(origin))) continue;
    if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] }))) continue;
    await chrome.scripting.registerContentScripts([{ id: scriptId(origin), matches: [originPattern(origin)], js: ["content.js"], runAt: "document_idle" }]);
  }
}

// ---- pairing and forgetting ------------------------------------------------

async function pair(rawUrl: string, code: string, name: string | undefined): Promise<string> {
  const origin = serverOrigin(rawUrl);
  if (!origin) throw new Error("the server address must start with https:// (http only for localhost)");
  if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] }))) throw new Error("permission to reach the planner server was not granted");
  let res: Response;
  try {
    res = await fetch(`${origin}/api/pair`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim().toUpperCase(), name: name ?? "Browser" }) });
  } catch {
    throw new Error("could not reach the planner server");
  }
  const body = (await res.json().catch(() => ({}))) as { deviceToken?: unknown; error?: unknown };
  if (!res.ok || typeof body.deviceToken !== "string") throw new Error(typeof body.error === "string" ? body.error.slice(0, 200) : `server ${res.status}`);
  const before = await loadSettings();
  generation++; // syncs for the previous pairing stop here
  inflight.clear();
  const token = body.deviceToken;
  await update((s) => {
    s.serverUrl = origin;
    s.deviceToken = token;
    // Results and refusals belonged to the previous pairing; the student's own removals stay.
    delete s.lastSync;
    const kept = Object.entries(s.ignoredOrigins ?? {}).filter(([, why]) => why === REMOVED_BY_STUDENT);
    s.ignoredOrigins = Object.fromEntries(kept);
  });
  const old = before.serverUrl ? serverOrigin(before.serverUrl) : undefined;
  if (old && originPattern(old) !== originPattern(origin)) {
    try {
      await chrome.permissions.remove({ origins: [originPattern(old)] });
    } catch {
      // already gone
    }
  }
  await refreshBadge();
  inBackground(syncAll(false));
  return "Paired. Open Canvas in a tab and the first sync starts.";
}

/**
 * "Forget everything": pairing, origins, results, locks, registered scripts and
 * the optional host permissions. The server has no endpoint to revoke a device
 * token from the extension, so the device stays listed on the planner's
 * settings page until the student removes it there.
 */
async function forget(): Promise<void> {
  generation++;
  inflight.clear();
  await wipe();
  await chrome.storage.session.clear();
  const ids = (await chrome.scripting.getRegisteredContentScripts()).map((x) => x.id).filter((id) => id.startsWith("planner-"));
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  const required = new Set((chrome.runtime.getManifest() as chrome.runtime.ManifestV3).host_permissions ?? []);
  const optional = ((await chrome.permissions.getAll()).origins ?? []).filter((o) => !required.has(o));
  if (optional.length) {
    try {
      await chrome.permissions.remove({ origins: optional });
    } catch {
      // nothing left to remove
    }
  }
  await refreshBadge();
}

// ---- messages ----------------------------------------------------------------

async function status(scope?: string): Promise<Status> {
  const s = await loadSettings();
  const only = <T>(m: Record<string, T> | undefined): Record<string, T> => (scope ? (m && scope in m ? { [scope]: m[scope]! } : {}) : { ...m });
  const out: Status = {
    paired: paired(s),
    assistant: s.assistant ?? "claude",
    canvasOrigins: scope ? s.canvasOrigins.filter((o) => o === scope) : s.canvasOrigins,
    ignoredOrigins: only(s.ignoredOrigins),
    lastSync: only(s.lastSync),
  };
  if (!scope && s.serverUrl) out.serverUrl = s.serverUrl;
  return out;
}

/** The extension's own pages (options), as opposed to a content script running inside a Canvas tab. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const own = chrome.runtime.getURL("");
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(own);
}

/** The origin of the Canvas tab a content script runs in: the tab's, not what the message claims. */
function senderOrigin(sender: chrome.runtime.MessageSender): string | undefined {
  try {
    return sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  } catch {
    return undefined;
  }
}

export async function handleMessage(msg: Message, sender: chrome.runtime.MessageSender): Promise<Reply> {
  const page = fromExtensionPage(sender);
  const from = page ? undefined : senderOrigin(sender);
  switch (msg?.type) {
    case "canvas-page": {
      if (page || !sender.tab || !from || from !== msg.origin || !from.startsWith("https://")) return { ok: false, error: "not a Canvas page" };
      await onCanvasPage(from);
      return { ok: true, status: await status(from) };
    }
    case "sync-now": {
      // Only origins the student registered: the session cookie is sent to whatever is synced.
      const origin = page ? msg.origin : from;
      if (origin) {
        if (!(await loadSettings()).canvasOrigins.includes(origin)) return { ok: false, error: "this Canvas address is not set up for syncing", status: await status(page ? undefined : origin) };
        await syncOrigin(origin, true);
      } else if (page) await syncAll(true);
      return { ok: true, status: await status(page ? undefined : origin) };
    }
    case "get-status":
      return { ok: true, status: await status(page ? undefined : from) };
    case "open-assistant":
      await chrome.tabs.create({ url: assistantUrl(await loadSettings()) });
      return { ok: true, status: await status(page ? undefined : from) };
    case "pair":
    case "add-origin":
    case "remove-origin":
    case "forget": {
      if (!page) return { ok: false, error: "only the extension's options page can do that" };
      let message: string;
      if (msg.type === "pair") message = await pair(String(msg.serverUrl ?? ""), String(msg.code ?? ""), msg.name);
      else if (msg.type === "add-origin") message = await addOrigin(String(msg.origin ?? ""));
      else if (msg.type === "remove-origin") {
        const origin = String(msg.origin ?? "");
        if (!URL.canParse(origin) || new URL(origin).origin !== origin) return { ok: false, error: "that is not a Canvas address" };
        await ignoreOrigin(origin, REMOVED_BY_STUDENT);
        message = "Removed. It will not sync again unless you add it back.";
      } else {
        await forget();
        message = "Forgotten on this browser.";
      }
      return { ok: true, message, status: await status() };
    }
    default:
      return { ok: false, error: "unknown message" };
  }
}

// ---- start -------------------------------------------------------------------

/** The alarm, unless it exists. Run at every worker start: Firefox does not keep alarms across restarts. */
async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(SYNC_ALARM))) await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
}

async function onActionClicked(): Promise<void> {
  const s = await loadSettings();
  // Nothing to sync yet: the options page says what to do next.
  if (!paired(s) || !s.canvasOrigins.length) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  await syncAll(true);
}

/**
 * Registers every listener synchronously, as an MV3 worker must, then checks
 * the alarm, scripts and badge; the promise settles when those checks have.
 */
export function start(): Promise<void> {
  chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
  chrome.runtime.onStartup.addListener(() => void ensureAlarm());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) inBackground(syncAll(false));
  });
  chrome.action.onClicked.addListener(() => inBackground(onActionClicked()));
  chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
    handleMessage(msg, sender).then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: (e as Error).message } satisfies Reply));
    return true;
  });
  return Promise.allSettled([ensureAlarm(), ensureContentScripts(), refreshBadge()]).then(() => undefined);
}
