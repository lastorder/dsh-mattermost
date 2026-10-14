import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeMattermost } from '../scripts/fake-mattermost.js'
import { createFakeDsh, sleep } from './fake-dsh.js'
import { Config, apply, testConnection } from '../index.js'
import { CONNECTION_DEFAULTS } from '../lib/config.js'
import { describe as describeError } from '../lib/bridge.js'

const WRITE = Symbol.for('cosmokit.volatile.write')
const USERS = [
  { id: 'user-alice', username: 'alice' },
  { id: 'user-bob', username: 'bob' },
  { id: 'user-mallory', username: 'mallory' },
]
const CONNECTION_FIELDS = new Set(Object.keys(CONNECTION_DEFAULTS))

/** A minimal Cordis-like context backed by the fake DSH bus. */
function fakeContext(dsh, { workspaces } = {}) {
  const effects = []
  const commands = new Map()
  const routes = new Map()
  const lines = []
  const logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    debug: (message) => lines.push(`debug ${message}`),
  }
  const ctx = {
    logger: Object.assign(() => logger, logger),
    fiber: { entry: { options: { id: 'mattermost-test' } } },
    sessionController: dsh.sessionController,
    on: (name, listener, options) => {
      const dispose = dsh.on(name, listener, options)
      effects.push(dispose)
      return dispose
    },
    effect(body) {
      const dispose = body()
      effects.push(dispose)
      return dispose
    },
    inject(names, callback) {
      const child = { ...ctx }
      if (names.includes('commands')) child.commands = { register: (definition) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } }
      if (names.includes('connection')) {
        child.connection = {
          fetch: {
            register: (route) => {
              if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        }
      }
      callback(child)
    },
    get: (name) => ({ workspaceRegistry: workspaces, sessionQuery: dsh.sessionQuery })[name],
  }
  return {
    ctx,
    commands,
    routes,
    lines,
    async dispose() {
      for (const dispose of effects.reverse()) await dispose?.()
    },
  }
}

/** Split a flat test config into the environment's own fields and the shared fields. */
function splitConfig(config) {
  const connection = {}
  const shared = {}
  for (const [key, value] of Object.entries(config)) (CONNECTION_FIELDS.has(key) ? connection : shared)[key] = value
  return { connection, shared }
}

