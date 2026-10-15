import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assistantText,
  buildPrompt,
  channelAllowed,
  cleanMention,
  cleanMentions,
  compilePattern,
  describeTurnEnd,
  findMention,
  ignoreReason,
  matchTrigger,
  matchRoutedTriggers,
  mentionPattern,
  parsePostedEvent,
  selectReply,
  splitMessage,
  threadPosts,
  toList,
  userAllowed,
} from '../lib/core.js'

const event = (message, extra = {}) => ({
  post: { id: 'p1', channel_id: 'c1', user_id: 'u1', message, root_id: '', type: '', props: {}, ...(extra.post ?? {}) },
  mentions: extra.mentions ?? [],
  channelType: extra.channelType ?? 'O',
  channelName: extra.channelName ?? 'town-square',
  channelDisplayName: extra.channelDisplayName ?? 'Town Square',
  senderName: 'alice',
  teamId: 't1',
})

test('mentionPattern matches whole mentions only', () => {
  const pattern = mentionPattern('orion-agent')
  assert.ok(pattern.test('@orion-agent hi'))
  assert.ok(pattern.test('hey @orion-agent, help'))
  assert.ok(pattern.test('thanks @orion-agent.'))
  assert.ok(pattern.test('@ORION-AGENT case'))
  assert.ok(pattern.test('(@orion-agent)'))
  assert.ok(!pattern.test('@orion-agent-dev hi'))
  assert.ok(!pattern.test('@orion-agent.dev hi'))
  assert.ok(!pattern.test('@orion-agent_2 hi'))
  assert.ok(!pattern.test('mail@orion-agent'))
  assert.ok(!pattern.test('orion-agent'))
})

test('cleanMention removes the mention and separators', () => {
  assert.equal(cleanMention('@bot: do it', 'bot'), 'do it')
  assert.equal(cleanMention('please @bot, do it', 'bot'), 'please do it')
  assert.equal(cleanMention('@bot', 'bot'), '')
  assert.equal(cleanMention('@bot-dev hi', 'bot'), '@bot-dev hi')
  assert.equal(cleanMention('  text  ', ''), 'text')
})

test('parsePostedEvent decodes the nested post and mentions', () => {
  const parsed = parsePostedEvent({
    event: 'posted',
    data: { post: JSON.stringify({ id: 'p', channel_id: 'c', message: 'hi' }), mentions: '["u1"]', channel_type: 'D', channel_name: 'a__b', sender_name: '@alice' },
  })
  assert.equal(parsed.post.message, 'hi')
  assert.deepEqual(parsed.mentions, ['u1'])
  assert.equal(parsed.channelType, 'D')
  assert.equal(parsed.senderName, 'alice')
  assert.equal(parsePostedEvent({ event: 'typing', data: {} }), undefined)
  assert.equal(parsePostedEvent({ event: 'posted', data: { post: '{bad' } }), undefined)
  assert.equal(parsePostedEvent(null), undefined)
})

test('ignoreReason skips own, system, deleted and bot posts', () => {
  assert.equal(ignoreReason({ user_id: 'me', type: '' }, 'me'), 'own')
  assert.equal(ignoreReason({ user_id: 'u', type: 'system_join_channel' }, 'me'), 'system')
  assert.equal(ignoreReason({ user_id: 'u', type: '', delete_at: 5 }, 'me'), 'deleted')
  assert.equal(ignoreReason({ user_id: 'u', type: '', props: { from_bot: 'true' } }, 'me'), 'bot')
  assert.equal(ignoreReason({ user_id: 'u', type: '', props: { from_bot: 'true' } }, 'me', false), undefined)
  assert.equal(ignoreReason({ user_id: 'u', type: '', props: {} }, 'me'), undefined)
})

test('matchTrigger handles mentions, direct messages, patterns and the mention list', () => {
  const base = { botUserId: 'bot', mentionName: 'bot', onMention: true, onDirectMessage: true }
  assert.deepEqual(matchTrigger(event('@bot what time is it'), base), { via: 'mention', mention: 'bot', prompt: 'what time is it' })
  assert.equal(matchTrigger(event('hello world'), base), undefined)
  assert.deepEqual(matchTrigger(event('hello', { channelType: 'D' }), base), { via: 'direct', prompt: 'hello' })
  assert.equal(matchTrigger(event('hello', { channelType: 'D' }), { ...base, onDirectMessage: false }), undefined)
  assert.equal(matchTrigger(event('@bot hi'), { ...base, onMention: false }), undefined)
  const pattern = compilePattern('^!ask\\s+(?<prompt>[\\s\\S]+)')
  assert.deepEqual(matchTrigger(event('!ask build the docs'), { ...base, pattern }), { via: 'pattern', prompt: 'build the docs' })
  assert.deepEqual(matchTrigger(event('deploy please'), { ...base, pattern: compilePattern('deploy') }), { via: 'pattern', prompt: 'deploy please' })
  assert.equal(matchTrigger(event('@everyone hi', { mentions: ['bot'] }), base), undefined)
  assert.deepEqual(matchTrigger(event('@channel hi', { mentions: ['bot'] }), { ...base, matchMentionsList: true }), { via: 'mention-list', prompt: '@channel hi' })
})

