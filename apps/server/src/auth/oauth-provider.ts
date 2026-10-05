/**
 * Our OAuth 2.1 authorization server, on the SDK's router. Clients register
 * dynamically (Claude) or arrive as Client ID Metadata Documents (ChatGPT).
 * Authorization redirects to a consent page; tokens are opaque and hashed.
 */
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientError, InvalidGrantError, InvalidScopeError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { hashToken, randomToken, type Store } from "@canvas-agent/core";
import { MCP_SCOPES, type TokenVerifier } from "./bearer.js";

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86_400;
export const CODE_TTL_S = 600;

export interface PendingAuthorization {
  kind: "authorize";
  clientId: string;
  clientName?: string;
  clientUri?: string;
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

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (/^https:\/\//.test(clientId)) return this.fetchCimd(clientId);
    return this.store.getOAuthClient<OAuthClientInformationFull>(clientId);
  }

  /** Client ID Metadata Document: the client_id is a URL to a JSON description of the client. */
  private async fetchCimd(url: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.cimd.get(url);
    if (cached && Date.now() - cached.fetchedAt < 3_600_000) return cached.doc;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    const doc = (await res.json()) as Partial<OAuthClientInformationFull>;
    if (doc.client_id !== url || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) return undefined;
    const full: OAuthClientInformationFull = {
      ...doc,
      client_id: url,
      redirect_uris: doc.redirect_uris,
      token_endpoint_auth_method: doc.token_endpoint_auth_method === "private_key_jwt" ? "none" : doc.token_endpoint_auth_method ?? "none",
    } as OAuthClientInformationFull;
    this.cimd.set(url, { doc: full, fetchedAt: Date.now() });
    return full;
  }

  private async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & { client_id?: string }): Promise<OAuthClientInformationFull> {
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
    const pendingId = randomToken(16);
    const pending: PendingAuthorization = {
      kind: "authorize",
      clientId: client.client_id,
      scopes: requested,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
    };
    if (client.client_name) pending.clientName = client.client_name;
    if (client.client_uri) pending.clientUri = client.client_uri;
    if (params.state) pending.state = params.state;
    if (params.resource) pending.resource = params.resource.toString();
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
      resource: pending.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_S * 1000).toISOString(),
    });
    const u = new URL(pending.redirectUri);
    u.searchParams.set("code", code);
    if (pending.state) u.searchParams.set("state", pending.state);
    return u.toString();
  }

  denyCode(pendingId: string): string | undefined {
    const pending = this.store.takePendingLogin<PendingAuthorization>(pendingId);
    if (!pending) return undefined;
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
    if (row.resource && resource && resource.toString() !== row.resource) throw new InvalidTargetError("resource mismatch");
    return this.issueTokens(client.client_id, row.userId, row.scope, row.resource ?? resource?.toString() ?? null, randomUUID());
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = this.store.getOAuthToken(hashToken(refreshToken));
    if (!row || row.kind !== "refresh") throw new InvalidGrantError("unknown refresh token");
    if (row.clientId !== client.client_id) throw new InvalidClientError("refresh token belongs to another client");
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      this.store.deleteOAuthFamily(row.family);
      throw new InvalidGrantError("refresh token expired");
    }
    const granted = row.scope ? row.scope.split(" ") : MCP_SCOPES;
    const wanted = scopes?.length ? scopes : granted;
    if (wanted.some((s) => !granted.includes(s))) throw new InvalidScopeError("scope exceeds the original grant");
    if (row.resource && resource && resource.toString() !== row.resource) throw new InvalidTargetError("resource mismatch");
    this.store.deleteOAuthToken(row.tokenHash); // rotation
    return this.issueTokens(client.client_id, row.userId, wanted.join(" "), row.resource, row.family);
  }

  private issueTokens(clientId: string, userId: string, scope: string | null, resource: string | null, family: string): OAuthTokens {
    const access = "at_" + randomToken(32);
    const refresh = "rt_" + randomToken(32);
    this.store.putOAuthToken({ tokenHash: hashToken(access), kind: "access", clientId, userId, scope, resource, expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(), family });
    this.store.putOAuthToken({ tokenHash: hashToken(refresh), kind: "refresh", clientId, userId, scope, resource, expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000).toISOString(), family });
    const tokens: OAuthTokens = { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh };
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