async function setup({ config = {}, responder, createdResponder, claimEvent = true, workspaces } = {}) {
  const server = await startFakeMattermost({ users: USERS })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mattermost-test-'))
  const dsh = createFakeDsh({ claimEvent, createdResponder })
  dsh.addSession('session-main', responder)
  const { connection, shared } = splitConfig(config)
  const parsed = Config({
    connections: [{ id: 'main', name: 'Main', serverUrl: server.url, token: server.token, sessionId: 'session-main', ...connection }],
    stateFile: join(dir, 'state.json'),
    typingIndicator: true,
    ...shared,
  })
  const harness = fakeContext(dsh, { workspaces })
  apply(harness.ctx, parsed)
  await server.waitFor((state) => state.sockets.size === 1)
  const command = (rawInput, agentId = 'session-main') => harness.commands.get('mattermost').handler({ agent: { id: agentId }, rawInput })
  /** Apply a volatile config change the way the Loader does. */
  const update = async (patch) => {
    const split = splitConfig(patch)
    if (Object.keys(split.connection).length > 0) {
      const [first, ...rest] = parsed.connections.get()
      parsed.connections[WRITE]([{ ...first, ...split.connection }, ...rest])
    }
    for (const [key, value] of Object.entries(split.shared)) parsed[key][WRITE](value)
    dsh.emit('loader/volatile-update', Object.keys(patch).map((key) => [key]))
  }
  const call = async (path, init) => {
    const route = harness.routes.get(`/api/dsh-mattermost/mattermost-test/${path}`)
    assert.ok(route, `route ${path} is registered`)
    const response = await route.fetch(new Request(`http://127.0.0.1/api/dsh-mattermost/mattermost-test/${path}`, init))
    return { status: response.status, body: await response.json() }
  }
  return {
    server,
    dsh,
    harness,
    parsed,
    command,
    update,
    call,
    dir,
    stateFile: join(dir, 'state.json'),
    /** The latest text of a bot post (created or patched). */
    text: (id) => server.state.posts.get(id)?.message,
    botPosts: () => server.state.created,
    async close() {
      await harness.dispose()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Poll a condition that is not observable through the fake server (e.g. DSH-side state). */
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error('until timed out')
}

/** Wait until the bot's reply in `rootId` no longer shows a transient notice. */
function finalReply(t, rootId, { contains, server = t.server } = {}) {
  return server.waitFor((state) => {
    for (const post of state.created) {
      if (post.root_id !== rootId) continue
      const message = state.posts.get(post.id).message
      if (/Processing your request|queued/.test(message)) continue
      if (contains && !message.includes(contains)) continue
      return message
    }
    return undefined
  }, 8000)
}

test('a mention is answered by the configured DSH session in the thread', async () => {
  const t = await setup({ responder: (text) => ({ texts: ['thinking out loud', `final answer to: ${text.split('\n').at(-1)}`] }) })
  try {
    const post = t.server.post({ message: '@dsh-bot what is 2+2?', user: 'user-alice' })
    const reply = await finalReply(t, post.id)
    assert.equal(reply, '@alice final answer to: @alice: what is 2+2?')
    assert.equal(t.dsh.prompts.length, 1)
    const prompt = t.dsh.prompts[0]
    assert.equal(prompt.sessionId, 'session-main')
    assert.equal(prompt.mode, 'queue')
    assert.match(prompt.requestId, new RegExp(`^mattermost-${post.id}-`))
    assert.match(prompt.text, /^\[Mattermost\] Message from @alice in ~town-square/)
    assert.match(prompt.text, /@alice: what is 2\+2\?$/)
    // One post only: the acknowledgement was patched into the answer.
    assert.equal(t.botPosts().filter((created) => created.root_id === post.id).length, 1)
    assert.ok(t.server.state.typing.length >= 1)
    assert.equal(t.server.state.typing[0].parent_id, post.id)
  } finally {
    await t.close()
  }
})

test('replyMode "all" posts every assistant message of the turn', async () => {
  const t = await setup({ config: { replyMode: 'all', mentionSender: false }, responder: () => ({ texts: ['part one', 'part two'] }) })
  try {
    const post = t.server.post({ message: '@dsh-bot go' })
    assert.equal(await finalReply(t, post.id), 'part one\n\npart two')
  } finally {
    await t.close()
  }
})

test('posts that do not address the bot, or come from bots, are ignored', async () => {
  const t = await setup()
  try {
    t.server.post({ message: 'hello everyone' })
    t.server.post({ message: '@dsh-bot-dev hi' })
    t.server.post({ message: '@dsh-bot from a bot', props: { from_bot: 'true' } })
    t.server.post({ message: '@dsh-bot joined', type: 'system_join_channel' })
    t.server.post({ message: '@dsh-bot own', user: 'bot-user-id' })
    await sleep(300)
    assert.equal(t.dsh.prompts.length, 0)
    assert.equal(t.botPosts().length, 0)
  } finally {
    await t.close()
  }
})

test('direct messages and patterns trigger without a mention', async () => {
  const t = await setup({ config: { triggerPattern: '^!ask\\s+(?<prompt>[\\s\\S]+)' } })
  try {
    const dm = t.server.post({ message: 'hi there', channel: 'dm-1', channel_type: 'D', channel_name: 'bot-user-id__user-alice', channel_display_name: '' })
    assert.equal(await finalReply(t, dm.id), '@alice echo: @alice: hi there')
    const asked = t.server.post({ message: '!ask build the docs' })
    assert.equal(await finalReply(t, asked.id), '@alice echo: @alice: build the docs')
    assert.match(t.dsh.prompts[0].text, /in a direct message/)
  } finally {
    await t.close()
  }
})

test('channel and user filters', async () => {
  const t = await setup({ config: { channels: ['dev'], allowedUsers: ['alice'] } })
  try {
    t.server.post({ message: '@dsh-bot wrong channel' })
    await sleep(200)
    assert.equal(t.botPosts().length, 0)
    const denied = t.server.post({ message: '@dsh-bot let me in', user: 'user-mallory', channel: 'c-dev', channel_name: 'dev', channel_display_name: 'Dev' })
    const refusal = await finalReply(t, denied.id)
    assert.equal(refusal, '@mallory You do not have permission to use this agent.')
    const allowed = t.server.post({ message: '@dsh-bot ok', user: 'user-alice', channel: 'c-dev', channel_name: 'dev', channel_display_name: 'Dev' })
    assert.equal(await finalReply(t, allowed.id), '@alice echo: @alice: ok')
    assert.equal(t.dsh.prompts.length, 1)
  } finally {
    await t.close()
  }
})

test('an empty mention gets the empty-message notice without a prompt', async () => {
  const t = await setup()
  try {
    const post = t.server.post({ message: '@dsh-bot' })
    assert.equal(await finalReply(t, post.id), '@alice Empty message after removing the mention.')
    assert.equal(t.dsh.prompts.length, 0)
  } finally {
    await t.close()
  }
})

test('thread replies carry earlier thread posts as context', async () => {
  const t = await setup()
  try {
    const root = t.server.post({ message: 'we need a release plan', user: 'user-bob' })
    t.server.post({ message: 'agreed, by Friday', user: 'user-alice', root_id: root.id })
    const ask = t.server.post({ message: '@dsh-bot draft it', user: 'user-alice', root_id: root.id })
    await finalReply(t, root.id)
    const text = t.dsh.prompts[0].text
    assert.match(text, /\[Thread context\]\n@bob: we need a release plan\n@alice: agreed, by Friday\n\n\[Current request\]\n@alice: draft it$/)
    assert.ok(!text.includes('Processing your request'))
    assert.ok(ask.id)
  } finally {
    await t.close()
  }
})

test('requests are processed one at a time with a queued notice', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const t = await setup({
    responder: async () => {
      calls += 1
      if (calls === 1) await gate
      return { texts: [`done ${calls}`] }
    },
  })
  try {
    const first = t.server.post({ message: '@dsh-bot first' })
    await until(() => t.dsh.prompts.length === 1)
    const second = t.server.post({ message: '@dsh-bot second', user: 'user-bob' })
    const queued = await t.server.waitFor((state) => state.created.find((post) => post.root_id === second.id))
    assert.match(queued.message, /queued/)
    await sleep(100)
    assert.equal(t.dsh.prompts.length, 1, 'the second request waits for the first')
    release()
    assert.equal(await finalReply(t, first.id), '@alice done 1')
    assert.equal(await finalReply(t, second.id), '@bob done 2')
    // The queued notice was updated in place, not duplicated.
    assert.equal(t.botPosts().filter((post) => post.root_id === second.id).length, 1)
  } finally {
    await t.close()
  }
})

test('the queue limit rejects extra requests', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t = await setup({ config: { queueMaxSize: 1 }, responder: async () => { await gate; return { texts: ['ok'] } } })
  try {
    t.server.post({ message: '@dsh-bot one' })
    await until(() => t.dsh.prompts.length === 1)
    t.server.post({ message: '@dsh-bot two' })
    await sleep(100)
    const third = t.server.post({ message: '@dsh-bot three' })
    const rejected = await t.server.waitFor((state) => state.created.find((post) => post.root_id === third.id))
    assert.match(rejected.message, /busy/)
    release()
  } finally {
    await t.close()
  }
})

