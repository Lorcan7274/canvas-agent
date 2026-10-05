/**
 * Google Calendar over plain fetch: token refresh, free/busy, and the events
 * we own (tagged with a private extended property so they can be found again).
 * Requests go through the egress guard (timeout, size cap, no redirects);
 * errors carry the status code only, never Google's response body.
 */
import { EgressError, safeFetcher, type Interval } from "@canvas-agent/core";

const googleFetch = safeFetcher({ timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

export const BLOCK_PROPERTY = "canvasAgentBlock";

export interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

export class GoogleError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

/** Safe to show or log: our own errors carry a status code at most; anything else (a JSON.parse message quoting the body) is replaced. */
export function googleErrorMessage(e: unknown): string {
  return e instanceof GoogleError || e instanceof EgressError ? e.message : "Google Calendar did not answer as expected";
}

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export class GoogleCalendar {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = googleFetch,
  ) {}

  /** `codeChallenge`: an S256 PKCE challenge; pass its verifier to `exchangeCode`. */
  authUrl(redirectUri: string, state: string, scopes: string[] = GOOGLE_SCOPES, codeChallenge?: string): string {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", scopes.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<GoogleTokens> {
    return this.tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code", ...(codeVerifier ? { code_verifier: codeVerifier } : {}) });
  }

  async refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  }

  private async tokenRequest(params: Record<string, string>): Promise<GoogleTokens> {
    const body = new URLSearchParams({ ...params, client_id: this.clientId, client_secret: this.clientSecret });
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new GoogleError(`google token endpoint ${res.status}`, res.status);
    return (await res.json()) as GoogleTokens;
  }

  async userInfo(accessToken: string): Promise<{ email?: string; name?: string; sub?: string }> {
    const res = await this.fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new GoogleError(`userinfo ${res.status}`, res.status);
    return (await res.json()) as { email?: string; name?: string; sub?: string };
  }

  private async api<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(`https://www.googleapis.com/calendar/v3${path}`, init);
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw new GoogleError(`Google Calendar returned ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  async freeBusy(accessToken: string, calendarIds: string[], timeMin: string, timeMax: string): Promise<Interval[]> {
    const data = await this.api<{ calendars: Record<string, { busy: Array<{ start: string; end: string }> }> }>(accessToken, "POST", "/freeBusy", {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    });
    const out: Interval[] = [];
    for (const cal of Object.values(data.calendars ?? {})) for (const b of cal.busy ?? []) out.push({ start: b.start, end: b.end });
    return out;
  }

  async insertEvent(accessToken: string, calendarId: string, ev: { summary: string; description?: string; start: string; end: string; blockId: string; url?: string }): Promise<GoogleEvent> {
    return this.api<GoogleEvent>(accessToken, "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.start },
      end: { dateTime: ev.end },
      source: ev.url ? { title: "Open in Canvas", url: ev.url } : undefined,
      extendedProperties: { private: { [BLOCK_PROPERTY]: ev.blockId } },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
  }

  async getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleEvent | undefined> {
    try {
      return await this.api<GoogleEvent>(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return undefined;
      throw e;
    }
  }

  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    try {
      await this.api<void>(accessToken, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  }
}
