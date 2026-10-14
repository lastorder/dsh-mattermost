#!/usr/bin/env node
/**
 * Local Mattermost helper for manually testing dsh-mattermost.
 *
 *   node scripts/mm-local.mjs setup
 *       Wait for the server, then create (idempotently) the admin, the team
 *       "DSH Test", test users alice/bob/carol, and the bot @dsh-bot with an
 *       access token. Writes everything to .mm-local.json (git-ignored).
 *
 *   node scripts/mm-local.mjs post [--as alice] [--channel town-square | --dm] [--reply-to <postId>]
 *                                  [--timeout 180] [--no-wait] <message…>
 *       Post as a test user, then wait for @dsh-bot's final reply in the thread
 *       (exit 0), or report that none came (exit 2).
 *
 *   node scripts/mm-local.mjs info
 *       Print the server URL, logins and the bot token again.
 *
 * Only Node built-ins are used. MM_URL / MM_PORT select another server.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = join(ROOT, '.mm-local.json')
const URL_BASE = (process.env.MM_URL ?? `http://localhost:${process.env.MM_PORT ?? 8065}`).replace(/\/+$/, '')
const TEAM = { name: 'dsh', displayName: 'DSH Test' }
const ADMIN = { username: 'dsh-admin', email: 'dsh-admin@example.com', password: 'Dsh-Admin-2026!' }
const USERS = ['alice', 'bob', 'carol'].map((name) => ({ username: name, email: `${name}@example.com`, password: 'Dsh-Test-2026!' }))
const BOT = { username: 'dsh-bot', displayName: 'DSH Bot', description: 'dsh-mattermost local test bot' }
const CHANNELS = ['town-square', 'off-topic']
const TRANSIENT = /Processing your request|has been queued|Waiting for a permission approval|Waiting for an answer in DSH/

class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → HTTP ${status}${body?.message ? `: ${body.message}` : ''}`)
    this.status = status
    this.id = body?.id
  }
}

async function api(path, { method = 'GET', token, body, withHeaders = false } = {}) {
  const response = await fetch(`${URL_BASE}/api/v4${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try { json = text === '' ? undefined : JSON.parse(text) } catch {}
  if (!response.ok) throw new ApiError(method, path, response.status, json)
  return withHeaders ? { json, headers: response.headers } : json
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  let shown = false
  while (Date.now() < deadline) {
    try {
      const { json, headers } = await api('/system/ping', { withHeaders: true })
      if (json?.status === 'OK') {
        if (shown) process.stdout.write('\n')
        // X-Version-Id is "<version>.<build>.<hash>.<enterprise>".
        return (headers.get('x-version-id') ?? 'unknown').split('.').slice(0, 3).join('.')
      }
    } catch {}
    if (!shown) process.stdout.write(`Waiting for Mattermost at ${URL_BASE} `)
    shown = true
    process.stdout.write('.')
    await sleep(3000)
  }
  throw new Error(`Mattermost did not answer at ${URL_BASE} within ${Math.round(timeoutMs / 1000)}s. Is it running? (pnpm run mm:up)`)
}

async function login(username, password) {
  const { json, headers } = await api('/users/login', { method: 'POST', body: { login_id: username, password }, withHeaders: true })
  const token = headers.get('token')
  if (!token) throw new Error(`login as ${username} returned no token`)
  return { token, user: json }
}

async function findUser(username, token) {
  try {
    return await api(`/users/username/${encodeURIComponent(username)}`, { token })
  } catch (error) {
    if (error.status === 404) return undefined
    throw error
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    return undefined
  }
}

async function setup() {
  const version = await waitForServer()
  console.log(`Mattermost ${version} is up at ${URL_BASE}`)

  // The first account on a fresh server becomes its system admin.
  let admin
  try {
    admin = await login(ADMIN.username, ADMIN.password)
  } catch (error) {
    if (error.status !== 401 && error.status !== 400) throw error
    await api('/users', { method: 'POST', body: { email: ADMIN.email, username: ADMIN.username, password: ADMIN.password } })
    admin = await login(ADMIN.username, ADMIN.password)
    console.log(`Created the admin account ${ADMIN.username}`)
  }
  if (!String(admin.user.roles ?? '').includes('system_admin')) {
    throw new Error(`${ADMIN.username} is not a system admin: this server already had users. Reset it with "pnpm run mm:down && pnpm run mm:up".`)
  }
  const token = admin.token

  const config = await api('/config', { token })
  if (config.ServiceSettings?.EnableBotAccountCreation !== true || config.ServiceSettings?.EnableUserAccessTokens !== true) {
    await api('/config/patch', { method: 'PUT', token, body: { ServiceSettings: { EnableBotAccountCreation: true, EnableUserAccessTokens: true } } })
    console.log('Enabled bot accounts and personal access tokens')
  }

  let team
  try {
    team = await api(`/teams/name/${TEAM.name}`, { token })
  } catch (error) {
    if (error.status !== 404 && error.status !== 403) throw error
    team = await api('/teams', { method: 'POST', token, body: { name: TEAM.name, display_name: TEAM.displayName, type: 'O' } })
    console.log(`Created the team "${TEAM.displayName}"`)
  }

  const users = []
  for (const spec of USERS) {
    let user = await findUser(spec.username, token)
    if (!user) {
      user = await api('/users', { method: 'POST', token, body: { email: spec.email, username: spec.username, password: spec.password } })
      console.log(`Created the user ${spec.username}`)
    }
    users.push({ ...spec, id: user.id })
  }

  let botUser = await findUser(BOT.username, token)
  if (botUser && !botUser.is_bot) throw new Error(`@${BOT.username} exists but is not a bot account`)
  if (!botUser) {
    const bot = await api('/bots', { method: 'POST', token, body: { username: BOT.username, display_name: BOT.displayName, description: BOT.description } })
    botUser = { id: bot.user_id, username: bot.username }
    console.log(`Created the bot @${BOT.username}`)
  }

  const members = [admin.user.id, ...users.map((user) => user.id), botUser.id]
  for (const userId of members) {
    await api(`/teams/${team.id}/members`, { method: 'POST', token, body: { team_id: team.id, user_id: userId } })
  }
  const channels = {}
  for (const name of CHANNELS) {
    const channel = await api(`/teams/${team.id}/channels/name/${name}`, { token })
    channels[name] = channel.id
    for (const userId of members) await api(`/channels/${channel.id}/members`, { method: 'POST', token, body: { user_id: userId } })
  }

  // Reuse a still-valid bot token, otherwise mint a new one.
  const previous = await loadState()
  let botToken = previous?.bot?.id === botUser.id ? previous.bot.token : undefined
  if (botToken) {
    try {
      await api('/users/me', { token: botToken })
    } catch {
      botToken = undefined
    }
  }
  if (!botToken) {
    const created = await api(`/users/${botUser.id}/tokens`, { method: 'POST', token, body: { description: 'dsh-mattermost local test' } })
    botToken = created.token
    console.log(`Created an access token for @${BOT.username}`)
  }

  const state = {
    url: URL_BASE,
    version,
    team: { id: team.id, name: team.name, displayName: team.display_name },
    channels,
    admin: { username: ADMIN.username, password: ADMIN.password, id: admin.user.id },
    users: users.map(({ username, password, id }) => ({ username, password, id })),
    bot: { username: BOT.username, id: botUser.id, token: botToken },
  }
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  printInfo(state)
}

function printInfo(state) {
  const logins = state.users.map((user) => user.username).join(', ')
  console.log(`
Local Mattermost is ready (details saved in .mm-local.json)

  Browser:      ${state.url}  → team "${state.team.displayName}", channels ~town-square and ~off-topic
  Log in as:    ${logins}  (password ${state.users[0].password}); admin: ${state.admin.username} / ${state.admin.password}
  Bot:          @${state.bot.username}

Add it in DSH: sidebar → Plugins → Mattermost Bridge → Add environment
  Server URL:   ${state.url}
  Access token: ${state.bot.token}
Then "Test connection", pick a session, Save — and post "@${state.bot.username} hello" in Town Square,
or from a terminal:  pnpm run mm:post -- "@${state.bot.username} hello"`)
}

function parseArgs(argv) {
  const options = { as: 'alice', channel: 'town-square', dm: false, replyTo: '', timeout: 180, wait: true, message: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--as') options.as = argv[++index]
    else if (arg === '--channel') options.channel = argv[++index]
    else if (arg === '--dm') options.dm = true
    else if (arg === '--reply-to') options.replyTo = argv[++index]
    else if (arg === '--timeout') options.timeout = Number(argv[++index])
    else if (arg === '--no-wait') options.wait = false
    else if (arg === '--') continue // npm/pnpm argument separator
    else options.message.push(arg)
  }
  options.message = options.message.join(' ').trim()
  return options
}

async function post(argv) {
  const state = await loadState()
  if (!state) throw new Error('No .mm-local.json yet: run "pnpm run mm:setup" first.')
  const options = parseArgs(argv)
  if (!options.message) throw new Error('Nothing to post. Example: pnpm run mm:post -- "@dsh-bot hello"')
  const account = state.users.find((user) => user.username === options.as) ?? (options.as === state.admin.username ? state.admin : undefined)
  if (!account) throw new Error(`Unknown test user "${options.as}" (known: ${state.users.map((user) => user.username).join(', ')})`)
  const { token, user } = await login(account.username, account.password)

  let channelId
  let where
  if (options.dm) {
    channelId = (await api('/channels/direct', { method: 'POST', token, body: [user.id, state.bot.id] })).id
    where = `a direct message with @${state.bot.username}`
  } else {
    channelId = state.channels[options.channel] ?? (await api(`/teams/${state.team.id}/channels/name/${options.channel}`, { token })).id
    where = `~${options.channel}`
  }
  if (options.replyTo) {
    const parent = await api(`/posts/${options.replyTo}`, { token })
    channelId = parent.channel_id
    options.replyTo = parent.root_id || parent.id
    where += ' (thread reply)'
  }
  const created = await api('/posts', { method: 'POST', token, body: { channel_id: channelId, message: options.message, ...(options.replyTo ? { root_id: options.replyTo } : {}) } })
  console.log(`@${account.username} posted ${created.id} in ${where}: ${options.message}`)
  if (!options.wait) return

  const rootId = options.replyTo || created.id
  const deadline = Date.now() + options.timeout * 1000
  let lastSeen = ''
  let stableSince = 0
  while (Date.now() < deadline) {
    await sleep(1500)
    const thread = await api(`/posts/${rootId}/thread`, { token })
    const replies = Object.values(thread.posts ?? {})
      .filter((item) => item.user_id === state.bot.id && item.create_at >= created.create_at)
      .sort((a, b) => a.create_at - b.create_at)
    const snapshot = replies.map((item) => item.message).join('\n---\n')
    if (snapshot !== lastSeen) {
      const pending = replies.find((item) => TRANSIENT.test(item.message))
      if (pending) console.log(`  … ${pending.message.split('\n')[0]}`)
      lastSeen = snapshot
      stableSince = Date.now()
      continue
    }
    if (replies.length > 0 && replies.every((item) => !TRANSIENT.test(item.message)) && Date.now() - stableSince >= 2000) {
      console.log(`@${state.bot.username} replied in ${replies.length} post(s):`)
      for (const item of replies) console.log(item.message.split('\n').map((line) => `  │ ${line}`).join('\n'))
      return
    }
  }
  console.log(lastSeen ? `No final reply within ${options.timeout}s; last bot text:\n  ${lastSeen}` : `@${state.bot.username} did not reply within ${options.timeout}s.`)
  process.exitCode = 2
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  if (command === 'setup') await setup()
  else if (command === 'post') await post(rest)
  else if (command === 'info') {
    const state = await loadState()
    if (!state) throw new Error('No .mm-local.json yet: run "pnpm run mm:setup" first.')
    printInfo(state)
  } else {
    console.log('Usage: node scripts/mm-local.mjs setup | info | post [--as alice] [--channel town-square | --dm] [--reply-to <postId>] [--timeout 180] [--no-wait] <message>')
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
})