test('failed, cancelled and empty turns produce explanatory replies', async () => {
  const plans = [
    { reason: { kind: 'error', error: { message: 'model exploded' } } },
    { texts: ['partial'], reason: { kind: 'aborted', reason: { kind: 'user' } } },
    { texts: [] },
  ]
  const t = await setup({ responder: () => plans.shift() })
  try {
    const a = t.server.post({ message: '@dsh-bot a' })
    assert.equal(await finalReply(t, a.id), '@alice Sorry, an error occurred while processing your request. (model exploded)')
    const b = t.server.post({ message: '@dsh-bot b' })
    assert.equal(await finalReply(t, b.id), '@alice partial\n\n_The request was cancelled in DSH._')
    const c = t.server.post({ message: '@dsh-bot c' })
    assert.equal(await finalReply(t, c.id), '@alice DSH finished without a text reply.')
  } finally {
    await t.close()
  }
})

test('the turn is found from user/message when no claim event is observed', async () => {
  const t = await setup({ claimEvent: false })
  try {
    const post = t.server.post({ message: '@dsh-bot fallback' })
    assert.equal(await finalReply(t, post.id), '@alice echo: @alice: fallback')
  } finally {
    await t.close()
  }
})

test('a missing configured session is reported', async () => {
  const t = await setup({ config: { sessionId: 'session-gone' } })
  try {
    const post = t.server.post({ message: '@dsh-bot hello' })
    assert.match(await finalReply(t, post.id), /DSH session not found: session-gone/)
  } finally {
    await t.close()
  }
})

test('without a session, one is created, titled, bound and reused; /mattermost bind rebinds', async () => {
  const workspaces = { list: () => [{ id: 'ws-1', path: '/tmp/ws', sessionIds: [] }], resolveByPath: async () => undefined }
  const t = await setup({ config: { sessionId: '' }, workspaces })
  try {
    const first = t.server.post({ message: '@dsh-bot start' })
    await finalReply(t, first.id)
    assert.equal(t.dsh.sessionController.lastCreate.workspaceId, 'ws-1')
    const created = t.dsh.prompts[0].sessionId
    assert.equal(created, 'session-created-1')
    assert.equal(t.dsh.sessions.get(created).title, 'Mattermost · Main')
    const stored = JSON.parse(await readFile(t.stateFile, 'utf8'))
    assert.equal(stored.bindings['mattermost-test/main'].sessionId, created)
    const second = t.server.post({ message: '@dsh-bot again' })
    await finalReply(t, second.id)
    assert.equal(t.dsh.prompts[1].sessionId, created)

    t.dsh.addSession('session-other')
    const result = await t.command(' bind', 'session-other')
    assert.equal(result.kind, 'success')
    const third = t.server.post({ message: '@dsh-bot third' })
    await finalReply(t, third.id)
    assert.equal(t.dsh.prompts[2].sessionId, 'session-other')

    // A vanished bound session is replaced automatically.
    t.dsh.sessions.delete('session-other')
    const fourth = t.server.post({ message: '@dsh-bot fourth' })
    assert.equal(await finalReply(t, fourth.id), '@alice echo: @alice: fourth')
    assert.equal(t.dsh.prompts.at(-1).sessionId, 'session-created-2')

    const status = await t.command('status')
    assert.match(status.text, /▸ Main \[main\] — connected as @dsh-bot/)
    assert.match(status.text, /@dsh-bot → default workspace · session-created-2 "Mattermost · Main" — bound with \/mattermost bind/)
    assert.equal((await t.command('unbind', 'session-created-2')).kind, 'success')
    assert.match((await t.command('')).text, /a session will be created on the first message/)
    assert.equal((await t.command('nope')).kind, 'error')
  } finally {
    await t.close()
  }
})

