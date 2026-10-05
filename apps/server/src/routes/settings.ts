/**
 * The one page a student needs: connect Canvas, get a connector key or a
 * pairing code, connect Google, set preferences, see what is due.
 */
import { Router, type Request, type Response } from "express";
import { formatLocal, pairingCode, type Preferences, type WorkWindow } from "@canvas-agent/core";
import type { Services } from "../services.js";
import { csrfFor, requireCsrf, requireLogin } from "../auth/login.js";
import { esc, page } from "../ui.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function windowsToText(w: WorkWindow[]): string {
  return w.map((x) => `${DAYS[x.weekday]} ${x.start}-${x.end}`).join("\n");
}

export function parseWindows(text: string): WorkWindow[] {
  const out: WorkWindow[] = [];
  for (const raw of text.split(/[\n;,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/i);
    if (!m) throw new Error(`cannot read work window "${line}" (use e.g. "Mon 17:00-22:00")`);
    const weekday = DAYS.findIndex((d) => d.toLowerCase() === m[1]!.toLowerCase());
    out.push({ weekday, start: m[2]!, end: m[3]! });
  }
  return out;
}

export function settingsRoutes(services: Services): Router {
  const r = Router();
  const cfg = services.config;

  const csrf = (req: Request) => `<input type="hidden" name="csrf" value="${csrfFor(req.sid!, cfg.secretKey)}">`;

  r.get("/", async (req, res) => {
    if (!req.loginUserId) {
      res.type("html").send(
        page(
          "Canvas planner",
          `<h1>Canvas planner</h1><p>Your assignments, time estimates and study blocks, for whichever AI assistant you use.</p><p><a href="/login"><button class="primary">Sign in</button></a></p>`,
          { nav: false },
        ),
      );
      return;
    }
    const userId = req.loginUserId;
    const user = services.userOrThrow(userId);
    const flash = typeof req.query["flash"] === "string" ? `<div class="flash">${esc(req.query["flash"])}</div>` : "";
    const secret = typeof req.query["secret"] === "string" ? `<div class="flash"><b>Copy this now; it is shown once.</b><pre>${esc(req.query["secret"])}</pre>${esc(String(req.query["secretHelp"] ?? ""))}</div>` : "";
    const error = typeof req.query["error"] === "string" ? `<div class="flash warn">${esc(req.query["error"])}</div>` : "";

    const accounts = services.store.listCanvasAccounts(userId);
    const google = services.store.getGoogleAccount(userId);
    const keys = services.store.listConnectorKeys(userId);
    const devices = services.store.listDevices(userId);
    const workload = await services.workload(userId, {});
    const checkIns = services.pendingCheckIns(userId);
    const tz = user.prefs.timezone;

    const accountRows = accounts.length
      ? accounts
          .map(
            (a) => `<tr><td>${esc(a.kind)}</td><td>${esc(new URL(a.baseUrl).host)}</td><td>${a.lastSyncAt ? esc(formatLocal(a.lastSyncAt, tz)) : "never"}${a.lastError ? `<br><span class="warn">${esc(a.lastError)}</span>` : ""}</td>
            <td><form class="inline" method="post" action="/settings/canvas/sync">${csrf(req)}<input type="hidden" name="id" value="${a.id}"><button type="submit">Sync</button></form>
            <form class="inline" method="post" action="/settings/canvas/delete">${csrf(req)}<input type="hidden" name="id" value="${a.id}"><button class="danger" type="submit">Remove</button></form></td></tr>`,
          )
          .join("")
      : `<tr><td colspan="4" class="muted">Nothing connected yet.</td></tr>`;

    const workRows = workload.items
      .slice(0, 25)
      .map(
        (i) => `<tr><td>${esc(i.dueLocal ?? "")}</td><td>${i.url ? `<a href="${esc(i.url)}">${esc(i.title)}</a>` : esc(i.title)}<br><span class="muted">${esc(i.course?.code ?? "")} · ${esc(i.status)}${i.late ? " · late" : ""}</span></td><td>~${i.estimate.p50Hours}h <span class="muted">(p80 ${i.estimate.p80Hours}h, ${esc(i.estimate.basis)})</span></td><td>${i.plannedMinutes ? `${Math.round((i.plannedMinutes / 60) * 4) / 4}h` : ""}</td></tr>`,
      )
      .join("");

    const checkInRows = checkIns
      .map(
        (c) => `<tr><td>${esc(c.title)}</td><td>${c.estimateP50 ? `est. ${c.estimateP50}h` : ""}</td><td><form class="inline" method="post" action="/settings/log">${csrf(req)}<input type="hidden" name="item_id" value="${esc(c.itemId)}">
          ${["<1h", "1-2h", "2-4h", "4-8h", "8h+"].map((b) => `<button name="bucket" value="${b}" type="submit">${b}</button>`).join(" ")}</form></td></tr>`,
      )
      .join("");

    const body = `
<h1>Canvas planner</h1><p class="muted">Signed in as ${esc(user.email ?? user.name ?? user.id)}</p>
${flash}${secret}${error}

<h2>1. Canvas</h2>
<div class="card">
<table><tr><th>Kind</th><th>Instance</th><th>Last sync</th><th></th></tr>${accountRows}</table>
<details><summary>Add the calendar feed (works at every school)</summary>
<p class="muted">In Canvas: Calendar → Calendar Feed → copy the link ending in <code>.ics</code>. Titles and due dates only, refreshed every ${cfg.syncIntervalMinutes} minutes.</p>
<form method="post" action="/settings/canvas/feed">${csrf(req)}<label>Feed URL</label><input name="feed_url" placeholder="https://canvas.school.edu/feeds/calendars/user_….ics" required><button class="primary" type="submit">Add feed</button></form></details>
<details><summary>Add a personal access token (if your school allows it)</summary>
<p class="muted">Canvas: Account → Settings → New Access Token. Full details, synced every ${cfg.syncIntervalMinutes} minutes. Student tokens expire within 120 days; add a new one when it does.</p>
<form method="post" action="/settings/canvas/token">${csrf(req)}<div class="row"><div><label>Canvas URL</label><input name="base_url" placeholder="canvas.school.edu" required></div><div><label>Token</label><input name="token" type="password" required></div></div><button class="primary" type="submit">Add token</button></form></details>
<details><summary>Pair the browser extension (full details, no token needed)</summary>
<p class="muted">Install the extension, open its options, paste this server's address and a pairing code. It reads Canvas with your own login whenever you have Canvas open.</p>
<form method="post" action="/settings/pair">${csrf(req)}<button class="primary" type="submit">Generate pairing code</button></form>
${devices.length ? `<table><tr><th>Device</th><th>Paired</th><th>Last seen</th><th></th></tr>${devices.map((d) => `<tr><td>${esc(d.name ?? d.id.slice(0, 8))}</td><td>${esc(formatLocal(d.createdAt, tz))}</td><td>${d.lastSeenAt ? esc(formatLocal(d.lastSeenAt, tz)) : ""}</td><td><form class="inline" method="post" action="/settings/device/delete">${csrf(req)}<input type="hidden" name="id" value="${d.id}"><button class="danger" type="submit">Remove</button></form></td></tr>`).join("")}</table>` : ""}
</details>
</div>

<h2>2. Your assistant</h2>
<div class="card">
<p>Add <code>${esc(cfg.baseUrl)}/mcp</code> as a connector. Claude and ChatGPT can sign in through this page (OAuth). For a connector that takes a fixed header instead, create a key and send it as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
<form method="post" action="/settings/key">${csrf(req)}<div class="row"><div><label>Label</label><input name="label" placeholder="Claude on my laptop"></div><div><button class="primary" type="submit">Create connector key</button></div></div></form>
${keys.length ? `<table><tr><th>Key</th><th>Created</th><th>Last used</th><th></th></tr>${keys.map((k) => `<tr><td>${esc(k.label ?? "")}</td><td>${esc(formatLocal(k.createdAt, tz))}</td><td>${k.lastUsedAt ? esc(formatLocal(k.lastUsedAt, tz)) : "never"}</td><td><form class="inline" method="post" action="/settings/key/delete">${csrf(req)}<input type="hidden" name="id" value="${k.id}"><button class="danger" type="submit">Revoke</button></form></td></tr>`).join("")}</table>` : ""}
</div>

<h2>3. Calendar</h2>
<div class="card">
${
  services.google
    ? google
      ? `<p class="ok">Google Calendar connected${google.email ? ` (${esc(google.email)})` : ""}. Study blocks are written to your primary calendar.</p><form method="post" action="/settings/google/disconnect">${csrf(req)}<button class="danger" type="submit">Disconnect</button></form>`
      : `<p>Connect Google Calendar so blocks land on your calendar and the planner sees your busy time.</p><p><a href="/oauth/google/start?purpose=calendar&next=/"><button class="primary">Connect Google Calendar</button></a></p>`
    : `<p class="muted">Google Calendar is not configured on this server.</p>`
}
<p>Any calendar app can subscribe to your planned blocks:</p><pre>${esc(services.planFeedUrl(userId))}</pre>
</div>

<h2>4. Preferences</h2>
<div class="card"><form method="post" action="/settings/prefs">${csrf(req)}
<div class="row"><div><label>Time zone</label><input name="timezone" value="${esc(user.prefs.timezone)}"></div><div><label>Max hours per day</label><input name="max_hours_per_day" type="number" step="0.5" min="0.5" max="16" value="${user.prefs.maxHoursPerDay}"></div></div>
<div class="row"><div><label>Min block (min)</label><input name="min_block_minutes" type="number" min="15" max="240" value="${user.prefs.minBlockMinutes}"></div><div><label>Max block (min)</label><input name="max_block_minutes" type="number" min="30" max="480" value="${user.prefs.maxBlockMinutes}"></div><div><label>Finish hours before due</label><input name="buffer_hours_before_due" type="number" min="0" max="168" value="${user.prefs.bufferHoursBeforeDue}"></div></div>
<label>Work windows, one per line (e.g. Mon 17:00-22:00)</label><textarea name="work_windows" rows="7">${esc(windowsToText(user.prefs.workWindows))}</textarea>
<div class="row"><div><label>"Plan my week" button opens</label><select name="assistant"><option value="claude"${user.prefs.assistant === "claude" ? " selected" : ""}>Claude</option><option value="chatgpt"${user.prefs.assistant === "chatgpt" ? " selected" : ""}>ChatGPT</option><option value="custom"${user.prefs.assistant === "custom" ? " selected" : ""}>Custom URL</option></select></div><div><label>Custom URL (optional)</label><input name="assistant_url" value="${esc(user.prefs.assistantUrl ?? "")}"></div></div>
<button class="primary" type="submit">Save</button></form></div>

${checkIns.length ? `<h2>How long did these take?</h2><div class="card"><table>${checkInRows}</table></div>` : ""}

<h2>Due soon</h2>
<div class="card">${workload.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
<table><tr><th>Due</th><th>Item</th><th>Estimate</th><th>Planned</th></tr>${workRows || `<tr><td colspan="4" class="muted">Nothing in the next two weeks.</td></tr>`}</table></div>
`;
    res.type("html").send(page("Canvas planner", body));
  });

  const back = (res: Response, q: Record<string, string>) => {
    const u = new URL("/", "http://x");
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    res.redirect(u.pathname + u.search);
  };

  r.post("/settings/canvas/feed", requireLogin, requireCsrf(services), async (req, res) => {
    const body = req.body as Record<string, string>;
    try {
      const account = services.addFeedAccount(req.loginUserId!, body["feed_url"] ?? "");
      const report = await services.syncAccount(account);
      back(res, { flash: report.errors.length ? `Feed added; first sync failed: ${report.errors.join("; ")}` : `Feed added: ${report.items} item(s) found.` });
    } catch (e) {
      back(res, { error: (e as Error).message });
    }
  });

  r.post("/settings/canvas/token", requireLogin, requireCsrf(services), async (req, res) => {
    const body = req.body as Record<string, string>;
    try {
      const account = services.addTokenAccount(req.loginUserId!, body["base_url"] ?? "", body["token"] ?? "");
      const report = await services.syncAccount(account);
      back(res, { flash: report.errors.length ? `Token added; sync reported: ${report.errors.join("; ")}` : `Token added: ${report.courses} course(s), ${report.items} item(s).` });
    } catch (e) {
      back(res, { error: (e as Error).message });
    }
  });

  r.post("/settings/canvas/sync", requireLogin, requireCsrf(services), async (req, res) => {
    const id = String((req.body as Record<string, string>)["id"] ?? "");
    const account = services.store.getCanvasAccount(id);
    if (!account || account.userId !== req.loginUserId) {
      back(res, { error: "unknown account" });
      return;
    }
    const report = await services.syncAccount(account);
    back(res, { flash: report.errors.length ? `Sync problems: ${report.errors.join("; ")}` : `Synced: ${report.items} item(s), ${report.detailsFetched} detail(s).` });
  });

  r.post("/settings/canvas/delete", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteCanvasAccount(req.loginUserId!, String((req.body as Record<string, string>)["id"] ?? ""));
    back(res, { flash: "Removed." });
  });

  r.post("/settings/key", requireLogin, requireCsrf(services), (req, res) => {
    const label = String((req.body as Record<string, string>)["label"] ?? "").slice(0, 80) || "assistant";
    const key = services.createConnectorKey(req.loginUserId!, label);
    back(res, { secret: key, secretHelp: `Connector URL: ${cfg.baseUrl}/mcp — send the key as "Authorization: Bearer ${key.slice(0, 6)}…"` });
  });

  r.post("/settings/key/delete", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteConnectorKey(req.loginUserId!, String((req.body as Record<string, string>)["id"] ?? ""));
    back(res, { flash: "Key revoked." });
  });

  r.post("/settings/pair", requireLogin, requireCsrf(services), (req, res) => {
    const code = pairingCode();
    services.store.createPairingCode(req.loginUserId!, code);
    back(res, { secret: code, secretHelp: `Enter this code in the extension within 15 minutes, with server ${cfg.baseUrl}` });
  });

  r.post("/settings/device/delete", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteDevice(req.loginUserId!, String((req.body as Record<string, string>)["id"] ?? ""));
    back(res, { flash: "Device removed." });
  });

  r.post("/settings/google/disconnect", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteGoogleAccount(req.loginUserId!);
    back(res, { flash: "Google Calendar disconnected. Existing events stay on your calendar." });
  });

  r.post("/settings/prefs", requireLogin, requireCsrf(services), (req, res) => {
    const b = req.body as Record<string, string>;
    try {
      const patch: Partial<Preferences> = {
        timezone: (b["timezone"] ?? "UTC").trim(),
        maxHoursPerDay: Number(b["max_hours_per_day"]),
        minBlockMinutes: Number(b["min_block_minutes"]),
        maxBlockMinutes: Number(b["max_block_minutes"]),
        bufferHoursBeforeDue: Number(b["buffer_hours_before_due"]),
        workWindows: parseWindows(b["work_windows"] ?? ""),
        assistant: (["claude", "chatgpt", "custom"] as const).find((a) => a === b["assistant"]) ?? "claude",
      };
      const url = (b["assistant_url"] ?? "").trim();
      if (url) patch.assistantUrl = new URL(url).toString();
      for (const k of ["maxHoursPerDay", "minBlockMinutes", "maxBlockMinutes", "bufferHoursBeforeDue"] as const) {
        if (!Number.isFinite(patch[k])) throw new Error(`${k} must be a number`);
      }
      services.setPreferences(req.loginUserId!, patch);
      back(res, { flash: "Preferences saved." });
    } catch (e) {
      back(res, { error: (e as Error).message });
    }
  });

  r.post("/settings/log", requireLogin, requireCsrf(services), async (req, res) => {
    const b = req.body as Record<string, string>;
    try {
      const r2 = await services.logTime(req.loginUserId!, b["item_id"] ?? "", { bucket: b["bucket"] ?? "" });
      back(res, { flash: `Logged ${r2.minutes} minutes.` });
    } catch (e) {
      back(res, { error: (e as Error).message });
    }
  });

  return r;
}
