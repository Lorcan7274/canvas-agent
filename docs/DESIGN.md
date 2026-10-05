# Design

Why the pieces are the way they are, the constraints that shaped them, and what is still open. The README says how to run it.

## The idea

Students already plan with AI assistants. None of those assistants can see Canvas, and none of them knows how long a CHEM 101 problem set takes *this* student. So: a connector that gives any MCP-speaking assistant the workload, calibrated time estimates, and the ability to put study blocks on the calendar. The assistant does the conversation and the judgement. The server does what assistants are bad at: fetching across six courses reliably, remembering what took four hours last month, and placing eleven blocks around twenty-three calendar events without double-booking.

## Getting data out of Canvas

Each school runs its own Canvas and decides who gets API access, and since the 2026 breach many block student tokens outright. So there is no single credential that works everywhere. Three are supported and all land on the same `WorkItem` rows:

| Credential | Works at | Gives | Lifetime |
|---|---|---|---|
| Calendar feed (`/feeds/calendars/user_<hex>.ics`) | every school | titles, due dates, descriptions as text | permanent; polled by the server |
| Logged-in browser session (extension) | every school, desktop only | full read API | until the school's session times out |
| Personal access token | where allowed | full read API from the server | ≤120 days for students |

The feed and the API agree on ids: feed UIDs are `event-assignment-<id>`, so a feed row and an API row for the same assignment merge into `canvas:assignment:<id>`. Quizzes and graded discussions are keyed by their *assignment* id for the same reason. `mergeItem` is field-level: a thin source (feed, planner view) updates due dates and status but never erases what a richer fetch stored.