test('matchTrigger reports which of several route names was mentioned', () => {
  const base = { botUserId: 'bot', mentionNames: ['orion-agent', 'orion-wizard'], onMention: true, onDirectMessage: true }
  assert.deepEqual(matchTrigger(event('@orion-wizard plan it'), base), { via: 'mention', mention: 'orion-wizard', prompt: 'plan it' })
  // The earliest mention decides; other mentions stay part of the request.
  assert.deepEqual(matchTrigger(event('@orion-agent ask @orion-wizard about it'), base), { via: 'mention', mention: 'orion-agent', prompt: 'ask @orion-wizard about it' })
  // An explicit mention wins in a direct message too; without one the message is a plain direct request.
  assert.deepEqual(matchTrigger(event('@orion-wizard hi', { channelType: 'D' }), base), { via: 'mention', mention: 'orion-wizard', prompt: 'hi' })
  assert.deepEqual(matchTrigger(event('hi there', { channelType: 'D' }), base), { via: 'direct', prompt: 'hi there' })
  assert.equal(matchTrigger(event('@orion-agent-dev hi'), base), undefined)
  assert.equal(matchTrigger(event('@bot hi'), base), undefined)
})

test('routed triggers choose one priority match or independently dispatch all matches', () => {
  const routes = [
    { key: 'agent', mentionName: 'orion-agent', triggerOnMention: true, triggerOnDirectMessage: true, followThreads: true, matchMentionsList: true, triggerPattern: '^!ask\\s+(?<prompt>.+)' },
    { key: 'wizard', mentionName: 'orion-wizard', triggerOnMention: true, triggerOnDirectMessage: false, followThreads: true, matchMentionsList: false, triggerPattern: '^!ask\\s+(?<prompt>.+)' },
  ]
  const options = { botUserId: 'bot', botUsername: 'dsh-bot', patternForRoute: (route) => compilePattern(route.triggerPattern) }
  const selected = (message, extra, more = {}) => matchRoutedTriggers(event(message, extra), routes, { ...options, ...more })
  assert.deepEqual(selected('@orion-wizard @orion-agent hello', {}, { multiple: true }).map(({ route, trigger }) => [route.key, trigger.prompt]), [
    ['agent', 'hello'], ['wizard', 'hello'],
  ])
  assert.equal(selected('@orion-wizard @orion-agent hello', {})[0].route.key, 'wizard', 'earliest explicit mention wins over route order')
  assert.deepEqual(selected('!ask build it', {}, { multiple: true }).map(({ route, trigger }) => [route.key, trigger.prompt]), [
    ['agent', 'build it'], ['wizard', 'build it'],
  ])
  assert.equal(selected('!ask build it', {})[0].route.key, 'agent', 'first matching regex wins in single-route mode')
  assert.equal(matchRoutedTriggers(event('!WIZARD build it'), [{ key: 'wizard', mentionName: 'orion-wizard', triggerPattern: '^!wizard\\s+(?<prompt>.+)', triggerPatternFlags: 'i' }], {
    botUsername: 'dsh-bot', patternForRoute: (route) => compilePattern(route.triggerPattern, route.triggerPatternFlags),
  })[0].trigger.prompt, 'build it', 'i flag on an individual route ignores case')
  assert.deepEqual(selected('@orion-wizard hi', { channelType: 'D' }, { multiple: true }).map(({ route, trigger }) => [route.key, trigger.prompt]), [
    ['agent', 'hi'], ['wizard', 'hi'],
  ])
  assert.equal(selected('@orion-wizard hi', { channelType: 'D' })[0].route.key, 'wizard', 'explicit mention beats another route’s DM trigger')
  assert.deepEqual(selected('@channel hello', { mentions: ['bot'] }, { multiple: true }).map(({ route }) => route.key), ['agent'])
  assert.deepEqual(selected('follow-up', { post: { root_id: 'r' } }, { multiple: true, threadRouteKeys: ['agent', 'wizard'] }).map(({ route }) => route.key), ['agent', 'wizard'])
  assert.equal(selected('follow-up', { post: { root_id: 'r' } }, { threadRouteKeys: ['wizard'] })[0].route.key, 'wizard')
  assert.deepEqual(selected('unmatched text', {}), [])
})

test('findMention and cleanMentions', () => {
  assert.deepEqual(findMention('x @b then @a', ['a', 'b']), { name: 'b', index: 2 })
  assert.equal(findMention('nobody here', ['a', '']), undefined)
  assert.equal(cleanMentions('@a hi @b, there', ['a', 'b']), 'hi there')
  assert.equal(cleanMentions('  plain  ', []), 'plain')
})

test('compilePattern rejects invalid sources and strips stateful flags', () => {
  assert.equal(compilePattern(''), undefined)
  assert.equal(compilePattern(undefined), undefined)
  assert.throws(() => compilePattern('(unclosed'), /invalid triggerPattern/)
  const pattern = compilePattern('x', 'gyi')
  assert.equal(pattern.flags, 'i')
})

