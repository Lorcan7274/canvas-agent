/**
 * Who is calling the MCP endpoint. Two kinds of bearer token are accepted:
 * a connector key (`ck_…`, pasted into an assistant as a fixed header) and an
 * access token our own OAuth server issued (`at_…`).
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { hashToken, type Store } from "@canvas-agent/core";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const MCP_SCOPES = ["workload:read", "plan:write"];

export function userIdOf(auth: AuthInfo | undefined): string {
  const id = auth?.extra?.["userId"];
  if (typeof id !== "string") throw new Error("no authenticated user");
  return id;
}

export class TokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly store: Store,
    private readonly resource: URL,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.startsWith("ck_")) {
      const userId = this.store.userForConnectorKey(hashToken(token));
      if (!userId) throw new InvalidTokenError("unknown connector key");
      // Connector keys do not expire on their own; the SDK wants a horizon, so give each check an hour.
      return { token, clientId: "connector-key", scopes: MCP_SCOPES, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: this.resource, extra: { userId, kind: "connector-key" } };
    }
    const row = this.store.getOAuthToken(hashToken(token));
    if (!row || row.kind !== "access") throw new InvalidTokenError("unknown token");
    if (new Date(row.expiresAt).getTime() < Date.now()) throw new InvalidTokenError("token expired");
    const info: AuthInfo = {
      token,
      clientId: row.clientId,
      scopes: row.scope ? row.scope.split(" ") : MCP_SCOPES,
      expiresAt: Math.floor(new Date(row.expiresAt).getTime() / 1000),
      extra: { userId: row.userId, kind: "oauth" },
    };
    if (row.resource) info.resource = new URL(row.resource);
    return info;
  }
}
