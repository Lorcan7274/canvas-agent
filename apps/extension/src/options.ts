/** Options page: pair with the server, grant Canvas hosts, see sync status. */
import { loadSettings, originPattern, saveSettings, serverOrigin } from "./shared.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function render(): Promise<void> {
  const s = await loadSettings();
  $<HTMLInputElement>("server").value = s.serverUrl ?? "";
  $<HTMLElement>("paired").textContent = s.deviceToken ? "Paired" : "Not paired";
  const list = $<HTMLUListElement>("origins");
  list.innerHTML = "";
  for (const o of s.canvasOrigins) {
    const li = document.createElement("li");
    const last = s.lastSync?.[o];
    li.textContent = `${o} — ${last ? `${last.ok ? "ok" : "problem"}: ${last.message} (${new Date(last.at).toLocaleString()})` : "never synced"}`;
    list.append(li);
  }
}

$<HTMLFormElement>("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $<HTMLInputElement>("server").value.trim();
  const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
  const out = $<HTMLElement>("pair-result");
  try {
    const serverUrl = serverOrigin(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!serverUrl) throw new Error("the server address must start with https:// (http only for localhost)");
    // Without a host permission for the server, the worker's requests are blocked as cross-origin.
    const granted = await chrome.permissions.request({ origins: [originPattern(serverUrl)] });
    if (!granted) throw new Error("permission to reach the planner server was not granted");
    const res = await fetch(`${serverUrl}/api/pair`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: navigator.userAgent.includes("Firefox") ? "Firefox" : "Chrome" }) });
    const body = (await res.json()) as { deviceToken?: string; error?: string };
    if (!res.ok || !body.deviceToken) throw new Error(body.error ?? `server ${res.status}`);
    await saveSettings({ serverUrl, deviceToken: body.deviceToken });
    out.textContent = "Paired. Open Canvas and the first sync starts.";
    $<HTMLInputElement>("code").value = "";
  } catch (err) {
    out.textContent = `Pairing failed: ${(err as Error).message}`;
  }
  await render();
});

$<HTMLFormElement>("origin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $<HTMLInputElement>("origin").value.trim();
  const out = $<HTMLElement>("origin-result");
  try {
    const origin = new URL(raw.startsWith("http") ? raw : `https://${raw}`).origin;
    if (!origin.startsWith("https://")) throw new Error("Canvas must be https");
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error("permission not granted");
    const id = "planner-" + origin.replace(/[^a-z0-9]/gi, "-");
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (!existing.length) await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ["content.js"], runAt: "document_idle" }]);
    const s = await loadSettings();
    if (!s.canvasOrigins.includes(origin)) await saveSettings({ canvasOrigins: [...s.canvasOrigins, origin] });
    out.textContent = `Added ${origin}. Open it in a tab to sync.`;
    $<HTMLInputElement>("origin").value = "";
  } catch (err) {
    out.textContent = `Could not add: ${(err as Error).message}`;
  }
  await render();
});

$<HTMLButtonElement>("sync").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "sync-now" }, () => void render());
});

$<HTMLButtonElement>("unpair").addEventListener("click", async () => {
  await chrome.storage.local.clear();
  await render();
});

void render();
