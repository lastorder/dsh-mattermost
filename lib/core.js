/**
 * Pure helpers for the Mattermost bridge: no I/O, no Cordis, no timers.
 *
 * Everything here is deterministic so it can be unit-tested in isolation;
 * the bridge (`bridge.js`) owns sockets, queues, and DSH sessions.
 */

/** Default user-facing texts posted to Mattermost; every key is overridable through `messages`. */
export const DEFAULT_MESSAGES = Object.freeze({
  queued: 'Your request has been queued. Please wait...',
  queueFull: 'The agent is busy, please try again later.',
  processing: 'Processing your request...',
  error: 'Sorry, an error occurred while processing your request.',
  empty: 'Empty message after removing the mention.',
  unauthorized: 'You do not have permission to use this agent.',
  cancelled: 'The request was cancelled in DSH.',
  timeout: 'Timed out waiting for DSH to reply.',
  noReply: 'DSH finished without a text reply.',
  noSession: 'No DSH session is bound to this bot yet. Run `/mattermost bind` in the DSH session that should answer.',
  waitingApproval: 'Waiting for a permission approval in DSH: `{tool}`',
  waitingAnswer: 'Waiting for an answer in DSH: {question}',
  stopped: 'The DSH bridge stopped before the request finished.',
})

/** Default first line of every prompt sent to DSH; `{user}` and `{channel}` are substituted. */
export const DEFAULT_PROMPT_HEADER = '[Mattermost] Message from @{user} in {channel}. Your final answer will be posted back to the Mattermost thread.'

const USERNAME_CHAR = 'A-Za-z0-9_\\-'

/** Escape a literal for use inside a RegExp source. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A RegExp matching `@name` as a whole Mattermost mention: not preceded by a
 * username character (so `foo@name` does not match) and not continued by
 * another username character (so `@name-dev` does not match), while a single
 * trailing dot such as `@name.` at the end of a sentence still matches.
 */
export function mentionPattern(name, flags = 'i') {
  const escaped = escapeRegExp(String(name).replace(/^@/, ''))
  return new RegExp(`(?<![${USERNAME_CHAR}.@])@${escaped}(?=$|[^${USERNAME_CHAR}.]|\\.(?:$|[^${USERNAME_CHAR}]))`, flags)
}

/** Remove every `@name` mention (plus a directly following `:` or `,`) and trim. */
export function cleanMention(text, name) {
  const source = String(text ?? '')
  if (!name) return source.trim()
  const pattern = new RegExp(`${mentionPattern(name).source}[:,]?[ \\t]*`, 'gi')
  return source.replace(pattern, '').trim()
}

/** {@link cleanMention} for several names. */
export function cleanMentions(text, names) {
  return (Array.isArray(names) ? names : [names]).filter(Boolean).reduce((result, name) => cleanMention(result, name), String(text ?? '').trim())
}

/**
 * The earliest whole-word `@mention` of one of `names` in `text`.
 * @returns `{ name, index }` with the name as configured, or `undefined`.
 */
export function findMention(text, names) {
  let found
  for (const name of Array.isArray(names) ? names : [names]) {
    if (!name) continue
    const match = mentionPattern(name).exec(String(text ?? ''))
    if (match && (found === undefined || match.index < found.index)) found = { name, index: match.index }
  }
  return found
}

