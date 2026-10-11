# Hubber

Local, single-user work hub for an engineering manager: a Hono server on Node 26, bound to 127.0.0.1, and a Vite + React web app. Requirements are in `docs/PRD.md`; the plan and the state of each package are in `docs/PLAN.md`.

## Running things

- Node 26 is required; the version is in `.nvmrc`. If `node -v` shows an older one, switch with `nvm use` or put a Node 26 binary first in `PATH`.
- The gate is `npm run check`: lint, type-check and unit tests. `npm run format` fixes formatting and import order.
- When the server, the web app or the build changes, also run `npm run test:e2e`. It builds and starts the app itself, on port 4478 or `HUBBER_E2E_PORT`, on a throwaway workspace that it creates for the run; the browsers come from `npm run test:e2e:install`. The server of the run works under `src/server/egress-observer.ts`, and the run fails when that server did anything that leaves its process: a connection, a name lookup, a started program.
- `npx tsc --noEmit` checks nothing here, because the root `tsconfig.json` only references the projects. Use `npm run typecheck`.
- Never start the app on the owner's workspace. Every command that creates a workspace or starts the app carries `HUBBER_WORKSPACE` itself, with the same throwaway directory each time, because your shell does not keep an `export` from one command to the next. Create the workspace once with `HUBBER_WORKSPACE="${TMPDIR:-/tmp}/hubber-agent/workspace" npm run workspace:create -- --name Test --kind anthropic` (the command refuses a directory that exists: go on with the one that is there, or remove it first), then put the same `HUBBER_WORKSPACE="${TMPDIR:-/tmp}/hubber-agent/workspace"` in front of `npm start` and of `npm run dev`. Without the variable the three commands exit with code 2 in your session, which they know by `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` or `AI_AGENT`. That catches a forgotten prefix and nothing else: a workspace that the variable names is opened whoever names it. Tests take theirs from `createTestWorkspace()` in `src/server/workspace/testing.ts`.

## Where things live

- `src/server`: the Hono server. `src/server/workspace` is what a workspace is on disk: its place, its configuration file, creating and opening one. `src/server/llm` is everything about the endpoint: its address, the credentials, the SDK client and the endpoint diagnostics.
- `src/web`: the React app; its user-facing strings are in `src/web/messages.ts`.
- `src/shared`: what the server and the web app both import, such as API contracts.
- `scripts`: the development runner, the Node version check, the diagnostics command, the command that creates a workspace, and the step that gives the end-to-end run its workspace.
- `e2e`: Playwright tests. Spec files take `test` and `expect` from `./fixtures.ts`.
- Unit tests sit next to the code as `*.test.ts` (`*.test.tsx` in `src/web`).

Node runs the server and the scripts straight from the TypeScript sources, so only erasable syntax is allowed (no enums, no parameter properties) and relative imports carry the file extension. Lint enforces the import boundaries: `src/web` and `src/server` do not import from each other, and `src/shared` imports from neither. Outside tests, `src/shared` and `src/web` use no Node built-in modules, and `src/shared` uses no `window`, `document` or `process`. In `src/server`, `src/shared` and `scripts`, tests and their `testing.ts` helpers aside, only `src/server/workspace/database.ts` imports `better-sqlite3`, only `src/server/llm/client.ts` builds an SDK client, and nothing calls `fetch` or opens a `WebSocket` or an `EventSource`: the client reaches the pinned endpoint over connections of its own, made with `node:http` and `node:https`. The endpoint diagnostics (`src/server/llm/diagnostics`, `scripts/diagnose.ts`) are the one exception: they build a client of their own and call `fetch`. Application code imports no test, no `testing.ts` helper and not `src/server/egress-observer.ts`; `scripts/e2e-workspace.ts`, a tool of the tests, may. Node's modules for the network and for starting programs (`node:http`, `node:https`, `node:net`, `node:child_process` and their kin) are for the files listed in `scripts/lint-boundaries.test.ts`, and a new use goes on that list with its purpose.

## Conventions

- User-facing text is Polish: the interface, the messages of the server and the scripts, `README.md` and `docs/`. Code, comments and test names are English.
- The repository is public. Keep employer names, internal hostnames, model catalogues of private endpoints and personal data out of files and commit messages. Where an example host is needed, use `router.corp.example`.
- Never read or commit `.env` or the top-level `diagnostics/` directory (`src/server/llm/diagnostics` is source code).
- Commit only when the owner asks.
