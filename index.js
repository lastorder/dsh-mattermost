/**
 * dsh-mattermost — Host half.
 *
 * Listens to one or more Mattermost environments (server + bot account) over
 * their WebSocket APIs, picks the posts that address the bot (an @mention, a
 * direct message, a configured pattern, or a follow-up in a thread it already
 * answered), routes each one by the `@name` it uses to a DSH workspace and
 * session, waits for that turn to finish, and posts the assistant's answer
 * back into the Mattermost thread.
 *
 * Every Config field is `volatile`, so the Plugins page edits it live: an
 * environment whose server or token changed reconnects, added/removed/
 * disabled environments start/stop, everything else (routes included)
 * applies to the next message. The page talks to this half through
 * authenticated `/api/dsh-mattermost/<entry>/…` routes (status, sessions,
 * workspaces, test, reconnect).
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { MattermostBridge, TurnTracker, describe } from './lib/bridge.js'
import { DEFAULT_MESSAGES, DEFAULT_PROMPT_HEADER } from './lib/core.js'
import { SESSION_MODES, connectionLabel, mergeSettings, normalizeConnections, routeLabel } from './lib/config.js'
import { MattermostRest, probeSocket, resolveEndpoints } from './lib/mattermost.js'

export const name = 'dsh-mattermost'
export const inject = ['sessionController']

const Messages = Schema.object(Object.fromEntries(
  Object.entries(DEFAULT_MESSAGES).map(([key, value]) => [key, Schema.string().default(value)]),
)).description('Texts the bot posts to Mattermost. `{tool}` and `{question}` are filled in the waiting notices.')

/** One route of an environment: an @mention name answered in one DSH workspace. */
export const Route = Schema.object({
  id: Schema.string().description('Stable identifier; bindings and thread sessions follow it.'),
  mentionName: Schema.string().description('The @name that selects this route, without @. Empty: the bot account username.'),
  workspace: Schema.string().description('DSH workspace directory whose sessions answer (its skills and instructions apply). Empty: the shared workspace setting, else the first workspace.'),
  sessionMode: Schema.union(SESSION_MODES).default('shared').description('shared: one session answers every request; thread: a new session per Mattermost thread, reused for its follow-ups; new: a new session for every request.'),
  sessionId: Schema.string().description('shared mode: the session that answers. Empty: the session bound with `/mattermost bind`, or one created in the workspace.'),
  channels: Schema.array(Schema.string()).default(undefined).description('Channels this route listens to (id, name or display name). Empty: all; omitted: inherit the legacy environment filter. DMs are independent.'),
  allowedUsers: Schema.array(Schema.string()).default(undefined).description('Usernames allowed to use this route. Empty: everyone; omitted: inherit the legacy environment filter.'),
  triggerOnDirectMessage: Schema.boolean().description('Answer direct messages without a matching route mention. The first route is enabled by default; other routes are off by default.'),
  followThreads: Schema.boolean().description('Answer follow-ups in a thread previously handled by this route, without another mention.'),
  matchMentionsList: Schema.boolean().description('Trust the server-side bot mention list, including @channel/@all fan-out.'),
  triggerPattern: Schema.string().description('Regular expression matching posts for this route. Named group `prompt` becomes the DSH question.'),
  triggerPatternFlags: Schema.string().description('Flags for this route’s regular expression (i ignores case; g/y are ignored).'),
})

