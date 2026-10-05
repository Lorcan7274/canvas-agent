/**
 * SQLite storage on node:sqlite. Every row carries user_id; a Postgres port is
 * a driver swap, not a schema change. Secrets are sealed before they get here.
 */
import { DatabaseSync } from "node:sqlite";
import type { Actual, Course, Estimate, Preferences, StudyBlock, WorkItem, BlockStatus } from "../types.js";
export declare const SCHEMA = "\nPRAGMA journal_mode = WAL;\nPRAGMA synchronous = FULL;\nPRAGMA busy_timeout = 5000;\n\nCREATE TABLE IF NOT EXISTS users (\n  id TEXT PRIMARY KEY,\n  email TEXT UNIQUE,\n  name TEXT,\n  prefs_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS canvas_accounts (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  base_url TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK (kind IN ('token','feed','session')),\n  secret_sealed TEXT,\n  label TEXT,\n  last_sync_at TEXT,\n  last_error TEXT,\n  created_at TEXT NOT NULL,\n  UNIQUE (user_id, base_url, kind)\n);\n\nCREATE TABLE IF NOT EXISTS courses (\n  user_id TEXT NOT NULL,\n  id TEXT NOT NULL,\n  json TEXT NOT NULL,\n  PRIMARY KEY (user_id, id)\n);\n\nCREATE TABLE IF NOT EXISTS items (\n  user_id TEXT NOT NULL,\n  id TEXT NOT NULL,\n  json TEXT NOT NULL,\n  due_at TEXT,\n  status TEXT NOT NULL,\n  source TEXT NOT NULL,\n  version_hash TEXT NOT NULL,\n  details_fetched_at TEXT,\n  first_seen_at TEXT NOT NULL,\n  last_seen_at TEXT NOT NULL,\n  PRIMARY KEY (user_id, id)\n);\nCREATE INDEX IF NOT EXISTS items_due ON items (user_id, due_at);\n\nCREATE TABLE IF NOT EXISTS priors (\n  key TEXT PRIMARY KEY,\n  json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS actuals (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  item_id TEXT NOT NULL,\n  host TEXT,\n  course_id TEXT,\n  minutes INTEGER NOT NULL,\n  source TEXT NOT NULL,\n  estimated_hours REAL,\n  created_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS actuals_user ON actuals (user_id, created_at);\nCREATE INDEX IF NOT EXISTS actuals_pool ON actuals (host, item_id);\n\nCREATE TABLE IF NOT EXISTS blocks (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  item_id TEXT NOT NULL,\n  start TEXT NOT NULL,\n  end TEXT NOT NULL,\n  minutes INTEGER NOT NULL,\n  status TEXT NOT NULL,\n  calendar_event_id TEXT,\n  calendar_id TEXT,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS blocks_user ON blocks (user_id, start);\n\nCREATE TABLE IF NOT EXISTS devices (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  token_hash TEXT NOT NULL UNIQUE,\n  name TEXT,\n  created_at TEXT NOT NULL,\n  last_seen_at TEXT\n);\n\nCREATE TABLE IF NOT EXISTS pairing_codes (\n  code TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  expires_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS connector_keys (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  token_hash TEXT NOT NULL UNIQUE,\n  label TEXT,\n  created_at TEXT NOT NULL,\n  last_used_at TEXT\n);\n\nCREATE TABLE IF NOT EXISTS google_accounts (\n  user_id TEXT PRIMARY KEY,\n  email TEXT,\n  refresh_token_sealed TEXT NOT NULL,\n  access_token_sealed TEXT,\n  access_expires_at TEXT,\n  calendar_id TEXT NOT NULL DEFAULT 'primary',\n  scopes TEXT,\n  created_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS oauth_clients (\n  client_id TEXT PRIMARY KEY,\n  json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS oauth_codes (\n  code TEXT PRIMARY KEY,\n  client_id TEXT NOT NULL,\n  user_id TEXT NOT NULL,\n  code_challenge TEXT NOT NULL,\n  redirect_uri TEXT NOT NULL,\n  scope TEXT,\n  resource TEXT,\n  expires_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS oauth_tokens (\n  token_hash TEXT PRIMARY KEY,\n  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),\n  client_id TEXT NOT NULL,\n  user_id TEXT NOT NULL,\n  scope TEXT,\n  resource TEXT,\n  expires_at TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  family TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family);\n\nCREATE TABLE IF NOT EXISTS login_sessions (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  expires_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS pending_logins (\n  id TEXT PRIMARY KEY,\n  json TEXT NOT NULL,\n  expires_at TEXT NOT NULL\n);\n";
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
export declare function now(): string;
export declare function itemVersionHash(item: WorkItem, hash: (s: string) => string): string;
export declare class Store {
    readonly db: DatabaseSync;
    constructor(path?: string);
    close(): void;
    createUser(email: string | null, name: string | null, prefs?: Partial<Preferences>): User;
    getUser(id: string): User | undefined;
    getUserByEmail(email: string): User | undefined;
    listUsers(): User[];
    updatePrefs(userId: string, patch: Partial<Preferences>): Preferences;
    upsertCanvasAccount(a: {
        userId: string;
        baseUrl: string;
        kind: CanvasAccount["kind"];
        secretSealed?: string | null;
        label?: string | null;
    }): CanvasAccount;
    getCanvasAccount(id: string): CanvasAccount | undefined;
    listCanvasAccounts(userId: string): CanvasAccount[];
    listAllCanvasAccounts(): CanvasAccount[];
    deleteCanvasAccount(userId: string, id: string): void;
    markSync(id: string, error: string | null): void;
    upsertCourse(userId: string, c: Course): void;
    listCourses(userId: string): Course[];
    courseMap(userId: string): Map<string, Course>;
    getItem(userId: string, id: string): ItemRow | undefined;
    upsertItem(userId: string, item: WorkItem, versionHash: string, opts?: {
        detailsFetched?: boolean;
    }): void;
    listItems(userId: string, opts?: {
        from?: string;
        to?: string;
        includeUndated?: boolean;
    }): ItemRow[];
    deleteItem(userId: string, id: string): void;
    getPrior(key: string): Estimate | undefined;
    putPrior(key: string, estimate: Estimate): void;
    addActual(userId: string, a: {
        itemId: string;
        host?: string | undefined;
        courseId?: string | undefined;
        minutes: number;
        source: Actual["source"];
        estimatedHours?: number | undefined;
    }): Actual;
    listActuals(userId: string): ActualSample[];
    latestActualFor(userId: string, itemId: string): ActualSample | undefined;
    /** Median minutes other students logged for the same item, if at least `minN` did. */
    pooledActual(host: string, itemId: string, minN?: number): {
        medianMinutes: number;
        n: number;
    } | undefined;
    addBlock(userId: string, b: {
        itemId: string;
        start: string;
        end: string;
        minutes: number;
        calendarEventId?: string | undefined;
        calendarId?: string | undefined;
    }): StudyBlock;
    getBlock(userId: string, id: string): StudyBlock | undefined;
    listBlocks(userId: string, opts?: {
        from?: string;
        to?: string;
        itemId?: string;
    }): StudyBlock[];
    updateBlock(userId: string, id: string, patch: Partial<Pick<StudyBlock, "start" | "end" | "minutes" | "status" | "calendarEventId" | "calendarId">>): void;
    deleteBlocksForItem(userId: string, itemId: string, statuses?: BlockStatus[]): StudyBlock[];
    createPairingCode(userId: string, code: string, ttlMinutes?: number): void;
    redeemPairingCode(code: string): string | undefined;
    createDevice(userId: string, tokenHash: string, name: string | null): string;
    userForDeviceToken(tokenHash: string): string | undefined;
    listDevices(userId: string): Array<{
        id: string;
        name: string | null;
        createdAt: string;
        lastSeenAt: string | null;
    }>;
    deleteDevice(userId: string, id: string): void;
    createConnectorKey(userId: string, tokenHash: string, label: string | null): string;
    userForConnectorKey(tokenHash: string): string | undefined;
    listConnectorKeys(userId: string): Array<{
        id: string;
        label: string | null;
        createdAt: string;
        lastUsedAt: string | null;
    }>;
    deleteConnectorKey(userId: string, id: string): void;
    putGoogleAccount(a: GoogleAccount): void;
    getGoogleAccount(userId: string): GoogleAccount | undefined;
    deleteGoogleAccount(userId: string): void;
    putOAuthClient(clientId: string, json: unknown): void;
    getOAuthClient<T>(clientId: string): T | undefined;
    putOAuthCode(row: OAuthCodeRow): void;
    takeOAuthCode(code: string): OAuthCodeRow | undefined;
    peekOAuthCode(code: string): OAuthCodeRow | undefined;
    putOAuthToken(row: OAuthTokenRow): void;
    getOAuthToken(tokenHash: string): OAuthTokenRow | undefined;
    deleteOAuthToken(tokenHash: string): void;
    deleteOAuthFamily(family: string): void;
    purgeExpired(): void;
    createLoginSession(userId: string, id: string, ttlDays?: number): void;
    userForLoginSession(id: string): string | undefined;
    deleteLoginSession(id: string): void;
    putPendingLogin(id: string, data: unknown, ttlMinutes?: number): void;
    peekPendingLogin<T>(id: string): T | undefined;
    takePendingLogin<T>(id: string): T | undefined;
}
