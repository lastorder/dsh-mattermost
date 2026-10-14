# dsh-mattermost

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that bridges Mattermost to DSH sessions: it listens for the Mattermost messages you choose — `@mentions`, direct messages, or posts matching your own pattern — lets **a DSH session** handle each of them, and posts the answer back into the Mattermost thread.

- **Routes:** one bot account can answer several `@names`, each in its own DSH workspace — e.g. `@orion-agent` in the `orion-agent` workspace and `@orion-wizard` in the `orion-wizard` workspace, each with that workspace's skills and instructions.
- **Session modes per route:** one shared session for every request, a new session per Mattermost thread, or a new session for every message.
- **Several environments** (servers / bot accounts) at once, all configured on the plugin's settings page.

English | [中文](README.zh.md)

It is the in-Harness counterpart of mm-agent-bridge (the Python bot that forwards mentions to OpenCode/Copilot): no separate process, no agent server to run — the plugin lives inside DSH and talks to the session directly.

## How it works

```
Mattermost ──WebSocket "posted"──▶ dsh-mattermost (DSH Host plugin, one connection per environment)
                                     │  trigger? which route (@name)? channel / user allowed?
                                     │  lanes: one shared session or thread → in order; others → in parallel
                                     ▼
          DSH session in the route's workspace (prompt = header + thread context + @user: text)
                                     │  waits for that exact turn to finish
                                     ▼
Mattermost thread ◀──REST patch/post── final assistant answer (split when too long)
```

