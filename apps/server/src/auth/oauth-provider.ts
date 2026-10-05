/**
 * Our OAuth 2.1 authorization server, on the SDK's router. Clients register
 * dynamically (Claude) or arrive as Client ID Metadata Documents (ChatGPT).
 * Authorization redirects to a consent page; tokens are opaque and hashed.
 * Refresh tokens rotate; a rotated one used again revokes its whole grant.
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { OAuthClientMetadataSchema, type OAuthClientInformationFull, type OAuthTokenRevocationRequest, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientError, InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { hashToken, randomToken, safeFetch, type Store } from "@canvas-agent/core";
import { MCP_SCOPES, type TokenVerifier } from "./bearer.js";

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86_400;
/** A grant ends this long after the user approved it, however often it is refreshed. */
export const FAMILY_TTL_S = 90 * 86_400;
export const CODE_TTL_S = 600;

const CIMD_TTL_MS = 3_600_000;
const CIMD_MAX_ENTRIES = 200;
const CIMD_MAX_BYTES = 16 * 1024;
const CIMD_TIMEOUT_MS = 5000;

export interface PendingAuthorization {
  kind: "authorize";
  clientId: string;
  clientName?: string;
  clientUri?: string;
  /** "metadata": client_id is a URL whose host vouches for the document; "registered": self-asserted at registration. */
  clientKind?: "metadata" | "registered";
  state?: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
}

interface CimdCache {
  doc: OAuthClientInformationFull;
  fetchedAt: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why a redirect URI is not acceptable, or undefined when it is: https, or http on a loopback host (RFC 8252). */
export function redirectUriProblem(uri: string): string | undefined {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return `redirect URI ${uri} is not a URL`;
  }
  if (u.hash) return "redirect URIs must not have a fragment";
  if (u.username || u.password) return "redirect URIs must not carry credentials";
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return undefined;
  return "redirect URIs must use https (or http on localhost)";
}

/** Same resource: same URL apart from a fragment and one trailing slash (as the SDK compares). */
export function sameResource(a: URL | string, b: URL | string): boolean {
  const norm = (v: URL | string) => {
    const t = String(v);
    const i = t.indexOf("#");
    return (i === -1 ? t : t.slice(0, i)).replace(/\/$/, "");
  };
  return norm(a) === norm(b);
}

export function isMetadataClientId(clientId: string): boolean {
  return /^https:\/\//.test(clientId);
}

/** What the settings page calls a client: the document's host for CIMD clients, the registered name (unverified) otherwise. */
export function clientLabel(store: Store, clientId: string): string {
  if (isMetadataClientId(clientId)) {
    try {
      return new URL(clientId).host;
    } catch {
      return clientId;
    }
  }
  const c = store.getOAuthClient<{ client_name?: string; redirect_uris?: string[] }>(clientId);
  const name = c?.client_name?.slice(0, 80) ?? "Unnamed client";
  let host = "";
  try {
    host = c?.redirect_uris?.[0] ? new URL(c.redirect_uris[0]).host : "";
  } catch {
    // ignore
  }
  return host ? `${name} (unverified name; ${host})` : `${name} (unverified name)`;
}

