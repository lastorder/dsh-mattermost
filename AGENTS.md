# AGENTS.md

Notes for an agent (or person) changing this repository. User-facing docs live in [README.md](README.md) / [README.zh.md](README.zh.md).

## Layout

- `index.js` — Host half: Config schema (`connections[].routes[]` + shared fields, every top-level field `.volatile()`), environment lifecycle (one `MattermostBridge` per enabled environment, reconciled on `loader/volatile-update`; settings are memoized per configuration change), one shared `TurnTracker`, `/mattermost` command, approval/question notices, the settings page's `/api/dsh-mattermost/<entry>/{status,sessions,workspaces,test,reconnect}` routes, and the state store (bindings of shared-mode routes + thread-mode sessions, keyed `<entry>/<env>[/<route>]`).
- `lib/bridge.js` — `MattermostBridge` (one environment: routing by `@mention`, lanes — one shared session or thread in order, the rest in parallel up to `maxConcurrent` — session selection per mode `shared | thread | new`, replies) and `TurnTracker` (one listener set following every submitted prompt to its DSH turn). Never imports Cordis: everything comes through the `host` adapter so tests can fake it.
- `lib/config.js` — normalizes `connections` and their `routes` (an environment without routes has one implicit route with key `''`), derives environment/route keys, merges one environment with the shared settings.
- `lib/mattermost.js` — REST over `fetch`, WebSocket over the global `WebSocket` (Node ≥ 22), `probeSocket` for "test connection". No runtime dependencies.
- `lib/core.js` — pure helpers; keep them free of I/O.
- `client.js` — Client half (Plugins page). Classic script in the `window.__ModuleLoader__` factory format; no build step, no Harness Client package imports, styles only via `--dsw-alias-*` tokens (copied from the host settings-form primitives under a `dshmm-` prefix). Its `testing` export exposes pure helpers for `test/client.test.js`.
- `scripts/fake-mattermost.js` — fake Mattermost (REST + WebSocket + `/_test/*` control routes) used by tests and manual runs.
- `docker-compose.yml` + `scripts/mm-local.mjs` — a real local Mattermost for manual testing (`pnpm run mm:up | mm:setup | mm:info | mm:post | mm:down`); `mm:setup` is idempotent and writes the git-ignored `.mm-local.json` (logins and the bot token). See README → "Manual testing with a local Mattermost".

## DSH contracts this plugin relies on

- `ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', content }, signal)` resumes the session if needed and stores `requestId` as the user message's `source.rpcId`; `.create({ workspaceId | cwd })`, `.rename({ sessionId, title })`, `.list({}, signal)` (titles in `projections.values.title`).
- `workspaceRegistry`: `list()` (`id`, `path`, `title`, `sessionIds`), `resolveByPath(path)`, `create(path)` (a route directory that is not a workspace yet is registered on first use).
- The turn is found from `agent/inbox/claimed { agent, message, turn }` (fallback: the `user/message` session event after the latest `turn/start`); the answer comes from `assistant/message` session events of that turn until `turn/end`.
- `approval/request` and `user-questions/request` are waterfalls: the listeners are `prepend`ed pass-throughs that must always `return next()`.
- `ctx.connection.fetch.register({ path: '/api/…', methods, requestBody: 'buffered', fetch })` mounts an authenticated exact route; the page calls it with a relative `fetch` from `document.baseURI` (desktop forwards `dsh-app://app/api/…` with the auth cookie).
- Settings forms (`ctx.configForms` → `settings.mutate`) apply path ops: `['connections', '<index>', '<field>']` edits one field and keeps the hidden token; `unset` of an array index removes the element; `set` at `length` appends. The page never rewrites an environment wholesale because tokens are redacted from what it reads; a changed route list (no secrets) is written whole at `['connections', '<index>', 'routes']`.

Confirm these with `cordis_inspect_list` / `cordis_inspect_query` (Service, Event) when upgrading DSH.

## Rules

- Every change ends with `pnpm run verify` (syntax checks + `node --test`). Behavior changes get a test in `test/` in the same change.
- No unhandled rejections and no throwing listeners: this code runs inside the DSH Host process.
- Keep `@deepseek-ai/schemastery` a `peerDependency` with a matching `devDependency`.
- Keep `client.js` defaults (`DEFAULT_MESSAGES`, `CONNECTION_DEFAULTS`, `ROUTE_DEFAULTS`, `SHARED_DEFAULTS`) and `connectionKeys`/`routeKeys` identical to the Host's; `test/client.test.js` fails otherwise.
- Installing a changed copy into a running DSH needs a restart (the module generation is cached). To try changes live without restarting, install a copy under a new path, package name and row id (route paths include the row id), then remove it.
- Public releases: publish only the `files` whitelist; never add `.npmrc`, `.env*`, `.mm-local.json`, Mattermost bot tokens, or profile overrides to Git. `prepublishOnly` runs `verify`. The first npm version is published locally; later versions use `.github/workflows/publish.yml` to **stage** via npm Trusted Publishing (OIDC), then the npm owner approves with 2FA. Staging success is not a public release. The npm publisher identity matches the exact workflow filename `publish.yml`.
