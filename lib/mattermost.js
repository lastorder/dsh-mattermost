/**
 * Minimal Mattermost API v4 client: REST over `fetch` and the event
 * WebSocket over the platform `WebSocket`, both from Node's standard globals.
 * No third-party dependency is needed inside the DSH Host process.
 */

/** A non-2xx Mattermost REST response. */
export class MattermostApiError extends Error {
  constructor(status, message, method, path, id) {
    super(`Mattermost ${method} ${path} failed with HTTP ${status}${message ? `: ${message}` : ''}`)
    this.name = 'MattermostApiError'
    this.status = status
    this.id = id
  }
}

/**
 * Derive the REST base and WebSocket URL from a configured server address.
 * Accepts `https://host`, `host` (https assumed), `http://host:8065`, a
 * subpath deployment, and a trailing `/api/v4`.
 */
export function resolveEndpoints(serverUrl) {
  let raw = typeof serverUrl === 'string' ? serverUrl.trim() : ''
  if (raw === '') throw new Error('serverUrl is not configured')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`serverUrl must use http or https, got ${url.protocol}`)
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v4$/i, '')
  const site = `${url.origin}${path}`
  return {
    siteUrl: site,
    apiBase: `${site}/api/v4`,
    wsUrl: `${site.replace(/^http/i, 'ws')}/api/v4/websocket`,
  }
}

/** REST client bound to one server and token. */
export class MattermostRest {
  /**
   * @param options.apiBase - `https://host/api/v4`.
   * @param options.token - bot or personal access token.
   * @param options.fetch - fetch implementation (tests inject a fake).
   * @param options.timeoutMs - per-request timeout.
   */
  constructor({ apiBase, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
    this.apiBase = apiBase
    this.token = token
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async request(method, path, body, signal) {
    const signals = [AbortSignal.timeout(this.timeoutMs)]
    if (signal) signals.push(signal)
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
    const text = await response.text()
    let json
    try { json = text === '' ? undefined : JSON.parse(text) } catch {}
    if (!response.ok) {
      const message = json && typeof json.message === 'string' ? json.message : text.slice(0, 300)
      throw new MattermostApiError(response.status, message, method, path, json?.id)
    }
    return json
  }

  /** The authenticated account (`id`, `username`, `is_bot`, ...). */
  me(signal) { return this.request('GET', '/users/me', undefined, signal) }
  user(userId, signal) { return this.request('GET', `/users/${encodeURIComponent(userId)}`, undefined, signal) }
  thread(rootId, signal) { return this.request('GET', `/posts/${encodeURIComponent(rootId)}/thread`, undefined, signal) }
  createPost(post, signal) { return this.request('POST', '/posts', post, signal) }
  patchPost(postId, patch, signal) { return this.request('PUT', `/posts/${encodeURIComponent(postId)}/patch`, patch, signal) }
}

/**
 * The Mattermost event WebSocket with token authentication, keep-alive pings,
 * stale-connection detection, and exponential reconnect.
 *
 * States: `idle` → `connecting` → `open` (authenticated) → `reconnecting` …; `stopped` after {@link stop}.
 */
export class MattermostSocket {
  /**
   * @param options.wsUrl - `wss://host/api/v4/websocket`.
   * @param options.token - access token sent in the authentication challenge.
   * @param options.onEvent - receives every parsed server event (`{ event, data, broadcast }`).
   * @param options.onState - receives `(state, detail)` on every state change.
   * @param options.WebSocket - WebSocket constructor (tests inject a fake).
   */
  constructor({
    wsUrl,
    token,
    onEvent,
    onState = () => {},
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    pingIntervalMs = 30_000,
    minReconnectMs = 1_000,
    maxReconnectMs = 60_000,
  }) {
    this.wsUrl = wsUrl
    this.token = token
    this.onEvent = onEvent
    this.onState = onState
    this.WebSocket = WebSocketImpl
    this.pingIntervalMs = pingIntervalMs
    this.minReconnectMs = minReconnectMs
    this.maxReconnectMs = maxReconnectMs
    this.state = 'idle'
    this.ws = undefined
    this.seq = 0
    this.authSeq = 0
    this.attempt = 0
    this.reconnectTimer = undefined
    this.pingTimer = undefined
    this.lastMessageAt = 0
    this.stopped = true
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearInterval(this.pingTimer)
    this.reconnectTimer = undefined
    this.pingTimer = undefined
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      try { ws.close(1000, 'bridge stopped') } catch {}
    }
    this.setState('stopped')
  }

  /** Send one client action; returns false while not authenticated. */
  send(action, data = {}) {
    const ws = this.ws
    if (!ws || this.state !== 'open' || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify({ seq: ++this.seq, action, data }))
      return true
    } catch {
      return false
    }
  }

