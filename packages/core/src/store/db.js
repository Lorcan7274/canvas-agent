/**
 * SQLite storage on node:sqlite. Every row carries user_id; a Postgres port is
 * a driver swap, not a schema change. Secrets are sealed before they get here.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_PREFERENCES } from "../types.js";
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canvas_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('token','feed','session')),
  secret_sealed TEXT,
  label TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, base_url, kind)
);

CREATE TABLE IF NOT EXISTS courses (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS items (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  details_fetched_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS items_due ON items (user_id, due_at);

CREATE TABLE IF NOT EXISTS priors (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actuals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  host TEXT,
  course_id TEXT,
  minutes INTEGER NOT NULL,
  source TEXT NOT NULL,
  estimated_hours REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actuals_user ON actuals (user_id, created_at);
CREATE INDEX IF NOT EXISTS actuals_pool ON actuals (host, item_id);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  calendar_event_id TEXT,
  calendar_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_user ON blocks (user_id, start);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS google_accounts (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  refresh_token_sealed TEXT NOT NULL,
  access_token_sealed TEXT,
  access_expires_at TEXT,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  scopes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  family TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family);

CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_logins (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;
export function now() {
    return new Date().toISOString();
}
export function itemVersionHash(item, hash) {
    return hash(JSON.stringify([
        item.kind,
        item.title,
        item.descriptionText ?? "",
        item.pointsPossible ?? null,
        item.submissionTypes ?? null,
        item.rubricCriteria ?? null,
        item.quiz ?? null,
        item.peerReviews ?? null,
        item.isGroup ?? null,
    ]));
}
export class Store {
    db;
    constructor(path = ":memory:") {
        this.db = new DatabaseSync(path);
        this.db.exec(SCHEMA);
    }
    close() {
        this.db.close();
    }
    // ---- users ----------------------------------------------------------
    createUser(email, name, prefs = {}) {
        const id = randomUUID();
        const createdAt = now();
        const merged = { ...DEFAULT_PREFERENCES, ...prefs };
        this.db
            .prepare("INSERT INTO users (id, email, name, prefs_json, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(id, email, name, JSON.stringify(merged), createdAt);
        return { id, email, name, prefs: merged, createdAt };
    }
    getUser(id) {
        const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
        return r ? rowToUser(r) : undefined;
    }
    getUserByEmail(email) {
        const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
        return r ? rowToUser(r) : undefined;
    }
    listUsers() {
        return this.db.prepare("SELECT * FROM users").all().map(rowToUser);
    }
    updatePrefs(userId, patch) {
        const u = this.getUser(userId);
        if (!u)
            throw new Error("no such user");
        const prefs = { ...u.prefs, ...patch };
        this.db.prepare("UPDATE users SET prefs_json = ? WHERE id = ?").run(JSON.stringify(prefs), userId);
        return prefs;
    }
    // ---- canvas accounts ------------------------------------------------
    upsertCanvasAccount(a) {
        const existing = this.db
            .prepare("SELECT * FROM canvas_accounts WHERE user_id = ? AND base_url = ? AND kind = ?")
            .get(a.userId, a.baseUrl, a.kind);
        if (existing) {
            this.db
                .prepare("UPDATE canvas_accounts SET secret_sealed = COALESCE(?, secret_sealed), label = COALESCE(?, label), last_error = NULL WHERE id = ?")
                .run(a.secretSealed ?? null, a.label ?? null, existing["id"]);
            return this.getCanvasAccount(existing["id"]);
        }
        const id = randomUUID();
        this.db
            .prepare("INSERT INTO canvas_accounts (id, user_id, base_url, kind, secret_sealed, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(id, a.userId, a.baseUrl, a.kind, a.secretSealed ?? null, a.label ?? null, now());
        return this.getCanvasAccount(id);
    }
    getCanvasAccount(id) {
        const r = this.db.prepare("SELECT * FROM canvas_accounts WHERE id = ?").get(id);
        return r ? rowToAccount(r) : undefined;
    }
    listCanvasAccounts(userId) {
        return this.db.prepare("SELECT * FROM canvas_accounts WHERE user_id = ? ORDER BY created_at").all(userId).map(rowToAccount);
    }
    listAllCanvasAccounts() {
        return this.db.prepare("SELECT * FROM canvas_accounts ORDER BY created_at").all().map(rowToAccount);
    }
    deleteCanvasAccount(userId, id) {
        this.db.prepare("DELETE FROM canvas_accounts WHERE user_id = ? AND id = ?").run(userId, id);
    }
    markSync(id, error) {
        this.db.prepare("UPDATE canvas_accounts SET last_sync_at = ?, last_error = ? WHERE id = ?").run(now(), error, id);
    }
    // ---- courses --------------------------------------------------------
    upsertCourse(userId, c) {
        this.db
            .prepare("INSERT INTO courses (user_id, id, json) VALUES (?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json")
            .run(userId, c.id, JSON.stringify(c));
    }
    listCourses(userId) {
        return this.db.prepare("SELECT json FROM courses WHERE user_id = ?").all(userId).map((r) => JSON.parse(r["json"]));
    }
    courseMap(userId) {
        return new Map(this.listCourses(userId).map((c) => [c.id, c]));
    }
    // ---- items ----------------------------------------------------------
    getItem(userId, id) {
        const r = this.db.prepare("SELECT * FROM items WHERE user_id = ? AND id = ?").get(userId, id);
        return r ? rowToItem(r) : undefined;
    }
    upsertItem(userId, item, versionHash, opts = {}) {
        const ts = now();
        const existing = this.getItem(userId, item.id);
        const detailsAt = opts.detailsFetched ? ts : existing?.detailsFetchedAt ?? null;
        this.db
            .prepare(`INSERT INTO items (user_id, id, json, due_at, status, source, version_hash, details_fetched_at, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json, due_at = excluded.due_at, status = excluded.status,
           source = excluded.source, version_hash = excluded.version_hash, details_fetched_at = excluded.details_fetched_at,
           last_seen_at = excluded.last_seen_at`)
            .run(userId, item.id, JSON.stringify(item), item.dueAt ?? null, item.status, item.source, versionHash, detailsAt, existing?.firstSeenAt ?? ts, ts);
    }
    listItems(userId, opts = {}) {
        const rows = this.db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY due_at IS NULL, due_at").all(userId);
        return rows.map(rowToItem).filter((r) => {
            const due = r.item.dueAt;
            if (!due)
                return opts.includeUndated ?? true;
            if (opts.from && due < opts.from)
                return false;
            if (opts.to && due > opts.to)
                return false;
            return true;
        });
    }
    deleteItem(userId, id) {
        this.db.prepare("DELETE FROM items WHERE user_id = ? AND id = ?").run(userId, id);
    }
    // ---- priors (shared, per Canvas instance) ----------------------------
    getPrior(key) {
        const r = this.db.prepare("SELECT json FROM priors WHERE key = ?").get(key);
        return r ? JSON.parse(r["json"]) : undefined;
    }
    putPrior(key, estimate) {
        this.db
            .prepare("INSERT INTO priors (key, json, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json")
            .run(key, JSON.stringify(estimate), now());
    }
    // ---- actuals --------------------------------------------------------
    addActual(userId, a) {
        const id = randomUUID();
        const createdAt = now();
        this.db
            .prepare("INSERT INTO actuals (id, user_id, item_id, host, course_id, minutes, source, estimated_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, userId, a.itemId, a.host ?? null, a.courseId ?? null, a.minutes, a.source, a.estimatedHours ?? null, createdAt);
        return { id, itemId: a.itemId, minutes: a.minutes, source: a.source, createdAt };
    }
    listActuals(userId) {
        return this.db.prepare("SELECT * FROM actuals WHERE user_id = ? ORDER BY created_at").all(userId).map((r) => ({
            itemId: r["item_id"],
            courseId: r["course_id"] ?? null,
            minutes: r["minutes"],
            estimatedHours: r["estimated_hours"] ?? null,
            createdAt: r["created_at"],
        }));
    }
    latestActualFor(userId, itemId) {
        const r = this.db
            .prepare("SELECT * FROM actuals WHERE user_id = ? AND item_id = ? ORDER BY created_at DESC LIMIT 1")
            .get(userId, itemId);
        if (!r)
            return undefined;
        return {
            itemId: r["item_id"],
            courseId: r["course_id"] ?? null,
            minutes: r["minutes"],
            estimatedHours: r["estimated_hours"] ?? null,
            createdAt: r["created_at"],
        };
    }
    /** Median minutes other students logged for the same item, if at least `minN` did. */
    pooledActual(host, itemId, minN = 5) {
        const rows = this.db
            .prepare("SELECT user_id, MAX(minutes) AS minutes FROM actuals WHERE host = ? AND item_id = ? GROUP BY user_id")
            .all(host, itemId);
        if (rows.length < minN)
            return undefined;
        const sorted = rows.map((r) => r["minutes"]).sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        return { medianMinutes: median, n: sorted.length };
    }
    // ---- blocks ---------------------------------------------------------
    addBlock(userId, b) {
        const id = randomUUID();
        const ts = now();
        this.db
            .prepare("INSERT INTO blocks (id, user_id, item_id, start, end, minutes, status, calendar_event_id, calendar_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)")
            .run(id, userId, b.itemId, b.start, b.end, b.minutes, b.calendarEventId ?? null, b.calendarId ?? null, ts, ts);
        return this.getBlock(userId, id);
    }
    getBlock(userId, id) {
        const r = this.db.prepare("SELECT * FROM blocks WHERE user_id = ? AND id = ?").get(userId, id);
        return r ? rowToBlock(r) : undefined;
    }
    listBlocks(userId, opts = {}) {
        const rows = this.db.prepare("SELECT * FROM blocks WHERE user_id = ? ORDER BY start").all(userId);
        return rows.map(rowToBlock).filter((b) => {
            if (opts.itemId && b.itemId !== opts.itemId)
                return false;
            if (opts.from && b.end < opts.from)
                return false;
            if (opts.to && b.start > opts.to)
                return false;
            return true;
        });
    }
    updateBlock(userId, id, patch) {
        const b = this.getBlock(userId, id);
        if (!b)
            return;
        const merged = { ...b, ...patch, updatedAt: now() };
        this.db
            .prepare("UPDATE blocks SET start = ?, end = ?, minutes = ?, status = ?, calendar_event_id = ?, calendar_id = ?, updated_at = ? WHERE user_id = ? AND id = ?")
            .run(merged.start, merged.end, merged.minutes, merged.status, merged.calendarEventId ?? null, merged.calendarId ?? null, merged.updatedAt, userId, id);
    }
    deleteBlocksForItem(userId, itemId, statuses = ["planned"]) {
        const victims = this.listBlocks(userId, { itemId }).filter((b) => statuses.includes(b.status));
        for (const v of victims)
            this.db.prepare("DELETE FROM blocks WHERE user_id = ? AND id = ?").run(userId, v.id);
        return victims;
    }
    // ---- devices and pairing --------------------------------------------
    createPairingCode(userId, code, ttlMinutes = 15) {
        this.db.prepare("DELETE FROM pairing_codes WHERE user_id = ? OR expires_at < ?").run(userId, now());
        this.db
            .prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
            .run(code, userId, new Date(Date.now() + ttlMinutes * 60_000).toISOString());
    }
    redeemPairingCode(code) {
        const r = this.db.prepare("SELECT * FROM pairing_codes WHERE code = ? AND expires_at > ?").get(code.toUpperCase(), now());
        if (!r)
            return undefined;
        this.db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code.toUpperCase());
        return r["user_id"];
    }
    createDevice(userId, tokenHash, name) {
        const id = randomUUID();
        this.db.prepare("INSERT INTO devices (id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, tokenHash, name, now());
        return id;
    }
    userForDeviceToken(tokenHash) {
        const r = this.db.prepare("SELECT id, user_id FROM devices WHERE token_hash = ?").get(tokenHash);
        if (!r)
            return undefined;
        this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), r["id"]);
        return r["user_id"];
    }
    listDevices(userId) {
        return this.db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").all(userId).map((r) => ({
            id: r["id"],
            name: r["name"] ?? null,
            createdAt: r["created_at"],
            lastSeenAt: r["last_seen_at"] ?? null,
        }));
    }
    deleteDevice(userId, id) {
        this.db.prepare("DELETE FROM devices WHERE user_id = ? AND id = ?").run(userId, id);
    }
    // ---- connector keys -------------------------------------------------
    createConnectorKey(userId, tokenHash, label) {
        const id = randomUUID();
        this.db.prepare("INSERT INTO connector_keys (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, tokenHash, label, now());
        return id;
    }
    userForConnectorKey(tokenHash) {
        const r = this.db.prepare("SELECT id, user_id FROM connector_keys WHERE token_hash = ?").get(tokenHash);
        if (!r)
            return undefined;
        this.db.prepare("UPDATE connector_keys SET last_used_at = ? WHERE id = ?").run(now(), r["id"]);
        return r["user_id"];
    }
    listConnectorKeys(userId) {
        return this.db.prepare("SELECT * FROM connector_keys WHERE user_id = ? ORDER BY created_at").all(userId).map((r) => ({
            id: r["id"],
            label: r["label"] ?? null,
            createdAt: r["created_at"],
            lastUsedAt: r["last_used_at"] ?? null,
        }));
    }
    deleteConnectorKey(userId, id) {
        this.db.prepare("DELETE FROM connector_keys WHERE user_id = ? AND id = ?").run(userId, id);
    }
    // ---- google ---------------------------------------------------------
    putGoogleAccount(a) {
        this.db
            .prepare(`INSERT INTO google_accounts (user_id, email, refresh_token_sealed, access_token_sealed, access_expires_at, calendar_id, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token_sealed = excluded.refresh_token_sealed,
           access_token_sealed = excluded.access_token_sealed, access_expires_at = excluded.access_expires_at,
           calendar_id = excluded.calendar_id, scopes = excluded.scopes`)
            .run(a.userId, a.email, a.refreshTokenSealed, a.accessTokenSealed, a.accessExpiresAt, a.calendarId, a.scopes, now());
    }
    getGoogleAccount(userId) {
        const r = this.db.prepare("SELECT * FROM google_accounts WHERE user_id = ?").get(userId);
        if (!r)
            return undefined;
        return {
            userId,
            email: r["email"] ?? null,
            refreshTokenSealed: r["refresh_token_sealed"],
            accessTokenSealed: r["access_token_sealed"] ?? null,
            accessExpiresAt: r["access_expires_at"] ?? null,
            calendarId: r["calendar_id"],
            scopes: r["scopes"] ?? null,
        };
    }
    deleteGoogleAccount(userId) {
        this.db.prepare("DELETE FROM google_accounts WHERE user_id = ?").run(userId);
    }
    // ---- oauth (our authorization server) --------------------------------
    putOAuthClient(clientId, json) {
        this.db
            .prepare("INSERT INTO oauth_clients (client_id, json, created_at) VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET json = excluded.json")
            .run(clientId, JSON.stringify(json), now());
    }
    getOAuthClient(clientId) {
        const r = this.db.prepare("SELECT json FROM oauth_clients WHERE client_id = ?").get(clientId);
        return r ? JSON.parse(r["json"]) : undefined;
    }
    putOAuthCode(row) {
        this.db
            .prepare("INSERT INTO oauth_codes (code, client_id, user_id, code_challenge, redirect_uri, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(row.code, row.clientId, row.userId, row.codeChallenge, row.redirectUri, row.scope, row.resource, row.expiresAt);
    }
    takeOAuthCode(code) {
        const r = this.db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(code);
        if (!r)
            return undefined;
        this.db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(code);
        return {
            code,
            clientId: r["client_id"],
            userId: r["user_id"],
            codeChallenge: r["code_challenge"],
            redirectUri: r["redirect_uri"],
            scope: r["scope"] ?? null,
            resource: r["resource"] ?? null,
            expiresAt: r["expires_at"],
        };
    }
    peekOAuthCode(code) {
        const r = this.db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(code);
        if (!r)
            return undefined;
        return {
            code,
            clientId: r["client_id"],
            userId: r["user_id"],
            codeChallenge: r["code_challenge"],
            redirectUri: r["redirect_uri"],
            scope: r["scope"] ?? null,
            resource: r["resource"] ?? null,
            expiresAt: r["expires_at"],
        };
    }
    putOAuthToken(row) {
        this.db
            .prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, resource, expires_at, created_at, family) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(row.tokenHash, row.kind, row.clientId, row.userId, row.scope, row.resource, row.expiresAt, now(), row.family);
    }
    getOAuthToken(tokenHash) {
        const r = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(tokenHash);
        if (!r)
            return undefined;
        return {
            tokenHash,
            kind: r["kind"],
            clientId: r["client_id"],
            userId: r["user_id"],
            scope: r["scope"] ?? null,
            resource: r["resource"] ?? null,
            expiresAt: r["expires_at"],
            family: r["family"],
        };
    }
    deleteOAuthToken(tokenHash) {
        this.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(tokenHash);
    }
    deleteOAuthFamily(family) {
        this.db.prepare("DELETE FROM oauth_tokens WHERE family = ?").run(family);
    }
    purgeExpired() {
        const ts = now();
        this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(ts);
        this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(ts);
        this.db.prepare("DELETE FROM login_sessions WHERE expires_at < ?").run(ts);
        this.db.prepare("DELETE FROM pending_logins WHERE expires_at < ?").run(ts);
        this.db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").run(ts);
    }
    // ---- login sessions (settings page) ---------------------------------
    createLoginSession(userId, id, ttlDays = 30) {
        this.db
            .prepare("INSERT INTO login_sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
            .run(id, userId, new Date(Date.now() + ttlDays * 86_400_000).toISOString());
    }
    userForLoginSession(id) {
        const r = this.db.prepare("SELECT user_id FROM login_sessions WHERE id = ? AND expires_at > ?").get(id, now());
        return r ? r["user_id"] : undefined;
    }
    deleteLoginSession(id) {
        this.db.prepare("DELETE FROM login_sessions WHERE id = ?").run(id);
    }
    putPendingLogin(id, data, ttlMinutes = 15) {
        this.db
            .prepare("INSERT INTO pending_logins (id, json, expires_at) VALUES (?, ?, ?)")
            .run(id, JSON.stringify(data), new Date(Date.now() + ttlMinutes * 60_000).toISOString());
    }
    peekPendingLogin(id) {
        const r = this.db.prepare("SELECT json FROM pending_logins WHERE id = ? AND expires_at > ?").get(id, now());
        return r ? JSON.parse(r["json"]) : undefined;
    }
    takePendingLogin(id) {
        const r = this.db.prepare("SELECT json FROM pending_logins WHERE id = ? AND expires_at > ?").get(id, now());
        if (!r)
            return undefined;
        this.db.prepare("DELETE FROM pending_logins WHERE id = ?").run(id);
        return JSON.parse(r["json"]);
    }
}
function rowToUser(r) {
    return {
        id: r["id"],
        email: r["email"] ?? null,
        name: r["name"] ?? null,
        prefs: { ...DEFAULT_PREFERENCES, ...JSON.parse(r["prefs_json"]) },
        createdAt: r["created_at"],
    };
}
function rowToAccount(r) {
    return {
        id: r["id"],
        userId: r["user_id"],
        baseUrl: r["base_url"],
        kind: r["kind"],
        secretSealed: r["secret_sealed"] ?? null,
        label: r["label"] ?? null,
        lastSyncAt: r["last_sync_at"] ?? null,
        lastError: r["last_error"] ?? null,
        createdAt: r["created_at"],
    };
}
function rowToItem(r) {
    return {
        item: JSON.parse(r["json"]),
        versionHash: r["version_hash"],
        detailsFetchedAt: r["details_fetched_at"] ?? null,
        firstSeenAt: r["first_seen_at"],
        lastSeenAt: r["last_seen_at"],
    };
}
function rowToBlock(r) {
    const b = {
        id: r["id"],
        itemId: r["item_id"],
        start: r["start"],
        end: r["end"],
        minutes: r["minutes"],
        status: r["status"],
        createdAt: r["created_at"],
        updatedAt: r["updated_at"],
    };
    const ev = r["calendar_event_id"];
    const cal = r["calendar_id"];
    if (ev)
        b.calendarEventId = ev;
    if (cal)
        b.calendarId = cal;
    return b;
}
//# sourceMappingURL=db.js.map