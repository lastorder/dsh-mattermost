/**
 * The Mattermost ⇄ DSH bridge for one environment: one Mattermost bot
 * connection whose posts are routed — by the `@mention` they use — to DSH
 * sessions in different workspaces.
 *
 * Requests run in lanes: requests for the same shared session (or the same
 * thread in thread mode) run one after another, while different lanes run
 * in parallel up to `maxConcurrent`.
 *
 * The bridge never imports Cordis. Its `host` adapter supplies configuration,
 * logging, event subscription, and the DSH session operations, so the same
 * code runs under the plugin (`index.js`) and under unit tests with fakes.
 */
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_MESSAGES,
  assistantText,
  buildPrompt,
  channelAllowed,
  channelLabel,
  cleanMentions,
  compilePattern,
  describeTurnEnd,
  fill,
  ignoreReason,
  matchTrigger,
  parsePostedEvent,
  selectReply,
  splitMessage,
  threadPosts,
  userAllowed,
} from './core.js'
import { routeLabel } from './config.js'
import { MattermostRest, MattermostSocket, resolveEndpoints } from './mattermost.js'

const USER_CACHE_MS = 10 * 60_000
const USER_LIMIT = 1000
const SEEN_LIMIT = 1000
const THREAD_LIMIT = 500
const TYPING_INTERVAL_MS = 5_000
const PROMPT_ADMISSION_TIMEOUT_MS = 120_000
const NOTICE_TIMEOUT_MS = 5_000

/** A bridge-level failure with a stable `code`. */
export class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * Follows DSH turns for submitted prompts with one set of event listeners,
 * shared by every request (instead of four listeners per request).
 *
 * A prompt is identified by its `requestId`, which the session controller
 * stores as the user message's `source.rpcId`. The owning turn is learned
 * from `agent/inbox/claimed` (or, as a fallback, from the `user/message`
 * event inside the latest `turn/start`); its assistant texts are collected
 * from `assistant/message` events until the matching `turn/end`.
 */
export class TurnTracker {
  /** @param on - `ctx.on`-compatible subscription returning a disposer. */
  constructor(on) {
    this.on = on
    this.bySession = new Map()
    this.disposers = undefined
  }

  /** Subscribe once, on first use; listeners never throw. */
  listen() {
    if (this.disposers) return
    const each = (sessionId, visit) => {
      const watches = typeof sessionId === 'string' ? this.bySession.get(sessionId) : undefined
      if (!watches) return
      for (const watch of [...watches]) {
        try { visit(watch) } catch {}
      }
    }
    this.disposers = [
      this.on('agent/inbox/claimed', (payload) => each(payload?.agent?.id, (watch) => watch.claimed(payload))),
      this.on('agent/inbox/discarded', (payload) => each(payload?.agent?.id, (watch) => watch.discarded(payload))),
      this.on('agent/disposed', (payload) => each(payload?.agent?.id, (watch) => watch.disposed())),
      this.on('session/event', (session, event) => each(session?.id, (watch) => watch.event(event))),
    ]
  }

  /**
   * Start following one prompt; call before submitting it.
   * @returns `{ result, turn, cancel(error) }`; `result` resolves to `{ reason, texts, turn }`.
   */
  watch(sessionId, requestId, timeoutMs) {
    this.listen()
    let resolveResult
    let rejectResult
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    // Callers may cancel before awaiting; never surface an unhandled rejection.
    result.catch(() => {})
    let settled = false
    let turn
    let latestTurnStart
    let timer
    const texts = []
    const ours = (message) => message?.source?.rpcId === requestId
    const watch = {
      claimed: (payload) => {
        if (ours(payload?.message) && typeof payload.turn === 'number') turn = payload.turn
      },
      discarded: (payload) => {
        if (ours(payload?.message)) settle('reject', new BridgeError('discarded', 'the request was removed from the DSH queue'))
      },
      disposed: () => settle('reject', new BridgeError('disposed', 'the DSH session was closed before it answered')),
      event: (event) => {
        const data = event?.data ?? {}
        switch (event?.type) {
          case 'turn/start':
            latestTurnStart = data.turn
            break
          case 'user/message':
            if (turn === undefined && ours(data)) turn = latestTurnStart
            break
          case 'assistant/message':
            if (turn !== undefined && data.turn === turn) {
              const text = assistantText(data.message)
              if (text !== '') texts.push(text)
            }
            break
          case 'turn/end':
            if (turn !== undefined && data.turn === turn) settle('resolve', { reason: data.reason, texts: [...texts], turn })
            break
          default:
            break
        }
      },
      cancel: (error) => settle('reject', error),
    }
    const settle = (outcome, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const watches = this.bySession.get(sessionId)
      watches?.delete(watch)
      if (watches?.size === 0) this.bySession.delete(sessionId)
      if (outcome === 'resolve') resolveResult(value)
      else rejectResult(value)
    }
    let watches = this.bySession.get(sessionId)
    if (!watches) this.bySession.set(sessionId, (watches = new Set()))
    watches.add(watch)
    if (timeoutMs > 0) {
      timer = setTimeout(() => settle('reject', new BridgeError('timeout', `no reply within ${Math.round(timeoutMs / 60_000)} minute(s)`)), timeoutMs)
      timer.unref?.()
    }
    return {
      result,
      get turn() { return turn },
      cancel: (error) => settle('reject', error ?? new BridgeError('cancelled', 'cancelled')),
    }
  }

