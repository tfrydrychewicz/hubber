# Hubber

Local, single-user work hub for an engineering manager: a Hono server on Node 26, bound to 127.0.0.1, and a Vite + React web app. Requirements are in `docs/PRD.md`; the plan and the state of each package are in `docs/PLAN.md`.

## Running things

- Node 26 is required; the version is in `.nvmrc`. If `node -v` shows an older one, switch with `nvm use` or put a Node 26 binary first in `PATH`.
- The gate is `npm run check`: lint, type-check and unit tests. `npm run format` fixes formatting and import order.
- When the server, the web app or the build changes, also run `npm run test:e2e`. It builds and starts the app itself, on port 4478 or `HUBBER_E2E_PORT`; the browsers come from `npm run test:e2e:install`.
- `npx tsc --noEmit` checks nothing here, because the root `tsconfig.json` only references the projects. Use `npm run typecheck`.

## Where things live

- `src/server`: the Hono server and the LLM endpoint diagnostics.
- `src/web`: the React app; its user-facing strings are in `src/web/messages.ts`.
- `src/shared`: what the server and the web app both import, such as API contracts.
- `scripts`: the development runner, the Node version check and the diagnostics command.
- `e2e`: Playwright tests. Spec files take `test` and `expect` from `./fixtures.ts`.
- Unit tests sit next to the code as `*.test.ts` (`*.test.tsx` in `src/web`).

Node runs the server and the scripts straight from the TypeScript sources, so only erasable syntax is allowed (no enums, no parameter properties) and relative imports carry the file extension. Lint enforces the import boundaries: `src/web` and `src/server` do not import from each other, and `src/shared` imports from neither. Outside tests, `src/shared` and `src/web` use no Node built-in modules, and `src/shared` uses no `window`, `document` or `process`.

## Conventions

- User-facing text is Polish: the interface, the messages of the server and the scripts, `README.md` and `docs/`. Code, comments and test names are English.
- The repository is public. Keep employer names, internal hostnames, model catalogues of private endpoints and personal data out of files and commit messages. Where an example host is needed, use `router.corp.example`.
- Never read or commit `.env` or the top-level `diagnostics/` directory (`src/server/llm/diagnostics` is source code).
- Commit only when the owner asks.
