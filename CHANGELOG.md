# Changelog

Notable changes, newest first. Versions follow [semantic versioning](https://semver.org); the server, the core library and the extension share one version.

## 0.1.0 (unreleased)

First release.

- **Server**: an MCP connector on Streamable HTTP with twelve tools and three prompts, its own OAuth 2.1 authorization server (authorization code with PKCE, dynamic client registration, client ID metadata documents), a settings page, the extension API, an ICS feed of planned blocks, Google Calendar writes and background syncs.
- **Core**: Canvas client and normaliser for the planner API, assignment and quiz details and the calendar feed; time estimates (a legible heuristic prior, optional Claude task cards, per-student calibration, pooled medians); the block planner; SQLite storage.
- **Extension** (Chrome and Edge; the same build loads in Firefox 128+): reads Canvas with the student's session, GET only, and posts a trimmed snapshot to the paired server; a "Plan my week" button on the dashboard.
- **Stub Canvas** for tests, local development and connector reviewers.
- **Security pass** before release: Canvas tokens, feed URLs and Google tokens sealed with AES-256-GCM, and connector keys, device tokens, pairing codes and OAuth tokens stored hashed; production refuses a missing or placeholder `SECRET_KEY`, open dev login and loopback egress; outbound Canvas and feed requests are https to public addresses only; request bodies capped before authentication; rate limits on sign-in, pairing, OAuth and feeds; a `Host` allowlist; CORS on the extension API for extension origins only, without credentials; snapshots cut to the fields the planner reads in the browser and again on the server.
- **Extension pass** before release: only real, production Canvas is registered (Instructure's own sites and beta/test copies are excluded; an origin needs Canvas's page markup and a JSON `/api/v1/users/self`); one sync per origin at a time, with a lock that survives a restarted worker; backoff after failures; details read four at a time and posted per batch; sign-in pages and SSO redirects read as "not signed in"; a badge per origin; Canvas addresses can be removed; "Forget everything" also unregisters scripts and hands back permissions; icons, a store-length description and Firefox manifest keys; a privacy policy (`docs/PRIVACY.md`).