  /** Number of prompts being followed. */
  get size() {
    let count = 0
    for (const watches of this.bySession.values()) count += watches.size
    return count
  }

  /** Unsubscribe and cancel every pending watch. */
  dispose() {
    for (const dispose of this.disposers?.splice(0) ?? []) {
      try { dispose() } catch {}
    }
    this.disposers = undefined
    for (const watches of [...this.bySession.values()]) {
      for (const watch of [...watches]) watch.cancel(new BridgeError('stopped', 'the bridge stopped'))
    }
    this.bySession.clear()
  }
}

/** Requests in one lane run one after another. */
function laneOf(route, rootId, postId) {
  switch (route.sessionMode) {
    case 'new': return `new:${postId}`
    case 'thread': return `thread:${route.key}:${rootId}`
    default: return route.sessionId ? `session:${route.sessionId}` : `shared:${route.key}`
  }
}

/** Insert into a bounded Set/Map, evicting the oldest entry. */
function remember(collection, key, value, limit) {
  if (collection instanceof Set) {
    if (collection.has(key)) return false
    collection.add(key)
  } else {
    collection.delete(key)
    collection.set(key, value)
  }
  if (collection.size > limit) collection.delete(collection.keys().next().value)
  return true
}

/**
 * One bridge instance (one environment).
 *
 * `host` members:
 * - `settings()` → merged settings of this environment (`mergeSettings` in lib/config.js), including `routes`.
 * - `log(level, message)`.
 * - `turns` → a shared {@link TurnTracker}; or `on(event, listener, options?)` to create one.
 * - `sessions` → `{ prompt(request, signal), create(request), rename(request) }` (DSH session controller).
 * - `workspaces` (optional) → `{ list(), resolveByPath(path), create?(path) }`.
 * - `binding` → `{ get(routeKey), set(routeKey, id | undefined) }` for shared-mode routes (`''` = implicit route).
 * - `threads` (optional) → `{ get(key), set(key, id) }` persisting thread-mode sessions.
 * - `agentOf(id)`, `hostname`, `key`, `name`, and optionally `fetch` / `WebSocket` / `socketOptions` for tests.
 */
export class MattermostBridge {
  constructor(host) {
    this.host = host
    this.turns = host.turns ?? new TurnTracker((name, listener, options) => host.on(name, listener, options))
    this.ownsTurns = host.turns === undefined
    this.generation = 0
    this.connection = { state: 'idle', detail: undefined, since: Date.now() }
    this.endpoints = undefined
    this.rest = undefined
    this.socket = undefined
    this.me = undefined
    this.waiting = []
    this.active = new Map()
    this.busyLanes = new Set()
    this.lastError = undefined
    this.lastRequest = undefined
    this.users = new Map()
    this.seen = new Set()
    this.threadRoutes = new Map()
    this.threadSessions = new Map()
    this.statusPosts = new Set()
    this.greeted = false
    this.retryTimer = undefined
    this.retryAttempt = 0
    this.patternError = undefined
    this.patternCache = undefined
  }

  settings() {
    return this.host.settings()
  }

  log(level, message) {
    try { this.host.log(level, message) } catch {}
  }

  setConnection(state, detail) {
    this.connection = { state, detail, since: Date.now() }
  }

