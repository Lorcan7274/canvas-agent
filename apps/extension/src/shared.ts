/** Storage shape and helpers shared by the service worker, content script and options page. */

export interface ExtensionSettings {
  serverUrl?: string;
  deviceToken?: string;
  /** Canvas origins the user granted, e.g. https://canvas.school.edu */
  canvasOrigins: string[];
  lastSync?: Record<string, { at: string; ok: boolean; message: string }>;
  assistant?: "claude" | "chatgpt" | "custom";
  assistantUrl?: string | null;
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const got = (await chrome.storage.local.get(["settings"])) as { settings?: Partial<ExtensionSettings> };
  return { canvasOrigins: [], ...(got.settings ?? {}) };
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export const PLAN_PROMPT = "Plan my week. Get my workload from the Canvas planner, ask me about any check-ins first, then propose study blocks around my calendar and show them by day. Wait for my OK before committing.";

/** Only https URLs are ever opened; a custom URL that is anything else falls back to Claude. */
export function assistantUrl(settings: ExtensionSettings, prompt = PLAN_PROMPT): string {
  const q = encodeURIComponent(prompt);
  if (settings.assistant === "chatgpt") return `https://chatgpt.com/?q=${q}`;
  if (settings.assistant === "custom" && settings.assistantUrl) {
    const url = settings.assistantUrl.includes("{q}") ? settings.assistantUrl.replace("{q}", q) : settings.assistantUrl;
    try {
      if (new URL(url).protocol === "https:") return url;
    } catch {
      // fall through
    }
  }
  return `https://claude.ai/new?q=${q}`;
}

/**
 * The planner server's origin, if it is one the device token may be sent to:
 * https anywhere, plain http only on this computer.
 */
export function serverOrigin(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return undefined;
    if (u.protocol === "https:") return u.origin;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.origin;
  } catch {
    // not a URL
  }
  return undefined;
}

/** The host permission pattern for an origin; ports are not part of match patterns. */
export function originPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

export type Message =
  | { type: "canvas-page"; origin: string }
  | { type: "sync-now"; origin?: string }
  | { type: "get-status" }
  | { type: "open-assistant" };
