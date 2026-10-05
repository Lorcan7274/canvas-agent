/**
 * Just enough of `chrome` for the service worker: storage (local and session),
 * alarms, action, runtime, permissions, scripting and tabs, with the state
 * exposed for assertions. Storage calls yield a turn like the real IPC does,
 * so interleaved read-modify-writes race here as they would in a browser.
 *
 * Plus `canvasNet`: a fetch that plays the browser in front of the stub
 * Canvas. Requests to the test's https Canvas origins go to the stub, with the
 * session cookie attached only when the request asks for credentials and the
 * student is "signed in" there; everything else (the planner server) goes out
 * unchanged.
 */
import { readFileSync } from "node:fs";

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as chrome.runtime.ManifestV3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any;

class FakeEvent {
  listeners: Fn[] = [];
  addListener(fn: Fn): void {
    this.listeners.push(fn);
  }
  removeListener(fn: Fn): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  hasListener(fn: Fn): boolean {
    return this.listeners.includes(fn);
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function storageArea(name: "local" | "session", map: Map<string, unknown>, writes: Array<[string, Record<string, unknown>]>) {
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      await tick();
      const list = keys == null ? [...map.keys()] : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out: Record<string, unknown> = {};
      for (const k of list) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      await tick();
      for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
      writes.push([name, structuredClone(items)]);
    },
    async remove(keys: string | string[]) {
      await tick();
      for (const k of [keys].flat()) map.delete(k);
    },
    async clear() {
      await tick();
      map.clear();
    },
  };
}

/** Does a granted match pattern cover the wanted one (scheme, host with `*.`, path `/*`)? */
function covers(grant: string, want: string): boolean {
  const g = /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(grant);
  const w = /^(https?):\/\/([^/]+)\/(.*)$/.exec(want);
  if (!g || !w) return false;
  if (g[1] !== "*" && g[1] !== w[1]) return false;
  const gh = g[2]!;
  const wh = w[2]!;
  const host = gh === "*" || gh === wh || (gh.startsWith("*.") && (wh === gh.slice(2) || wh.endsWith(gh.slice(1))));
  return host && (g[3] === "*" || g[3] === w[3]);
}

export interface FakeChrome {
  chrome: typeof chrome;
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  /** Every storage.set, in order: [area, items]. */
  writes: Array<[string, Record<string, unknown>]>;
  alarms: Map<string, chrome.alarms.Alarm>;
  alarmCreates: number;
  scripts: Map<string, chrome.scripting.RegisteredContentScript>;
  granted: Set<string>;
  badge: { text: string; title: string };
  opened: { options: number; tabs: string[] };
  /** Deliver a runtime message to the worker's listener, as the browser would, and wait for its answer. */
  message<T = unknown>(msg: unknown, sender: chrome.runtime.MessageSender): Promise<T>;
  fireAlarm(name: string): void;
  clickAction(): void;
  /** The worker died: its listeners go with it; storage, alarms, scripts and permissions stay. */
  kill(): void;
}

export function fakeChrome(): FakeChrome {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const writes: Array<[string, Record<string, unknown>]> = [];
  const alarms = new Map<string, chrome.alarms.Alarm>();
  const scripts = new Map<string, chrome.scripting.RegisteredContentScript>();
  const granted = new Set<string>();
  const required = manifest.host_permissions ?? [];
  const badge = { text: "", title: String(manifest.action?.default_title ?? "") };
  const opened = { options: 0, tabs: [] as string[] };
  const events = {
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    onMessage: new FakeEvent(),
    onAlarm: new FakeEvent(),
    onClicked: new FakeEvent(),
    onChanged: new FakeEvent(),
  };

  const fake = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getManifest: () => manifest,
      async openOptionsPage() {
        opened.options++;
      },
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage,
    },
    storage: { local: storageArea("local", local, writes), session: storageArea("session", session, writes), onChanged: events.onChanged },
    alarms: {
      async create(name: string, info: chrome.alarms.AlarmCreateInfo) {
        fakeState.alarmCreates++;
        const alarm: chrome.alarms.Alarm = { name, scheduledTime: Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000 };
        if (info.periodInMinutes !== undefined) alarm.periodInMinutes = info.periodInMinutes;
        alarms.set(name, alarm);
      },
      async get(name: string) {
        return alarms.get(name);
      },
      async getAll() {
        return [...alarms.values()];
      },
      async clear(name: string) {
        return alarms.delete(name);
      },
      onAlarm: events.onAlarm,
    },
    action: {
      async setBadgeText({ text }: { text: string }) {
        badge.text = text;
      },
      async setTitle({ title }: { title: string }) {
        badge.title = title;
      },
      async setBadgeBackgroundColor() {},
      onClicked: events.onClicked,
    },
    permissions: {
      async contains({ origins = [] }: chrome.permissions.Permissions) {
        return origins.every((o) => [...required, ...granted].some((g) => covers(g, o)));
      },
      async request({ origins = [] }: chrome.permissions.Permissions) {
        for (const o of origins) granted.add(o);
        return true;
      },
      async remove({ origins = [] }: chrome.permissions.Permissions) {
        if (origins.some((o) => required.includes(o))) throw new Error("You cannot remove required permissions.");
        for (const o of origins) granted.delete(o);
        return true;
      },
      async getAll() {
        return { permissions: [...(manifest.permissions ?? [])], origins: [...required, ...granted] };
      },
    },
    scripting: {
      async registerContentScripts(list: chrome.scripting.RegisteredContentScript[]) {
        for (const s of list) {
          if (scripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
          scripts.set(s.id, structuredClone(s));
        }
      },
      async getRegisteredContentScripts(filter?: { ids?: string[] }) {
        const all = [...scripts.values()].map((s) => structuredClone(s));
        return filter?.ids ? all.filter((s) => filter.ids!.includes(s.id)) : all;
      },
      async unregisterContentScripts(filter?: { ids?: string[] }) {
        for (const id of filter?.ids ?? [...scripts.keys()]) {
          if (!scripts.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
          scripts.delete(id);
        }
      },
    },
    tabs: {
      async create({ url }: { url: string }) {
        opened.tabs.push(url);
        return { id: 99, url };
      },
    },
  };

  const fakeState: FakeChrome = {
    chrome: fake as unknown as typeof chrome,
    local,
    session,
    writes,
    alarms,
    alarmCreates: 0,
    scripts,
    granted,
    badge,
    opened,
    message<T>(msg: unknown, sender: chrome.runtime.MessageSender): Promise<T> {
      const listener = events.onMessage.listeners[0];
      if (!listener) return Promise.reject(new Error("no worker is listening"));
      return new Promise<T>((resolve) => {
        const keepOpen = listener(msg, sender, resolve);
        if (keepOpen !== true) resolve(undefined as T);
      });
    },
    fireAlarm(name: string) {
      for (const l of events.onAlarm.listeners) l({ name, scheduledTime: Date.now() });
    },
    clickAction() {
      for (const l of events.onClicked.listeners) l({ id: 1 });
    },
    kill() {
      for (const e of Object.values(events)) e.listeners = [];
    },
  };
  return fakeState;
}

