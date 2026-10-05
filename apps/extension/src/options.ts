/**
 * Options page: pair with the server, add or remove Canvas addresses, see sync
 * status. It reads storage but never writes it; the worker does, by message.
 * Permission prompts are requested here, first thing in the click handler,
 * because only a page with a user gesture may ask.
 */
import { canvasOriginRefusal, loadSettings, originPattern, serverOrigin, type Message, type Reply } from "./shared.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function send(msg: Message): Promise<Reply> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply?: Reply) => {
      const err = chrome.runtime.lastError;
      resolve(err || !reply ? { ok: false, error: err?.message ?? "the extension did not answer; try again" } : reply);
    });
  });
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "quiet small";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function render(): Promise<void> {
  const s = await loadSettings();
  if (document.activeElement !== $("server")) $<HTMLInputElement>("server").value = s.serverUrl ?? "";
  $<HTMLElement>("paired").textContent = s.deviceToken ? `Paired with ${s.serverUrl}` : "Not paired";
  const list = $<HTMLUListElement>("origins");
  list.replaceChildren();
  if (!s.canvasOrigins.length) {
    const li = document.createElement("li");
    li.textContent = "No Canvas yet. Open your school's Canvas in a tab while signed in.";
    list.append(li);
  }
  for (const o of s.canvasOrigins) {
    const li = document.createElement("li");
    const last = s.lastSync?.[o];
    li.textContent = `${o} — ${last ? `${last.ok ? "ok" : "problem"}: ${last.message} (${new Date(last.at).toLocaleString()})` : "never synced"}`;
    li.append(button("Remove", () => void remove(o)));
    list.append(li);
  }
  const ignored = Object.entries(s.ignoredOrigins ?? {});
  $<HTMLElement>("ignored-head").hidden = !ignored.length;
  const off = $<HTMLUListElement>("ignored");
  off.replaceChildren();
  for (const [o, why] of ignored) {
    const li = document.createElement("li");
    li.textContent = `${o} — ${why}`;
    li.append(button("Add back", () => void add(o, $<HTMLElement>("status-result"))));
    off.append(li);
  }
}

async function add(raw: string, out: HTMLElement): Promise<void> {
  let origin: string;
  try {
    origin = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    out.textContent = "Could not add: that is not a web address";
    return;
  }
  const refusal = canvasOriginRefusal(origin);
  if (refusal) {
    out.textContent = `Could not add: ${refusal}`;
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
  } catch (err) {
    out.textContent = `Could not add: ${(err as Error).message}`;
    return;
  }
  if (!granted) {
    out.textContent = "Could not add: permission not granted";
    return;
  }
  out.textContent = `Checking ${origin}…`;
  const reply = await send({ type: "add-origin", origin });
  out.textContent = reply.ok ? (reply.message ?? "Added.") : `Could not add: ${reply.error}`;
  await render();
}

async function remove(origin: string): Promise<void> {
  const reply = await send({ type: "remove-origin", origin });
  $<HTMLElement>("status-result").textContent = reply.ok ? `${origin}: ${reply.message ?? "removed"}` : reply.error;
  await render();
}

$<HTMLFormElement>("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $<HTMLInputElement>("server").value.trim();
  const code = $<HTMLInputElement>("code").value.trim().toUpperCase();
  const out = $<HTMLElement>("pair-result");
  const serverUrl = serverOrigin(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!serverUrl) {
    out.textContent = "Pairing failed: the server address must start with https:// (http only for localhost)";
    return;
  }
  // Without a host permission for the server, the worker's requests are blocked as cross-origin.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(serverUrl)] });
  } catch (err) {
    out.textContent = `Pairing failed: ${(err as Error).message}`;
    return;
  }
  if (!granted) {
    out.textContent = "Pairing failed: permission to reach the planner server was not granted";
    return;
  }
  const reply = await send({ type: "pair", serverUrl, code, name: navigator.userAgent.includes("Firefox") ? "Firefox" : "Chrome" });
  out.textContent = reply.ok ? (reply.message ?? "Paired.") : `Pairing failed: ${reply.error}`;
  if (reply.ok) $<HTMLInputElement>("code").value = "";
  await render();
});

$<HTMLFormElement>("origin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("origin");
  void add(input.value.trim(), $<HTMLElement>("origin-result")).then(() => {
    if ($<HTMLElement>("origin-result").textContent?.startsWith("Added")) input.value = "";
  });
});

$<HTMLButtonElement>("sync").addEventListener("click", () => {
  const out = $<HTMLElement>("status-result");
  out.textContent = "Syncing…";
  void send({ type: "sync-now" }).then((reply) => {
    out.textContent = reply.ok ? "Done." : reply.error;
    return render();
  });
});

$<HTMLButtonElement>("unpair").addEventListener("click", () => {
  if (!confirm("Forget the pairing, your Canvas addresses and sync results on this browser?")) return;
  void send({ type: "forget" }).then((reply) => {
    $<HTMLElement>("status-result").textContent = reply.ok ? (reply.message ?? "Forgotten.") : reply.error;
    return render();
  });
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void render();
});

void render();
