# canvas-agent

Your Canvas assignments, how long they will take, and study blocks on your calendar, for whichever AI assistant you use. It is an MCP connector (Claude, ChatGPT, anything that speaks MCP) backed by a small server you run, plus a browser extension that reads Canvas with your own login when your school does not allow API tokens.

Ask your assistant *"what do I have this week, and put it in my schedule"* and it can answer properly: every course, real due dates, an estimate per item that learns from how long things actually took you, and blocks placed around your calendar.

## How it fits together

```
Canvas ──(calendar feed)──────► ┐
Canvas ──(personal token)─────► ├─ server ─► SQLite ─► MCP tools ─► your assistant
Canvas ──(browser extension, your session)─► ┘    │
                                                  └─► Google Calendar events + ICS feed
```

| Piece | Where | What it does |
|---|---|---|
| `packages/core` | TypeScript library | Canvas client and normaliser, ICS reader/writer, time-estimate engine (heuristic prior, optional Claude task cards, per-student calibration), the block planner, SQLite storage |
| `apps/server` | Express + MCP SDK | The MCP endpoint (`/mcp`), an OAuth 2.1 authorization server for assistants, the settings page, the extension API, the planned-blocks ICS feed, Google Calendar writes, background syncs |
| `apps/extension` | Chrome/Edge MV3 (Firefox-compatible) | Reads Canvas with your logged-in session (GET only), posts a snapshot to the server, adds a "Plan my week" button to the Canvas dashboard |
| `apps/stub-canvas` | Fake Canvas | A term of realistic data behind the real API quirks, for tests, local development and connector reviewers |

## Quick start (for yourself)

Requirements: Node 22.13 or newer (it uses the built-in `node:sqlite`), pnpm 10.

```bash
pnpm install
pnpm check                 # typecheck + tests, runs against the stub Canvas
pnpm dev                   # server on http://localhost:8787, dev login, heuristic estimates
```

Then:

1. Open <http://localhost:8787>, sign in (dev mode: any email).
2. **Connect Canvas**, by whichever route your school allows:
   - **Calendar feed** (works everywhere): Canvas → Calendar → *Calendar Feed* → paste the `.ics` link. Titles and due dates, refreshed every 30 minutes.
   - **Personal access token** (if *Account → Settings → New Access Token* exists for you): full details, refreshed every 30 minutes. Student tokens expire within 120 days.
   - **Browser extension** (full details, no token): `pnpm --filter @canvas-agent/extension build`, load `apps/extension/build` unpacked in Chrome, open its options, paste the server URL and a pairing code from the settings page. It syncs whenever you have Canvas open.
3. **Connect your assistant.** The MCP URL is `<server>/mcp`.
   - **Claude Code** (works with localhost): `claude mcp add --transport http planner http://localhost:8787/mcp --header "Authorization: Bearer ck_…"` using a connector key from the settings page.
   - **claude.ai / Claude Desktop / ChatGPT**: these connect from the vendor's cloud, so the server needs a public HTTPS URL (deploy it, or expose it with a tunnel such as `cloudflared tunnel --url http://localhost:8787` and set `BASE_URL` to the tunnel URL). An https `BASE_URL` counts as production, so dev login is refused there: configure Google sign-in (below) first, and do not set `ALLOW_DEV_LOGIN` on a public URL. Add a custom connector with the `/mcp` URL and sign in when asked; the server is its own OAuth provider.
4. **Calendar.** Without Google configured, commit a plan and subscribe to the ICS feed shown on the settings page in any calendar app. With Google configured (below), blocks are written to your primary calendar and the planner reads your busy time.

Try the prompts the connector ships: *Plan my week*, *What's due*, *Weekly check-in*.

## Configuration