/** Normalize a username or channel reference for comparison: lowercase, without a leading `@`, `~` or `#`. */
export function normalizeName(value) {
  return String(value ?? '').trim().replace(/^[@~#]/, '').toLowerCase()
}

/** Split a comma/newline separated string or an array into trimmed, non-empty entries. */
export function toList(value) {
  if (Array.isArray(value)) return value.flatMap(toList)
  if (typeof value !== 'string') return []
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
}

/**
 * Parse one raw Mattermost WebSocket message of type `posted`.
 * @returns the post plus the broadcast metadata, or `undefined` for any other event.
 */
export function parsePostedEvent(msg) {
  if (msg === null || typeof msg !== 'object' || msg.event !== 'posted') return undefined
  const data = msg.data
  if (data === null || typeof data !== 'object') return undefined
  let post = data.post
  if (typeof post === 'string') {
    try { post = JSON.parse(post) } catch { return undefined }
  }
  if (post === null || typeof post !== 'object' || typeof post.id !== 'string' || typeof post.channel_id !== 'string') return undefined
  let mentions = []
  if (typeof data.mentions === 'string') {
    try {
      const parsed = JSON.parse(data.mentions)
      if (Array.isArray(parsed)) mentions = parsed.filter((item) => typeof item === 'string')
    } catch {}
  } else if (Array.isArray(data.mentions)) {
    mentions = data.mentions.filter((item) => typeof item === 'string')
  }
  return {
    post,
    mentions,
    channelType: typeof data.channel_type === 'string' ? data.channel_type : '',
    channelName: typeof data.channel_name === 'string' ? data.channel_name : '',
    channelDisplayName: typeof data.channel_display_name === 'string' ? data.channel_display_name : '',
    senderName: typeof data.sender_name === 'string' ? data.sender_name.replace(/^@/, '') : '',
    teamId: typeof data.team_id === 'string' ? data.team_id : '',
  }
}

/**
 * Why a post must not be handled at all, or `undefined` when it is an ordinary user post.
 * @param post - the Mattermost post.
 * @param botUserId - the bridge's own user id.
 * @param ignoreBots - also skip posts made by bot accounts and incoming webhooks.
 */
export function ignoreReason(post, botUserId, ignoreBots = true) {
  if (botUserId && post.user_id === botUserId) return 'own'
  if (typeof post.type === 'string' && post.type !== '') return 'system'
  if (Number(post.delete_at) > 0) return 'deleted'
  const props = post.props ?? {}
  if (ignoreBots && (props.from_bot === 'true' || props.from_bot === true || props.from_webhook === 'true' || props.from_webhook === true)) return 'bot'
  return undefined
}

/** Compile the configured trigger pattern; invalid sources throw a descriptive error. */
export function compilePattern(source, flags = 'i') {
  const text = typeof source === 'string' ? source.trim() : ''
  if (text === '') return undefined
  const cleanFlags = [...new Set(String(flags ?? '').replace(/[gy]/g, ''))].join('')
  try {
    return new RegExp(text, cleanFlags)
  } catch (error) {
    throw new Error(`invalid triggerPattern ${JSON.stringify(text)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Decide whether a parsed `posted` event addresses the bridge.
 * @param event - result of {@link parsePostedEvent}.
 * @param options.botUserId - the bridge's user id (used with `matchMentionsList`).
 * @param options.mentionNames - usernames whose `@mention` triggers the bridge (one per route);
 *   `options.mentionName` (a single name) is accepted too.
 * @param options.onMention - react to `@mention`s.
 * @param options.onDirectMessage - react to every message in a direct channel with the bot.
 * @param options.pattern - compiled RegExp; a match triggers the bridge.
 * @param options.matchMentionsList - also accept the server-parsed mention list (includes @channel/@all fan-out).
 * @returns `{ via, prompt, mention? }` for a trigger — `mention` is the name that matched — otherwise `undefined`.
 */
export function matchTrigger(event, options) {
  const { botUserId, onMention = true, onDirectMessage = true, pattern, matchMentionsList = false } = options
  const names = (Array.isArray(options.mentionNames) ? options.mentionNames : [options.mentionName]).filter(Boolean)
  const text = typeof event.post.message === 'string' ? event.post.message : ''
  // An explicit mention wins, even in a direct message: it selects the route.
  const found = onMention ? findMention(text, names) : undefined
  if (found) return { via: 'mention', mention: found.name, prompt: cleanMention(text, found.name) }
  if (onDirectMessage && event.channelType === 'D') return { via: 'direct', prompt: cleanMentions(text, names) }
  if (onMention && matchMentionsList && botUserId && event.mentions.includes(botUserId)) {
    return { via: 'mention-list', prompt: cleanMentions(text, names) }
  }
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) {
      const captured = match.groups?.prompt ?? match.groups?.text
      return { via: 'pattern', prompt: (typeof captured === 'string' ? captured : cleanMentions(text, names)).trim() }
    }
  }
  return undefined
}

/**
 * Apply each route's own triggers once. With `multiple` off the strongest match
 * wins; with it on, every matching route gets one independent request.
 * Priority: explicit @mention (earliest in the text), direct message, server
 * mention list, regex, then a follow-up without another trigger. Among equal
 * non-explicit matches, prefer the route already handling that thread, then
 * configuration order. This keeps a single bot from replying twice by default.
 */
export function matchRoutedTriggers(event, routes, { botUserId, botUsername, threadRouteKeys = [], multiple = false, patternForRoute } = {}) {
  const text = typeof event.post.message === 'string' ? event.post.message : ''
  const names = routes.map((route) => route.mentionName || botUsername || '')
  const threadKeys = new Set(threadRouteKeys)
  const priority = { mention: 0, direct: 1, 'mention-list': 2, pattern: 3, thread: 4 }
  const matches = []
  for (const [index, route] of routes.entries()) {
    const trigger = matchTrigger(event, {
      botUserId,
      mentionName: names[index],
      onMention: route.triggerOnMention !== false,
      onDirectMessage: route.triggerOnDirectMessage === true,
      matchMentionsList: route.matchMentionsList === true,
      pattern: patternForRoute?.(route),
    }) ?? (event.post.root_id && threadKeys.has(route.key) && route.followThreads === true
      ? { via: 'thread', prompt: cleanMentions(text, names) }
      : undefined)
    if (!trigger) continue
    const mentionAt = trigger.via === 'mention' ? findMention(text, names[index])?.index ?? Infinity : Infinity
    matches.push({ route, trigger: multiple && (trigger.via === 'mention' || trigger.via === 'direct')
      ? { ...trigger, prompt: cleanMentions(text, names) }
      : trigger, priority: priority[trigger.via], mentionAt, inThread: threadKeys.has(route.key), index })
  }
  if (multiple) return matches.map(({ route, trigger }) => ({ route, trigger }))
  matches.sort((a, b) => a.priority - b.priority || a.mentionAt - b.mentionAt || Number(b.inThread) - Number(a.inThread) || a.index - b.index)
  return matches.length ? [{ route: matches[0].route, trigger: matches[0].trigger }] : []
}

/**
 * Whether the channel of an event passes the configured channel filter.
 * An empty filter accepts every channel; entries match a channel id, name, or display name.
 * Direct messages are governed by the direct-message trigger instead of this list.
 */
export function channelAllowed(event, channels) {
  const wanted = toList(channels).map(normalizeName)
  if (wanted.length === 0 || event.channelType === 'D') return true
  const names = [event.post.channel_id, event.channelName, event.channelDisplayName].filter(Boolean).map(normalizeName)
  return wanted.some((entry) => names.includes(entry))
}

/** Whether a username passes the allow-list; an empty list allows everyone. */
export function userAllowed(username, allowedUsers) {
  const wanted = toList(allowedUsers).map(normalizeName)
  if (wanted.length === 0) return true
  return wanted.includes(normalizeName(username))
}

/** Human-readable channel label for prompts and logs. */
export function channelLabel(event) {
  if (event.channelType === 'D') return 'a direct message'
  if (event.channelType === 'G') return `the group message "${event.channelDisplayName || event.channelName || event.post.channel_id}"`
  const name = event.channelName || event.post.channel_id
  return event.channelDisplayName && event.channelDisplayName !== name
    ? `~${name} ("${event.channelDisplayName}")`
    : `~${name}`
}

/**
 * Order a Mattermost thread response chronologically, drop the triggering post, and keep the newest `max` posts.
 * @param thread - `GET /posts/{id}/thread` response (`{ order, posts }`).
 * @param excludeId - the post that triggered the request.
 * @param max - maximum number of posts to keep.
 */
export function threadPosts(thread, excludeId, max) {
  if (!thread || typeof thread !== 'object' || max <= 0) return []
  const posts = thread.posts && typeof thread.posts === 'object' ? thread.posts : {}
  // `order` is newest-first; walk it backwards so equal timestamps keep chronological order.
  const ids = Array.isArray(thread.order) && thread.order.length > 0 ? [...thread.order].reverse() : Object.keys(posts)
  const list = []
  const seen = new Set()
  for (const id of ids) {
    const post = posts[id]
    if (!post || seen.has(id) || id === excludeId) continue
    seen.add(id)
    if (typeof post.type === 'string' && post.type !== '') continue
    if (Number(post.delete_at) > 0) continue
    list.push(post)
  }
  list.sort((a, b) => Number(a.create_at ?? 0) - Number(b.create_at ?? 0))
  return list.length > max ? list.slice(list.length - max) : list
}

/**
 * Compose the text sent to the DSH session.
 * @param input.text - the request text after trigger cleanup.
 * @param input.username - sender username.
 * @param input.channel - channel label for the header.
 * @param input.header - header template (`{user}`, `{channel}`); empty disables it.
 * @param input.context - earlier thread messages as `{ username, message }`.
 * @param input.files - names of files attached to the post.
 */
export function buildPrompt({ text, username, channel, header, context = [], files = [] }) {
  const lines = []
  const head = typeof header === 'string' ? header.trim() : ''
  if (head !== '') lines.push(head.replaceAll('{user}', username).replaceAll('{channel}', channel))
  if (context.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('[Thread context]')
    for (const item of context) lines.push(`@${item.username}: ${String(item.message ?? '').trim()}`)
    lines.push('')
    lines.push('[Current request]')
  } else if (lines.length > 0) {
    lines.push('')
  }
  lines.push(`@${username}: ${text}`)
  if (files.length > 0) lines.push(`(attached files, not forwarded: ${files.join(', ')})`)
  return lines.join('\n')
}

/** The text blocks of one assistant message, joined. */
export function assistantText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** Choose the reply from the assistant texts of one turn. */
export function selectReply(texts, mode = 'final') {
  const nonEmpty = texts.filter((text) => typeof text === 'string' && text.trim() !== '')
  if (nonEmpty.length === 0) return ''
  return mode === 'all' ? nonEmpty.join('\n\n') : nonEmpty[nonEmpty.length - 1]
}

/**
 * Classify a DSH `turn/end` reason.
 * @returns `ok` for a turn whose answer should be posted, plus a short label for failures.
 */
export function describeTurnEnd(reason) {
  const kind = reason && typeof reason.kind === 'string' ? reason.kind : 'unknown'
  switch (kind) {
    case 'completed':
    case 'max-tokens':
      return { ok: true, kind }
    case 'aborted':
      return { ok: false, kind, cancelled: true }
    case 'error': {
      const message = reason.error && typeof reason.error.message === 'string' ? reason.error.message : ''
      return { ok: false, kind, detail: message }
    }
    case 'blocked':
      return { ok: false, kind, detail: 'the turn was blocked (is the session archived or waiting for something?)' }
    default:
      return { ok: false, kind, detail: `the turn ended with "${kind}"` }
  }
}

/** Replace `{name}` placeholders. */
export function fill(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) => (Object.hasOwn(values, key) ? String(values[key]) : whole))
}

/**
 * Split a long Markdown message into posts no longer than `max` characters,
 * preferring paragraph, then line, then word boundaries, and re-opening a
 * fenced code block that a split would otherwise leave unterminated.
 */
export function splitMessage(text, max) {
  const limit = Math.max(200, Math.floor(max))
  const source = String(text ?? '')
  if (source.length <= limit) return [source]
  const chunks = []
  let rest = source
  let reopen = ''
  while (rest.length > 0) {
    let body = reopen + rest
    if (body.length <= limit) {
      chunks.push(body)
      break
    }
    const budget = limit - 4 // room for a closing fence
    let cut = lastBreak(body, budget)
    let piece = body.slice(0, cut)
    const fence = openFence(piece)
    if (fence !== undefined) piece = `${piece.replace(/\n*$/, '')}\n\`\`\``
    chunks.push(piece)
    rest = body.slice(cut).replace(/^\n+/, '')
    reopen = fence === undefined ? '' : `${fence}\n`
    // A pathological fence info string must not stall progress.
    if (reopen.length > budget / 4) reopen = ''
  }
  return chunks.filter((chunk) => chunk.trim() !== '')
}

function lastBreak(text, budget) {
  const window = text.slice(0, budget)
  const minimum = Math.floor(budget * 0.5)
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = window.lastIndexOf(separator)
    if (index >= minimum) return index + separator.length
  }
  // Never split a UTF-16 surrogate pair.
  const code = text.charCodeAt(budget - 1)
  return code >= 0xd800 && code <= 0xdbff ? budget - 1 : budget
}

/** The opening fence line (e.g. "```ts") when `text` ends inside a fenced code block. */
function openFence(text) {
  let open
  for (const line of text.split('\n')) {
    const match = /^\s*(```+|~~~+)(.*)$/.exec(line)
    if (!match) continue
    if (open === undefined) open = `${match[1]}${match[2].trim()}`
    else if (match[1].startsWith(open[0]) && match[2].trim() === '') open = undefined
  }
  return open
}
