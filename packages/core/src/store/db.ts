/**
 * SQLite storage on node:sqlite. Every row carries user_id; a Postgres port is
 * a driver swap, not a schema change. Secrets are sealed before they get here.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Actual, Course, Estimate, Preferences, StudyBlock, WorkItem, BlockStatus } from "../types.js";
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

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  prefs: Preferences;
  createdAt: string;
}

export interface CanvasAccount {
  id: string;
  userId: string;
  baseUrl: string;
  kind: "token" | "feed" | "session";
  secretSealed: string | null;
  label: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ItemRow {
  item: WorkItem;
  versionHash: string;
  detailsFetchedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface GoogleAccount {
  userId: string;
  email: string | null;
  refreshTokenSealed: string;
  accessTokenSealed: string | null;
  accessExpiresAt: string | null;
  calendarId: string;
  scopes: string | null;
}

export interface OAuthCodeRow {
  code: string;
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  scope: string | null;
  resource: string | null;
  expiresAt: string;
}

export interface OAuthTokenRow {
  tokenHash: string;
  kind: "access" | "refresh";
  clientId: string;
  userId: string;
  scope: string | null;
  resource: string | null;
  expiresAt: string;
  family: string;
}

export interface ActualSample {
  itemId: string;
  courseId: string | null;
  minutes: number;
  estimatedHours: number | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

export function now(): string {
  return new Date().toISOString();
}

export function itemVersionHash(item: WorkItem, hash: (s: string) => string): string {
  return hash(
    JSON.stringify([
      item.kind,
      item.title,
      item.descriptionText ?? "",
      item.pointsPossible ?? null,
      item.submissionTypes ?? null,
      item.rubricCriteria ?? null,
      item.quiz ?? null,
      item.peerReviews ?? null,
      item.isGroup ?? null,
    ]),
  );
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- users ----------------------------------------------------------

  createUser(email: string | null, name: string | null, prefs: Partial<Preferences> = {}): User {
    const id = randomUUID();
    const createdAt = now();
    const merged = { ...DEFAULT_PREFERENCES, ...prefs };
    this.db
      .prepare("INSERT INTO users (id, email, name, prefs_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, email, name, JSON.stringify(merged), createdAt);
    return { id, email, name, prefs: merged, createdAt };
  }

  getUser(id: string): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToUser(r) : undefined;
  }

  getUserByEmail(email: string): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined;
    return r ? rowToUser(r) : undefined;
  }

  listUsers(): User[] {
    return (this.db.prepare("SELECT * FROM users").all() as Row[]).map(rowToUser);
  }

  updatePrefs(userId: string, patch: Partial<Preferences>): Preferences {
    const u = this.getUser(userId);
    if (!u) throw new Error("no such user");
    const prefs = { ...u.prefs, ...patch };
    this.db.prepare("UPDATE users SET prefs_json = ? WHERE id = ?").run(JSON.stringify(prefs), userId);
    return prefs;
  }

  // ---- canvas accounts ------------------------------------------------

  upsertCanvasAccount(a: {
    userId: string;
    baseUrl: string;
    kind: CanvasAccount["kind"];
    secretSealed?: string | null;
    label?: string | null;
  }): CanvasAccount {
    const existing = this.db
      .prepare("SELECT * FROM canvas_accounts WHERE user_id = ? AND base_url = ? AND kind = ?")
      .get(a.userId, a.baseUrl, a.kind) as Row | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE canvas_accounts SET secret_sealed = COALESCE(?, secret_sealed), label = COALESCE(?, label), last_error = NULL WHERE id = ?")
        .run(a.secretSealed ?? null, a.label ?? null, existing["id"] as string);
      return this.getCanvasAccount(existing["id"] as string)!;
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO canvas_accounts (id, user_id, base_url, kind, secret_sealed, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.userId, a.baseUrl, a.kind, a.secretSealed ?? null, a.label ?? null, now());
    return this.getCanvasAccount(id)!;
  }

  getCanvasAccount(id: string): CanvasAccount | undefined {
    const r = this.db.prepare("SELECT * FROM canvas_accounts WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToAccount(r) : undefined;
  }

  listCanvasAccounts(userId: string): CanvasAccount[] {
    return (this.db.prepare("SELECT * FROM canvas_accounts WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map(rowToAccount);
  }

  listAllCanvasAccounts(): CanvasAccount[] {
    return (this.db.prepare("SELECT * FROM canvas_accounts ORDER BY created_at").all() as Row[]).map(rowToAccount);
  }

  deleteCanvasAccount(userId: string, id: string): void {
    this.db.prepare("DELETE FROM canvas_accounts WHERE user_id = ? AND id = ?").run(userId, id);
  }

  markSync(id: string, error: string | null): void {
    this.db.prepare("UPDATE canvas_accounts SET last_sync_at = ?, last_error = ? WHERE id = ?").run(now(), error, id);
  }

  // ---- courses --------------------------------------------------------

  upsertCourse(userId: string, c: Course): void {
    this.db
      .prepare("INSERT INTO courses (user_id, id, json) VALUES (?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json")
      .run(userId, c.id, JSON.stringify(c));
  }

  listCourses(userId: string): Course[] {
    return (this.db.prepare("SELECT json FROM courses WHERE user_id = ?").all(userId) as Row[]).map((r) => JSON.parse(r["json"] as string) as Course);
  }

  courseMap(userId: string): Map<string, Course> {
    return new Map(this.listCourses(userId).map((c) => [c.id, c]));
  }

  // ---- items ----------------------------------------------------------

  getItem(userId: string, id: string): ItemRow | undefined {
    const r = this.db.prepare("SELECT * FROM items WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return r ? rowToItem(r) : undefined;
  }

  upsertItem(userId: string, item: WorkItem, versionHash: string, opts: { detailsFetched?: boolean } = {}): void {
    const ts = now();
    const existing = this.getItem(userId, item.id);
    const detailsAt = opts.detailsFetched ? ts : existing?.detailsFetchedAt ?? null;
    this.db
      .prepare(
        `INSERT INTO items (user_id, id, json, due_at, status, source, version_hash, details_fetched_at, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json, due_at = excluded.due_at, status = excluded.status,
           source = excluded.source, version_hash = excluded.version_hash, details_fetched_at = excluded.details_fetched_at,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(userId, item.id, JSON.stringify(item), item.dueAt ?? null, item.status, item.source, versionHash, detailsAt, existing?.firstSeenAt ?? ts, ts);
  }

  listItems(userId: string, opts: { from?: string; to?: string; includeUndated?: boolean } = {}): ItemRow[] {
    const rows = this.db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY due_at IS NULL, due_at").all(userId) as Row[];
    return rows.map(rowToItem).filter((r) => {
      const due = r.item.dueAt;
      if (!due) return opts.includeUndated ?? true;
      if (opts.from && due < opts.from) return false;
      if (opts.to && due > opts.to) return false;
      return true;
    });
  }

  deleteItem(userId: string, id: string): void {
    this.db.prepare("DELETE FROM items WHERE user_id = ? AND id = ?").run(userId, id);
  }

  // ---- priors (shared, per Canvas instance) ----------------------------

  getPrior(key: string): Estimate | undefined {
    const r = this.db.prepare("SELECT json FROM priors WHERE key = ?").get(key) as Row | undefined;
    return r ? (JSON.parse(r["json"] as string) as Estimate) : undefined;
  }

  putPrior(key: string, estimate: Estimate): void {
    this.db
      .prepare("INSERT INTO priors (key, json, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json")
      .run(key, JSON.stringify(estimate), now());
  }

  // ---- actuals --------------------------------------------------------

  addActual(userId: string, a: { itemId: string; host?: string | undefined; courseId?: string | undefined; minutes: number; source: Actual["source"]; estimatedHours?: number | undefined }): Actual {
    const id = randomUUID();
    const createdAt = now();
    this.db
      .prepare("INSERT INTO actuals (id, user_id, item_id, host, course_id, minutes, source, estimated_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, a.itemId, a.host ?? null, a.courseId ?? null, a.minutes, a.source, a.estimatedHours ?? null, createdAt);
    return { id, itemId: a.itemId, minutes: a.minutes, source: a.source, createdAt };
  }

  listActuals(userId: string): ActualSample[] {
    return (this.db.prepare("SELECT * FROM actuals WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map((r) => ({
      itemId: r["item_id"] as string,
      courseId: (r["course_id"] as string | null) ?? null,
      minutes: r["minutes"] as number,
      estimatedHours: (r["estimated_hours"] as number | null) ?? null,
      createdAt: r["created_at"] as string,
    }));
  }

  latestActualFor(userId: string, itemId: string): ActualSample | undefined {
    const r = this.db
      .prepare("SELECT * FROM actuals WHERE user_id = ? AND item_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(userId, itemId) as Row | undefined;
    if (!r) return undefined;
    return {
      itemId: r["item_id"] as string,
      courseId: (r["course_id"] as string | null) ?? null,
      minutes: r["minutes"] as number,
      estimatedHours: (r["estimated_hours"] as number | null) ?? null,
      createdAt: r["created_at"] as string,
    };
  }

  /** Median minutes other students logged for the same item, if at least `minN` did. */
  pooledActual(host: string, itemId: string, minN = 5): { medianMinutes: number; n: number } | undefined {
    const rows = this.db
      .prepare("SELECT user_id, MAX(minutes) AS minutes FROM actuals WHERE host = ? AND item_id = ? GROUP BY user_id")
      .all(host, itemId) as Row[];
    if (rows.length < minN) return undefined;
    const sorted = rows.map((r) => r["minutes"] as number).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return { medianMinutes: median, n: sorted.length };
  }

  // ---- blocks ---------------------------------------------------------

  addBlock(userId: string, b: { itemId: string; start: string; end: string; minutes: number; calendarEventId?: string | undefined; calendarId?: string | undefined }): StudyBlock {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare("INSERT INTO blocks (id, user_id, item_id, start, end, minutes, status, calendar_event_id, calendar_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)")
      .run(id, userId, b.itemId, b.start, b.end, b.minutes, b.calendarEventId ?? null, b.calendarId ?? null, ts, ts);
    return this.getBlock(userId, id)!;
  }

  getBlock(userId: string, id: string): StudyBlock | undefined {
    const r = this.db.prepare("SELECT * FROM blocks WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return r ? rowToBlock(r) : undefined;
  }

  listBlocks(userId: string, opts: { from?: string; to?: string; itemId?: string } = {}): StudyBlock[] {
    const rows = this.db.prepare("SELECT * FROM blocks WHERE user_id = ? ORDER BY start").all(userId) as Row[];
    return rows.map(rowToBlock).filter((b) => {
      if (opts.itemId && b.itemId !== opts.itemId) return false;
      if (opts.from && b.end < opts.from) return false;
      if (opts.to && b.start > opts.to) return false;
      return true;
    });
  }

  updateBlock(userId: string, id: string, patch: Partial<Pick<StudyBlock, "start" | "end" | "minutes" | "status" | "calendarEventId" | "calendarId">>): void {
    const b = this.getBlock(userId, id);
    if (!b) return;
    const merged = { ...b, ...patch, updatedAt: now() };
    this.db
      .prepare("UPDATE blocks SET start = ?, end = ?, minutes = ?, status = ?, calendar_event_id = ?, calendar_id = ?, updated_at = ? WHERE user_id = ? AND id = ?")
      .run(merged.start, merged.end, merged.minutes, merged.status, merged.calendarEventId ?? null, merged.calendarId ?? null, merged.updatedAt, userId, id);
  }

  deleteBlocksForItem(userId: string, itemId: string, statuses: BlockStatus[] = ["planned"]): StudyBlock[] {
    const victims = this.listBlocks(userId, { itemId }).filter((b) => statuses.includes(b.status));
    for (const v of victims) this.db.prepare("DELETE FROM blocks WHERE user_id = ? AND id = ?").run(userId, v.id);
    return victims;
  }

  // ---- devices and pairing --------------------------------------------

  createPairingCode(userId: string, code: string, ttlMinutes = 15): void {
    this.db.prepare("DELETE FROM pairing_codes WHERE user_id = ? OR expires_at < ?").run(userId, now());
    this.db
      .prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
      .run(code, userId, new Date(Date.now() + ttlMinutes * 60_000).toISOString());
  }

  redeemPairingCode(code: string): string | undefined {
    const r = this.db.prepare("SELECT * FROM pairing_codes WHERE code = ? AND expires_at > ?").get(code.toUpperCase(), now()) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code.toUpperCase());
    return r["user_id"] as string;
  }

  createDevice(userId: string, tokenHash: string, name: string | null): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO devices (id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, tokenHash, name, now());
    return id;
  }

  userForDeviceToken(tokenHash: string): string | undefined {
    const r = this.db.prepare("SELECT id, user_id FROM devices WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), r["id"] as string);
    return r["user_id"] as string;
  }

  listDevices(userId: string): Array<{ id: string; name: string | null; createdAt: string; lastSeenAt: string | null }> {
    return (this.db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map((r) => ({
      id: r["id"] as string,
      name: (r["name"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      lastSeenAt: (r["last_seen_at"] as string | null) ?? null,
    }));
  }

  deleteDevice(userId: string, id: string): void {
    this.db.prepare("DELETE FROM devices WHERE user_id = ? AND id = ?").run(userId, id);
  }

  // ---- connector keys -------------------------------------------------

  createConnectorKey(userId: string, tokenHash: string, label: string | null): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO connector_keys (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, tokenHash, label, now());
    return id;
  }

  userForConnectorKey(tokenHash: string): string | undefined {
    const r = this.db.prepare("SELECT id, user_id FROM connector_keys WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("UPDATE connector_keys SET last_used_at = ? WHERE id = ?").run(now(), r["id"] as string);
    return r["user_id"] as string;
  }

  listConnectorKeys(userId: string): Array<{ id: string; label: string | null; createdAt: string; lastUsedAt: string | null }> {
    return (this.db.prepare("SELECT * FROM connector_keys WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map((r) => ({
      id: r["id"] as string,
      label: (r["label"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      lastUsedAt: (r["last_used_at"] as string | null) ?? null,
    }));
  }

  deleteConnectorKey(userId: string, id: string): void {
    this.db.prepare("DELETE FROM connector_keys WHERE user_id = ? AND id = ?").run(userId, id);
  }

  // ---- google ---------------------------------------------------------

  putGoogleAccount(a: GoogleAccount): void {
    this.db
      .prepare(
        `INSERT INTO google_accounts (user_id, email, refresh_token_sealed, access_token_sealed, access_expires_at, calendar_id, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token_sealed = excluded.refresh_token_sealed,
           access_token_sealed = excluded.access_token_sealed, access_expires_at = excluded.access_expires_at,
           calendar_id = excluded.calendar_id, scopes = excluded.scopes`,
      )
      .run(a.userId, a.email, a.refreshTokenSealed, a.accessTokenSealed, a.accessExpiresAt, a.calendarId, a.scopes, now());
  }

  getGoogleAccount(userId: string): GoogleAccount | undefined {
    const r = this.db.prepare("SELECT * FROM google_accounts WHERE user_id = ?").get(userId) as Row | undefined;
    if (!r) return undefined;
    return {
      userId,
      email: (r["email"] as string | null) ?? null,
      refreshTokenSealed: r["refresh_token_sealed"] as string,
      accessTokenSealed: (r["access_token_sealed"] as string | null) ?? null,
      accessExpiresAt: (r["access_expires_at"] as string | null) ?? null,
      calendarId: r["calendar_id"] as string,
      scopes: (r["scopes"] as string | null) ?? null,
    };
  }

  deleteGoogleAccount(userId: string): void {
    this.db.prepare("DELETE FROM google_accounts WHERE user_id = ?").run(userId);
  }

  // ---- oauth (our authorization server) --------------------------------

  putOAuthClient(clientId: string, json: unknown): void {
    this.db
      .prepare("INSERT INTO oauth_clients (client_id, json, created_at) VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET json = excluded.json")
      .run(clientId, JSON.stringify(json), now());
  }

  getOAuthClient<T>(clientId: string): T | undefined {
    const r = this.db.prepare("SELECT json FROM oauth_clients WHERE client_id = ?").get(clientId) as Row | undefined;
    return r ? (JSON.parse(r["json"] as string) as T) : undefined;
  }

  putOAuthCode(row: OAuthCodeRow): void {
    this.db
      .prepare("INSERT INTO oauth_codes (code, client_id, user_id, code_challenge, redirect_uri, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.code, row.clientId, row.userId, row.codeChallenge, row.redirectUri, row.scope, row.resource, row.expiresAt);
  }

  takeOAuthCode(code: string): OAuthCodeRow | undefined {
    const r = this.db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(code) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(code);
    return {
      code,
      clientId: r["client_id"] as string,
      userId: r["user_id"] as string,
      codeChallenge: r["code_challenge"] as string,
      redirectUri: r["redirect_uri"] as string,
      scope: (r["scope"] as string | null) ?? null,
      resource: (r["resource"] as string | null) ?? null,
      expiresAt: r["expires_at"] as string,
    };
  }

  peekOAuthCode(code: string): OAuthCodeRow | undefined {
    const r = this.db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(code) as Row | undefined;
    if (!r) return undefined;
    return {
      code,
      clientId: r["client_id"] as string,
      userId: r["user_id"] as string,
      codeChallenge: r["code_challenge"] as string,
      redirectUri: r["redirect_uri"] as string,
      scope: (r["scope"] as string | null) ?? null,
      resource: (r["resource"] as string | null) ?? null,
      expiresAt: r["expires_at"] as string,
    };
  }

  putOAuthToken(row: OAuthTokenRow): void {
    this.db
      .prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, resource, expires_at, created_at, family) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.tokenHash, row.kind, row.clientId, row.userId, row.scope, row.resource, row.expiresAt, now(), row.family);
  }

  getOAuthToken(tokenHash: string): OAuthTokenRow | undefined {
    const r = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    if (!r) return undefined;
    return {
      tokenHash,
      kind: r["kind"] as "access" | "refresh",
      clientId: r["client_id"] as string,
      userId: r["user_id"] as string,
      scope: (r["scope"] as string | null) ?? null,
      resource: (r["resource"] as string | null) ?? null,
      expiresAt: r["expires_at"] as string,
      family: r["family"] as string,
    };
  }

  deleteOAuthToken(tokenHash: string): void {
    this.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(tokenHash);
  }

  deleteOAuthFamily(family: string): void {
    this.db.prepare("DELETE FROM oauth_tokens WHERE family = ?").run(family);
  }

  purgeExpired(): void {
    const ts = now();
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(ts);
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(ts);
    this.db.prepare("DELETE FROM login_sessions WHERE expires_at < ?").run(ts);
    this.db.prepare("DELETE FROM pending_logins WHERE expires_at < ?").run(ts);
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").run(ts);
  }

  // ---- login sessions (settings page) ---------------------------------

  createLoginSession(userId: string, id: string, ttlDays = 30): void {
    this.db
      .prepare("INSERT INTO login_sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
      .run(id, userId, new Date(Date.now() + ttlDays * 86_400_000).toISOString());
  }

  userForLoginSession(id: string): string | undefined {
    const r = this.db.prepare("SELECT user_id FROM login_sessions WHERE id = ? AND expires_at > ?").get(id, now()) as Row | undefined;
    return r ? (r["user_id"] as string) : undefined;
  }

  deleteLoginSession(id: string): void {
    this.db.prepare("DELETE FROM login_sessions WHERE id = ?").run(id);
  }

  putPendingLogin(id: string, data: unknown, ttlMinutes = 15): void {
    this.db
      .prepare("INSERT INTO pending_logins (id, json, expires_at) VALUES (?, ?, ?)")
      .run(id, JSON.stringify(data), new Date(Date.now() + ttlMinutes * 60_000).toISOString());
  }

  peekPendingLogin<T>(id: string): T | undefined {
    const r = this.db.prepare("SELECT json FROM pending_logins WHERE id = ? AND expires_at > ?").get(id, now()) as Row | undefined;
    return r ? (JSON.parse(r["json"] as string) as T) : undefined;
  }

  takePendingLogin<T>(id: string): T | undefined {
    const r = this.db.prepare("SELECT json FROM pending_logins WHERE id = ? AND expires_at > ?").get(id, now()) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("DELETE FROM pending_logins WHERE id = ?").run(id);
    return JSON.parse(r["json"] as string) as T;
  }
}

function rowToUser(r: Row): User {
  return {
    id: r["id"] as string,
    email: (r["email"] as string | null) ?? null,
    name: (r["name"] as string | null) ?? null,
    prefs: { ...DEFAULT_PREFERENCES, ...(JSON.parse(r["prefs_json"] as string) as Partial<Preferences>) },
    createdAt: r["created_at"] as string,
  };
}

function rowToAccount(r: Row): CanvasAccount {
  return {
    id: r["id"] as string,
    userId: r["user_id"] as string,
    baseUrl: r["base_url"] as string,
    kind: r["kind"] as CanvasAccount["kind"],
    secretSealed: (r["secret_sealed"] as string | null) ?? null,
    label: (r["label"] as string | null) ?? null,
    lastSyncAt: (r["last_sync_at"] as string | null) ?? null,
    lastError: (r["last_error"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
  };
}

function rowToItem(r: Row): ItemRow {
  return {
    item: JSON.parse(r["json"] as string) as WorkItem,
    versionHash: r["version_hash"] as string,
    detailsFetchedAt: (r["details_fetched_at"] as string | null) ?? null,
    firstSeenAt: r["first_seen_at"] as string,
    lastSeenAt: r["last_seen_at"] as string,
  };
}

function rowToBlock(r: Row): StudyBlock {
  const b: StudyBlock = {
    id: r["id"] as string,
    itemId: r["item_id"] as string,
    start: r["start"] as string,
    end: r["end"] as string,
    minutes: r["minutes"] as number,
    status: r["status"] as BlockStatus,
    createdAt: r["created_at"] as string,
    updatedAt: r["updated_at"] as string,
  };
  const ev = r["calendar_event_id"] as string | null;
  const cal = r["calendar_id"] as string | null;
  if (ev) b.calendarEventId = ev;
  if (cal) b.calendarId = cal;
  return b;
}