test('autoCreateSession false asks the user to bind a session', async () => {
  const t = await setup({ config: { sessionId: '', autoCreateSession: false } })
  try {
    const post = t.server.post({ message: '@dsh-bot hello' })
    assert.match(await finalReply(t, post.id), /No DSH session is bound/)
  } finally {
    await t.close()
  }
})

test('an approval wait in DSH is shown in the acknowledgement', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t = await setup({
    responder: async (text, { agent, waterfall }) => {
      const outcome = waterfall('approval/request', { agent, toolName: 'bash' }, () => gate.then(() => ({ kind: 'approved' })))
      await outcome
      return { texts: ['ran it'] }
    },
  })
  try {
    const post = t.server.post({ message: '@dsh-bot run ls' })
    const waiting = await t.server.waitFor((state) => state.patched.find((patch) => /permission approval/.test(patch.message)))
    assert.equal(waiting.message, '@alice Waiting for a permission approval in DSH: `bash`')
    release()
    assert.equal(await finalReply(t, post.id, { contains: 'ran it' }), '@alice ran it')
  } finally {
    await t.close()
  }
})

test('a question asked by a sub-agent of the target session is shown too', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t = await setup({
    responder: async (text, { waterfall }) => {
      const child = { id: 'session-child', session: { header: { parentSession: 'session-main' } } }
      const stranger = { id: 'session-other', session: { header: {} } }
      await waterfall('approval/request', { agent: stranger, toolName: 'rm' }, () => ({ kind: 'approved' }))
      await waterfall('user-questions/request', { agent: child, questions: [{ question: 'Which branch?', header: 'Branch' }] }, () => gate.then(() => ({})))
      return { texts: ['used main'] }
    },
  })
  try {
    const post = t.server.post({ message: '@dsh-bot release it' })
    const waiting = await t.server.waitFor((state) => state.patched.find((patch) => /Waiting for an answer/.test(patch.message)))
    assert.equal(waiting.message, '@alice Waiting for an answer in DSH: Which branch?')
    assert.ok(!t.server.state.patched.some((patch) => patch.message.includes('`rm`')), 'other sessions are not reported')
    release()
    assert.equal(await finalReply(t, post.id, { contains: 'used main' }), '@alice used main')
  } finally {
    await t.close()
  }
})