Environment variables (see `.env.example`; `node --env-file=.env …` loads them):

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Where to listen |
| `BASE_URL` | `http://localhost:PORT` | Public origin. OAuth issuer, MCP resource, redirect URIs, feed URLs |
| `SECRET_KEY` | dev value locally; required in production | Seals Canvas tokens, feed URLs and Google tokens at rest; signs CSRF. In production (`NODE_ENV=production` or an https `BASE_URL`) it must be 32+ characters and not a placeholder: `openssl rand -base64 48` |
| `DB_PATH` | `./data/canvas-agent.sqlite` | SQLite file (`:memory:` for throwaway) |
| `AUTH_MODE` | `google` when Google is configured, else `dev` | `dev` = email-only login form; the server refuses to start with it in production |
| `ALLOW_DEV_LOGIN` | off | `1` allows dev login in production, for a private test deployment only: anyone who can reach it can sign in as any non-Google account |
| `ALLOWED_HOSTS` | loopback names when `BASE_URL` is localhost, else any | Comma-separated `Host` headers the server answers |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | Sign in with Google + Calendar. Redirect URI: `BASE_URL/oauth/google/callback`. Scopes: `calendar.events`, `calendar.freebusy` (sensitive; under 100 users Google's "testing" mode needs no verification) |
| `ANTHROPIC_API_KEY`, `USE_LLM` | heuristic only | With a key, each new assignment gets one Claude task card (steps, quantities, p50/p80), shared by everyone who has that assignment |
| `SYNC_INTERVAL_MINUTES` | `30` | Token and feed re-sync cadence |
| `CANVAS_HOSTS` | any | Comma-separated Canvas hostnames this server accepts |
| `RATE_LIMIT` | `on` | `off` only in tests |

## The MCP surface

| Tool | Kind | Does |
|---|---|---|
| `get_workload` | read | Items due in a period with status, p50/p80 estimate, planned minutes, and pending check-ins |
| `get_assignment` | read | Full record: description, rubric size, quiz facts, estimate reasoning and steps, planned blocks, same-course history |
| `propose_plan` | read | Blocks placed in work windows, around busy time, before due dates with a buffer, under the daily cap. Nothing saved |
| `commit_plan` | write, additive | Saves agreed blocks; writes Google events when connected; always in the ICS feed |
| `clear_plan` | write, destructive | Removes still-planned blocks (and their events) |
| `log_time` | write, additive | Minutes or a bucket (`<1h`, `1-2h`, `2-4h`, `4-8h`, `8h+`); calibrates future estimates |
| `get_preferences` / `set_preferences` | read / write | Time zone, work windows, daily cap, block sizes, buffer, which assistant the Canvas button opens |
| `get_profile` | read | Stable account id (ChatGPT multi-account) |

Every tool carries a title and `readOnlyHint`/`destructiveHint`, which both connector directories require.

## How estimates work

1. **Prior.** From the Canvas record: kind of work, points relative to the course's median, quantities in the brief (pages, words, problems, questions, sources, a quiz time limit), rubric size, peer review, group work. With `ANTHROPIC_API_KEY`, Claude reads the brief once per assignment version and returns a task card with the steps unpacked, which research on the planning fallacy says is what makes estimates honest.
2. **Calibration.** Each `log_time` gives a ratio actual/estimate. Your factor for a course shrinks toward your overall factor, which shrinks toward 1, in log space, so one outlier cannot own it. p80 narrows as evidence accumulates.
3. **Pooling.** When five or more students on the same Canvas instance have logged the same assignment, the median is shown alongside. Only aggregates ever cross users.

p80 is used automatically for anything due within 72 hours.

## Deploying

`Dockerfile` builds a single image: `docker build -t canvas-agent . && docker run -p 8787:8787 -v canvas-data:/data -e BASE_URL=https://planner.example.com -e SECRET_KEY=… -e GOOGLE_CLIENT_ID=… -e GOOGLE_CLIENT_SECRET=… canvas-agent`. Production needs Google sign-in (or `ALLOW_DEV_LOGIN=1` for a private test). Without Docker: `pnpm install && pnpm build && node --env-file=.env apps/server/dist/main.js`. Any host that runs a container with a persistent volume works (Fly, Railway, a VPS behind Caddy). Put it behind HTTPS; the OAuth flows require it.

## Privacy and safety

- The server only ever **reads** Canvas. The extension sends GET requests with your session; it never submits, posts or messages.
- Canvas tokens, feed URLs and Google tokens are sealed with AES-256-GCM under `SECRET_KEY`. Connector keys, device tokens and OAuth tokens are stored hashed.
- Nothing from one student's account is visible to another; pooled estimates are medians over at least five students.
- Delete everything from the settings page (remove accounts, revoke keys, disconnect assistants and Google) or by deleting the SQLite file.
- Your school's acceptable-use policy applies to you. Some schools forbid third-party tools reading Canvas; check before you connect.

## Development

```bash
pnpm check                          # typecheck + vitest
pnpm stub                           # fake Canvas on :3999 (token stub-token, feed URL printed)
EGRESS_ALLOW_LOOPBACK=1 pnpm dev    # needed to point the server at the stub: outbound requests to loopback are refused otherwise
pnpm dev                            # server with tsx watch
pnpm --filter @canvas-agent/extension build
```

Tests run against the stub, including the full OAuth flow an assistant performs and an MCP client calling every tool. See `docs/DESIGN.md` for the reasoning behind the architecture and what is not built yet.
