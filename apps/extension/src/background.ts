/**
 * Service worker: reads Canvas with the student's own session (GET only) and
 * posts a snapshot to the planner server. Runs when a Canvas page opens, on
 * the action button, and every 30 minutes while the session lives.
 *
 * Only the fields the planner reads leave the browser (`projectCanvasSnapshot`):
 * no submission bodies, comments, attachments, LTI parameters or preview links.
 */
import { projectCanvasSnapshot } from "../../../packages/core/src/canvas/project.js";
import { assistantUrl, loadSettings, saveSettings, serverOrigin, type ExtensionSettings, type Message } from "./shared.js";

const SYNC_ALARM = "planner-sync";
const MIN_INTERVAL_MS = 10 * 60_000;
const DETAIL_BUDGET = 40;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 30 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void syncAll(false);
});
chrome.action.onClicked.addListener(() => void syncAll(true));
chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  (async () => {
    if (msg.type === "canvas-page") {
      // Trust the tab the message came from, not what it claims.
      const from = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
      if (!from || from !== msg.origin || !from.startsWith("https://")) throw new Error("not a Canvas page");
      await registerOrigin(msg.origin);
      await syncOrigin(msg.origin, false);
      sendResponse(await status());
    } else if (msg.type === "sync-now") {
      // Only origins the student registered: the session cookie is sent to whatever is synced.
      if (msg.origin) {
        if ((await loadSettings()).canvasOrigins.includes(msg.origin)) await syncOrigin(msg.origin, true);
      } else await syncAll(true);
      sendResponse(await status());
    } else if (msg.type === "get-status") {
      sendResponse(await status());
    } else if (msg.type === "open-assistant") {
      await chrome.tabs.create({ url: assistantUrl(await loadSettings()) });
      sendResponse({ ok: true });
    }
  })().catch((e) => sendResponse({ error: (e as Error).message }));
  return true;
});

async function status(): Promise<{ paired: boolean; lastSync: ExtensionSettings["lastSync"]; assistant: string }> {
  const s = await loadSettings();
  return { paired: !!(s.serverUrl && s.deviceToken), lastSync: s.lastSync, assistant: s.assistant ?? "claude" };
}

async function registerOrigin(origin: string): Promise<void> {
  const s = await loadSettings();
  if (!s.canvasOrigins.includes(origin)) await saveSettings({ canvasOrigins: [...s.canvasOrigins, origin] });
}

async function syncAll(force: boolean): Promise<void> {
  const s = await loadSettings();
  for (const origin of s.canvasOrigins) await syncOrigin(origin, force);
}

async function canvasGet<T>(origin: string, path: string): Promise<T> {
  const res = await fetch(origin + path, { credentials: "include", headers: { accept: "application/json" } });
  if (res.status === 401) throw new Error("not signed in to Canvas");
  if (res.status === 429) throw new Error("Canvas rate limit; will retry later");
  if (!res.ok) throw new Error(`Canvas ${res.status} for ${path}`);
  const text = await res.text();
  return JSON.parse(text.startsWith("while(1);") ? text.slice(9) : text) as T;
}

async function canvasGetAll<T>(origin: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = origin + path + (path.includes("?") ? "&" : "?") + "per_page=100";
  for (let page = 0; url && page < 20; page++) {
    const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    if (res.status === 401) throw new Error("not signed in to Canvas");
    if (!res.ok) throw new Error(`Canvas ${res.status} for ${path}`);
    const text = await res.text();
    const body = JSON.parse(text.startsWith("while(1);") ? text.slice(9) : text) as T[];
    out.push(...body);
    const link = res.headers.get("link") ?? "";
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    // Follow pages on this Canvas only; the session cookie stays where it belongs.
    const next = m?.[1] ? new URL(m[1], origin) : undefined;
    url = next && next.origin === origin ? next.toString() : undefined;
  }
  return out;
}

/** Canvas ids from the server's wanted list: digits (or Canvas's shard~id form), nothing that could change the path. */
const CANVAS_ID = /^\d+(~\d+)?$/;