test('long answers are split across posts in the thread', async () => {
  const long = Array.from({ length: 40 }, (_, index) => `line ${index} ${'z'.repeat(60)}`).join('\n')
  const t = await setup({ config: { maxPostLength: 1000 }, responder: () => ({ texts: [long] }) })
  try {
    const post = t.server.post({ message: '@dsh-bot long' })
    await t.server.waitFor((state) => state.created.filter((created) => created.root_id === post.id).length >= 3)
    await sleep(100)
    const parts = t.botPosts().filter((created) => created.root_id === post.id).map((created) => t.text(created.id))
    for (const part of parts) assert.ok(part.length <= 1000)
    assert.ok(parts[0].startsWith('@alice line 0'))
    assert.equal(parts.join('\n').replace(/^@alice /, '').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '))
  } finally {
    await t.close()
  }
})

test('the bridge reconnects after the connection drops', async () => {
  const t = await setup()
  try {
    t.server.dropConnections()
    await t.server.waitFor((state) => state.sockets.size === 0)
    await t.server.waitFor((state) => state.sockets.size === 1, 8000)
    const post = t.server.post({ message: '@dsh-bot still there?' })
    assert.equal(await finalReply(t, post.id), '@alice echo: @alice: still there?')
  } finally {
    await t.close()
  }
})

test('changing the token reconnects; a wrong token is reported', async () => {
  const t = await setup()
  try {
    await t.update({ token: 'wrong' })
    await t.server.waitFor((state) => state.sockets.size === 0)
    await sleep(300)
    const { text } = await t.command('status')
    assert.match(text, /— (error|connecting|token rejected|reconnecting)/)
    await t.update({ token: t.server.token })
    await t.server.waitFor((state) => state.sockets.size === 1, 8000)
    const post = t.server.post({ message: '@dsh-bot back' })
    assert.equal(await finalReply(t, post.id), '@alice echo: @alice: back')
  } finally {
    await t.close()
  }
})

test('changing shared settings applies without reconnecting', async () => {
  const t = await setup()
  try {
    await t.update({ mentionSender: false, messages: { processing: 'Working on it…' } })
    await sleep(100)
    assert.equal(t.server.state.sockets.size, 1)
    const post = t.server.post({ message: '@dsh-bot hi' })
    assert.equal(await finalReply(t, post.id, { contains: 'echo' }), 'echo: @alice: hi')
    assert.ok(t.server.state.patched.some((patch) => patch.message === 'echo: @alice: hi'))
    assert.ok(t.server.state.created.some((created) => created.root_id === post.id && created.message === 'Working on it…'), 'the custom processing text was posted first')
  } finally {
    await t.close()
  }
})

test('several environments run side by side, each with its own session, and can be disabled live', async () => {
  const t = await setup()
  const other = await startFakeMattermost({ users: USERS, token: 'other-token', bot: { id: 'bot-2', username: 'helper' } })
  try {
    t.dsh.addSession('session-b', (text) => ({ texts: [`B says ${text.split('\n').at(-1)}`] }))
    const [main] = t.parsed.connections.get()
    t.parsed.connections[WRITE]([main, { id: 'second', name: 'Second', serverUrl: other.url, token: 'other-token', sessionId: 'session-b' }])
    t.dsh.emit('loader/volatile-update', [['connections']])
    await other.waitFor((state) => state.sockets.size === 1)
    assert.equal(t.server.state.sockets.size, 1, 'the first environment kept its connection')

    const a = t.server.post({ message: '@dsh-bot hello A' })
    const b = other.post({ message: '@helper hello B' })
    assert.equal(await finalReply(t, a.id), '@alice echo: @alice: hello A')
    assert.equal(await finalReply(t, b.id, { server: other }), '@alice B says @alice: hello B')
    assert.deepEqual(t.dsh.prompts.map((prompt) => prompt.sessionId).sort(), ['session-b', 'session-main'])

    const status = await t.command('status')
    assert.match(status.text, /Mattermost environments: 2 \(2 connected\)/)
    assert.match(status.text, /▸ Second \[second\] — connected as @helper/)
    assert.equal((await t.command('bind')).kind, 'error', 'bind needs a name with several environments')
    assert.equal((await t.command('bind second', 'session-main')).kind, 'success')
    assert.equal((await t.command('bind nope')).kind, 'error')

    t.parsed.connections[WRITE]([main, { id: 'second', name: 'Second', serverUrl: other.url, token: 'other-token', sessionId: 'session-b', enabled: false }])
    t.dsh.emit('loader/volatile-update', [['connections']])
    await other.waitFor((state) => state.sockets.size === 0)
    assert.match((await t.command('status')).text, /▸ Second \[second\] — disabled/)
    assert.equal(t.server.state.sockets.size, 1)
  } finally {
    await other.close()
    await t.close()
  }
})

test('the settings page endpoints report status, list sessions, test and reconnect', async () => {
  const t = await setup()
  try {
    t.dsh.sessions.get('session-main').title = 'Main work'
    t.dsh.addSession('session-child').origin = 'subagent'
    await until(async () => (await t.call('status')).body.connections[0].state === 'connected')
    const status = await t.call('status')
    assert.equal(status.status, 200)
    assert.equal(status.body.ok, true)
    const [main] = status.body.connections
    assert.equal(main.key, 'main')
    assert.equal(main.state, 'connected')
    assert.equal(main.bot, 'dsh-bot')
    assert.equal(main.hasToken, true)
    assert.deepEqual(main.target, { id: 'session-main', source: 'config', title: 'Main work' })
    assert.ok(!JSON.stringify(status.body).includes(t.server.token), 'tokens never leave the Host')

    const sessions = await t.call('sessions')
    assert.deepEqual(sessions.body.sessions.map((session) => [session.id, session.title]), [['session-main', 'Main work']])

    const saved = await t.call('test', { method: 'POST', body: JSON.stringify({ key: 'main' }) })
    assert.deepEqual([saved.body.ok, saved.body.username, saved.body.websocket], [true, 'dsh-bot', 'ok'])
    const wrong = await t.call('test', { method: 'POST', body: JSON.stringify({ serverUrl: t.server.url, token: 'nope' }) })
    assert.equal(wrong.body.ok, false)
    assert.match(wrong.body.error, /401/)
    const empty = await t.call('test', { method: 'POST', body: JSON.stringify({}) })
    assert.match(empty.body.error, /server URL is empty/)
    const malformed = await t.call('test', { method: 'POST', body: 'not json' })
    assert.equal(malformed.status, 400)

    const reconnect = await t.call('reconnect', { method: 'POST', body: JSON.stringify({ key: 'main' }) })
    assert.equal(reconnect.body.ok, true)
    await until(async () => (await t.call('status')).body.connections[0].state === 'connected')
    const missing = await t.call('reconnect', { method: 'POST', body: JSON.stringify({ key: 'ghost' }) })
    assert.equal(missing.status, 404)
  } finally {
    await t.close()
  }
})

test('testConnection reports a WebSocket failure separately from sign-in', async () => {
  const server = await startFakeMattermost({ users: USERS })
  try {
    class RejectingSocket extends EventTarget {
      constructor() {
        super()
        setTimeout(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1006 })), 5)
      }
      send() {}
      close() {}
    }
    const result = await testConnection({ serverUrl: server.url, token: server.token, WebSocket: RejectingSocket })
    assert.equal(result.ok, false)
    assert.equal(result.username, 'dsh-bot')
    assert.match(result.error, /WebSocket failed/)
  } finally {
    await server.close()
  }
})