/** The options page, opened in a tab. */
export function pageSender(): chrome.runtime.MessageSender {
  return { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/options.html`, origin: `chrome-extension://${EXTENSION_ID}`, tab: { id: 2 } as chrome.tabs.Tab };
}

/** The content script in a Canvas tab. */
export function tabSender(origin: string, path = "/"): chrome.runtime.MessageSender {
  return { id: EXTENSION_ID, url: origin + path, origin, tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 };
}

export interface SeenRequest {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  canvas: boolean;
  authorization: boolean;
  /** JSON bodies sent to the planner server, parsed. */
  json?: Record<string, unknown>;
}

export interface CanvasNet {
  fetch: typeof fetch;
  /** https Canvas origins where the student has a live session cookie. */
  signedIn: Set<string>;
  requests: SeenRequest[];
  maxDetailsInFlight: number;
  /** Answer a request instead of the stub or the server (a sign-in page, a throttle, an outage). */
  intercept?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
  /** Hold a Canvas request until the promise resolves. */
  gate?: (url: URL) => Promise<void> | undefined;
}

export function canvasNet(stubOrigin: string, canvasOrigins: string[]): CanvasNet {
  const realFetch = globalThis.fetch;
  let inFlight = 0;
  const net: CanvasNet = {
    signedIn: new Set(),
    requests: [],
    maxDetailsInFlight: 0,
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const canvas = canvasOrigins.includes(url.origin);
      const headers = new Headers(init?.headers);
      const seen: SeenRequest = { url: url.href, method: init?.method ?? "GET", credentials: init?.credentials, canvas, authorization: headers.has("authorization") };
      if (typeof init?.body === "string") seen.json = JSON.parse(init.body) as Record<string, unknown>;
      net.requests.push(seen);
      const answer = await net.intercept?.(url, init);
      if (answer) return answer;
      if (!canvas) return realFetch(input, init);
      await net.gate?.(url);
      const detail = /\/(assignments|quizzes)\/\d+$/.test(url.pathname);
      if (detail) net.maxDetailsInFlight = Math.max(net.maxDetailsInFlight, ++inFlight);
      try {
        // The browser attaches the Canvas session cookie only to requests made with credentials.
        if (init?.credentials === "include" && net.signedIn.has(url.origin)) headers.set("cookie", "canvas_session=ok");
        const res = await realFetch(stubOrigin + url.pathname + url.search, { method: init?.method ?? "GET", headers });
        const swap = (text: string) => text.split(stubOrigin).join(url.origin);
        const body = swap(await res.text());
        const out = new Headers();
        res.headers.forEach((v, k) => {
          if (k !== "content-length" && k !== "content-encoding") out.set(k, k === "link" ? swap(v) : v);
        });
        // Hold detail answers a moment so concurrent requests overlap and can be counted.
        if (detail) await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(body, { status: res.status, headers: out });
      } finally {
        if (detail) inFlight--;
      }
    },
  };
  return net;
}

/** A browser-made response that says where it ended up after redirects. */
export function redirectedTo(url: string, body: string, contentType: string, status = 200): Response {
  const res = new Response(body, { status, headers: { "content-type": contentType } });
  Object.defineProperty(res, "redirected", { value: true });
  Object.defineProperty(res, "url", { value: url });
  return res;
}
