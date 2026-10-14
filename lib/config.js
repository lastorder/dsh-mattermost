/**
 * Pure configuration helpers: normalize the `connections` list (one entry per
 * Mattermost environment, i.e. one server + bot token) and its `routes` (one
 * per mention name: which DSH workspace answers and how sessions are used),
 * and merge one environment with the shared settings into the flat settings
 * object a bridge reads.
 *
 * The Client page (`client.js`) repeats `connectionKeys`/`routeKeys` so both
 * halves derive identical keys; `test/client.test.js` checks they agree.
 */
import { DEFAULT_MESSAGES } from './core.js'

/** How a route uses DSH sessions. */
export const SESSION_MODES = Object.freeze([
  'shared', // every request in one session (pinned, bound, or created once)
  'thread', // one new session per Mattermost thread, reused for its follow-ups
  'new', // a new session for every request
])

/** Fields of one route, with their defaults. */
export const ROUTE_DEFAULTS = Object.freeze({
  id: '',
  mentionName: '',
  workspace: '',
  sessionMode: 'shared',
  sessionId: '',
})

/** Fields of one environment, with their defaults. `mentionName`/`sessionId` apply when it has no routes. */
export const CONNECTION_DEFAULTS = Object.freeze({
  id: '',
  name: '',
  enabled: true,
  serverUrl: '',
  token: '',
  routes: Object.freeze([]),
  sessionId: '',
  mentionName: '',
  triggerOnMention: true,
  triggerOnDirectMessage: true,
  followThreads: false,
  matchMentionsList: false,
  triggerPattern: '',
  triggerPatternFlags: 'i',
  channels: Object.freeze([]),
  allowedUsers: Object.freeze([]),
  greetingEnabled: false,
  greetingChannelId: '',
  greetingMessage: '',
  goodbyeMessage: '',
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const username = (value) => text(value).replace(/^@+/, '')

/** Lowercase ASCII slug: letters, digits, and single dashes. */
export function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Host name of a server URL, tolerating a missing scheme; '' when unparsable. */
export function hostOf(serverUrl) {
  const raw = text(serverUrl)
  if (raw === '') return ''
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname
  } catch {
    return ''
  }
}

/** Unique keys in list order: `-2`, `-3`, … are appended to repeats. */
function uniqueKeys(bases) {
  const used = new Set()
  return bases.map((base) => {
    let key = base
    for (let suffix = 2; used.has(key); suffix += 1) key = `${base}-${suffix}`
    used.add(key)
    return key
  })
}

/** Environment keys: the explicit `id`, else a slug of the name, else of the host, else `connection-<n>`. */
export function connectionKeys(list) {
  return uniqueKeys((Array.isArray(list) ? list : []).map((entry, index) => {
    const item = isObject(entry) ? entry : {}
    return text(item.id) || slug(item.name) || slug(hostOf(item.serverUrl)) || `connection-${index + 1}`
  }))
}

/** Route keys: the explicit `id`, else a slug of the mention name, else `route-<n>`. */
export function routeKeys(list) {
  return uniqueKeys((Array.isArray(list) ? list : []).map((entry, index) => {
    const item = isObject(entry) ? entry : {}
    return text(item.id) || slug(username(item.mentionName)) || `route-${index + 1}`
  }))
}

/**
 * The routes of one environment. Without configured routes there is one
 * implicit route (key `''`): the environment's own `mentionName` (default:
 * the bot username) answered in one shared session — the behavior of
 * environments configured before routes existed.
 */
export function normalizeRoutes(connection) {
  const list = Array.isArray(connection?.routes) ? connection.routes : []
  if (list.length === 0) {
    return [{ ...ROUTE_DEFAULTS, key: '', index: 0, implicit: true, mentionName: username(connection?.mentionName), sessionId: text(connection?.sessionId) }]
  }
  const keys = routeKeys(list)
  return list.map((entry, index) => {
    const item = isObject(entry) ? entry : {}
    return {
      id: text(item.id),
      mentionName: username(item.mentionName),
      workspace: text(item.workspace),
      sessionMode: SESSION_MODES.includes(item.sessionMode) ? item.sessionMode : 'shared',
      sessionId: text(item.sessionId),
      key: keys[index],
      index,
      implicit: false,
    }
  })
}

/** Normalize the raw `connections` value into complete environment objects with `key`, `index` and `routes`. */
export function normalizeConnections(list) {
  const entries = Array.isArray(list) ? list : []
  const keys = connectionKeys(entries)
  return entries.map((entry, index) => {
    const item = isObject(entry) ? entry : {}
    const merged = { ...CONNECTION_DEFAULTS }
    for (const field of Object.keys(CONNECTION_DEFAULTS)) {
      const value = item[field]
      if (value === undefined || value === null || field === 'routes') continue
      merged[field] = Array.isArray(CONNECTION_DEFAULTS[field])
        ? (Array.isArray(value) ? value.filter((part) => typeof part === 'string') : [])
        : value
    }
    for (const field of ['id', 'name', 'serverUrl', 'token', 'sessionId', 'triggerPattern', 'greetingChannelId']) merged[field] = text(merged[field])
    merged.mentionName = username(merged.mentionName)
    merged.enabled = merged.enabled !== false
    return { ...merged, routes: normalizeRoutes(item), key: keys[index], index }
  })
}

/** Display label of an environment. */
export function connectionLabel(connection) {
  return connection?.name || hostOf(connection?.serverUrl) || connection?.key || 'Mattermost'
}

/** Display label of a route: its `@mention`, falling back to the bot username. */
export function routeLabel(route, botUsername) {
  const name = route?.mentionName || botUsername
  return name ? `@${name}` : 'default'
}

/**
 * The flat settings one bridge reads: shared settings overlaid with the
 * environment's own fields and routes.
 * @param shared - shared (top-level) settings snapshot.
 * @param connection - one normalized environment.
 */
export function mergeSettings(shared, connection) {
  const base = isObject(shared) ? shared : {}
  const c = connection ?? { ...CONNECTION_DEFAULTS, key: 'default' }
  return {
    ...base,
    messages: { ...DEFAULT_MESSAGES, ...(base.messages ?? {}) },
    sessionTitle: text(base.sessionTitle) || 'Mattermost',
    maxConcurrent: Math.max(1, Math.floor(Number(base.maxConcurrent) || 3)),
    connectionName: c.name ?? '',
    serverUrl: c.serverUrl,
    token: c.token,
    routes: Array.isArray(c.routes) && c.routes.length > 0 && 'key' in c.routes[0] ? c.routes : normalizeRoutes(c),
    triggerOnMention: c.triggerOnMention,
    triggerOnDirectMessage: c.triggerOnDirectMessage,
    followThreads: c.followThreads,
    matchMentionsList: c.matchMentionsList,
    triggerPattern: c.triggerPattern,
    triggerPatternFlags: c.triggerPatternFlags,
    channels: c.channels,
    allowedUsers: c.allowedUsers,
    greeting: {
      enabled: c.greetingEnabled === true,
      channelId: c.greetingChannelId,
      message: c.greetingMessage,
      goodbyeMessage: c.goodbyeMessage,
    },
  }
}