test('with no environment the plugin stays idle and says how to add one', async () => {
  const dsh = createFakeDsh()
  const harness = fakeContext(dsh)
  apply(harness.ctx, Config({}))
  const status = await harness.commands.get('mattermost').handler({ agent: { id: 's' }, rawInput: '' })
  assert.match(status.text, /No Mattermost environment is configured yet/)
  assert.equal((await harness.commands.get('mattermost').handler({ agent: { id: 's' }, rawInput: 'bind' })).kind, 'error')
  await harness.dispose()
})

test('an environment without a token reports itself unconfigured', async () => {
  const dsh = createFakeDsh()
  const harness = fakeContext(dsh)
  apply(harness.ctx, Config({ connections: [{ name: 'Empty', serverUrl: 'https://mm.example.com' }] }))
  await sleep(20)
  const status = await harness.commands.get('mattermost').handler({ agent: { id: 's' }, rawInput: 'status' })
  assert.match(status.text, /▸ Empty \[empty\] — missing server URL or token/)
  await harness.dispose()
})

test('disposing the plugin closes the socket and removes its listeners and routes', async () => {
  const t = await setup()
  try {
    assert.equal(t.dsh.listenerCount('approval/request'), 1)
    assert.equal(t.harness.routes.size, 5)
    const post = t.server.post({ message: '@dsh-bot hi' })
    await finalReply(t, post.id)
    assert.equal(t.dsh.listenerCount('session/event'), 1, 'one shared turn listener, not one per request')
    await t.harness.dispose()
    await t.server.waitFor((state) => state.sockets.size === 0)
    assert.equal(t.dsh.listenerCount('approval/request'), 0)
    assert.equal(t.dsh.listenerCount('session/event'), 0)
    assert.equal(t.harness.routes.size, 0)
  } finally {
    await t.server.close()
    await rm(t.dir, { recursive: true, force: true })
  }
})

test('error descriptions include the low-level cause', async () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) })
  assert.equal(describeError(refused), 'fetch failed (connect ECONNREFUSED 127.0.0.1:1)')
  const both = new TypeError('fetch failed', { cause: Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:1'), new Error('connect ECONNREFUSED 127.0.0.1:1')], ''), { code: 'ECONNREFUSED' }) })
  assert.equal(describeError(both), 'fetch failed (connect ECONNREFUSED ::1:1)')
  assert.equal(describeError(Object.assign(new Error('nope'), { code: 'session/not-found' })), 'session/not-found: nope')
  assert.equal(describeError('plain'), 'plain')
  // A port that was just free: nothing listens there any more.
  const { createServer } = await import('node:net')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  const unreachable = await testConnection({ serverUrl: `http://127.0.0.1:${port}`, token: 'x' })
  assert.equal(unreachable.ok, false)
  assert.match(unreachable.error, /^fetch failed \(.*ECONNREFUSED.*\)$/)
})

/** A workspace registry with the two orion workspaces; unknown directories can be registered. */
function fakeWorkspaces() {
  const list = [
    { id: 'ws-agent', path: '/ws/orion-agent', title: 'orion-agent', sessionIds: [] },
    { id: 'ws-wizard', path: '/ws/orion-wizard', title: 'orion-wizard', sessionIds: [] },
  ]
  const created = []
  return {
    created,
    list: () => list,
    resolveByPath: async (path) => list.find((workspace) => workspace.path === path),
    create: async (path) => {
      const workspace = { id: `ws-${list.length + 1}`, path, title: path.split('/').pop(), sessionIds: [] }
      list.push(workspace)
      created.push(path)
      return workspace
    },
  }
}

const ROUTES = [
  { id: 'agent', mentionName: 'orion-agent', workspace: '/ws/orion-agent', sessionMode: 'shared' },
  { id: 'wizard', mentionName: 'orion-wizard', workspace: '/ws/orion-wizard', sessionMode: 'new' },
]

/** Wait until the thread holds `count` final (non-transient) bot replies. */
function finalReplies(t, rootId, count) {
  return t.server.waitFor((state) => {
    const done = state.created
      .filter((post) => post.root_id === rootId)
      .map((post) => state.posts.get(post.id).message)
      .filter((message) => !/Processing your request|queued/.test(message))
    return done.length >= count ? done : undefined
  }, 8000)
}