  /** Connect when `serverUrl` and `token` are configured; otherwise stay idle. */
  start() {
    const generation = ++this.generation
    const s = this.settings()
    this.waiting = []
    if (!s.serverUrl || !s.token) {
      this.setConnection('unconfigured', 'set serverUrl and token to connect')
      this.log('info', 'not connecting: serverUrl and token are not both configured')
      return
    }
    try {
      this.endpoints = resolveEndpoints(s.serverUrl)
    } catch (error) {
      this.setConnection('error', describe(error))
      this.log('warn', `invalid serverUrl: ${describe(error)}`)
      return
    }
    this.rest = new MattermostRest({
      apiBase: this.endpoints.apiBase,
      token: s.token,
      ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
    })
    void this.login(generation)
  }

  /** Disconnect, abandon in-flight waits, and optionally post the goodbye message. */
  async stop({ goodbye = false } = {}) {
    this.generation += 1
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.stop()
    const dropped = this.waiting.splice(0)
    const running = [...this.active.values()]
    for (const current of running) current.watch?.cancel(new BridgeError('stopped', 'the bridge stopped'))
    if (this.ownsTurns) this.turns.dispose()
    const rest = this.rest
    const s = this.settings()
    const notices = []
    if (rest) {
      const stopped = (item) => ({ message: this.decorate(item.prefix + this.messages().stopped) })
      for (const current of running) if (current.ackId) notices.push(rest.patchPost(current.ackId, stopped(current.item)))
      for (const item of dropped) {
        notices.push(item.ackPromise?.then((ackId) => (ackId ? rest.patchPost(ackId, stopped(item)) : undefined)))
      }
      if (goodbye && this.greeted && s.greeting?.enabled && s.greeting.channelId) {
        notices.push(rest.createPost({ channel_id: s.greeting.channelId, message: this.decorate(s.greeting.goodbyeMessage || 'Agent is shutting down. Goodbye.') }))
      }
    }
    this.setConnection('stopped')
    if (notices.length > 0) {
      await Promise.race([
        Promise.allSettled(notices),
        new Promise((resolve) => setTimeout(resolve, NOTICE_TIMEOUT_MS).unref?.()),
      ])
    }
  }

  /** Reconnect with the current configuration (waiting requests are dropped). */
  async restart() {
    await this.stop()
    this.start()
  }

  alive(generation) {
    return generation === this.generation
  }

  async login(generation) {
    if (!this.alive(generation)) return
    this.setConnection('connecting', `signing in to ${this.endpoints.siteUrl}`)
    try {
      const me = await this.rest.me()
      if (!this.alive(generation)) return
      if (!me || typeof me.id !== 'string') throw new Error('unexpected /users/me response')
      this.me = { id: me.id, username: String(me.username ?? ''), isBot: me.is_bot === true }
      this.retryAttempt = 0
      this.log('info', `signed in to ${this.endpoints.siteUrl} as @${this.me.username}`)
    } catch (error) {
      if (!this.alive(generation)) return
      const delay = Math.min(300_000, 5_000 * 2 ** Math.min(this.retryAttempt, 6))
      this.retryAttempt += 1
      this.setConnection('error', `sign-in failed: ${describe(error)}; retrying in ${Math.round(delay / 1000)}s`)
      this.log('warn', `sign-in to ${this.endpoints.siteUrl} failed: ${describe(error)}`)
      this.retryTimer = setTimeout(() => void this.login(generation), delay)
      this.retryTimer.unref?.()
      return
    }
    const s = this.settings()
    this.socket = new MattermostSocket({
      wsUrl: this.endpoints.wsUrl,
      token: s.token,
      ...(this.host.WebSocket ? { WebSocket: this.host.WebSocket } : {}),
      ...(this.host.socketOptions ?? {}),
      onEvent: (message) => this.onSocketEvent(generation, message),
      onState: (state, detail) => this.onSocketState(generation, state, detail),
    })
    this.socket.start()
  }

  onSocketState(generation, state, detail) {
    if (!this.alive(generation)) return
    this.setConnection(state === 'open' ? 'connected' : state, detail)
    if (state === 'open') {
      this.log('info', `listening on ${this.endpoints.wsUrl} as @${this.me?.username} for ${this.mentionNames().map((name) => `@${name}`).join(', ')}`)
      void this.greet(generation)
    } else if (state === 'auth-failed') {
      this.log('warn', `WebSocket authentication failed: ${detail ?? ''}`)
    } else if (state === 'reconnecting') {
      this.log('info', `WebSocket ${detail ?? 'reconnecting'}`)
    }
  }

