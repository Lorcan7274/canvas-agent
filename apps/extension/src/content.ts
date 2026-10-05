/**
 * On a Canvas page: tell the worker this origin looks like Canvas (it confirms
 * with a JSON /api/v1/users/self before registering a new one), and put a
 * "Plan my week" button on the dashboard that opens the assistant.
 */
import { canvasOriginRefusal, type Message, type Reply } from "./shared.js";

const ID = "planner-for-canvas";
let observer: MutationObserver | undefined;
let orphaned = false;

/** Canvas's own markup on an address that may be registered; Instructure's other sites and beta/test copies never are. */
function isCanvasPage(): boolean {
  return canvasOriginRefusal(location.origin) === undefined && !!document.querySelector("#application.ic-app");
}

/**
 * A message to the worker; undefined when it cannot answer. After the
 * extension is updated or reloaded this script is orphaned: `chrome.runtime`
 * throws "Extension context invalidated", so the button says to reload.
 */
function send(msg: Message): Promise<Reply | undefined> {
  return new Promise((resolve) => {
    if (orphaned || !chrome.runtime?.id) {
      resolve(orphan());
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, (reply?: Reply) => {
        // Reading lastError marks it handled (no "Unchecked runtime.lastError" in the console).
        if (chrome.runtime.lastError) resolve(undefined);
        else resolve(reply);
      });
    } catch {
      resolve(orphan());
    }
  });
}

function orphan(): undefined {
  orphaned = true;
  observer?.disconnect();
  const wrap = document.getElementById(ID);
  wrap?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const line = wrap?.querySelector("[data-status]");
  if (line) line.textContent = "Planner for Canvas was updated: reload this page";
  return undefined;
}

function statusLine(reply: Reply | undefined): string {
  if (!reply) return "";
  if (!reply.ok) return reply.error;
  const s = reply.status;
  if (!s.paired) return "not paired: open the extension's options";
  const ignored = s.ignoredOrigins[location.origin];
  if (ignored) return `not syncing: ${ignored}`;
  return s.lastSync[location.origin]?.message ?? "";
}

function build(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.id = ID;
  wrap.style.cssText = "display:flex;gap:8px;align-items:center;margin:8px 0;font:14px system-ui,sans-serif";
  const plan = document.createElement("button");
  plan.type = "button";
  plan.textContent = "Plan my week";
  plan.style.cssText = "padding:6px 12px;border-radius:6px;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;cursor:pointer";
  plan.addEventListener("click", () => void send({ type: "open-assistant" }));
  const sync = document.createElement("button");
  sync.type = "button";
  sync.textContent = "Sync";
  sync.style.cssText = "padding:6px 10px;border-radius:6px;border:1px solid #999;background:#fff;color:#333;cursor:pointer";
  const line = document.createElement("span");
  line.dataset["status"] = "";
  line.style.cssText = "color:#666";
  sync.addEventListener("click", () => {
    line.textContent = "syncing…";
    void send({ type: "sync-now" }).then((r) => {
      if (!orphaned) line.textContent = statusLine(r);
    });
  });
  wrap.append(plan, sync, line);
  return wrap;
}

/**
 * Beside the dashboard header, not inside it: Canvas renders that node with
 * React, which may replace its children at any time.
 */
function mount(): void {
  if (orphaned || document.getElementById(ID)) return;
  const header = document.querySelector("#dashboard_header_container");
  const content = document.querySelector("#content");
  const wrap = build();
  if (header) header.insertAdjacentElement("afterend", wrap);
  else if (content) content.insertAdjacentElement("afterbegin", wrap);
  else return;
  void send({ type: "get-status" }).then((r) => {
    const line = wrap.querySelector("[data-status]");
    if (line && !orphaned) line.textContent = statusLine(r);
  });
}

/** Canvas renders the dashboard late and re-renders parts of it; put the button back whenever it goes. */
function watch(): void {
  let queued = false;
  observer = new MutationObserver(() => {
    if (queued || orphaned || document.getElementById(ID)) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      mount();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (isCanvasPage()) {
  void send({ type: "canvas-page", origin: location.origin });
  if (location.pathname === "/" || location.pathname.startsWith("/dashboard")) {
    mount();
    watch();
  }
}