/** One Mattermost environment: a server, a bot account, and how it is used. */
export const Connection = Schema.object({
  id: Schema.string().description('Stable identifier; bindings and status follow it.'),
  name: Schema.string().description('Display name, e.g. "Company" or "Local test".'),
  enabled: Schema.boolean().default(true).description('Connect this environment.'),
  serverUrl: Schema.string().description('Mattermost server URL, e.g. https://mattermost.example.com (https is assumed without a scheme).'),
  token: Schema.string().role('secret').description('Access token of the bot account (or a personal access token).'),
  routes: Schema.array(Route).default([]).description('Routes by @mention, workspace, session mode, and route-specific triggers. Empty: one implicit route with the bot username and legacy environment triggers.'),
  routeToAllMatches: Schema.boolean().default(false).description('Off: deliver a post to one best-matching route. On: deliver it once to every matching route; each posts an identifiable reply.'),
  sessionId: Schema.string().description('Legacy fallback when no routes are configured: the DSH session that answers.'),
  mentionName: Schema.string().description('Legacy fallback when no routes are configured: the username to listen for without @.'),
  triggerOnMention: Schema.boolean().default(true).description('Legacy trigger fallback for pre-route configs; edit each route’s triggers in the Plugins page.'),
  triggerOnDirectMessage: Schema.boolean().default(true).description('Legacy trigger fallback for pre-route configs; edit each route’s triggers in the Plugins page.'),
  followThreads: Schema.boolean().default(false).description('Legacy trigger fallback for pre-route configs; edit each route’s triggers in the Plugins page.'),
  matchMentionsList: Schema.boolean().default(false).description('Legacy trigger fallback for pre-route configs; edit each route’s triggers in the Plugins page.'),
  triggerPattern: Schema.string().description('Legacy trigger fallback for pre-route configs; edit each route’s triggers in the Plugins page.'),
  triggerPatternFlags: Schema.string().default('i').description('Legacy trigger fallback for pre-route configs; edit each route’s triggers in the Plugins page.'),
  channels: Schema.array(Schema.string()).default([]).description('Legacy default channel filter for routes without their own channels; also applies to the implicit route.'),
  allowedUsers: Schema.array(Schema.string()).default([]).description('Legacy default user allow-list for routes without their own allowedUsers; also applies to the implicit route.'),
  greetingEnabled: Schema.boolean().default(false).description('Post a greeting when the environment connects and a goodbye when it stops.'),
  greetingChannelId: Schema.string().description('Channel id that receives the greeting and goodbye.'),
  greetingMessage: Schema.string().description('Greeting text; defaults to an "online and ready" notice that names the mentions.'),
  goodbyeMessage: Schema.string().description('Goodbye text.'),
})

export const Config = Schema.object({
  connections: Schema.array(Connection).default([]).description('Mattermost environments. Each enabled one connects with its own bot account and routes its posts to DSH sessions.').volatile(),
  autoCreateSession: Schema.boolean().default(true).description('shared-mode routes: create a session when none is pinned or bound.').volatile(),
  workspace: Schema.string().description('Workspace directory for created sessions of routes without their own workspace; defaults to the first workspace.').volatile(),
  sessionTitle: Schema.string().default('Mattermost').description('Title prefix of created sessions (the route or environment is appended).').volatile(),
  maxConcurrent: Schema.natural().min(1).default(3).description('Requests per environment that may run at the same time. Requests of one shared session or one thread always run one after another.').volatile(),
  ignoreBots: Schema.boolean().default(true).description('Ignore posts from bot accounts and incoming webhooks.').volatile(),
  threadContextMaxMessages: Schema.natural().default(20).description('Earlier thread posts included as context (0 disables).').volatile(),
  queueMaxSize: Schema.natural().default(10).description('Requests per environment that may wait; more are rejected.').volatile(),
  replyTimeoutMinutes: Schema.number().min(0).default(60).description('Stop waiting for a DSH answer after this many minutes (0 waits forever).').volatile(),
  replyMode: Schema.union(['final', 'all']).default('final').description('final: the last assistant message of the turn; all: every assistant message of the turn.').volatile(),
  mentionSender: Schema.boolean().default(true).description('Start replies with @sender.').volatile(),
  promptHeader: Schema.string().default(DEFAULT_PROMPT_HEADER).description('First line of the prompt sent to DSH ({user}, {channel}); empty disables it.').volatile(),
  typingIndicator: Schema.boolean().default(true).description('Show "is typing" in the thread while DSH works.').volatile(),
  showHost: Schema.boolean().default(false).description('Append "(host: <hostname>)" to every post.').volatile(),
  maxPostLength: Schema.natural().min(1000).default(16000).description('Longer replies are split into several posts.').volatile(),
  messages: Messages.volatile(),
  stateFile: Schema.string().description('Where bound sessions and thread sessions are stored. Default: <DSH home>/mattermost/state.json').volatile(),
  debugLogFile: Schema.string().description('Append diagnostic lines to this file (empty disables).').volatile(),
})

const read = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
const TITLE_CACHE_MS = 15_000
const SESSION_LIST_LIMIT = 200
const THREAD_SESSION_LIMIT = 500