  async greet(generation) {
    const s = this.settings()
    if (this.greeted || !s.greeting?.enabled || !s.greeting.channelId) return
    this.greeted = true
    const mentions = this.mentionNames().map((name) => `@${name}`).join(' / ') || '@bot'
    const message = s.greeting.message || `Agent is now online and ready. You can use ${mentions} to request my support.`
    try {
      if (this.alive(generation)) await this.rest.createPost({ channel_id: s.greeting.channelId, message: this.decorate(message) })
    } catch (error) {
      this.log('warn', `greeting failed: ${describe(error)}`)
    }
  }

  onSocketEvent(generation, message) {
    if (!this.alive(generation)) return
    const event = parsePostedEvent(message)
    if (event === undefined) return
    this.handlePosted(generation, event).catch((error) => {
      this.lastError = describe(error)
      this.log('warn', `failed to handle post ${event.post.id}: ${describe(error)}`)
    })
  }

  messages() {
    return this.settings().messages ?? DEFAULT_MESSAGES
  }

  /** Append the host suffix when `showHost` is on. */
  decorate(message) {
    return this.settings().showHost && this.host.hostname ? `${message}\n(host: ${this.host.hostname})` : message
  }

  /** The configured routes (at least one). */
  routes() {
    const routes = this.settings().routes
    return Array.isArray(routes) && routes.length > 0 ? routes : [{ key: '', mentionName: '', workspace: '', sessionMode: 'shared', sessionId: '', implicit: true, index: 0 }]
  }

  /** The `@name` of each route; an empty mention name stands for the bot username. */
  mentionNames(routes = this.routes()) {
    return routes.map((route) => route.mentionName || this.me?.username || '').filter(Boolean)
  }

  /** The compiled trigger pattern, recompiled only when its source or flags change. */
  pattern() {
    const s = this.settings()
    const key = `${s.triggerPattern ?? ''}\u0000${s.triggerPatternFlags ?? ''}`
    if (this.patternCache?.key === key) return this.patternCache.compiled
    let compiled
    try {
      compiled = compilePattern(s.triggerPattern, s.triggerPatternFlags)
      this.patternError = undefined
    } catch (error) {
      if (this.patternError !== describe(error)) this.log('warn', describe(error))
      this.patternError = describe(error)
    }
    this.patternCache = { key, compiled }
    return compiled
  }

  /** Decide whether one post addresses the bridge and which route answers it, then queue it. */
  async handlePosted(generation, event) {
    const s = this.settings()
    const post = event.post
    if (!this.me || ignoreReason(post, this.me.id, s.ignoreBots !== false) !== undefined) return
    const routes = this.routes()
    const names = routes.map((route) => route.mentionName || this.me.username)
    let trigger = matchTrigger(event, {
      botUserId: this.me.id,
      mentionNames: names,
      onMention: s.triggerOnMention !== false,
      onDirectMessage: s.triggerOnDirectMessage !== false,
      pattern: this.pattern(),
      matchMentionsList: s.matchMentionsList === true,
    })
    const threadRouteKey = post.root_id ? this.threadRoutes.get(post.root_id) : undefined
    const threadRoute = threadRouteKey === undefined ? undefined : routes.find((route) => route.key === threadRouteKey)
    if (trigger === undefined && s.followThreads && threadRoute) {
      trigger = { via: 'thread', prompt: cleanMentions(post.message, names) }
    }
    if (trigger === undefined) return
    // An explicit mention picks its route; otherwise stay with the thread's route, else the first route.
    const mentioned = trigger.mention === undefined ? -1 : names.findIndex((name) => name.toLowerCase() === trigger.mention.toLowerCase())
    const route = routes[mentioned] ?? threadRoute ?? routes[0]
    if (!channelAllowed(event, s.channels)) return
    if (!remember(this.seen, post.id, true, SEEN_LIMIT)) return

    const username = await this.username(post.user_id, event.senderName)
    if (!this.alive(generation)) return
    const rootId = post.root_id || post.id
    const prefix = s.mentionSender !== false ? `@${username} ` : ''
    const messages = this.messages()
    const label = `post ${post.id} from @${username} in ${channelLabel(event)} (${trigger.via} → ${routeLabel(route, this.me.username)})`
    if (!userAllowed(username, s.allowedUsers)) {
      this.log('info', `rejected ${label}: user not allowed`)
      await this.reply(post.channel_id, rootId, this.decorate(prefix + messages.unauthorized))
      return
    }
    if (trigger.prompt === '') {
      this.log('info', `ignored ${label}: empty request`)
      await this.reply(post.channel_id, rootId, this.decorate(prefix + messages.empty))
      return
    }
    const item = { id: post.id, event, trigger, route, username, rootId, prefix, lane: laneOf(route, rootId, post.id), receivedAt: Date.now(), ackPromise: undefined }
    const limit = Number.isFinite(s.queueMaxSize) ? s.queueMaxSize : 10
    if (!this.canStart(item) && this.waiting.length >= limit) {
      this.log('warn', `rejected ${label}: queue full (${this.waiting.length} waiting)`)
      await this.reply(post.channel_id, rootId, this.decorate(prefix + messages.queueFull))
      return
    }
    this.waiting.push(item)
    this.pump()
    const waits = this.waiting.includes(item)
    this.log('info', `queued ${label}; ${this.waiting.length} waiting, ${this.active.size} running`)
    if (waits) item.ackPromise = this.reply(post.channel_id, rootId, this.decorate(prefix + messages.queued))
  }

