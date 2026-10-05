# canvas-agent

Canvas workload, calibrated time estimates and study-block planning for AI assistants, over MCP. Read `README.md` for how it runs and `docs/DESIGN.md` for why it is shaped this way before changing structure.

## Commands

- `pnpm check`: typecheck every package and run vitest. Green before any commit.
- `pnpm dev`: server with `tsx watch` (dev login, heuristic estimates, SQLite in `./data`).
- `pnpm stub`: fake Canvas on :3999 for manual testing.
- `pnpm --filter @canvas-agent/extension build`: bundle the extension into `apps/extension/build`.

## Layout

- `packages/core`: pure library. Canvas client (`canvas/client.ts`), normaliser (`canvas/normalize.ts`), ICS (`ics.ts`), estimates (`estimate/`), planner (`plan/planner.ts`), SQLite store (`store/db.ts`), sync paths (`sync.ts`), sealing (`crypto.ts`), time zones (`tz.ts`).
- `apps/server`: Express app. `services.ts` is the only place behaviour lives; MCP tools (`mcp/server.ts`), the settings page and the extension API all call it. Auth: `auth/bearer.ts` (who is calling), `auth/oauth-provider.ts` (our authorization server), `auth/login.ts` (people).
- `apps/extension`: MV3, TypeScript, esbuild. `background.ts` reads Canvas and posts snapshots; `content.ts` is the dashboard button.
- `apps/stub-canvas`: fixtures and a fake API with real quirks. Tests and reviewers use it; never point it at real data.
- `tests/`: integration tests across packages (sync, server end to end including OAuth and an MCP client).

## Rules

- Toward Canvas the system is read-only. No tool, job or extension path sends anything but GET to a Canvas host.
- One user per request. Every store method takes `userId`; never query across users except `pooledActual`, which returns a median over at least five users and nothing else.
- Secrets are sealed (`Sealer`) before they reach the store; tokens we issue are stored hashed. Nothing secret in logs, error messages or tool results.
- A tool returns `content` text and `structuredContent`; every tool has a `title` and `readOnlyHint`/`destructiveHint`. New tools get a row in the `lists annotated tools` test.
- New Canvas fields go through `normalize.ts` and `mergeItem`, with a test, so the token, feed and extension paths stay identical.
- Estimation rules stay legible: a changed number in `heuristic.ts` comes with the reasoning string that explains it.
- Time is UTC ISO in storage; the student's zone is applied only when formatting or planning (`tz.ts`).
- Node 22.13+ for `node:sqlite`; zod stays on 3.25 (both SDKs accept it); the MCP SDK is 1.32.
