/**
 * The one page a student needs: connect Canvas, get a connector key or a
 * pairing code, connect Google, set preferences, see what is due.
 */
import { Router, type Request, type Response } from "express";
import { formatLocal, hashToken, pairingCode, type Preferences, type WorkWindow } from "@canvas-agent/core";
import type { Services } from "../services.js";
import { csrfFor, putFlash, requireCsrf, requireLogin, takeFlash, type Flash } from "../auth/login.js";
import { clientLabel, FAMILY_TTL_S } from "../auth/oauth-provider.js";
import { esc, page } from "../ui.js";

/** Connector key lifetimes offered on the settings page, in days; 0 = until revoked. */
const KEY_EXPIRY_DAYS = [30, 90, 365, 0];

/** Only web links become links; anything else (javascript:, data:) is shown as text. */
function isWebUrl(u: string | undefined): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

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
    // Messages come from the server-side flash, never the URL: secrets stay out of history, logs and Referer, and nobody can put words on this page with a link.
    const msg = takeFlash(services, req.sid!);
    const flash = msg.flash ? `<div class="flash">${esc(msg.flash)}</div>` : "";
    const secret = msg.secret ? `<div class="flash"><b>Copy this now; it is shown once.</b><pre>${esc(msg.secret)}</pre>${esc(msg.secretHelp ?? "")}</div>` : "";
    const error = msg.error ? `<div class="flash warn">${esc(msg.error)}</div>` : "";

    const accounts = services.store.listCanvasAccounts(userId);
    const google = services.store.getGoogleAccount(userId);
    const keys = services.store.listConnectorKeys(userId);
    const keyExpiries = services.store.listConnectorKeyExpiries(userId);
    const grants = services.store.listOAuthGrants(userId);
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
        (i) => `<tr><td>${esc(i.dueLocal ?? "")}</td><td>${isWebUrl(i.url) ? `<a href="${esc(i.url)}" rel="noreferrer">${esc(i.title)}</a>` : esc(i.title)}<br><span class="muted">${esc(i.course?.code ?? "")} · ${esc(i.status)}${i.late ? " · late" : ""}</span></td><td>~${i.estimate.p50Hours}h <span class="muted">(p80 ${i.estimate.p80Hours}h, ${esc(i.estimate.basis)})</span></td><td>${i.plannedMinutes ? `${Math.round((i.plannedMinutes / 60) * 4) / 4}h` : ""}</td></tr>`,
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
<form method="post" action="/settings/key">${csrf(req)}<div class="row"><div><label>Label</label><input name="label" placeholder="Claude on my laptop"></div><div><label>Expires</label><select name="expires_days">${KEY_EXPIRY_DAYS.map((d) => `<option value="${d}"${d === 90 ? " selected" : ""}>${d ? `in ${d} days` : "never (until revoked)"}</option>`).join("")}</select></div><div><button class="primary" type="submit">Create connector key</button></div></div></form>
${keys.length ? `<table><tr><th>Key</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr>${keys.map((k) => { const exp = keyExpiries.get(k.id); return `<tr><td>${esc(k.label ?? "")}</td><td>${esc(formatLocal(k.createdAt, tz))}</td><td>${k.lastUsedAt ? esc(formatLocal(k.lastUsedAt, tz)) : "never"}</td><td>${exp ? `${Date.parse(exp) > Date.now() ? "" : `<span class="warn">expired</span> `}${esc(formatLocal(exp, tz))}` : "never"}</td><td><form class="inline" method="post" action="/settings/key/delete">${csrf(req)}<input type="hidden" name="id" value="${esc(k.id)}"><button class="danger" type="submit">Revoke</button></form></td></tr>`; }).join("")}</table>` : ""}
<h3>Connected assistants</h3>
${
  grants.length
    ? `<table><tr><th>Assistant</th><th>Connected</th><th>Last refreshed</th><th></th></tr>${grants
        .map((g) => {
          const connected = g.familyExpiresAt ? new Date(Date.parse(g.familyExpiresAt) - FAMILY_TTL_S * 1000).toISOString() : g.createdAt;
          return `<tr><td>${esc(clientLabel(services.store, g.clientId))}</td><td>${esc(formatLocal(connected, tz))}</td><td>${esc(formatLocal(g.lastUsedAt, tz))}</td><td><form class="inline" method="post" action="/settings/grant/delete">${csrf(req)}<input type="hidden" name="family" value="${esc(g.family)}"><button class="danger" type="submit">Disconnect</button></form></td></tr>`;
        })
        .join("")}</table>`
    : `<p class="muted">No assistant has signed in over OAuth.</p>`
}
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
<p>Any calendar app can subscribe to your planned blocks. Treat the link like a password; regenerate it if it was shared.</p><pre>${esc(services.planFeedUrl(userId))}</pre>
<form method="post" action="/settings/feed/rotate">${csrf(req)}<button type="submit">Regenerate feed link</button></form>
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