  canStart(item) {
    return this.active.size < this.settings().maxConcurrent && !this.busyLanes.has(item.lane)
  }

  /** Start waiting requests whose lane is free, oldest first, up to `maxConcurrent`. */
  pump() {
    const generation = this.generation
    for (let index = 0; index < this.waiting.length;) {
      const item = this.waiting[index]
      if (!this.canStart(item)) {
        if (this.active.size >= this.settings().maxConcurrent) return
        index += 1
        continue
      }
      this.waiting.splice(index, 1)
      this.run(generation, item)
    }
  }

  run(generation, item) {
    const current = { item, ackId: undefined, sessionId: undefined, state: 'acknowledging', startedAt: Date.now(), watch: undefined }
    this.busyLanes.add(item.lane)
    this.active.set(item.id, current)
    this.process(generation, current)
      .catch((error) => {
        this.lastError = describe(error)
        this.log('error', `request ${item.id} failed: ${describe(error)}`)
      })
      .finally(() => {
        this.busyLanes.delete(item.lane)
        if (this.active.get(item.id) === current) this.active.delete(item.id)
        try { this.pump() } catch (error) { this.log('error', `scheduling failed: ${describe(error)}`) }
      })
  }

  /** Handle one request from acknowledgement to final reply. */
  async process(generation, current) {
    const s = this.settings()
    const messages = this.messages()
    const item = current.item
    const post = item.event.post
    const channelId = post.channel_id
    try {
      let ackId = item.ackPromise ? await item.ackPromise : undefined
      const processing = this.decorate(item.prefix + messages.processing)
      if (ackId && !(await this.patch(ackId, processing))) ackId = undefined
      ackId ??= await this.reply(channelId, item.rootId, processing)
      current.ackId = ackId
      current.state = 'preparing'
      if (ackId) this.statusPosts.add(ackId)
      const typing = this.startTyping(channelId, item.rootId)
      let outcome
      try {
        const context = await this.threadContext(item)
        const files = Array.isArray(post.metadata?.files) ? post.metadata.files.map((file) => file?.name).filter(Boolean) : []
        const prompt = buildPrompt({
          text: item.trigger.prompt,
          username: item.username,
          channel: channelLabel(item.event),
          header: s.promptHeader,
          context,
          files,
        })
        outcome = await this.ask(generation, current, prompt)
      } catch (error) {
        outcome = { error }
      } finally {
        typing.stop()
      }
      // A stopped bridge already told the user (see stop()).
      if (!this.alive(generation)) return
      const reply = this.render(outcome, current)
      const ok = outcome.error === undefined && describeTurnEnd(outcome.reason).ok
      this.lastRequest = { postId: post.id, username: item.username, route: item.route.key, sessionId: current.sessionId, ok, finishedAt: Date.now() }
      if (outcome.error !== undefined) this.lastError = describe(outcome.error)
      this.log(ok ? 'info' : 'warn', `request ${post.id} ${ok ? 'answered' : `failed: ${outcome.error !== undefined ? describe(outcome.error) : describeTurnEnd(outcome.reason).kind}`}`)
      current.state = 'replying'
      await this.deliver(channelId, item.rootId, ackId, item.prefix, reply)
      remember(this.threadRoutes, item.rootId, item.route.key, THREAD_LIMIT)
    } finally {
      if (current.ackId) this.statusPosts.delete(current.ackId)
    }
  }