test('mentions pick their route: the workspace and session mode follow the route', async () => {
  const workspaces = fakeWorkspaces()
  const t = await setup({ config: { sessionId: '', routes: ROUTES }, workspaces })
  try {
    const a1 = t.server.post({ message: '@orion-agent first agent question' })
    assert.equal(await finalReply(t, a1.id), '@alice echo: @alice: first agent question')
    const a2 = t.server.post({ message: '@orion-agent second agent question' })
    await finalReply(t, a2.id)
    assert.equal(t.dsh.creates.length, 1, 'shared mode creates one session')
    const agentSession = t.dsh.creates[0].sessionId
    assert.equal(t.dsh.creates[0].workspaceId, 'ws-agent')
    assert.deepEqual(t.dsh.prompts.map((prompt) => prompt.sessionId), [agentSession, agentSession])
    assert.equal(t.dsh.sessions.get(agentSession).title, 'Mattermost · @orion-agent')
    const stored = JSON.parse(await readFile(t.stateFile, 'utf8'))
    assert.equal(stored.bindings['mattermost-test/main/agent'].sessionId, agentSession)

    const w1 = t.server.post({ message: '@orion-wizard   plan the release' })
    assert.equal(await finalReply(t, w1.id), '@alice echo: @alice: plan the release')
    const w2 = t.server.post({ message: '@orion-wizard review it' })
    await finalReply(t, w2.id)
    const wizard = t.dsh.creates.slice(1)
    assert.equal(wizard.length, 2, 'new mode creates a session per request')
    assert.deepEqual(wizard.map((entry) => entry.workspaceId), ['ws-wizard', 'ws-wizard'])
    assert.equal(t.dsh.sessions.get(wizard[0].sessionId).title, 'Mattermost · @orion-wizard · plan the release')
    assert.deepEqual(t.dsh.prompts.slice(2).map((prompt) => prompt.sessionId), wizard.map((entry) => entry.sessionId))

    // With routes, the bot's own name is not a trigger; a direct message goes to the first route unless it mentions another.
    t.server.post({ message: '@dsh-bot hello' })
    await sleep(150)
    assert.equal(t.dsh.prompts.length, 4)
    const dm = { channel: 'dm-1', channel_type: 'D', channel_name: 'bot-user-id__user-alice', channel_display_name: '' }
    const private1 = t.server.post({ message: 'hi in private', ...dm })
    await finalReply(t, private1.id)
    assert.equal(t.dsh.prompts.at(-1).sessionId, agentSession)
    const private2 = t.server.post({ message: '@orion-wizard in private', ...dm })
    assert.equal(await finalReply(t, private2.id), '@alice echo: @alice: in private')
    assert.equal(t.dsh.creates.length, 4)
    assert.equal(t.dsh.prompts.at(-1).sessionId, t.dsh.creates[3].sessionId)
  } finally {
    await t.close()
  }
})

test('thread mode: one session per thread, reused for follow-ups, also after a reload', async () => {
  const workspaces = fakeWorkspaces()
  const t = await setup({ config: { sessionId: '', followThreads: true, routes: [{ id: 'agent', mentionName: 'orion-agent', workspace: '/ws/orion-agent', sessionMode: 'thread' }] }, workspaces })
  try {
    const root = t.server.post({ message: '@orion-agent topic one' })
    await finalReply(t, root.id)
    t.server.post({ message: 'more about it', root_id: root.id })
    await finalReplies(t, root.id, 2)
    const other = t.server.post({ message: '@orion-agent topic two' })
    await finalReply(t, other.id)
    const [first, second] = t.dsh.creates
    assert.equal(t.dsh.creates.length, 2)
    assert.equal(first.workspaceId, 'ws-agent')
    assert.deepEqual(t.dsh.prompts.map((prompt) => prompt.sessionId), [first.sessionId, first.sessionId, second.sessionId])
    assert.equal(t.dsh.sessions.get(first.sessionId).title, 'Mattermost · @orion-agent · topic one')
    const stored = JSON.parse(await readFile(t.stateFile, 'utf8'))
    assert.equal(stored.threads[`mattermost-test/main/agent:${root.id}`].sessionId, first.sessionId)

    // A reloaded plugin continues the thread in the same session.
    await t.harness.dispose()
    await t.server.waitFor((state) => state.sockets.size === 0)
    const again = fakeContext(t.dsh, { workspaces })
    apply(again.ctx, t.parsed)
    try {
      await t.server.waitFor((state) => state.sockets.size === 1)
      t.server.post({ message: '@orion-agent still there?', root_id: root.id })
      await finalReplies(t, root.id, 3)
      assert.equal(t.dsh.prompts.at(-1).sessionId, first.sessionId)
      assert.equal(t.dsh.creates.length, 2)
    } finally {
      await again.dispose()
    }
  } finally {
    await t.close()
  }
})