async function server<T>(s: ExtensionSettings, method: string, path: string, body?: unknown): Promise<T> {
  const origin = serverOrigin(s.serverUrl ?? "");
  if (!origin) throw new Error("the planner server address must be https; pair again from the options page");
  const init: RequestInit = { method, headers: { authorization: `Bearer ${s.deviceToken}`, "content-type": "application/json" }, credentials: "omit" };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${origin}${path}`, init);
  if (res.status === 401) throw new Error("the planner server rejected this device; pair again from the options page");
  if (!res.ok) throw new Error(`planner server ${res.status}`);
  return (await res.json()) as T;
}

async function syncOrigin(origin: string, force: boolean): Promise<void> {
  const s = await loadSettings();
  if (!s.serverUrl || !s.deviceToken) return;
  const last = s.lastSync?.[origin];
  if (!force && last?.ok && Date.now() - new Date(last.at).getTime() < MIN_INTERVAL_MS) return;
  const record = async (ok: boolean, message: string) => {
    await saveSettings({ lastSync: { ...(await loadSettings()).lastSync, [origin]: { at: new Date().toISOString(), ok, message } } });
    await chrome.action.setBadgeText({ text: ok ? "" : "!" });
    if (!ok) await chrome.action.setTitle({ title: `Planner for Canvas: ${message}` });
  };
  try {
    await canvasGet(origin, "/api/v1/users/self");
    const today = new Date();
    const start = new Date(today.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(today.getTime() + 120 * 86_400_000).toISOString().slice(0, 10);
    const courses = await canvasGetAll(origin, "/api/v1/courses?enrollment_state=active&include[]=term");
    const plannerItems = await canvasGetAll(origin, `/api/v1/planner/items?start_date=${start}&end_date=${end}`);
    let missingSubmissions: unknown[] = [];
    try {
      missingSubmissions = await canvasGetAll(origin, "/api/v1/users/self/missing_submissions?filter[]=submittable&include[]=course");
    } catch {
      // some instances restrict this endpoint; the planner view is enough
    }
    const fetchedAt = new Date().toISOString();
    await server(s, "POST", "/api/ingest", projectCanvasSnapshot({ baseUrl: origin, fetchedAt, courses, plannerItems, missingSubmissions }));

    // Second pass: details the server has not got yet.
    const { wanted } = await server<{ wanted: Array<{ courseId: string; assignmentId: string; quizId: string | null }> }>(s, "GET", "/api/ingest/wanted");
    const assignments: Record<string, unknown> = {};
    const quizzes: Record<string, unknown> = {};
    for (const w of wanted.slice(0, DETAIL_BUDGET)) {
      if (!CANVAS_ID.test(String(w.courseId)) || !CANVAS_ID.test(String(w.assignmentId)) || (w.quizId !== null && !CANVAS_ID.test(String(w.quizId)))) continue;
      try {
        assignments[w.assignmentId] = await canvasGet(origin, `/api/v1/courses/${w.courseId}/assignments/${w.assignmentId}?include[]=submission`);
        if (w.quizId) quizzes[w.quizId] = await canvasGet(origin, `/api/v1/courses/${w.courseId}/quizzes/${w.quizId}`);
      } catch {
        // skip one; the next sync will try again
      }
    }
    if (Object.keys(assignments).length) {
      await server(s, "POST", "/api/ingest", projectCanvasSnapshot({ baseUrl: origin, fetchedAt, courses: [], plannerItems: [], assignments, quizzes }));
    }
    const me = await server<{ assistant: ExtensionSettings["assistant"]; assistantUrl: string | null }>(s, "GET", "/api/me");
    await saveSettings({ assistant: me.assistant ?? "claude", assistantUrl: me.assistantUrl });
    await record(true, `synced ${plannerItems.length} items, ${Object.keys(assignments).length} details`);
  } catch (e) {
    await record(false, (e as Error).message);
  }
}