/** Binding-store key of one route: the environment alone for its implicit route. */
const bindingKey = (connectionKey, routeKey) => (routeKey ? `${connectionKey}/${routeKey}` : connectionKey)

export function apply(ctx, config) {
  // Settings are read on every post: compute them once per configuration change.
  let sharedCache
  let environmentsCache
  const settingsCache = new Map()
  const known = new Map()
  const shared = () => {
    if (sharedCache) return sharedCache
    const snapshot = {}
    for (const key of Object.keys(config ?? {})) if (key !== 'connections') snapshot[key] = read(config[key])
    snapshot.messages = { ...DEFAULT_MESSAGES, ...(snapshot.messages ?? {}) }
    return (sharedCache = snapshot)
  }
  /** Normalized environments; `known` keeps the last form of removed ones for their stopping bridges. */
  const environments = () => {
    if (environmentsCache) return environmentsCache
    environmentsCache = normalizeConnections(read(config?.connections))
    for (const connection of environmentsCache) known.set(connection.key, connection)
    return environmentsCache
  }
  const settingsOf = (key) => {
    environments()
    let merged = settingsCache.get(key)
    if (!merged) settingsCache.set(key, (merged = mergeSettings(shared(), known.get(key))))
    return merged
  }
  const invalidate = () => {
    sharedCache = undefined
    environmentsCache = undefined
    settingsCache.clear()
  }

  const named = typeof ctx.logger === 'function' ? ctx.logger('mattermost') : undefined
  const recent = []
  const log = (level, message) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`
    recent.push(line)
    if (recent.length > 80) recent.shift()
    try {
      const target = named ?? ctx.logger ?? console
      ;(target[level] ?? target.info ?? console.log).call(target, message)
    } catch {}
    const file = shared().debugLogFile
    if (typeof file === 'string' && file.trim() !== '') appendFile(file.trim(), `${line}\n`).catch(() => {})
  }

  const entryId = ctx.fiber?.entry?.options?.id ?? 'default'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateFile = () => {
    const configured = shared().stateFile
    return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : join(dshHome, 'mattermost', 'state.json')
  }
  const { bindings, threads } = createStateStore(stateFile, entryId, log)
  const turns = new TurnTracker((event, listener, options) => ctx.on(event, listener, options))

  const runtimes = new Map()
  let disposed = false
  const labelOf = (key) => connectionLabel(known.get(key) ?? { key })

  const createBridge = (key) => new MattermostBridge({
    key,
    name: () => labelOf(key),
    settings: () => settingsOf(key),
    log: (level, message) => log(level, `[${labelOf(key)}] ${message}`),
    turns,
    sessions: {
      prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
      create: (request) => ctx.sessionController.create(request),
      rename: (request) => ctx.sessionController.rename(request),
    },
    get workspaces() { return ctx.get('workspaceRegistry') },
    agentOf: (id) => ctx.get('agents')?.get?.(id),
    binding: {
      get: (routeKey) => bindings.get(bindingKey(key, routeKey)),
      set: (routeKey, id) => bindings.set(bindingKey(key, routeKey), id),
    },
    threads: {
      get: (threadKey) => threads.get(`${key}/${threadKey}`),
      set: (threadKey, id) => threads.set(`${key}/${threadKey}`, id),
    },
    hostname: hostname(),
  })

  // Reconcile running bridges with the configured environments, one pass at a time.
  let chain = Promise.resolve()
  const sync = () => {
    chain = chain.then(async () => {
      if (disposed) return
      const wanted = new Map(environments().filter((connection) => connection.enabled).map((connection) => [connection.key, connection]))
      const stopping = []
      for (const [key, runtime] of runtimes) {
        if (wanted.has(key)) continue
        runtimes.delete(key)
        log('info', `[${labelOf(key)}] disconnecting: removed or disabled`)
        stopping.push(runtime.bridge.stop({ goodbye: true }))
      }
      await Promise.allSettled(stopping)
      for (const [key, connection] of wanted) {
        if (disposed) return
        const signature = JSON.stringify([connection.serverUrl, connection.token])
        const runtime = runtimes.get(key)
        if (runtime?.signature === signature) continue
        if (runtime) {
          runtime.signature = signature
          log('info', `[${labelOf(key)}] server or token changed; reconnecting`)
          await runtime.bridge.restart()
          continue
        }
        const bridge = createBridge(key)
        runtimes.set(key, { bridge, signature })
        bridge.start()
      }
    }).catch((error) => log('warn', `applying the configuration failed: ${describe(error)}`))
    return chain
  }

  ctx.effect(() => {
    void sync()
    return async () => {
      disposed = true
      const all = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(all.map((runtime) => runtime.bridge.stop({ goodbye: true })))
      turns.dispose()
    }
  }, 'mattermost: bridges')

  ctx.on('loader/volatile-update', () => {
    invalidate()
    void sync()
  })

  // While a Mattermost request runs, tell its thread when DSH waits for a human.
  // Both events are waterfalls whose real answerer never calls next(): stay outermost and pass through.
  ctx.on('approval/request', (request, next) => {
    for (const { bridge } of runtimes.values()) {
      try { bridge.notifyWaiting(request?.agent, 'approval', request?.toolName) } catch {}
    }
    return next()
  }, { prepend: true })
  ctx.on('user-questions/request', (request, next) => {
    const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
    for (const { bridge } of runtimes.values()) {
      try { bridge.notifyWaiting(request?.agent, 'question', first?.question ?? first?.header) } catch {}
    }
    return next()
  }, { prepend: true })

  const titles = new Map()
  const titleOf = async (sessionId) => {
    const cached = titles.get(sessionId)
    if (cached && Date.now() - cached.at < TITLE_CACHE_MS) return cached.title
    let title
    try {
      const snapshot = await ctx.get('sessionQuery')?.readTitle?.(sessionId)
      title = typeof snapshot === 'string' ? snapshot : (typeof snapshot?.title === 'string' ? snapshot.title : undefined)
    } catch {}
    titles.set(sessionId, { title, at: Date.now() })
    if (titles.size > 500) titles.delete(titles.keys().next().value)
    return title
  }

  /** Where one route's requests go, from the configuration and bindings (for environments without a running bridge). */
  const targetOf = (connection, route) => {
    if (route.sessionMode !== 'shared') return { id: undefined, source: route.sessionMode }
    if (route.sessionId) return { id: route.sessionId, source: 'config' }
    const bound = bindings.get(bindingKey(connection.key, route.key))
    if (bound) return { id: bound, source: 'binding' }
    return { id: undefined, source: shared().autoCreateSession === false ? 'none' : 'auto-create' }
  }

  /** Status of every configured environment, for the page and the command. */
  const statusOf = async ({ withTitles = false } = {}) => {
    const items = []
    for (const connection of environments()) {
      const status = runtimes.get(connection.key)?.bridge.status()
      const routes = status?.routes ?? connection.routes.map((route) => ({
        key: route.key,
        implicit: route.implicit === true,
        mentionName: route.mentionName || undefined,
        workspace: route.workspace || undefined,
        sessionMode: route.sessionMode,
        target: targetOf(connection, route),
      }))
      for (const route of routes) {
        if (withTitles && route.target?.id) route.target = { ...route.target, title: await titleOf(route.target.id) }
      }
      items.push({
        key: connection.key,
        name: connectionLabel(connection),
        enabled: connection.enabled,
        serverUrl: connection.serverUrl,
        hasToken: connection.token !== '',
        routeToAllMatches: connection.routeToAllMatches,
        state: status?.connection.state ?? (connection.enabled ? 'starting' : 'disabled'),
        detail: status?.connection.detail,
        since: status?.connection.since,
        bot: status?.bot,
        mentionName: routes[0]?.mentionName ?? status?.bot,
        routes,
        target: routes[0]?.target,
        queue: status?.queue ?? 0,
        running: status?.running ?? 0,
        active: status?.active ?? [],
        current: status?.current,
        lastRequest: status?.lastRequest,
        lastError: status?.lastError,
        patternError: status?.patternError,
      })
    }
    return items
  }

  ctx.inject(['commands'], (child) => {
    child.commands.register({
      name: 'mattermost',
      description: 'Mattermost bridge: show its status, or bind this session to answer Mattermost messages',
      input: { hint: '[status | bind [env|@route|all] | unbind [env|@route|all] | reconnect [env|all] | log]' },
      handler: (invocation) => runCommand(invocation, { environments, runtimes, bindings, recent, stateFile, statusOf }),
    })
    log('info', 'registered the /mattermost command')
  })

  ctx.inject(['connection'], (child) => {
    const prefix = `/api/dsh-mattermost/${entryId}`
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
    const body = async (request) => {
      try { return await request.json() } catch { return undefined }
    }
    const route = (path, method, handler) => child.effect(() => child.connection.fetch.register({
      path: `${prefix}/${path}`,
      methods: [method],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(request)
        } catch (error) {
          return json({ ok: false, error: describe(error) }, 500)
        }
      },
    }), `mattermost: ${prefix}/${path}`)

    route('status', 'GET', async () => json({ ok: true, entry: entryId, connections: await statusOf({ withTitles: true }) }))
    route('sessions', 'GET', async (request) => json({ ok: true, sessions: await listSessions(ctx, request.signal) }))
    route('workspaces', 'GET', async () => json({ ok: true, workspaces: listWorkspaces(ctx) }))
    route('test', 'POST', async (request) => {
      const input = await body(request)
      if (input === undefined || typeof input !== 'object') return json({ ok: false, error: 'expected a JSON body' }, 400)
      const saved = typeof input.key === 'string' ? environments().find((connection) => connection.key === input.key) : undefined
      return json(await testConnection({
        serverUrl: typeof input.serverUrl === 'string' && input.serverUrl.trim() !== '' ? input.serverUrl : saved?.serverUrl,
        token: typeof input.token === 'string' && input.token.trim() !== '' ? input.token : saved?.token,
      }))
    })
    route('reconnect', 'POST', async (request) => {
      const input = await body(request)
      const key = typeof input?.key === 'string' ? input.key : 'all'
      const targets = [...runtimes.entries()].filter(([candidate]) => key === 'all' || candidate === key)
      if (targets.length === 0) return json({ ok: false, error: `no running environment "${key}"` }, 404)
      await Promise.all(targets.map(([, runtime]) => runtime.bridge.restart()))
      return json({ ok: true })
    })
    log('info', `serving the settings page endpoints under ${prefix}`)
  })

  log('info', `loaded (entry ${entryId})`)
}

/** Registered DSH workspaces, for the route editor. */
function listWorkspaces(ctx) {
  try {
    return (ctx.get('workspaceRegistry')?.list?.() ?? [])
      .filter((workspace) => typeof workspace?.path === 'string')
      .map((workspace) => ({ id: workspace.id, title: workspace.title || basename(workspace.path), path: workspace.path }))
  } catch {
    return []
  }
}

/** Recent top-level sessions with their titles and workspaces, for the session picker. */
async function listSessions(ctx, signal) {
  const listing = await ctx.sessionController.list({}, signal)
  const items = Array.isArray(listing?.items) ? listing.items : []
  const registry = ctx.get('workspaceRegistry')
  const workspaceOf = new Map()
  let archived = new Set()
  try {
    for (const workspace of registry?.list?.() ?? []) {
      for (const id of workspace.sessionIds ?? []) workspaceOf.set(id, workspace)
    }
    archived = new Set(registry?.archivedSessionIds ?? [])
  } catch {}
  const sessions = []
  for (const item of items) {
    if (sessions.length >= SESSION_LIST_LIMIT) break
    if (!item || typeof item.sessionId !== 'string' || item.origin === 'subagent' || archived.has(item.sessionId)) continue
    const workspace = workspaceOf.get(item.sessionId)
    const title = item.projections?.values?.title
    sessions.push({
      id: item.sessionId,
      title: typeof title === 'string' ? title : null,
      workspace: workspace?.title || (workspace?.path ? basename(workspace.path) : (item.cwd ? basename(item.cwd) : '')),
      path: workspace?.path ?? item.cwd ?? '',
      updatedAt: item.updatedAt,
      running: item.running === true,
      blank: item.blank === true,
    })
  }
  return sessions
}

/** Check a server URL and token: REST sign-in, then WebSocket authentication. Never throws. */
export async function testConnection({ serverUrl, token, fetch: fetchImpl, WebSocket: WebSocketImpl } = {}) {
  if (typeof serverUrl !== 'string' || serverUrl.trim() === '') return { ok: false, error: 'The server URL is empty.' }
  if (typeof token !== 'string' || token.trim() === '') return { ok: false, error: 'The access token is empty.' }
  let endpoints
  try {
    endpoints = resolveEndpoints(serverUrl)
  } catch (error) {
    return { ok: false, error: describe(error) }
  }
  const rest = new MattermostRest({ apiBase: endpoints.apiBase, token: token.trim(), timeoutMs: 10_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  let me
  try {
    me = await rest.me()
  } catch (error) {
    return { ok: false, siteUrl: endpoints.siteUrl, error: describe(error) }
  }
  const socket = await probeSocket({ wsUrl: endpoints.wsUrl, token: token.trim(), ...(WebSocketImpl ? { WebSocket: WebSocketImpl } : {}) })
  return {
    ok: socket.ok,
    siteUrl: endpoints.siteUrl,
    username: typeof me?.username === 'string' ? me.username : undefined,
    isBot: me?.is_bot === true,
    websocket: socket.ok ? 'ok' : socket.error,
    ...(socket.ok ? {} : { error: `Signed in as @${me?.username ?? '?'}, but the WebSocket failed: ${socket.error}` }),
  }
}

const NO_ENVIRONMENT = 'No Mattermost environment is configured yet. Add one on the Plugins page (sidebar → Plugins → Mattermost Bridge).'

/** Resolve which environments a command argument names. */
function pickEnvironments(list, target, { emptyMeansAll = false } = {}) {
  const names = list.map((connection) => connection.key).join(', ')
  if (list.length === 0) return { error: NO_ENVIRONMENT }
  if (!target) {
    if (list.length === 1 || emptyMeansAll) return { items: list }
    return { error: `Several environments are configured (${names}). Name one, or use "all".` }
  }
  if (target.toLowerCase() === 'all') return { items: list }
  const wanted = target.toLowerCase()
  const items = list.filter((connection) => connection.key.toLowerCase() === wanted || connection.name.toLowerCase() === wanted || connectionLabel(connection).toLowerCase() === wanted)
  return items.length > 0 ? { items } : { error: `No environment named "${target}". Configured: ${names}.` }
}

/** `env`, `env/route` or `@route` label of one route for the command. */
const routeName = (connection, route) => (route.implicit ? connection.key : `${connection.key}/${route.mentionName ? `@${route.mentionName}` : route.key}`)

/**
 * Resolve which routes a `bind`/`unbind` argument names: an environment (all
 * its routes), a route (`@orion-agent`, `orion-agent`, `env/@orion-agent`),
 * or `all`. Without an argument there must be exactly one shared route.
 */
function pickRoutes(list, target) {
  if (list.length === 0) return { error: NO_ENVIRONMENT }
  const pairs = list.flatMap((connection) => connection.routes.map((route) => ({ connection, route })))
  const known = pairs.map(({ connection, route }) => routeName(connection, route)).join(', ')
  if (!target) {
    const sharedRoutes = pairs.filter(({ route }) => route.sessionMode === 'shared')
    if (sharedRoutes.length === 1) return { items: sharedRoutes }
    return { error: `Name the route to bind (${known}), or use "all".` }
  }
  const wanted = target.toLowerCase().replace(/^@/, '')
  if (wanted === 'all') return { items: pairs }
  const items = pairs.filter(({ connection, route }) => {
    const environment = [connection.key, connection.name, connectionLabel(connection)].map((value) => value.toLowerCase())
    const routeNames = [route.key, route.mentionName].filter(Boolean).map((value) => value.toLowerCase())
    const qualified = routeNames.flatMap((value) => environment.flatMap((env) => [`${env}/${value}`, `${env}/@${value}`]))
    return environment.includes(wanted) || routeNames.includes(wanted) || qualified.includes(wanted)
  })
  return items.length > 0 ? { items } : { error: `No route or environment named "${target}". Routes: ${known}.` }
}

async function runCommand({ agent, rawInput }, deps) {
  const words = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const action = (words.shift() ?? 'status').toLowerCase()
  const target = words.join(' ')
  const list = deps.environments()
  switch (action) {
    case 'bind': {
      if (!agent?.id) return { kind: 'error', text: 'No session to bind.' }
      const picked = pickRoutes(list, target)
      if (picked.error) return { kind: 'error', text: picked.error }
      const lines = []
      for (const { connection, route } of picked.items) {
        const label = route.implicit ? connectionLabel(connection) : `${connectionLabel(connection)} ${routeLabel(route)}`
        if (route.sessionMode !== 'shared') {
          lines.push(`${label}: skipped — it creates a ${route.sessionMode === 'new' ? 'new session for every request' : 'new session per thread'}.`)
          continue
        }
        await deps.bindings.set(bindingKey(connection.key, route.key), agent.id)
        const pinned = route.sessionId && route.sessionId !== agent.id
          ? ` (note: its settings pin session ${route.sessionId}, which takes precedence; clear it on the Plugins page to use this binding)`
          : ''
        lines.push(`${label}: messages will be answered in this session${pinned}.`)
      }
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'unbind': {
      const picked = target
        ? pickRoutes(list, target)
        : { items: list.flatMap((connection) => connection.routes.map((route) => ({ connection, route }))).filter(({ connection, route }) => deps.bindings.get(bindingKey(connection.key, route.key)) === agent?.id) }
      if (picked.error) return { kind: 'error', text: picked.error }
      if (picked.items.length === 0) return { kind: 'success', text: 'No route is bound to this session.' }
      for (const { connection, route } of picked.items) await deps.bindings.set(bindingKey(connection.key, route.key), undefined)
      return { kind: 'success', text: `Unbound: ${picked.items.map(({ connection, route }) => routeName(connection, route)).join(', ')}.` }
    }
    case 'reconnect': {
      const picked = pickEnvironments(list, target, { emptyMeansAll: true })
      if (picked.error) return { kind: 'error', text: picked.error }
      const running = picked.items.filter((connection) => deps.runtimes.has(connection.key))
      await Promise.all(running.map((connection) => deps.runtimes.get(connection.key).bridge.restart()))
      return { kind: 'success', text: running.length > 0 ? `Reconnecting: ${running.map(connectionLabel).join(', ')}.` : 'No enabled environment to reconnect.' }
    }
    case 'log':
      return { kind: 'success', text: deps.recent.length > 0 ? deps.recent.join('\n') : 'No log lines yet.' }
    case 'status':
      return { kind: 'success', text: formatStatus(await deps.statusOf({ withTitles: true }), agent?.id, deps.stateFile()) }
    default:
      return { kind: 'error', text: `Unknown action "${action}". Use: status, bind [env|@route|all], unbind [env|@route|all], reconnect [env|all], log.` }
  }
}

const STATE_TEXT = {
  connected: 'connected',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  'auth-failed': 'token rejected',
  error: 'error',
  unconfigured: 'missing server URL or token',
  disabled: 'disabled',
  starting: 'starting',
  stopped: 'stopped',
}

const MODE_TEXT = { shared: 'one shared session', thread: 'a new session per thread', new: 'a new session per message' }

function formatStatus(items, here, stateFile) {
  if (items.length === 0) return NO_ENVIRONMENT
  const since = (time) => (time ? new Date(time).toLocaleString() : '')
  const connected = items.filter((item) => item.state === 'connected').length
  const lines = [`Mattermost environments: ${items.length} (${connected} connected)`]
  for (const item of items) {
    lines.push('')
    const who = item.bot ? ` as @${item.bot}` : ''
    lines.push(`▸ ${item.name} [${item.key}] — ${STATE_TEXT[item.state] ?? item.state}${who}${item.detail && item.state !== 'connected' ? ` (${item.detail})` : ''}`)
    if (item.serverUrl) lines.push(`  Server: ${item.serverUrl}`)
    lines.push(`  Dispatch: ${item.routeToAllMatches ? 'every matching route (labeled replies)' : 'one best-matching route'}`)
    for (const route of item.routes ?? []) {
      const target = route.target ?? {}
      const session = target.id ? `${target.id}${target.title ? ` "${target.title}"` : ''}${target.id === here ? ' (this session)' : ''}` : ''
      const source = {
        config: `${session} — pinned in the settings`,
        binding: `${session} — bound with /mattermost bind (${stateFile})`,
        'auto-create': 'a session will be created on the first message',
        none: 'no session: run /mattermost bind in the session that should answer',
        thread: MODE_TEXT.thread,
        new: MODE_TEXT.new,
      }[target.source] ?? target.source
      const mention = route.mentionName ? `@${route.mentionName}` : (item.bot ? `@${item.bot}` : 'mentions')
      lines.push(`  ${mention} → ${route.workspace || 'default workspace'} · ${source}`)
    }
    if (item.enabled) {
      const working = (item.active ?? []).map((active) => `post ${active.postId} from @${active.username} (${active.state})`).join('; ')
      lines.push(`  Queue: ${item.queue} waiting, ${item.running ?? 0} running${working ? ` — ${working}` : ''}`)
    }
    if (item.lastRequest) lines.push(`  Last request: post ${item.lastRequest.postId} from @${item.lastRequest.username} — ${item.lastRequest.ok ? 'answered' : 'failed'} at ${since(item.lastRequest.finishedAt)}`)
    if (item.patternError) lines.push(`  Trigger pattern error: ${item.patternError}`)
    if (item.lastError) lines.push(`  Last error: ${item.lastError}`)
  }
  return lines.join('\n')
}

/**
 * Persistent state per plugin entry in one JSON file: sessions bound to
 * shared-mode routes (`/mattermost bind`, or created automatically) and the
 * sessions of thread-mode threads (bounded, oldest dropped first).
 */
function createStateStore(fileOf, entry, log) {
  const prefix = `${entry}/`
  let loadedFrom
  let bindings = new Map()
  let threads = new Map()
  const load = () => {
    const file = fileOf()
    if (file === loadedFrom) return file
    loadedFrom = file
    bindings = new Map()
    threads = new Map()
    try {
      const document = JSON.parse(readFileSync(file, 'utf8'))
      for (const [key, value] of Object.entries(document?.bindings ?? {})) {
        if (key.startsWith(prefix) && typeof value?.sessionId === 'string' && value.sessionId !== '') bindings.set(key.slice(prefix.length), value.sessionId)
      }
      const stored = Object.entries(document?.threads ?? {})
        .filter(([key, value]) => key.startsWith(prefix) && typeof value?.sessionId === 'string' && value.sessionId !== '')
        .sort((a, b) => String(a[1].updatedAt ?? '').localeCompare(String(b[1].updatedAt ?? '')))
      for (const [key, value] of stored.slice(-THREAD_SESSION_LIMIT)) threads.set(key.slice(prefix.length), { sessionId: value.sessionId, updatedAt: value.updatedAt })
    } catch {}
    return file
  }
  let writing = Promise.resolve()
  /** Rewrite this entry's part of the file, keeping other entries' data. */
  const persist = (file) => {
    writing = writing.then(async () => {
      let document = {}
      try { document = JSON.parse(await readFile(file, 'utf8')) } catch {}
      if (document === null || typeof document !== 'object' || Array.isArray(document)) document = {}
      const keep = (section) => Object.fromEntries(Object.entries(document[section] ?? {}).filter(([key]) => !key.startsWith(prefix)))
      const nextBindings = keep('bindings')
      for (const [key, sessionId] of bindings) nextBindings[`${prefix}${key}`] = { sessionId, updatedAt: new Date().toISOString() }
      const nextThreads = keep('threads')
      for (const [key, value] of threads) nextThreads[`${prefix}${key}`] = value
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ ...document, version: 3, bindings: nextBindings, threads: nextThreads }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, file)
    }).catch((error) => log('warn', `saving the session state to ${file} failed: ${describe(error)}`))
    return writing
  }
  return {
    bindings: {
      get(key) {
        load()
        return bindings.get(key)
      },
      set(key, sessionId) {
        const file = load()
        if (typeof sessionId === 'string' && sessionId !== '') bindings.set(key, sessionId)
        else bindings.delete(key)
        return persist(file)
      },
    },
    threads: {
      get(key) {
        load()
        return threads.get(key)?.sessionId
      },
      set(key, sessionId) {
        const file = load()
        threads.delete(key)
        if (typeof sessionId === 'string' && sessionId !== '') threads.set(key, { sessionId, updatedAt: new Date().toISOString() })
        while (threads.size > THREAD_SESSION_LIMIT) threads.delete(threads.keys().next().value)
        return persist(file)
      },
    },
  }
}
