/**
 * A fake DSH Host for bridge tests: a Cordis-like event bus plus a session
 * controller whose sessions replay the agent loop's event sequence
 * (`agent/inbox/inserted` → `turn/start` → `agent/inbox/claimed` →
 * `user/message` → `assistant/message`… → `turn/end`), one queued prompt per turn.
 */
export class FakeRemoteError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param options.claimEvent - emit `agent/inbox/claimed` (otherwise the bridge must fall back to `user/message`).
 * @param options.createdResponder - responder of sessions made by `sessionController.create`.
 */
export function createFakeDsh({ claimEvent = true, createdResponder } = {}) {
  const listeners = new Map()
  const sessions = new Map()
  const prompts = []
  const creates = []
  let created = 0

  const on = (name, listener, options) => {
    const list = listeners.get(name) ?? []
    if (options?.prepend) list.unshift(listener)
    else list.push(listener)
    listeners.set(name, list)
    return () => {
      const current = listeners.get(name) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
      return index >= 0
    }
  }
  const emit = (name, ...args) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
  }
  /** Run a waterfall through the registered listeners, innermost `final`. */
  const waterfall = (name, payload, final) => {
    const list = [...(listeners.get(name) ?? [])]
    const run = (index) => (index < list.length ? list[index](payload, () => run(index + 1)) : final())
    return run(0)
  }
  const listenerCount = (name) => (listeners.get(name) ?? []).length

  function addSession(id, responder = defaultResponder) {
    const session = { id, header: { id }, turn: 0, queue: [], running: false, responder, seq: 0, title: undefined }
    sessions.set(id, session)
    return session
  }

  function append(session, type, data) {
    emit('session/event', session, { type, seq: session.seq++, time: Date.now(), data })
  }

  async function drive(session) {
    if (session.running) return
    session.running = true
    const agent = { id: session.id, session }
    try {
      while (session.queue.length > 0) {
        const message = session.queue.shift()
        const turn = ++session.turn
        append(session, 'turn/start', { turn })
        if (claimEvent) emit('agent/inbox/claimed', { agent, message, turn })
        append(session, 'step/start', { turn, step: 1 })
        append(session, 'user/message', message)
        const text = message.content.map((part) => part.text).join('')
        let plan
        try {
          plan = await session.responder(text, { session, turn, agent, emit, waterfall })
        } catch (error) {
          plan = { reason: { kind: 'error', error: { message: String(error?.message ?? error), code: 'UNKNOWN' } } }
        }
        let step = 1
        for (const reply of plan.texts ?? []) {
          append(session, 'assistant/message', { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
          step += 1
        }
        append(session, 'step/end', { turn, step })
        append(session, 'turn/end', { turn, reason: plan.reason ?? { kind: 'completed' } })
      }
    } finally {
      session.running = false
    }
  }

  const sessionController = {
    async prompt(request, signal) {
      signal?.throwIfAborted()
      const session = sessions.get(request.sessionId)
      if (!session) throw new FakeRemoteError('session/not-found', `session "${request.sessionId}" not found`)
      const message = { id: `m-${prompts.length}`, role: 'user', content: request.content, source: { kind: 'user', rpcId: request.requestId } }
      prompts.push({ ...request, text: request.content.map((part) => part.text).join('') })
      session.queue.push(message)
      emit('agent/inbox/inserted', { agent: { id: session.id }, message })
      setTimeout(() => void drive(session), 5)
      return { accepted: true }
    },
    async create(request) {
      created += 1
      const id = `session-created-${created}`
      addSession(id, createdResponder)
      sessionController.lastCreate = request
      creates.push({ sessionId: id, ...request })
      return { sessionId: id }
    },
    async rename({ sessionId, title }) {
      const session = sessions.get(sessionId)
      if (!session) throw new FakeRemoteError('session/not-found', 'missing')
      session.title = title
      return { title, seq: 0 }
    },
    async list() {
      return {
        items: [...sessions.values()].reverse().map((session) => ({
          sessionId: session.id,
          updatedAt: Date.now(),
          running: session.running,
          blank: false,
          cwd: '/tmp/workspace',
          ...(session.origin ? { origin: session.origin } : {}),
          projections: { kind: 'sequenced', asOfSeq: 0, values: { title: session.title ?? null } },
        })),
      }
    },
  }

  const sessionQuery = {
    async readTitle(id) {
      const session = sessions.get(id)
      return session?.title ? { title: session.title } : undefined
    },
  }

  return { on, emit, waterfall, listenerCount, sessions, prompts, creates, addSession, sessionController, sessionQuery }
}

function defaultResponder(text) {
  return { texts: [`echo: ${text.split('\n').at(-1)}`] }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
