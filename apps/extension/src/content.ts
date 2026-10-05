/**
 * On a Canvas page: tell the worker this origin is Canvas (so it syncs), and
 * put a "Plan my week" button on the dashboard that opens the assistant.
 */
import type { Message } from "./shared.js";

function isCanvas(): boolean {
  return !!document.querySelector('meta[name="csrf-token"]') || !!document.getElementById("application") || /\/courses|\/dashboard|\/calendar/.test(location.pathname) || location.host.endsWith(".instructure.com");
}

function send<T>(msg: Message): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r: T) => resolve(r)));
}

function mountButton(): void {
  if (document.getElementById("planner-for-canvas")) return;
  const host = document.querySelector("#dashboard_header_container, .ic-Dashboard-header__actions, #right-side, #content") as HTMLElement | null;
  if (!host) return;
  const wrap = document.createElement("div");
  wrap.id = "planner-for-canvas";
  wrap.style.cssText = "display:flex;gap:8px;align-items:center;margin:8px 0;font:14px system-ui,sans-serif";
  const btn = document.createElement("button");
  btn.textContent = "Plan my week";
  btn.style.cssText = "padding:6px 12px;border-radius:6px;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;cursor:pointer";
  btn.addEventListener("click", () => void send({ type: "open-assistant" }));
  const sync = document.createElement("button");
  sync.textContent = "Sync";
  sync.style.cssText = "padding:6px 10px;border-radius:6px;border:1px solid #999;background:#fff;color:#333;cursor:pointer";
  const status = document.createElement("span");
  status.style.cssText = "color:#666";
  sync.addEventListener("click", () => {
    status.textContent = "syncing…";
    void send<{ lastSync?: Record<string, { ok: boolean; message: string }> }>({ type: "sync-now", origin: location.origin }).then((s) => {
      status.textContent = s?.lastSync?.[location.origin]?.message ?? "";
    });
  });
  wrap.append(btn, sync, status);
  host.prepend(wrap);
  void send<{ paired: boolean; lastSync?: Record<string, { ok: boolean; message: string }> }>({ type: "get-status" }).then((s) => {
    if (!s) return;
    status.textContent = s.paired ? s.lastSync?.[location.origin]?.message ?? "" : "not paired: open the extension options";
  });
}

if (isCanvas()) {
  void send({ type: "canvas-page", origin: location.origin });
  if (location.pathname === "/" || location.pathname.startsWith("/dashboard")) {
    mountButton();
    // Canvas renders the dashboard header late; try again once it settles.
    setTimeout(mountButton, 1500);
    setTimeout(mountButton, 4000);
  }
}