  /** Submit the prompt to the route's session and wait for its turn; replaces a vanished session once. */
  async ask(generation, current, prompt) {
    const item = current.item
    let target = await this.targetSession(item)
    try {
      return await this.submit(generation, current, target.id, prompt)
    } catch (error) {
      const replaceable = target.source === 'thread' || (target.source === 'binding' && this.settings().autoCreateSession !== false)
      if (error?.code !== 'session/not-found' || !replaceable) throw error
      this.log('warn', `${target.source === 'thread' ? 'thread' : 'bound'} session ${target.id} no longer exists; creating a new one`)
      const id = await this.createSession(item)
      if (target.source === 'thread') await this.setThreadSession(item, id)
      else await this.host.binding.set(item.route.key, id)
      target = { id, source: target.source }
      return await this.submit(generation, current, target.id, prompt)
    }
  }

  async submit(generation, current, sessionId, prompt) {
    if (!this.alive(generation)) throw new BridgeError('stopped', 'the bridge stopped')
    const s = this.settings()
    const postId = current.item.event.post.id
    const timeoutMs = Math.max(0, Number(s.replyTimeoutMinutes ?? 60)) * 60_000
    const requestId = `mattermost-${postId}-${randomUUID().slice(0, 8)}`
    const watch = this.turns.watch(sessionId, requestId, timeoutMs)
    current.sessionId = sessionId
    current.watch = watch
    current.state = 'submitting'
    try {
      await this.host.sessions.prompt({
        sessionId,
        requestId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, AbortSignal.timeout(PROMPT_ADMISSION_TIMEOUT_MS))
    } catch (error) {
      watch.cancel(error)
      throw error
    }
    current.state = 'waiting'
    this.log('info', `request ${postId} submitted to DSH session ${sessionId}`)
    return await watch.result
  }

  threadKey(item) {
    return `${item.route.key}:${item.rootId}`
  }

  threadSession(item) {
    const key = this.threadKey(item)
    return this.host.threads ? this.host.threads.get(key) : this.threadSessions.get(key)
  }

  async setThreadSession(item, sessionId) {
    const key = this.threadKey(item)
    if (this.host.threads) await this.host.threads.set(key, sessionId)
    else remember(this.threadSessions, key, sessionId, THREAD_LIMIT)
  }

  /** The session that answers `item`, by its route's session mode. */
  async targetSession(item) {
    const route = item.route
    if (route.sessionMode === 'new') return { id: await this.createSession(item), source: 'new' }
    if (route.sessionMode === 'thread') {
      const known = this.threadSession(item)
      if (known) return { id: known, source: 'thread' }
      const id = await this.createSession(item)
      await this.setThreadSession(item, id)
      return { id, source: 'thread' }
    }
    if (route.sessionId) return { id: route.sessionId, source: 'config' }
    const bound = this.host.binding.get(route.key)
    if (bound) return { id: bound, source: 'binding' }
    if (this.settings().autoCreateSession === false) throw new BridgeError('no-session', 'no DSH session is configured or bound')
    const id = await this.createSession(item)
    await this.host.binding.set(route.key, id)
    return { id, source: 'binding' }
  }

  describeTarget(route) {
    if (route.sessionMode === 'new' || route.sessionMode === 'thread') return { id: undefined, source: route.sessionMode }
    if (route.sessionId) return { id: route.sessionId, source: 'config' }
    const bound = this.host.binding.get(route.key)
    if (bound) return { id: bound, source: 'binding' }
    return { id: undefined, source: this.settings().autoCreateSession === false ? 'none' : 'auto-create' }
  }

  /** Where a new session goes: the route's (or shared) workspace directory, registered as a DSH workspace if needed. */
  async sessionLocation(directory) {
    const registry = this.host.workspaces
    if (registry) {
      try {
        let workspace = directory ? await registry.resolveByPath(directory) : registry.list()[0]
        if (!workspace && directory && typeof registry.create === 'function') {
          workspace = await registry.create(directory)
          this.log('info', `registered ${directory} as a DSH workspace`)
        }
        if (workspace?.id) return { workspaceId: workspace.id }
      } catch (error) {
        this.log('warn', `workspace lookup for ${directory || 'the first workspace'} failed: ${describe(error)}`)
      }
    }
    return directory ? { cwd: directory } : {}
  }

  sessionTitle(item) {
    const s = this.settings()
    const route = item.route
    const label = route.implicit ? s.connectionName : routeLabel(route, this.me?.username)
    const head = [s.sessionTitle, label].filter(Boolean).join(' · ')
    if (route.sessionMode === 'shared') return head
    const snippet = truncate(String(item.trigger.prompt ?? '').replace(/\s+/g, ' ').trim(), 48)
    return snippet ? `${head} · ${snippet}` : head
  }

  async createSession(item) {
    const s = this.settings()
    const directory = item.route.workspace || (typeof s.workspace === 'string' ? s.workspace.trim() : '')
    const request = await this.sessionLocation(directory)
    const created = await this.host.sessions.create(request)
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session creation returned no sessionId')
    const title = this.sessionTitle(item)
    if (title) {
      try {
        await this.host.sessions.rename({ sessionId, title })
      } catch (error) {
        this.log('warn', `could not title session ${sessionId}: ${describe(error)}`)
      }
    }
    const where = request.workspaceId ? `workspace ${request.workspaceId}` : request.cwd ?? 'the default workspace'
    this.log('info', `created DSH session ${sessionId} (${item.route.sessionMode}) for ${routeLabel(item.route, this.me?.username)} in ${where}`)
    return sessionId
  }

  /** Turn an outcome into the reply text (without the sender prefix). */
  render(outcome, current) {
    const s = this.settings()
    const messages = this.messages()
    if (outcome.error !== undefined) {
      const error = outcome.error
      switch (error?.code) {
        case 'no-session': return messages.noSession
        case 'timeout': return messages.timeout
        case 'stopped': return messages.stopped
        case 'discarded': return messages.cancelled
        case 'session/not-found': return `${messages.error} (DSH session not found: ${current?.sessionId ?? '?'})`
        default: return `${messages.error} (${truncate(describe(error), 300)})`
      }
    }
    const verdict = describeTurnEnd(outcome.reason)
    const text = selectReply(outcome.texts ?? [], s.replyMode)
    if (verdict.ok) return text || messages.noReply
    if (verdict.cancelled) return text ? `${text}\n\n_${messages.cancelled}_` : messages.cancelled
    const failure = `${messages.error}${verdict.detail ? ` (${truncate(verdict.detail, 300)})` : ''}`
    return text ? `${text}\n\n_${failure}_` : failure
  }

  /** Post the reply: the first part replaces the acknowledgement, the rest follow in the thread. */
  async deliver(channelId, rootId, ackId, prefix, text) {
    const s = this.settings()
    const suffix = s.showHost && this.host.hostname ? `\n(host: ${this.host.hostname})` : ''
    const max = Math.max(1000, Number(s.maxPostLength) || 16_000) - suffix.length
    const chunks = splitMessage(prefix + text, max)
    for (let index = 0; index < chunks.length; index += 1) {
      const message = chunks[index] + (index === chunks.length - 1 ? suffix : '')
      if (index === 0 && ackId && (await this.patch(ackId, message))) continue
      await this.reply(channelId, rootId, message)
    }
  }

  async reply(channelId, rootId, message) {
    try {
      const created = await this.rest.createPost({ channel_id: channelId, root_id: rootId, message })
      return typeof created?.id === 'string' ? created.id : undefined
    } catch (error) {
      this.lastError = describe(error)
      this.log('warn', `posting to channel ${channelId} failed: ${describe(error)}`)
      return undefined
    }
  }

  async patch(postId, message) {
    try {
      await this.rest.patchPost(postId, { message })
      return true
    } catch (error) {
      this.log('warn', `updating post ${postId} failed: ${describe(error)}`)
      return false
    }
  }

  async username(userId, hint) {
    if (!userId) return hint || 'unknown'
    const cached = this.users.get(userId)
    if (cached && Date.now() - cached.at < USER_CACHE_MS) return cached.name
    let name = hint || userId
    try {
      const user = await this.rest.user(userId)
      if (user && typeof user.username === 'string' && user.username !== '') name = user.username
    } catch (error) {
      this.log('debug', `user lookup for ${userId} failed: ${describe(error)}`)
    }
    remember(this.users, userId, { name, at: Date.now() }, USER_LIMIT)
    return name
  }

  async threadContext(item) {
    const s = this.settings()
    const post = item.event.post
    const max = Number.isFinite(s.threadContextMaxMessages) ? s.threadContextMaxMessages : 20
    if (!post.root_id || max <= 0) return []
    try {
      const thread = await this.rest.thread(post.root_id)
      const posts = threadPosts(thread, post.id, max + this.statusPosts.size).filter((entry) => !this.statusPosts.has(entry.id))
      const kept = posts.length > max ? posts.slice(posts.length - max) : posts
      const context = []
      for (const entry of kept) {
        context.push({ username: await this.username(entry.user_id, entry.props?.override_username), message: entry.message ?? '' })
      }
      return context
    } catch (error) {
      this.log('warn', `thread context for ${post.root_id} unavailable: ${describe(error)}`)
      return []
    }
  }

  startTyping(channelId, rootId) {
    if (this.settings().typingIndicator === false) return { stop() {} }
    const send = () => this.socket?.send('user_typing', { channel_id: channelId, parent_id: rootId })
    send()
    const timer = setInterval(send, TYPING_INTERVAL_MS)
    timer.unref?.()
    return { stop: () => clearInterval(timer) }
  }

  /**
   * Show in the acknowledgement post of every running request of `agent`'s
   * session (or its sub-agents) that DSH now waits for a human — an approval
   * or a question. Fire-and-forget.
   */
  notifyWaiting(agent, kind, detail) {
    if (!this.rest) return
    const messages = this.messages()
    const template = kind === 'approval' ? messages.waitingApproval : messages.waitingAnswer
    const text = fill(template, { tool: detail ?? 'a tool', question: detail ?? '' })
    for (const current of this.active.values()) {
      if (!current.ackId || !current.sessionId || !belongsTo(agent, current.sessionId, this.host.agentOf)) continue
      void this.patch(current.ackId, this.decorate(current.item.prefix + text))
    }
  }

  /** Snapshot for the `/mattermost` command and the settings page. */
  status() {
    const s = this.settings()
    const routes = this.routes().map((route) => ({
      key: route.key,
      implicit: route.implicit === true,
      mentionName: route.mentionName || this.me?.username || undefined,
      workspace: route.workspace || undefined,
      sessionMode: route.sessionMode,
      target: this.describeTarget(route),
    }))
    const active = [...this.active.values()].map((current) => ({
      postId: current.item.id,
      username: current.item.username,
      route: current.item.route.key,
      state: current.state,
      sessionId: current.sessionId,
      since: current.startedAt,
    }))
    return {
      key: this.host.key,
      name: typeof this.host.name === 'function' ? this.host.name() : this.host.name,
      connection: this.connection,
      server: this.endpoints?.siteUrl ?? (s.serverUrl || undefined),
      hasToken: typeof s.token === 'string' && s.token !== '',
      bot: this.me?.username,
      mentionName: routes[0]?.mentionName,
      routes,
      target: routes[0]?.target,
      queue: this.waiting.length,
      running: active.length,
      active,
      current: active[0],
      lastRequest: this.lastRequest,
      lastError: this.lastError,
      patternError: this.patternError,
    }
  }
}

/**
 * Whether `agent` is the target session's agent or one of its sub-agents,
 * following `parentSession` in session headers (live ancestors via `agentOf`).
 */
function belongsTo(agent, sessionId, agentOf) {
  let cursor = agent
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    if (cursor.id === sessionId) return true
    const parent = cursor.session?.header?.parentSession
    if (typeof parent !== 'string' || parent === '') return false
    if (parent === sessionId) return true
    let next
    try { next = typeof agentOf === 'function' ? agentOf(parent) : undefined } catch {}
    cursor = next ?? undefined
  }
  return false
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** The low-level reason behind an error, e.g. "connect ECONNREFUSED 127.0.0.1:8065" behind "fetch failed". */
function causeOf(error) {
  const cause = error?.cause
  if (typeof cause === 'string') return cause
  if (!(cause instanceof Error)) return ''
  if (cause.message) return cause.message
  const first = Array.isArray(cause.errors) ? cause.errors.find((item) => item instanceof Error && item.message) : undefined
  if (first) return first.message
  return typeof cause.code === 'string' ? cause.code : ''
}

export function describe(error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? `${error.code}: ` : ''
    const cause = causeOf(error)
    return `${code}${error.message}${cause && !error.message.includes(cause) ? ` (${cause})` : ''}`
  }
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return String(error) }
}