The Canvas calls are the planner API (one call across all courses, with the student's own done-marks in `planner_override`), missing submissions, assignment detail (description, points, rubric, submission types, attempts, peer review, group), and classic quiz detail (`time_limit`, `question_count`). New Quizzes are LTI tools and opaque; they are estimated as "quiz, size unknown". Rate limits are per token and cost-based, so detail fetches are budgeted (40 per sync) and skipped when the planner's `updated_at` has not moved.

The extension registers a Canvas origin only when the page carries Canvas's own markup (`#application.ic-app`) and `/api/v1/users/self` answers with JSON. Beta and test copies (`*.beta.`, `*.test.instructure.com`) and Instructure's own sites are excluded in the manifest and in code, because a copy carries production's assignment ids and would overwrite its rows. Each origin syncs once at a time: the worker keeps the in-flight promise, and a lock in `chrome.storage.session` survives a restarted worker until it goes stale. After a failure, automatic syncs wait (a minute while signed out, otherwise exponential from two minutes to two hours). Details are read four at a time and posted per batch, and the progress write per batch keeps the worker alive. A planner list read to its last page carries its date window, so the server can mark what Canvas no longer lists as gone; failed details are reported so the server backs off on them.

A fourth path exists for later: a global developer key from Instructure that each school admin toggles on. The code already treats accounts generically.

## The connector

A remote MCP server on Streamable HTTP, stateless (one `McpServer` per request), on the TypeScript SDK. Twelve tools, three prompts, server `instructions` that teach the loop (workload → check-ins → propose → agree → commit).

Authentication accepts two bearer kinds: a connector key (`ck_…`) for assistants that take a fixed header (Claude Code, personal use), and access tokens from the built-in OAuth 2.1 authorization server (authorization code + PKCE, dynamic client registration for Claude, Client ID Metadata Documents for ChatGPT, refresh-token rotation, resource indicators echoed into tokens). Login is a dev form or Google; the Google sign-in also captures the calendar consent, so one screen connects everything. The SDK's router serves the metadata and endpoints; `SqliteOAuthProvider` holds the state.

## Who writes the calendar

Assistants differ: Claude's own Google Calendar connector can create events on the free plan; ChatGPT's is paid-only and not in the EU/UK; Gemini's custom connectors are US, 18+, personal accounts only. So the server owns the write: Google Calendar through the REST API when connected, and always an ICS feed of planned blocks that any calendar app can subscribe to. Owning the write also means the planner can see when a block was moved, stretched or deleted (`reconcileGoogle`), which is free signal.

The assistant can still contribute busy time from any calendar it can read, by passing `busy` intervals to `propose_plan`.

## Estimates

Log-normal hours with p50 and p80.

**Prior.** `heuristicEstimate` names the shape of the work from the title and brief (paper, problem set, reading, quiz, discussion, exam, project, lab, presentation, reflection), reads quantities out of the brief (`extractQuantities`: pages, words, problems, questions, sources, minutes, chapters), and applies legible rules: 250 words per 36 minutes plus setup, an hour per written page, six minutes per page of reading, eighteen minutes per problem, quiz time limit plus thirty minutes' review, ten percent per rubric criterion over three, thirty minutes for peer review, ten percent for group coordination. Without quantities it falls back to a base per shape scaled by points relative to the course's median. Confidence sets the spread.

With an Anthropic key, `ClaudeEstimator` asks for a structured task card (shape, steps, quantities, p50, p80, confidence, reasoning) once per assignment version and caches it in `priors`, shared across every student who has that assignment. Cards are built by the background jobs (`warmTaskCards`, a few at a time), never inside a tool call, so reads serve the heuristic until a card exists; a refusal or a bad card is remembered per version with a retry time. Heuristic priors are not cached: they depend on the student's own course median and are cheap. The prompt insists on unpacking the steps, because unpacking measurably reduces the planning fallacy (Kruger & Evans 2004), and reminds the model that students underestimate (Buehler, Griffin & Ross 1994: 33.9 days predicted, 55.5 actual).

**Calibration.** Each actual gives `log(actual / estimate)` against the uncalibrated prior. Ratios are clipped to ±1.5 in log space; each item counts once (its latest actual); the student's overall factor leaves the target course out, and the course factor is a mean shrunk toward it, each with three pseudo-observations. Spread is predictive, not a standard error: `(3·base² + Σ(x − x̄)²) / (n + 2) × (1 + 1/(n + 3))`, from the course's ratios once it has five, else all of the student's, floor 0.25 and no cap, so tight scatter narrows it and wide scatter widens it past the prior. A bucket answer is read as its bounds: the calibrated estimate moved into the bucket, so a bucket that agrees with the estimate confirms it rather than dragging it to the bucket's middle. A seeded simulation pins p80 coverage near 0.80.

**Actuals** arrive as one-tap buckets (`<1h` → 40 min, `1-2h` → 90, `2-4h` → 180, `4-8h` → 360, `8h+` → 600), exact minutes, or later from calendar behaviour. The settings page and `get_workload` surface pending check-ins: items past due that had planned blocks or a submission but no actual.

**Pooling** is a median over distinct users per (Canvas host, item id), only when at least five have logged. Nothing per-student leaves the row.

## The planner

`planBlocks` is pure. Free slots = work windows per weekday in the student's zone (a window ending at or before its start runs past midnight; overlapping windows merge), minus busy intervals (Canvas calendar events included, all-day ones excepted), minus every block that still occupies time, cut at "now" rounded up to the five-minute grid. Overdue work (`asap`) goes first, then earliest deadline (points break ties); each item needs `p80` if due within 72 hours else `p50`, less what is already planned, and items due after the horizon get only this horizon's share. Blocks are 45–120 minutes on the grid, at least 30 minutes apart for the same item, capped per day (counted by the day a window starts), placed before `due − buffer`; a block that must run past that point is flagged individually, remainders shorter than a block are merged or dropped rather than reported, and what still does not fit is reported with the hours short and why. The `even` strategy spreads an item's blocks toward evenly spaced targets instead of front-loading. Horizons over 120 days are refused. Time-zone arithmetic is `Intl` only (`tz.ts`); a skipped hour moves forward, a repeated hour takes its first pass. A seeded property test holds the invariants across DST weeks in seven zones.

## Storage and secrets

SQLite through `node:sqlite`, WAL, `synchronous=FULL`. Every table carries `user_id`. Canvas tokens, feed URLs and Google tokens are sealed (AES-256-GCM under an HKDF-derived key from `SECRET_KEY`); connector keys, device tokens, OAuth access and refresh tokens are stored as SHA-256 hashes. Pooled priors live in `priors`, keyed by host, item id and a version hash of the fields the estimate used, so a rewritten brief gets a fresh estimate.

## Constraints and what was done about them

| Constraint | Response |
|---|---|
| Student tokens blocked or short-lived | extension (session) and feed are first-class; token is optional |
| Vanity Canvas domains | fixed permission for `*.instructure.com` (beta/test copies and Instructure's own sites excluded), optional host permission granted per origin from the options page, content script registered dynamically and re-registered at worker start; the options page removes an origin and hands its permission back |
| No extension on phones | feed keeps due dates fresh server-side; extension adds depth when at a laptop |
| Session expiry | background sync records the failure per origin, retries once a minute at most, and sets a badge that only that origin's next success clears; a sign-in page or SSO redirect reads as "not signed in"; feed keeps flowing |
| Rate limits | planner-first, delta detail fetches, budget per sync, backoff on 429 and on Canvas's 403 "Rate Limit Exceeded"; the extension reads details four at a time and stops a sync's details when throttled |
| New Quizzes opaque | estimated as a quiz without size; the brief's own "N minutes" is still read |
| Instructure's API policy and school AUPs | strictly read-only, student acts with their own credential, host allowlist available for operators, README says to check the school's policy |
| ChatGPT free users only reach apps through the directory, which needs OAuth 2.1, annotations, privacy policy, a test account | the OAuth server, annotations on every tool, `get_profile`, and the stub Canvas for reviewers are in place |
| ChatGPT calendar write is paid-only | the server writes the calendar and serves ICS |
| Claude's client follows the 2025 authorization specs | the SDK negotiates; DCR and CIMD both work |
| Trust after the breach | read-only, open code, sealed secrets, one-page delete |

## Not built yet

- Work outside Canvas: Gradescope, publisher platforms, course sites. Items are source-agnostic (`source: "manual"` exists) but nothing feeds them yet.
- Microsoft 365 / Outlook calendar.
- Directory listings (Claude, ChatGPT) and the Chrome Web Store listing: the code meets the requirements and the build draws the icons; `docs/PRIVACY.md` is the policy text but has no public URL yet, and nothing is submitted.
- Firefox: the one build carries `background.scripts` and a gecko id and loads as a temporary add-on in Firefox 128+, but it is not signed or listed on AMO and is not tested in CI. Safari packaging is not built.
- A global developer key with Instructure, and an LTI placement for schools.
- Calendar-derived actuals: moved/deleted blocks are recorded but not yet turned into time samples.
- Push nudges (the weekly check-in is a prompt the student runs).
- Postgres: the store is SQLite with `user_id` everywhere; a port is a driver, not a schema change.
