/**
 * A fake Mattermost server for tests: the REST endpoints the bridge uses plus
 * the event WebSocket, with helpers to inject `posted` events and observe the
 * bridge's posts, patches, and typing events.
 *
 * Run standalone for live testing against a running DSH:
 *   node scripts/fake-mattermost.js --port 18065 --token test-token
 * Control endpoints (no auth): POST /_test/post {message, user, channel, root_id?, channel_type?},
 * GET /_test/state, POST /_test/reset.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const id = () => randomUUID().replace(/-/g, '').slice(0, 26)

export async function startFakeMattermost({ port = 0, token = 'test-token', bot = { id: 'bot-user-id', username: 'dsh-bot' }, users = [] } = {}) {
  const state = {
    users: new Map([[bot.id, { ...bot, is_bot: true }], ...users.map((user) => [user.id, user])]),
    posts: new Map(),
    created: [],
    patched: [],
    typing: [],
    pings: 0,
    sockets: new Set(),
    authFailures: 0,
  }
  const waiters = new Set()
  const notify = () => {
    for (const waiter of [...waiters]) {
      let value
      try { value = waiter.predicate(state) } catch {}
      if (value) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(value)
      }
    }
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path.startsWith('/_test/')) return control(req, res, path)
    if (path === '/api/v4/system/ping') return json(res, 200, { status: 'OK' })
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { id: 'api.context.session_expired.app_error', message: 'Invalid or expired session, please login again.' })
    let match
    if (req.method === 'GET' && path === '/api/v4/users/me') return json(res, 200, state.users.get(bot.id))
    if (req.method === 'GET' && (match = /^\/api\/v4\/users\/([^/]+)$/.exec(path))) {
      const user = state.users.get(match[1])
      return user ? json(res, 200, user) : json(res, 404, { message: 'user not found' })
    }
    if (req.method === 'GET' && (match = /^\/api\/v4\/posts\/([^/]+)\/thread$/.exec(path))) {
      const root = match[1]
      const posts = [...state.posts.values()].filter((post) => post.id === root || post.root_id === root)
      return json(res, 200, { order: posts.map((post) => post.id).reverse(), posts: Object.fromEntries(posts.map((post) => [post.id, post])) })
    }
    if (req.method === 'POST' && path === '/api/v4/posts') {
      const body = await readBody(req)
      const post = { id: id(), create_at: Date.now(), update_at: Date.now(), delete_at: 0, user_id: bot.id, channel_id: body.channel_id, root_id: body.root_id ?? '', message: body.message ?? '', type: '', props: { from_bot: 'true' } }
      state.posts.set(post.id, post)
      // `created` keeps the text as first posted; `posts` follows later patches.
      state.created.push({ ...post })
      notify()
      return json(res, 201, post)
    }
    if (req.method === 'PUT' && (match = /^\/api\/v4\/posts\/([^/]+)\/patch$/.exec(path))) {
      const post = state.posts.get(match[1])
      if (!post) return json(res, 404, { message: 'post not found' })
      const body = await readBody(req)
      if (typeof body.message === 'string') post.message = body.message
      post.update_at = Date.now()
      state.patched.push({ id: post.id, message: post.message })
      notify()
      return json(res, 200, post)
    }
    json(res, 404, { message: `no route ${req.method} ${path}` })
  })

  async function control(req, res, path) {
    if (req.method === 'POST' && path === '/_test/post') {
      const body = await readBody(req)
      const post = api.post(body)
      return json(res, 200, post)
    }
    if (req.method === 'GET' && path === '/_test/state') {
      return json(res, 200, { created: state.created, patched: state.patched, typing: state.typing.length, pings: state.pings, sockets: state.sockets.size, posts: [...state.posts.values()] })
    }
    if (req.method === 'POST' && path === '/_test/reset') {
      state.created.length = 0
      state.patched.length = 0
      state.typing.length = 0
      return json(res, 200, { ok: true })
    }
    json(res, 404, { message: 'unknown control route' })
  }

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/api/v4/websocket') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.authenticated = false
      ws.on('message', (raw) => {
        let message
        try { message = JSON.parse(String(raw)) } catch { return }
        if (message.action === 'authentication_challenge') {
          if (message.data?.token === token) {
            ws.authenticated = true
            state.sockets.add(ws)
            ws.send(JSON.stringify({ status: 'OK', seq_reply: message.seq }))
            ws.send(JSON.stringify({ event: 'hello', data: { server_version: 'fake' }, broadcast: {}, seq: 0 }))
            notify()
          } else {
            state.authFailures += 1
            ws.send(JSON.stringify({ status: 'FAIL', seq_reply: message.seq, error: { id: 'api.web_socket_router.not_authenticated.app_error', message: 'invalid token' } }))
            ws.close()
          }
          return
        }
        if (!ws.authenticated) return
        if (message.action === 'ping') {
          state.pings += 1
          ws.send(JSON.stringify({ status: 'OK', seq_reply: message.seq, data: { text: 'pong' } }))
        } else if (message.action === 'user_typing') {
          state.typing.push(message.data)
          ws.send(JSON.stringify({ status: 'OK', seq_reply: message.seq }))
        }
      })
      ws.on('close', () => {
        state.sockets.delete(ws)
        notify()
      })
    })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  let seq = 1

  const api = {
    url: `http://127.0.0.1:${address.port}`,
    token,
    bot,
    state,
    /** Store a user post and broadcast it as a `posted` event. */
    post({ message, user = 'user-alice', channel = 'channel-town', root_id = '', channel_type = 'O', channel_name = 'town-square', channel_display_name = 'Town Square', props = {}, type = '', file_names = [] } = {}) {
      const author = state.users.get(user) ?? { id: user, username: user }
      const post = { id: id(), create_at: Date.now(), update_at: Date.now(), delete_at: 0, user_id: author.id, channel_id: channel, root_id, message, type, props, ...(file_names.length > 0 ? { metadata: { files: file_names.map((name) => ({ name })) } } : {}) }
      state.posts.set(post.id, post)
      const mentions = [...state.users.values()].filter((candidate) => message.includes(`@${candidate.username}`)).map((candidate) => candidate.id)
      const event = {
        event: 'posted',
        data: {
          channel_display_name,
          channel_name,
          channel_type,
          mentions: JSON.stringify(mentions),
          post: JSON.stringify(post),
          sender_name: `@${author.username}`,
          set_online: true,
          team_id: 'team-1',
        },
        broadcast: { channel_id: channel, team_id: '', user_id: '' },
        seq: seq++,
      }
      for (const ws of state.sockets) ws.send(JSON.stringify(event))
      return post
    },
    /** Resolve with the first truthy predicate result, re-checked after every observed change. */
    waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        let value
        try { value = predicate(state) } catch {}
        if (value) return resolve(value)
        const waiter = { predicate, resolve }
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error('waitFor timed out'))
        }, timeoutMs)
        waiters.add(waiter)
      })
    },
    /** Drop every WebSocket connection (simulates a network drop). */
    dropConnections() {
      for (const ws of state.sockets) ws.terminate()
    },
    async close() {
      for (const waiter of waiters) clearTimeout(waiter.timer)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  return api
}

// Standalone mode for live testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 ? args[index + 1] : fallback
  }
  const server = await startFakeMattermost({
    port: Number(option('port', '18065')),
    token: option('token', 'test-token'),
    bot: { id: 'bot-user-id', username: option('bot', 'dsh-bot') },
    users: [
      { id: 'user-alice', username: 'alice' },
      { id: 'user-bob', username: 'bob' },
      { id: 'user-mallory', username: 'mallory' },
    ],
  })
  console.log(`fake Mattermost listening on ${server.url} (token ${server.token})`)
  const stop = async () => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