  setState(state, detail) {
    if (this.state === state && detail === undefined) return
    this.state = state
    try { this.onState(state, detail) } catch {}
  }

  connect() {
    if (this.stopped) return
    this.setState('connecting')
    let ws
    try {
      ws = new this.WebSocket(this.wsUrl)
    } catch (error) {
      this.scheduleReconnect(error)
      return
    }
    try { ws.binaryType = 'arraybuffer' } catch {}
    this.ws = ws
    this.seq = 0
    this.authSeq = ++this.seq
    this.lastMessageAt = Date.now()
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      try {
        ws.send(JSON.stringify({ seq: this.authSeq, action: 'authentication_challenge', data: { token: this.token } }))
      } catch (error) {
        this.setState('connecting', `authentication send failed: ${describe(error)}`)
      }
    })
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return
      this.handleMessage(event.data)
    })
    ws.addEventListener('error', (event) => {
      if (this.ws !== ws) return
      this.lastError = describe(event?.error ?? event?.message ?? 'WebSocket error')
    })
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return
      this.ws = undefined
      clearInterval(this.pingTimer)
      this.pingTimer = undefined
      const reason = `closed (${event?.code ?? '?'}${event?.reason ? ` ${event.reason}` : ''})${this.lastError ? `: ${this.lastError}` : ''}`
      this.lastError = undefined
      this.scheduleReconnect(reason)
    })
  }

  handleMessage(data) {
    this.lastMessageAt = Date.now()
    let text
    if (typeof data === 'string') text = data
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
    else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
    else return
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (message.seq_reply !== undefined) {
      if (message.seq_reply === this.authSeq) {
        if (message.status === 'OK') this.authenticated()
        else this.authenticationFailed(message)
      }
      return
    }
    if (message.event === 'hello') {
      this.authenticated()
      return
    }
    if (typeof message.event === 'string' && this.state === 'open') {
      try { this.onEvent(message) } catch {}
    }
  }

  authenticated() {
    if (this.state === 'open') return
    this.attempt = 0
    this.setState('open')
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.keepAlive(), this.pingIntervalMs)
    this.pingTimer.unref?.()
  }

  authenticationFailed(message) {
    const reason = message?.error?.message ?? message?.error?.id ?? 'authentication rejected'
    this.setState('auth-failed', String(reason))
    // A rejected token will not start working by itself: back off to the maximum.
    this.attempt = 32
    try { this.ws?.close(4001, 'authentication failed') } catch {}
  }

  keepAlive() {
    const ws = this.ws
    if (!ws) return
    if (Date.now() - this.lastMessageAt > this.pingIntervalMs * 2.5) {
      this.lastError = 'no traffic from server'
      try { ws.close(4000, 'stale connection') } catch {}
      // Some implementations never fire `close` for a dead TCP peer.
      if (this.ws === ws) {
        this.ws = undefined
        clearInterval(this.pingTimer)
        this.pingTimer = undefined
        this.scheduleReconnect('stale connection')
      }
      return
    }
    this.send('ping')
  }

  scheduleReconnect(reason) {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    const delay = Math.min(this.maxReconnectMs, this.minReconnectMs * 2 ** Math.min(this.attempt, 16))
    this.attempt += 1
    if (this.state !== 'auth-failed') this.setState('reconnecting', `${describe(reason)}; retrying in ${Math.round(delay / 1000)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }
}

/**
 * Open the event WebSocket once, authenticate, and close it: proves the
 * token works over the WebSocket path too (proxies sometimes block it).
 * @returns `{ ok: true }` or `{ ok: false, error }`; never rejects.
 */
export function probeSocket({ wsUrl, token, WebSocket: WebSocketImpl = globalThis.WebSocket, timeoutMs = 8_000 }) {
  return new Promise((resolve) => {
    let ws
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ws?.close(1000, 'probe finished') } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs)
    timer.unref?.()
    try {
      ws = new WebSocketImpl(wsUrl)
    } catch (error) {
      finish({ ok: false, error: describe(error) })
      return
    }
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token } }))
      } catch (error) {
        finish({ ok: false, error: describe(error) })
      }
    })
    ws.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')) } catch { return }
      if (message?.seq_reply === 1) {
        finish(message.status === 'OK' ? { ok: true } : { ok: false, error: String(message.error?.message ?? message.error?.id ?? 'authentication rejected') })
      } else if (message?.event === 'hello') {
        finish({ ok: true })
      }
    })
    ws.addEventListener('error', (event) => {
      finish({ ok: false, error: describe(event?.error ?? event?.message ?? 'WebSocket error') })
    })
    ws.addEventListener('close', (event) => {
      finish({ ok: false, error: `closed (${event?.code ?? '?'})` })
    })
  })
}

function describe(value) {
  if (value instanceof Error) return value.cause ? `${value.message} (${describe(value.cause)})` : value.message
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message
  return String(value)
}