<h2>Delete my data</h2>
<div class="card"><p class="muted">Removes your account and everything stored for it: Canvas connections, items, estimates, logged times, planned blocks, keys, devices and assistant connections. Events already on your Google Calendar stay there.</p>
<form method="post" action="/settings/account/delete">${csrf(req)}<label><input type="checkbox" name="confirm" value="yes" required style="width:auto;margin-right:.5rem">I understand this cannot be undone</label><button class="danger" type="submit">Delete everything</button></form></div>
`;
    res.type("html").send(page("Canvas planner", body));
  });

  /** Post/redirect/get with the message kept server-side for this session. */
  const back = (req: Request, res: Response, msg: Flash) => {
    putFlash(services, req.sid!, msg);
    res.redirect("/");
  };

  r.post("/settings/canvas/feed", requireLogin, requireCsrf(services), async (req, res) => {
    const body = req.body as Record<string, string>;
    try {
      const account = services.addFeedAccount(req.loginUserId!, body["feed_url"] ?? "");
      // The first read runs in the background so a slow or stalled feed cannot hang this page.
      services.syncInBackground(account);
      back(req, res, { flash: "Feed added. The first sync is running; reload in a moment to see what it found." });
    } catch (e) {
      back(req, res, { error: (e as Error).message });
    }
  });

  r.post("/settings/canvas/token", requireLogin, requireCsrf(services), async (req, res) => {
    const body = req.body as Record<string, string>;
    try {
      const account = services.addTokenAccount(req.loginUserId!, body["base_url"] ?? "", body["token"] ?? "");
      services.syncInBackground(account);
      back(req, res, { flash: "Token added. The first sync is running; reload in a moment to see your courses." });
    } catch (e) {
      back(req, res, { error: (e as Error).message });
    }
  });

  r.post("/settings/canvas/sync", requireLogin, requireCsrf(services), async (req, res) => {
    const id = String((req.body as Record<string, string>)["id"] ?? "");
    const account = services.store.getCanvasAccount(id);
    if (!account || account.userId !== req.loginUserId) {
      back(req, res, { error: "unknown account" });
      return;
    }
    const report = await services.syncAccount(account);
    back(req, res, { flash: report.errors.length ? `Sync problems: ${report.errors.join("; ")}` : `Synced: ${report.items} item(s), ${report.detailsFetched} detail(s).` });
  });

  r.post("/settings/canvas/delete", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteCanvasAccount(req.loginUserId!, String((req.body as Record<string, string>)["id"] ?? ""));
    back(req, res, { flash: "Removed." });
  });

  r.post("/settings/key", requireLogin, requireCsrf(services), (req, res) => {
    const body = req.body as Record<string, string>;
    const label = String(body["label"] ?? "").slice(0, 80) || "assistant";
    const days = Number(body["expires_days"] ?? 90);
    if (!KEY_EXPIRY_DAYS.includes(days)) {
      back(req, res, { error: "pick an expiry from the list" });
      return;
    }
    const key = services.createConnectorKey(req.loginUserId!, label);
    const row = services.store.getConnectorKeyByHash(hashToken(key));
    if (row && days) services.store.setConnectorKeyExpiry(req.loginUserId!, row.id, new Date(Date.now() + days * 86_400_000).toISOString());
    back(req, res, { secret: key, secretHelp: `Connector URL: ${cfg.baseUrl}/mcp — send the key as "Authorization: Bearer ${key.slice(0, 6)}…"${days ? `; it stops working in ${days} days` : ""}` });
  });

  r.post("/settings/key/delete", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteConnectorKey(req.loginUserId!, String((req.body as Record<string, string>)["id"] ?? ""));
    back(req, res, { flash: "Key revoked." });
  });

  r.post("/settings/grant/delete", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteOAuthFamilyForUser(req.loginUserId!, String((req.body as Record<string, string>)["family"] ?? ""));
    back(req, res, { flash: "Assistant disconnected; it will have to ask again." });
  });

  r.post("/settings/pair", requireLogin, requireCsrf(services), (req, res) => {
    const code = pairingCode();
    services.store.createPairingCode(req.loginUserId!, code);
    back(req, res, { secret: code, secretHelp: `Enter this code in the extension within 15 minutes, with server ${cfg.baseUrl}` });
  });

  r.post("/settings/device/delete", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteDevice(req.loginUserId!, String((req.body as Record<string, string>)["id"] ?? ""));
    back(req, res, { flash: "Device removed." });
  });

  r.post("/settings/google/disconnect", requireLogin, requireCsrf(services), (req, res) => {
    services.store.deleteGoogleAccount(req.loginUserId!);
    back(req, res, { flash: "Google Calendar disconnected. Existing events stay on your calendar." });
  });

  r.post("/settings/feed/rotate", requireLogin, requireCsrf(services), (req, res) => {
    services.rotateFeedToken(req.loginUserId!);
    back(req, res, { flash: "Feed link regenerated. Re-subscribe in your calendar app; the old link no longer works." });
  });

  r.post("/settings/account/delete", requireLogin, requireCsrf(services), (req, res) => {
    if ((req.body as Record<string, string>)["confirm"] !== "yes") {
      back(req, res, { error: "tick the confirmation box to delete your data" });
      return;
    }
    // Removes the login session too, so the cookie that got us here stops working.
    services.deleteUserData(req.loginUserId!);
    res.redirect("/login");
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
      if (url) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") throw new Error("the custom assistant URL must start with https://");
        patch.assistantUrl = parsed.toString();
      }
      for (const k of ["maxHoursPerDay", "minBlockMinutes", "maxBlockMinutes", "bufferHoursBeforeDue"] as const) {
        if (!Number.isFinite(patch[k])) throw new Error(`${k} must be a number`);
      }
      services.setPreferences(req.loginUserId!, patch);
      back(req, res, { flash: "Preferences saved." });
    } catch (e) {
      back(req, res, { error: (e as Error).message });
    }
  });

  r.post("/settings/log", requireLogin, requireCsrf(services), async (req, res) => {
    const b = req.body as Record<string, string>;
    try {
      const r2 = await services.logTime(req.loginUserId!, b["item_id"] ?? "", { bucket: b["bucket"] ?? "" });
      back(req, res, { flash: `Logged ${r2.minutes} minutes.` });
    } catch (e) {
      back(req, res, { error: (e as Error).message });
    }
  });

  return r;
}