export class SqliteOAuthProvider implements OAuthServerProvider {
  private readonly cimd = new Map<string, CimdCache>();
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly store: Store,
    private readonly verifier: TokenVerifier,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.clientsStore = {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  /** The MCP endpoint: the one resource tokens are issued for. */
  private get resource(): URL {
    return this.verifier.resource;
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (isMetadataClientId(clientId)) return this.fetchCimd(clientId);
    return this.store.getOAuthClient<OAuthClientInformationFull>(clientId);
  }

  /** Client ID Metadata Document: the client_id is a URL to a JSON description of the client. */
  private async fetchCimd(url: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.cimd.get(url);
    if (cached && Date.now() - cached.fetchedAt < CIMD_TTL_MS) {
      this.cimd.delete(url); // most recently used goes last
      this.cimd.set(url, cached);
      return cached.doc;
    }
    if (cached) this.cimd.delete(url);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return undefined;
    }
    // A metadata document lives on the client's own domain, at a path; never an IP literal or a loopback name.
    if (target.protocol !== "https:" || target.hash || target.username || target.password || target.pathname === "/" || isIP(target.hostname.replace(/^\[|\]$/g, "")) || LOOPBACK.has(target.hostname)) return undefined;
    const text = await this.fetchSmall(target);
    if (text === undefined) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== "object" || (raw as { client_id?: unknown }).client_id !== url) return undefined;
    const parsed = OAuthClientMetadataSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.redirect_uris.length) return undefined;
    if (parsed.data.redirect_uris.some((u) => redirectUriProblem(u))) return undefined;
    const method = parsed.data.token_endpoint_auth_method;
    // We cannot verify a private_key_jwt assertion and a metadata client has no shared secret; treating either as a public client would be a silent downgrade.
    if (method !== undefined && method !== "none") throw new InvalidClientError(`token_endpoint_auth_method ${method} is not supported for metadata-document clients; use none`);
    const full = { ...parsed.data, client_id: url, token_endpoint_auth_method: "none" } as OAuthClientInformationFull;
    while (this.cimd.size >= CIMD_MAX_ENTRIES) {
      const oldest = this.cimd.keys().next().value;
      if (oldest === undefined) break;
      this.cimd.delete(oldest);
    }
    this.cimd.set(url, { doc: full, fetchedAt: Date.now() });
    return full;
  }

  /**
   * GET a small JSON document: no redirects, a timeout, a size cap. With the
   * real fetch it goes through the egress guard (private ranges, DNS rebinding);
   * an injected fetch (tests) keeps the local checks only.
   */
  private async fetchSmall(url: URL): Promise<string | undefined> {
    if (this.fetchImpl === globalThis.fetch) {
      try {
        const guarded = await safeFetch(url, { headers: { accept: "application/json" } }, { timeoutMs: CIMD_TIMEOUT_MS, maxBytes: CIMD_MAX_BYTES });
        return guarded.status === 200 ? await guarded.text() : undefined;
      } catch {
        return undefined;
      }
    }
    let res: globalThis.Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(CIMD_TIMEOUT_MS) });
    } catch {
      return undefined;
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    if (Number(res.headers.get("content-length") ?? 0) > CIMD_MAX_BYTES) {
      await res.body.cancel().catch(() => {});
      return undefined;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CIMD_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return undefined;
        }
        chunks.push(value);
      }
    } catch {
      return undefined;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & { client_id?: string }): Promise<OAuthClientInformationFull> {
    if (!client.redirect_uris?.length) throw new InvalidClientMetadataError("at least one redirect URI is required");
    for (const uri of client.redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new InvalidClientMetadataError(problem);
    }
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: client.client_id ?? randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    } as OAuthClientInformationFull;
    this.store.putOAuthClient(full.client_id, full);
    return full;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requested = params.scopes?.length ? params.scopes : MCP_SCOPES;
    if (requested.some((s) => !MCP_SCOPES.includes(s))) throw new InvalidScopeError(`unknown scope; supported: ${MCP_SCOPES.join(" ")}`);
    if (params.resource && !sameResource(params.resource, this.resource)) throw new InvalidTargetError(`unknown resource; this server's is ${this.resource.toString()}`);
    const pendingId = randomToken(16);
    const pending: PendingAuthorization = {
      kind: "authorize",
      clientId: client.client_id,
      clientKind: isMetadataClientId(client.client_id) ? "metadata" : "registered",
      scopes: requested,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: this.resource.toString(),
    };
    if (client.client_name) pending.clientName = client.client_name.slice(0, 80);
    if (client.client_uri) pending.clientUri = client.client_uri;
    if (params.state) pending.state = params.state;
    this.store.putPendingLogin(pendingId, pending);
    res.redirect(`/authorize/consent?pending=${encodeURIComponent(pendingId)}`);
  }

  /** Called by the consent page once the user allowed. Returns the redirect URL. */
  issueCode(pendingId: string, userId: string): string | undefined {
    const pending = this.store.takePendingLogin<PendingAuthorization>(pendingId);
    if (!pending || pending.kind !== "authorize") return undefined;
    const code = "ac_" + randomToken(24);
    this.store.putOAuthCode({
      code,
      clientId: pending.clientId,
      userId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      scope: pending.scopes.join(" "),
      resource: pending.resource ?? this.resource.toString(),
      expiresAt: new Date(Date.now() + CODE_TTL_S * 1000).toISOString(),
    });
    const u = new URL(pending.redirectUri);
    u.searchParams.set("code", code);
    if (pending.state) u.searchParams.set("state", pending.state);
    return u.toString();
  }

  denyCode(pendingId: string): string | undefined {
    const pending = this.store.takePendingLogin<PendingAuthorization>(pendingId);
    if (!pending || pending.kind !== "authorize") return undefined;
    const u = new URL(pending.redirectUri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "The user declined");
    if (pending.state) u.searchParams.set("state", pending.state);
    return u.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.store.peekOAuthCode(authorizationCode);
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError("unknown authorization code");
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const row = this.store.takeOAuthCode(authorizationCode);
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError("unknown authorization code");
    if (new Date(row.expiresAt).getTime() < Date.now()) throw new InvalidGrantError("authorization code expired");
    if (redirectUri && redirectUri !== row.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const granted = row.resource ?? this.resource.toString();
    if (!sameResource(granted, this.resource) || (resource && !sameResource(resource, granted))) throw new InvalidTargetError("resource mismatch");
    return this.issueTokens(client.client_id, row.userId, row.scope, granted, randomUUID(), Date.now() + FAMILY_TTL_S * 1000);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const hash = hashToken(refreshToken);
    const row = this.store.getOAuthToken(hash);
    if (!row || row.kind !== "refresh") throw new InvalidGrantError("unknown refresh token");
    if (row.clientId !== client.client_id) throw new InvalidClientError("refresh token belongs to another client");
    if (row.usedAt) {
      // A rotated token came back: either the client or a thief holds a copy. End the grant for both.
      this.store.deleteOAuthFamily(row.family);
      throw new InvalidGrantError("refresh token was already used; the grant has been revoked");
    }
    const familyEnd = row.familyExpiresAt ? Date.parse(row.familyExpiresAt) : Date.now() + FAMILY_TTL_S * 1000;
    if (new Date(row.expiresAt).getTime() < Date.now() || !(familyEnd > Date.now())) {
      this.store.deleteOAuthFamily(row.family);
      throw new InvalidGrantError("refresh token expired");
    }
    const granted = row.scope ? row.scope.split(" ") : MCP_SCOPES;
    const wanted = scopes?.length ? scopes : granted;
    if (wanted.some((s) => !granted.includes(s))) throw new InvalidScopeError("scope exceeds the original grant");
    const grantedResource = row.resource ?? this.resource.toString();
    if (resource && !sameResource(resource, grantedResource)) throw new InvalidTargetError("resource mismatch");
    if (!this.store.markOAuthTokenUsed(hash)) {
      this.store.deleteOAuthFamily(row.family);
      throw new InvalidGrantError("refresh token was already used; the grant has been revoked");
    }
    this.store.deleteOAuthAccessTokens(row.family); // rotation: the previous access token ends with its refresh token
    return this.issueTokens(client.client_id, row.userId, wanted.join(" "), grantedResource, row.family, familyEnd);
  }

  private issueTokens(clientId: string, userId: string, scope: string | null, resource: string, family: string, familyEnd: number): OAuthTokens {
    const access = "at_" + randomToken(32);
    const refresh = "rt_" + randomToken(32);
    const nowMs = Date.now();
    const accessEnd = Math.min(nowMs + ACCESS_TTL_S * 1000, familyEnd);
    const refreshEnd = Math.min(nowMs + REFRESH_TTL_S * 1000, familyEnd);
    const familyExpiresAt = new Date(familyEnd).toISOString();
    this.store.putOAuthToken({ tokenHash: hashToken(access), kind: "access", clientId, userId, scope, resource, expiresAt: new Date(accessEnd).toISOString(), family, familyExpiresAt });
    this.store.putOAuthToken({ tokenHash: hashToken(refresh), kind: "refresh", clientId, userId, scope, resource, expiresAt: new Date(refreshEnd).toISOString(), family, familyExpiresAt });
    const tokens: OAuthTokens = { access_token: access, token_type: "Bearer", expires_in: Math.max(1, Math.floor((accessEnd - nowMs) / 1000)), refresh_token: refresh };
    if (scope) tokens.scope = scope;
    return tokens;
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    return this.verifier.verifyAccessToken(token);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.store.getOAuthToken(hashToken(request.token));
    if (!row || row.clientId !== client.client_id) return;
    if (row.kind === "refresh") this.store.deleteOAuthFamily(row.family);
    else this.store.deleteOAuthToken(row.tokenHash);
  }
}
