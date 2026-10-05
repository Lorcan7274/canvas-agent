/**
 * Storage shape, messages and pure helpers shared by the service worker, the
 * content script and the options page. Nothing here touches `chrome` at import
 * time, so the server's tests can import it too.
 */

/** Why a sync failed, which decides when an automatic sync tries again. */
export type FailureKind = "signed-out" | "rate" | "unpaired" | "refused" | "error";

export interface OriginSync {
  at: string;
  ok: boolean;
  message: string;
  /** Consecutive failures; a success resets it. */
  failures?: number;
  /** No automatic sync (page load, alarm) before this ISO time; the Sync button ignores it. */
  retryAt?: string;
}

export interface ExtensionSettings {
  serverUrl?: string;
  deviceToken?: string;
  /** Origins confirmed as Canvas (page plus a JSON /api/v1/users/self), e.g. https://canvas.school.edu */
  canvasOrigins: string[];
  /** Origins never registered again on their own, with the reason: removed by the student, or refused by the server. */
  ignoredOrigins?: Record<string, string>;
  lastSync?: Record<string, OriginSync>;
  assistant?: "claude" | "chatgpt" | "custom";
  assistantUrl?: string | null;
}

/** The reason recorded when the student removes an origin in the options page. */
export const REMOVED_BY_STUDENT = "removed by you";

/** Read-only view; only the service worker writes settings (one writer, so no lost updates). */
export async function loadSettings(): Promise<ExtensionSettings> {
  const got = (await chrome.storage.local.get(["settings"])) as { settings?: Partial<ExtensionSettings> };
  return { canvasOrigins: [], ...(got.settings ?? {}) };
}

export const PLAN_PROMPT = "Plan my week. Get my workload from the Canvas planner, ask me about any check-ins first, then propose study blocks around my calendar and show them by day. Wait for my OK before committing.";

/** Only https URLs are ever opened; a custom URL that is anything else falls back to Claude. */
export function assistantUrl(settings: Pick<ExtensionSettings, "assistant" | "assistantUrl"> & Partial<ExtensionSettings>, prompt = PLAN_PROMPT): string {
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

const INSTRUCTURE = ".instructure.com";
/** Instructure's own sites on the Canvas domain, which are not a school's Canvas. */
const INSTRUCTURE_SITES = new Set(["www", "community", "status"]);

/**
 * Why an origin must not be registered as Canvas, or undefined when it may be.
 * Mirrors what the server accepts (https only) and keeps out the hosts the
 * manifest's `exclude_matches` lists: Instructure's own sites, and beta/test
 * copies (`school.beta.instructure.com`), which carry production's assignment
 * ids and would overwrite its rows on the server.
 */
export function canvasOriginRefusal(origin: string): string | undefined {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return "that is not a web address";
  }
  if (u.protocol !== "https:") return "Canvas must be https";
  if (u.username || u.password) return "a Canvas address has no user name or password in it";
  const host = u.hostname.toLowerCase();
  if (host === INSTRUCTURE.slice(1)) return "that is Instructure's site, not a school's Canvas";
  if (host.endsWith(INSTRUCTURE)) {
    const sub = host.slice(0, -INSTRUCTURE.length);
    if (sub.includes(".")) return "that is a Canvas beta or test copy (or another Instructure service); only your school's live Canvas is synced";
    if (INSTRUCTURE_SITES.has(sub)) return "that is Instructure's site, not a school's Canvas";
  }
  return undefined;
}

/** Canvas on *.instructure.com: covered by the manifest's own host permission and content script. */
export function isInstructureCanvas(origin: string): boolean {
  return !canvasOriginRefusal(origin) && new URL(origin).hostname.toLowerCase().endsWith(INSTRUCTURE);
}

/** The id of the content script registered for a school's own Canvas address. */
export function scriptId(origin: string): string {
  return "planner-" + origin.replace(/[^a-z0-9]/gi, "-");
}

export type Message =
  | { type: "canvas-page"; origin: string }
  | { type: "sync-now"; origin?: string }
  | { type: "get-status" }
  | { type: "open-assistant" }
  // From the extension's own pages only:
  | { type: "pair"; serverUrl: string; code: string; name?: string }
  | { type: "add-origin"; origin: string }
  | { type: "remove-origin"; origin: string }
  | { type: "forget" };

export interface Status {
  paired: boolean;
  /** Extension pages only. */
  serverUrl?: string;
  assistant: string;
  canvasOrigins: string[];
  ignoredOrigins: Record<string, string>;
  lastSync: Record<string, OriginSync>;
}

export type Reply = { ok: true; message?: string; status: Status } | { ok: false; error: string; status?: Status };
