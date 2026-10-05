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

A fourth path exists for later: a global developer key from Instructure that each school admin toggles on. The code already treats accounts generically.

## The connector

A remote MCP server on Streamable HTTP, stateless (one `McpServer` per request), on the TypeScript SDK. Nine tools, three prompts, server `instructions` that teach the loop (workload → check-ins → propose → agree → commit).

Authentication accepts two bearer kinds: a connector key (`ck_…`) for assistants that take a fixed header (Claude Code, personal use), and access tokens from the built-in OAuth 2.1 authorization server (authorization code + PKCE, dynamic client registration for Claude, Client ID Metadata Documents for ChatGPT, refresh-token rotation, resource indicators echoed into tokens). Login is a dev form or Google; the Google sign-in also captures the calendar consent, so one screen connects everything. The SDK's router serves the metadata and endpoints; `SqliteOAuthProvider` holds the state.

## Who writes the calendar

Assistants differ: Claude's own Google Calendar connector can create events on the free plan; ChatGPT's is paid-only and not in the EU/UK; Gemini's custom connectors are US, 18+, personal accounts only. So the server owns the write: Google Calendar through the REST API when connected, and always an ICS feed of planned blocks that any calendar app can subscribe to. Owning the write also means the planner can see when a block was moved, stretched or deleted (`reconcileGoogle`), which is free signal.

The assistant can still contribute busy time from any calendar it can read, by passing `busy` intervals to `propose_plan`.

## Estimates

Log-normal hours with p50 and p80.

**Prior.** `heuristicEstimate` names the shape of the work from the title and brief (paper, problem set, reading, quiz, discussion, exam, project, lab, presentation, reflection), reads quantities out of the brief (`extractQuantities`: pages, words, problems, questions, sources, minutes, chapters), and applies legible rules: 250 words per 36 minutes plus setup, an hour per written page, six minutes per page of reading, eighteen minutes per problem, quiz time limit plus thirty minutes' review, ten percent per rubric criterion over three, thirty minutes for peer review, ten percent for group coordination. Without quantities it falls back to a base per shape scaled by points relative to the course's median. Confidence sets the spread.

With an Anthropic key, `ClaudeEstimator` asks for a structured task card (shape, steps, quantities, p50, p80, confidence, reasoning) once per assignment version and caches it in `priors`, shared across every student who has that assignment. The prompt insists on unpacking the steps, because unpacking measurably reduces the planning fallacy (Kruger & Evans 2004), and reminds the model that students underestimate (Buehler, Griffin & Ross 1994: 33.9 days predicted, 55.5 actual).

**Calibration.** Each actual gives `log(actual / estimate)`. The course factor is a shrunk mean toward the student's overall factor, itself shrunk toward 0 with three pseudo-observations; ratios are clipped to ±2.5 in log space. Spread narrows as `sqrt(3 / (n + 3))` but never below the observed scatter or 0.25.

**Actuals** arrive as one-tap buckets (`<1h` → 40 min, `1-2h` → 90, `2-4h` → 180, `4-8h` → 360, `8h+` → 600), exact minutes, or later from calendar behaviour. The settings page and `get_workload` surface pending check-ins: items past due that had planned blocks or a submission but no actual.

**Pooling** is a median over distinct users per (Canvas host, item id), only when at least five have logged. Nothing per-student leaves the row.

## The planner

`planBlocks` is pure. Free slots = work windows per weekday in the student's zone, minus busy intervals, minus existing blocks, cut at "now". Items go earliest-deadline-first (points break ties); each needs `p80` if due within 72 hours else `p50`, less what is already planned. Blocks are 45–120 minutes on a five-minute grid, capped per day, placed before `due − buffer`; if that fails they may eat into the buffer (flagged), and what still does not fit is reported with the hours short and why. The `even` strategy spreads an item's blocks toward evenly spaced targets instead of front-loading. Time-zone arithmetic is `Intl` only (`tz.ts`).

## Storage and secrets

SQLite through `node:sqlite`, WAL, `synchronous=FULL`. Every table carries `user_id`. Canvas tokens, feed URLs and Google tokens are sealed (AES-256-GCM under an HKDF-derived key from `SECRET_KEY`); connector keys, device tokens, OAuth access and refresh tokens are stored as SHA-256 hashes. Pooled priors live in `priors`, keyed by host, item id and a version hash of the fields the estimate used, so a rewritten brief gets a fresh estimate.

## Constraints and what was done about them

| Constraint | Response |
|---|---|
| Student tokens blocked or short-lived | extension (session) and feed are first-class; token is optional |
| Vanity Canvas domains | fixed permission for `*.instructure.com`, optional host permission granted per origin from the options page, content script registered dynamically |
| No extension on phones | feed keeps due dates fresh server-side; extension adds depth when at a laptop |
| Session expiry | background sync records the failure and sets a badge; feed keeps flowing |
| Rate limits | planner-first, delta detail fetches, budget per sync, backoff on 429 |
| New Quizzes opaque | estimated as a quiz without size; the brief's own "N minutes" is still read |
| Instructure's API policy and school AUPs | strictly read-only, student acts with their own credential, host allowlist available for operators, README says to check the school's policy |
| ChatGPT free users only reach apps through the directory, which needs OAuth 2.1, annotations, privacy policy, a test account | the OAuth server, annotations on every tool, `get_profile`, and the stub Canvas for reviewers are in place |
| ChatGPT calendar write is paid-only | the server writes the calendar and serves ICS |
| Claude's client follows the 2025 authorization specs | the SDK negotiates; DCR and CIMD both work |
| Trust after the breach | read-only, open code, sealed secrets, one-page delete |

## Not built yet

- Work outside Canvas: Gradescope, publisher platforms, course sites. Items are source-agnostic (`source: "manual"` exists) but nothing feeds them yet.
- Microsoft 365 / Outlook calendar.
- Directory listings (Claude, ChatGPT) and the Chrome Web Store listing: the code meets the requirements; the submissions, privacy policy page and icons are not done.
- Firefox and Safari packaging (the code is MV3-portable).
- A global developer key with Instructure, and an LTI placement for schools.
- Calendar-derived actuals: moved/deleted blocks are recorded but not yet turned into time samples.
- Push nudges (the weekly check-in is a prompt the student runs).
- Postgres: the store is SQLite with `user_id` everywhere; a port is a driver, not a schema change.