test('channel and user filters', () => {
  assert.ok(channelAllowed(event('x'), []))
  assert.ok(channelAllowed(event('x'), ['town-square']))
  assert.ok(channelAllowed(event('x'), ['~Town-Square']))
  assert.ok(channelAllowed(event('x'), ['c1']))
  assert.ok(channelAllowed(event('x'), ['Town Square']))
  assert.ok(!channelAllowed(event('x'), ['off-topic']))
  assert.ok(channelAllowed(event('x', { channelType: 'D' }), ['off-topic']))
  assert.ok(userAllowed('alice', []))
  assert.ok(userAllowed('Alice', ['@alice', 'bob']))
  assert.ok(!userAllowed('mallory', 'alice, bob'))
  assert.deepEqual(toList('a, b,\nc'), ['a', 'b', 'c'])
})

test('threadPosts orders, filters and limits', () => {
  const thread = {
    order: ['p3', 'p2', 'p1', 'p0'],
    posts: {
      p0: { id: 'p0', create_at: 1, message: 'root', type: '' },
      p1: { id: 'p1', create_at: 2, message: 'join', type: 'system_join_channel' },
      p2: { id: 'p2', create_at: 3, message: 'two', type: '' },
      p3: { id: 'p3', create_at: 4, message: 'current', type: '' },
    },
  }
  assert.deepEqual(threadPosts(thread, 'p3', 10).map((post) => post.id), ['p0', 'p2'])
  assert.deepEqual(threadPosts(thread, 'p3', 1).map((post) => post.id), ['p2'])
  assert.deepEqual(threadPosts(thread, 'p3', 0), [])
  assert.deepEqual(threadPosts(undefined, 'p3', 5), [])
})

test('buildPrompt includes the header, thread context and files', () => {
  const prompt = buildPrompt({
    text: 'summarize',
    username: 'alice',
    channel: '~town-square',
    header: '[Mattermost] from @{user} in {channel}',
    context: [{ username: 'bob', message: 'first' }],
    files: ['a.png'],
  })
  assert.equal(prompt, [
    '[Mattermost] from @alice in ~town-square',
    '',
    '[Thread context]',
    '@bob: first',
    '',
    '[Current request]',
    '@alice: summarize',
    '(attached files, not forwarded: a.png)',
  ].join('\n'))
  assert.equal(buildPrompt({ text: 'hi', username: 'alice', channel: 'x', header: '' }), '@alice: hi')
})

test('assistant text selection', () => {
  assert.equal(assistantText({ content: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Hello ' }, { type: 'tool-call', id: 't' }, { type: 'text', text: 'world' }] }), 'Hello world')
  assert.equal(assistantText({ content: 'plain' }), 'plain')
  assert.equal(assistantText(undefined), '')
  assert.equal(selectReply(['a', '', 'b']), 'b')
  assert.equal(selectReply(['a', '', 'b'], 'all'), 'a\n\nb')
  assert.equal(selectReply([]), '')
})

test('describeTurnEnd classifies reasons', () => {
  assert.equal(describeTurnEnd({ kind: 'completed' }).ok, true)
  assert.equal(describeTurnEnd({ kind: 'max-tokens' }).ok, true)
  assert.equal(describeTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }).cancelled, true)
  assert.equal(describeTurnEnd({ kind: 'error', error: { message: 'boom' } }).detail, 'boom')
  assert.equal(describeTurnEnd({ kind: 'blocked' }).ok, false)
  assert.equal(describeTurnEnd(undefined).ok, false)
})

test('splitMessage keeps short text and splits long text at boundaries', () => {
  assert.deepEqual(splitMessage('short', 1000), ['short'])
  const paragraphs = Array.from({ length: 30 }, (_, index) => `paragraph ${index} ${'x'.repeat(80)}`).join('\n\n')
  const parts = splitMessage(paragraphs, 500)
  assert.ok(parts.length > 1)
  for (const part of parts) assert.ok(part.length <= 500, `part too long: ${part.length}`)
  assert.equal(parts.join('\n\n').replace(/\s+/g, ' '), paragraphs.replace(/\s+/g, ' '))
})

test('splitMessage re-opens a code fence cut by a split', () => {
  const code = Array.from({ length: 60 }, (_, index) => `const value${index} = ${index}`).join('\n')
  const text = `Here is code:\n\n\`\`\`js\n${code}\n\`\`\`\n\nDone.`
  const parts = splitMessage(text, 400)
  assert.ok(parts.length > 1)
  for (const part of parts) {
    assert.ok(part.length <= 400)
    const fences = part.split('\n').filter((line) => line.startsWith('```')).length
    assert.equal(fences % 2, 0, `unbalanced fences in part:\n${part}`)
  }
  assert.ok(parts[1].startsWith('```js'))
})

test('splitMessage never loops on unbreakable text', () => {
  const parts = splitMessage('y'.repeat(5000), 1000)
  assert.equal(parts.join(''), 'y'.repeat(5000))
  for (const part of parts) assert.ok(part.length <= 1000)
})