test('different routes run in parallel while one shared session answers in order', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t = await setup({
    config: {
      sessionId: '',
      routes: [
        { id: 'agent', mentionName: 'orion-agent', sessionMode: 'shared', sessionId: 'session-main' },
        { id: 'wizard', mentionName: 'orion-wizard', sessionMode: 'new' },
      ],
    },
    responder: async (text) => {
      if (text.includes('slow')) await gate
      return { texts: [`agent: ${text.split('\n').at(-1)}`] }
    },
    createdResponder: (text) => ({ texts: [`wizard: ${text.split('\n').at(-1)}`] }),
  })
  try {
    const slow = t.server.post({ message: '@orion-agent slow job' })
    await until(() => t.dsh.prompts.length === 1)
    const quick = t.server.post({ message: '@orion-wizard quick one', user: 'user-bob' })
    assert.equal(await finalReply(t, quick.id), '@bob wizard: @bob: quick one')
    const next = t.server.post({ message: '@orion-agent next job' })
    const notice = await t.server.waitFor((state) => state.created.find((post) => post.root_id === next.id))
    assert.match(notice.message, /queued/)
    assert.equal(t.dsh.prompts.length, 2, 'the second request of the shared session waits for the first')
    release()
    assert.equal(await finalReply(t, slow.id), '@alice agent: @alice: slow job')
    assert.equal(await finalReply(t, next.id), '@alice agent: @alice: next job')
  } finally {
    release()
    await t.close()
  }
})

test('maxConcurrent 1 runs every request one after another', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t = await setup({
    config: {
      sessionId: '',
      maxConcurrent: 1,
      routes: [
        { id: 'agent', mentionName: 'orion-agent', sessionMode: 'shared', sessionId: 'session-main' },
        { id: 'wizard', mentionName: 'orion-wizard', sessionMode: 'new' },
      ],
    },
    responder: async () => {
      await gate
      return { texts: ['agent done'] }
    },
    createdResponder: () => ({ texts: ['wizard done'] }),
  })
  try {
    const slow = t.server.post({ message: '@orion-agent slow job' })
    await until(() => t.dsh.prompts.length === 1)
    const quick = t.server.post({ message: '@orion-wizard quick one' })
    const notice = await t.server.waitFor((state) => state.created.find((post) => post.root_id === quick.id))
    assert.match(notice.message, /queued/)
    await sleep(100)
    assert.equal(t.dsh.prompts.length, 1)
    release()
    assert.equal(await finalReply(t, slow.id), '@alice agent done')
    assert.equal(await finalReply(t, quick.id), '@alice wizard done')
  } finally {
    release()
    await t.close()
  }
})

test('/mattermost bind, status and the page endpoints know the routes', async () => {
  const workspaces = fakeWorkspaces()
  const t = await setup({ config: { sessionId: '', routes: ROUTES }, workspaces })
  try {
    t.dsh.sessions.get('session-main').title = 'Main work'
    const bound = await t.command('bind')
    assert.equal(bound.kind, 'success')
    assert.match(bound.text, /@orion-agent: messages will be answered in this session/)
    assert.match((await t.command('bind @orion-wizard')).text, /skipped — it creates a new session for every request/)
    assert.equal((await t.command('bind nope')).kind, 'error')
    const status = (await t.command('status')).text
    assert.match(status, /@orion-agent → \/ws\/orion-agent · session-main "Main work" \(this session\) — bound with \/mattermost bind/)
    assert.match(status, /@orion-wizard → \/ws\/orion-wizard · a new session per message/)
    const asked = t.server.post({ message: '@orion-agent hello' })
    await finalReply(t, asked.id)
    assert.equal(t.dsh.prompts.at(-1).sessionId, 'session-main')
    assert.equal(t.dsh.creates.length, 0)

    const page = await t.call('status')
    assert.deepEqual(page.body.connections[0].routes.map((route) => [route.key, route.mentionName, route.workspace, route.sessionMode, route.target.source, route.target.title]), [
      ['agent', 'orion-agent', '/ws/orion-agent', 'shared', 'binding', 'Main work'],
      ['wizard', 'orion-wizard', '/ws/orion-wizard', 'new', 'new', undefined],
    ])
    const listed = await t.call('workspaces')
    assert.deepEqual(listed.body.workspaces, [
      { id: 'ws-agent', title: 'orion-agent', path: '/ws/orion-agent' },
      { id: 'ws-wizard', title: 'orion-wizard', path: '/ws/orion-wizard' },
    ])
    assert.match((await t.command('unbind')).text, /Unbound: main\/@orion-agent/)
  } finally {
    await t.close()
  }
})

test('a route directory that is not a DSH workspace yet is registered as one', async () => {
  const workspaces = fakeWorkspaces()
  const t = await setup({ config: { sessionId: '', routes: [{ id: 'x', mentionName: 'orion-x', workspace: '/ws/brand-new', sessionMode: 'new' }] }, workspaces })
  try {
    const asked = t.server.post({ message: '@orion-x hi' })
    await finalReply(t, asked.id)
    assert.deepEqual(workspaces.created, ['/ws/brand-new'])
    assert.equal(t.dsh.creates[0].workspaceId, 'ws-3')
  } finally {
    await t.close()
  }
})