1. Each enabled environment signs in with its bot token (`GET /api/v4/users/me`) and keeps the event WebSocket open (token challenge, keep-alive pings, automatic reconnect with back-off).
2. A post is handled when it addresses the bot (see [Triggers](#triggers)) and passes the environment's channel and user filters. The `@name` it uses selects the **route** — the DSH workspace and session mode that answer. Own posts, system messages, other bots and webhooks are ignored.
3. Requests for the same shared session (or the same thread in thread mode) run **one after another**; different routes, threads and new sessions run **in parallel**, up to `maxConcurrent`. A request that has to wait gets a *queued* notice; when it starts the same post becomes *Processing your request…*, and finally it is replaced by the answer — one post per request, like mm-agent-bridge.
4. The text sent to DSH is a short header (`[Mattermost] Message from @alice in ~town-square …`), the earlier posts of the thread when the request is a thread reply, and `@alice: <request>`. It enters the session exactly like a prompt typed in the DSH window, so you can watch the conversation live in DSH.
5. The plugin waits for the DSH turn that consumed *that* prompt (matched by request id, not by "the agent became idle") and posts the turn's final assistant message. Failed, cancelled, blocked or timed-out turns get an explanatory reply instead.
6. While the turn waits for a human in DSH — a permission approval or an `ask_user_question` — the thread shows *Waiting for a permission approval in DSH: `bash`*, so the requester knows why it is slow.

## Install

Install the [published npm package](https://www.npmjs.com/package/dsh-mattermost) as a DSH bundle from the sidebar → **Plugins**, or with `dsh plugin --profile <profile> add dsh-mattermost`.

For development, install a local checkout instead:

```sh
git clone https://github.com/lastorder/dsh-mattermost.git
cd dsh-mattermost
pnpm install          # resolves @deepseek-ai/schemastery locally (needed until the next DSH restart)
```

Then sidebar → **Plugins** → install from a path, or `dsh plugin --profile <profile> add /path/to/dsh-mattermost`. You can also ask the DSH agent to install the bundle from that path (via `plugin_manager`).

The plugin starts idle until an environment is added.

> **Updating an installed copy:** DSH keeps the loaded plugin code until it restarts. After changing or pulling this package's code, **restart DSH**. Configuration changes never need a restart.

## Create a bot account in Mattermost

1. System Console → Integrations → **Bot Accounts**: enable bot account creation.
2. Integrations → Bot Accounts → **Add Bot Account**; choose a username (e.g. `dsh-bot`); copy the **access token**.
3. Add the bot to the channels it should listen in (DMs work without that).

A personal access token of a regular account works too (Profile → Security → Personal Access Tokens). Use a *dedicated* account: the bridge ignores its own posts, so mentions must come from other accounts.

> Do not run mm-agent-bridge and this plugin with the same bot token at the same time — both would answer every mention.

## Configure on the settings page

Sidebar → **Plugins** → *Mattermost Bridge*. Everything is editable there and **Save** applies it live: an environment whose server or token changed reconnects, added / removed / disabled environments connect or disconnect, all other settings apply to the next message.

**Mattermost environments** — one card per server / bot account, with a live status (*Connected @bot*, *Token rejected*, *Disabled*, …):

| Field | Meaning |
|---|---|
| Name, enable switch | Tell environments apart; disabled ones stay configured but disconnected. |
| Server URL | e.g. `https://mattermost.example.com` (`https://` assumed without a scheme; subpath deployments work). |
| Access token | Stored as a secret: never shown again, never sent to the page. Leave empty to keep the saved one. |
| **Test connection** | Signs in with the entered (or saved) token and authenticates the WebSocket; shows the bot account or the error. |
| **Routes** | `@name` → workspace directory → session mode (→ session). See below. |
| Triggers | @mentions of route names, direct messages, follow-ups in answered threads, server mention list, a custom regular expression + flags. |
| Scope | Channel filter (ids, names or display names) and user allow-list. |
| Online / offline notice | Greeting / goodbye posts in a channel. |
| Reconnect / Remove | Per environment. |

**Shared settings** (all environments): automatic session creation, default workspace directory, session title prefix, requests at the same time (`maxConcurrent`), reply content (last vs. every assistant message), reply timeout, thread context size, queue limit, maximum post length, @sender prefix, typing indicator, host suffix, ignoring bots, and the prompt's first line. **Reply texts** lets you replace every text the bot posts; **Diagnostics** sets a debug log file and the state file.

### Routes: which workspace and session answer

One environment (one bot token) can have several routes. Each route has:

| Field | Meaning |
|---|---|
| `@name` | The mention that selects the route, e.g. `orion-agent`. Empty: the bot account username. It does not have to be a real Mattermost user — the bot sees every post in its channels. |
| Workspace directory | The DSH workspace that answers (its skills, `AGENTS.md`, MCP servers apply). The field suggests your DSH workspaces; a directory that is not a workspace yet is added on first use. Empty: the shared default workspace. |
| Session mode | **One session** — every request in the same session; **new session per thread** — the first request of a Mattermost thread creates a session and follow-ups in that thread reuse it (also after a restart); **new session per message** — every request gets a fresh session. |
| Session (one-session mode) | Pick the session from the list (sessions of that workspace), or *Automatic*: the session bound with `/mattermost bind`, otherwise one created in the workspace on the first message (titled *Mattermost · @name*) and remembered. A deleted bound session is replaced automatically. |

The **first route** also takes direct messages without a mention, pattern matches and server-side mentions; a follow-up in a thread (with *follow-ups need no new mention*) stays with the route that answered the thread. An environment without routes behaves like one route: `@<bot username>` in one shared session.

Created sessions are titled *Mattermost · @name* (one-session mode) or *Mattermost · @name · \<first words of the request\>* (thread / per-message modes), so they are easy to find — and to archive — in the DSH sidebar.

### Triggers

| Trigger | Default |
|---|---|
| `@mention` of a route name (whole word: `@orion-agent-dev` does not trigger `@orion-agent`) | on |
| Any direct message to the bot (first route, unless it mentions another route) | on |
| A post matching your regular expression (first route); a named group `prompt` selects the text sent to DSH, e.g. `^!ask\s+(?<prompt>[\s\S]+)` | off |
| Later posts in a thread the bot already answered, without a new mention (the thread's route) | off |
| The server-side mention list (also contains `@channel`/`@all` fan-out) | off |

`ignoreBots` (shared, default on) skips bot and webhook posts.

## Configure in cordis.patch.yml (alternative)

The page writes your profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/cordis.patch.yml`); you can also edit it by hand. A patch replaces the row's whole `config`, so list every field you set:

```yaml
- id: mattermost
  name: dsh-mattermost
  config:
    connections:
      - id: company                    # stable key: keep it when renaming
        name: Company
        serverUrl: https://mattermost.example.com
        token: <bot access token>      # or: !!js process.env.MM_TOKEN
        allowedUsers: [alice, bob]
        routes:
          - id: orion-agent
            mentionName: orion-agent
            workspace: /path/to/orion-agent
            sessionMode: shared        # shared | thread | new
          - id: orion-wizard
            mentionName: orion-wizard
            workspace: /path/to/orion-wizard
            sessionMode: new
      - id: local
        name: Local test
        serverUrl: http://localhost:8065
        token: <token>
        enabled: false
    maxConcurrent: 3
    replyTimeoutMinutes: 30
```

### All options

Per environment (`connections[]`):

| Field | Default | Meaning |
|---|---|---|
| `id` | derived from the name | Stable key for bindings and status. The page generates one. |
| `name` | — | Display name. |
| `enabled` | `true` | Connect this environment. |
| `serverUrl`, `token` | — | Server and bot (or personal) access token. |
| `routes` | `[]` | See the route fields below. Empty: one implicit route (`mentionName`, `sessionId`). |
| `mentionName`, `sessionId` | bot username, — | Only without routes: the name to listen for and a pinned session. |
| `triggerOnMention` / `triggerOnDirectMessage` | `true` / `true` | See [Triggers](#triggers). |
| `followThreads` | `false` | Answer follow-ups in threads the bot already answered. |
| `matchMentionsList` | `false` | Trust the server's mention list too. |
| `triggerPattern` / `triggerPatternFlags` | — / `i` | Custom match. |
| `channels` / `allowedUsers` | `[]` (all) | Channel filter / user allow-list. |
| `greetingEnabled`, `greetingChannelId`, `greetingMessage`, `goodbyeMessage` | off | Post when the environment connects / stops. |

Per route (`connections[].routes[]`):

| Field | Default | Meaning |
|---|---|---|
| `id` | derived from `mentionName` | Stable key for bindings and thread sessions. The page generates one. |
| `mentionName` | bot username | The `@name` that selects the route. |
| `workspace` | shared `workspace` | Workspace directory whose sessions answer. |
| `sessionMode` | `shared` | `shared`: one session; `thread`: a new session per thread, reused for follow-ups; `new`: a new session per message. |
| `sessionId` | — | `shared` mode: the pinned session (else `/mattermost bind`, else created automatically). |

Shared:

| Field | Default | Meaning |
|---|---|---|
| `autoCreateSession` | `true` | `shared` routes: create and bind a session when none is pinned or bound. |
| `workspace` | first workspace | Workspace directory of routes without their own. |
| `sessionTitle` | `Mattermost` | Title prefix of created sessions (the route is appended). |
| `maxConcurrent` | `3` | Requests per environment that run at the same time; one shared session or thread always runs in order. |
| `ignoreBots` | `true` | Ignore bot and webhook posts. |
| `threadContextMaxMessages` | `20` | Earlier thread posts sent as context (0 disables). |
| `queueMaxSize` | `10` | Waiting requests per environment; more are rejected. |
| `replyTimeoutMinutes` | `60` | Stop waiting for DSH after this long (0 = forever); the DSH turn itself continues. |
| `replyMode` | `final` | `final`: last assistant message of the turn; `all`: every assistant message. |
| `mentionSender` | `true` | Prefix replies with `@sender`. |
| `promptHeader` | see `lib/core.js` | First line of the prompt (`{user}`, `{channel}`); empty disables it. |
| `typingIndicator` | `true` | Show "is typing…" in the thread while DSH works. |
| `showHost` | `false` | Append `(host: <hostname>)` to every post. |
| `maxPostLength` | `16000` | Longer answers are split into several posts (code fences are re-opened across parts). |
| `messages` | English defaults | `queued`, `queueFull`, `processing`, `error`, `empty`, `unauthorized`, `cancelled`, `timeout`, `noReply`, `noSession`, `waitingApproval` (`{tool}`), `waitingAnswer` (`{question}`), `stopped`. |
| `stateFile` | `~/.dsh/mattermost/state.json` | Where bound sessions and thread sessions are stored. |
| `debugLogFile` | — | Append diagnostic lines to this file. |

## The `/mattermost` command

Run it in any DSH session. `[target]` is an environment (`local`), a route (`@orion-agent`, `local/@orion-agent`) or `all`; it can be omitted when there is only one choice:

| Command | Effect |
|---|---|
| `/mattermost` or `/mattermost status` | Every environment and route: connection, bot account, workspace, session mode and session, queue, last request and error. |
| `/mattermost bind [target]` | Make *this* session answer the target's one-session routes (thread / per-message routes are skipped). |
| `/mattermost unbind [target]` | Remove bindings (without an argument: every route bound to this session). |
| `/mattermost reconnect [env\|all]` | Reconnect (default: all). |
| `/mattermost log` | The bridge's recent log lines. |

## Things to know

- **Approvals.** A session whose permission mode asks for approvals pauses until someone approves in DSH; the thread says so. Pick the workspace's permission preset with that in mind — a remote Mattermost user cannot approve anything.
- **Shared session.** A bound session is an ordinary DSH session; you can keep using it in the DSH window. Mattermost prompts queue behind your own turns and vice versa.
- **Per-message / per-thread sessions** accumulate in the workspace's session list; archive old ones in the DSH sidebar. Each new session starts the workspace's MCP servers, so its first answer takes a few seconds longer.
- **Missed messages.** Posts sent while DSH is not running (or the connection is down) are not replayed.
- **Attachments** are not forwarded; the prompt lists their file names.

## Mapping from mm-agent-bridge

| mm-agent-bridge (`.env`) | dsh-mattermost |
|---|---|
| `MM_URL`, `MM_PORT`, `MM_SCHEME` | environment *Server URL* (e.g. `https://host:443`) |
| `MM_TOKEN` | environment *Access token* |
| `BOT_MENTION_NAME` | a route's *@name* (add one route per name) |
| `MENTION_BY_ID` | environment *Server mention list* |
| `MM_USERNAME_WHITELIST` | environment *Only these users* |
| `OPENCODE_SESSION_ID` / `COPILOT_SESSION_ID` | a route's *Session* (one-session mode), or `/mattermost bind` |
| `GREETING_*`, `GOODBYE_MESSAGE` | environment *Online / offline notice* |
| `QUEUE_MAX_SIZE` | *Queue limit* |
| `THREAD_CONTEXT_MAX_MESSAGES` | *Thread context messages* |
| `MSG_*` | *Reply texts* |
| `MSG_SHOW_HOST` | *Append the host name* |
| `AGENT_TYPE`, `OPENCODE_*`, `COPILOT_*` | not needed — the workspace's sessions, model and preset apply |

## Manual testing with a local Mattermost

The repository ships a disposable Mattermost server (`docker-compose.yml`: the `mattermost/mattermost-preview` image, which bundles its database) and a helper (`scripts/mm-local.mjs`) that prepares it for testing.

**Requirements:** Docker with Compose v2 (Docker Desktop, OrbStack, or colima). The image is `linux/amd64` only; on Apple Silicon it runs under Rosetta/QEMU emulation, so the first start takes about a minute.

### 1. Start and prepare the server

```sh
pnpm run mm:up      # start the container and wait until it is healthy
pnpm run mm:setup   # create the admin, the team, test users and the bot; print the bot token
```

`mm:setup` can be re-run safely and saves everything to `.mm-local.json` (git-ignored); `pnpm run mm:info` prints it again.

| What | Value |
|---|---|
| URL | http://localhost:8065 — team **DSH Test**, channels ~town-square and ~off-topic |
| Test users | `alice`, `bob`, `carol` — password `Dsh-Test-2026!` |
| Admin | `dsh-admin` / `Dsh-Admin-2026!` |
| Bot | `@dsh-bot`; its access token is printed by `mm:setup` / `mm:info` |

Port 8065 already taken? Use another one for both commands: `MM_PORT=8066 pnpm run mm:up && MM_PORT=8066 pnpm run mm:setup`.

### 2. Connect DSH

Restart DSH first if this plugin's code changed. Then sidebar → **Plugins** → *Mattermost Bridge* → **Add environment**: name `Local`, server URL `http://localhost:8065`, the bot token → **Test connection** (expect *Connected: signed in as @dsh-bot*) → **Save**. The card turns to *Connected @dsh-bot*.

To try routes, add two in the card, e.g. `@orion-agent` → one workspace with *One session*, `@orion-wizard` → another workspace with *New session per message*, and **Save**. Typing `@orion-agent` in Mattermost works although no such user exists — the bot reads every post of its channels.

### 3. Checklist

Log in at http://localhost:8065 as `alice` and open **DSH Test → Town Square**:

| # | Do | Expect |
|---|---|---|
| 1 | Post `@dsh-bot hello` (no routes) | In the thread *Processing your request…* appears and is replaced by the answer; the prompt shows up in the DSH session. |
| 2 | Reply in that thread: `@dsh-bot what did I just say?` | The answer uses the thread as context. |
| 3 | Turn on *follow-ups need no new mention*, reply in the thread without @ | Answered. |
| 4 | Open a direct message with `dsh-bot`, write without @ | Answered (by the first route). |
| 5 | Post two mentions of the same one-session route right after each other (e.g. alice, then bob in another browser) | The second shows *queued* and is answered after the first. |
| 6 | With two routes: ask each `@name` "reply with only your working directory" | Each answers from its own workspace; the sessions appear in those workspaces in DSH. |
| 7 | Ask `@orion-agent` twice and `@orion-wizard` twice | `@orion-agent` reuses one session *Mattermost · @orion-agent*; `@orion-wizard` creates a new session each time. |
| 8 | Switch a route to *New session per thread*; ask, then follow up in the same thread | The follow-up continues in the thread's session; a new thread gets a new one. |
| 9 | Post to both routes at the same moment | Both are answered without waiting for each other (`/mattermost status` shows 2 running). |
| 10 | Set *Only these users* to `alice`; post as `carol` | *You do not have permission to use this agent.* |
| 11 | Set *Only these channels* to `town-square`; post in ~off-topic | No reply. |
| 12 | Set the custom match to `^!ask\s+(?<prompt>[\s\S]+)`; post `!ask what is 2+2` | Answered (first route) without a mention. |
| 13 | Set *Maximum post length* to 1000; ask for the numbers 1–300, one per line | The answer arrives in several posts. |
| 14 | Run `docker restart dsh-mattermost-mm` | The card shows *Reconnecting*, then *Connected* again within about a minute. |
| 15 | Run `/mattermost status` in a DSH session | Every route with its workspace, session mode and session, and the last request. |

`pnpm run mm:post` does the posting from a terminal: it posts as a test user and waits for the bot's final reply (exit code 2 when none comes).

```sh
pnpm run mm:post "@dsh-bot hello"                              # alice in ~town-square
pnpm run mm:post "@orion-wizard what can you do?"              # a route
pnpm run mm:post --as bob --dm "hello"                         # direct message
pnpm run mm:post --reply-to <postId> "@dsh-bot and then?"      # reply in a thread
pnpm run mm:post --channel off-topic --timeout 20 "@dsh-bot hi"
pnpm run mm:post --no-wait "@orion-agent one" & pnpm run mm:post --as bob --no-wait "@orion-wizard two" & wait   # both at once
```

### 4. Stop

`docker compose stop` keeps the data for the next `docker compose start`; `pnpm run mm:down` deletes the container and all its Mattermost data (run `mm:setup` again after the next `mm:up`, and update the token in DSH).

## Development

```sh
pnpm install
pnpm test            # unit + integration tests (fake Mattermost server, fake DSH, page logic + server render)
pnpm run verify      # syntax checks + tests
pnpm run fake-mattermost -- --port 18065 --token test-token   # a fake server for manual runs
```

The fake server (`scripts/fake-mattermost.js`) implements the REST calls and WebSocket the plugin uses, plus control routes: `POST /_test/post {"message":"@dsh-bot hi","user":"user-alice"}` injects a post, `GET /_test/state` shows what the bot posted. Add it as an environment (`http://127.0.0.1:18065`, token `test-token`) to try the plugin end to end without a Mattermost server.

| File | Role |
|---|---|
| `index.js` | Host half: Config schema, environment lifecycle, `/mattermost` command, approval notices, page endpoints, binding store. |
| `lib/bridge.js` | One environment: routing, lanes and concurrency, session selection per mode, turn tracking, replies. |
| `lib/config.js` | Environment and route normalization, keys, and settings merge. |
| `lib/mattermost.js` | Mattermost REST client, WebSocket (auth, ping, reconnect) and connection probe. |
| `lib/core.js` | Pure helpers: event parsing, triggers, prompt, message splitting. |
| `client.js` | Client half: the settings page on the Plugins panel. |
| `docker-compose.yml`, `scripts/mm-local.mjs` | Local Mattermost for manual testing (see above). |
| `scripts/fake-mattermost.js` | Fake Mattermost for the automated tests. |

## Publishing (maintainers)

The CI workflow (`.github/workflows/ci.yml`) runs `pnpm run verify` and audits the npm tarball on pushes and pull requests. The release workflow (`.github/workflows/publish.yml`) uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (GitHub OIDC), **not** an npm access token in GitHub Secrets. It runs on a non-prerelease GitHub Release whose tag exactly matches `v<package.json version>`. Only release from a reviewed, protected tag.

**Initial release (`0.1.0`)** is published once from a maintainer's own machine, after `npm login --registry=https://registry.npmjs.org/`, `pnpm run verify`, and `npm publish --access public`. Do not commit `.npmrc`, `.mm-local.json`, or credentials. `prepublishOnly` runs verification again. A version already published to npm cannot be published a second time.

After the first release, the package owner must visit **npmjs.com → dsh-mattermost → Settings → Trusted Publishers** and add a GitHub Actions publisher: owner `lastorder`, repository `dsh-mattermost`, workflow filename **`publish.yml`**. Allow direct `npm publish` (rather than stage-only). No `NPM_TOKEN` or `NODE_AUTH_TOKEN` GitHub secret is needed. Complete the first trusted release within two days of adding the publisher, or reconfigure it; see [npm's instructions](https://docs.npmjs.com/trusted-publishers/). Public GitHub releases published via this workflow include npm provenance automatically; the initial local version does not.

For a **later** release, bump the version, commit, tag, push, then publish a non-prerelease GitHub Release (replace `0.1.1` with the new version):

```sh
npm version patch --no-git-tag-version
pnpm install --lockfile-only
pnpm run verify
git add package.json pnpm-lock.yaml
git commit -m "release: v0.1.1"
git tag v0.1.1
git push origin main v0.1.1
gh release create v0.1.1 --verify-tag --title "v0.1.1" --generate-notes
```

Check the release workflow and `npm view dsh-mattermost version` afterwards. Do **not** create a GitHub Release for `v0.1.0`: it was published locally already and cannot be re-published by the workflow.

## License

MIT
