import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONNECTION_DEFAULTS, connectionKeys, connectionLabel, hostOf, mergeSettings, normalizeConnections, normalizeRoutes, routeKeys, routeLabel, slug } from '../lib/config.js'
import { DEFAULT_MESSAGES } from '../lib/core.js'

test('slug and hostOf', () => {
  assert.equal(slug('  Company Prod!  '), 'company-prod')
  assert.equal(slug('公司'), '')
  assert.equal(hostOf('matter.example.com'), 'matter.example.com')
  assert.equal(hostOf('http://localhost:8065/sub'), 'localhost')
  assert.equal(hostOf(''), '')
  assert.equal(hostOf('http://'), '')
})

test('connectionKeys prefer ids, then names, then hosts, and stay unique', () => {
  assert.deepEqual(connectionKeys([
    { id: 'prod' },
    { name: 'Local Test' },
    { serverUrl: 'https://mm.example.com' },
    {},
    { id: 'prod' },
    { name: '公司' },
  ]), ['prod', 'local-test', 'mm-example-com', 'connection-4', 'prod-2', 'connection-6'])
  assert.deepEqual(connectionKeys(undefined), [])
})

test('normalizeConnections fills defaults, trims text and keeps only string list entries', () => {
  const [entry] = normalizeConnections([{ id: ' prod ', serverUrl: ' https://mm.example.com ', channels: ['dev', 3], enabled: 'yes', mentionName: '@bot' }])
  assert.equal(entry.key, 'prod')
  assert.equal(entry.id, 'prod')
  assert.equal(entry.serverUrl, 'https://mm.example.com')
  assert.deepEqual(entry.channels, ['dev'])
  assert.equal(entry.enabled, true)
  assert.equal(entry.mentionName, 'bot')
  assert.equal(entry.triggerOnMention, CONNECTION_DEFAULTS.triggerOnMention)
  assert.equal(normalizeConnections([{ enabled: false }])[0].enabled, false)
  assert.deepEqual(normalizeConnections('nope'), [])
})

test('routes: keys, defaults, and the implicit route of an environment without routes', () => {
  assert.deepEqual(routeKeys([{ id: 'a' }, { mentionName: '@Orion-Agent' }, {}, { mentionName: 'orion-agent' }]), ['a', 'orion-agent', 'route-3', 'orion-agent-2'])
  const routes = normalizeRoutes({ routes: [{ mentionName: '@orion-agent', workspace: ' /ws/a ', sessionMode: 'new' }, { id: 'w', mentionName: 'orion-wizard', sessionMode: 'bogus', sessionId: ' s1 ' }] })
  assert.deepEqual(routes.map((route) => [route.key, route.mentionName, route.workspace, route.sessionMode, route.sessionId, route.implicit]), [
    ['orion-agent', 'orion-agent', '/ws/a', 'new', '', false],
    ['w', 'orion-wizard', '', 'shared', 's1', false],
  ])
  const [implicit] = normalizeRoutes({ mentionName: 'bot', sessionId: 'pinned' })
  assert.deepEqual([implicit.key, implicit.mentionName, implicit.sessionMode, implicit.sessionId, implicit.implicit], ['', 'bot', 'shared', 'pinned', true])
  assert.equal(normalizeConnections([{ routes: [{ mentionName: 'x' }] }])[0].routes[0].key, 'x')
  assert.equal(routeLabel(routes[0]), '@orion-agent')
  assert.equal(routeLabel(implicit, 'dsh-bot'), '@bot')
  assert.equal(routeLabel({ mentionName: '' }, 'dsh-bot'), '@dsh-bot')
})

test('legacy environment triggers migrate to routes until route triggers are explicitly configured', () => {
  const old = normalizeConnections([{
    id: 'local', triggerOnMention: false, triggerOnDirectMessage: false, followThreads: true,
    matchMentionsList: true, triggerPattern: '^!ask\\s+(?<prompt>.+)', triggerPatternFlags: 'im',
    routes: [{ id: 'agent', mentionName: 'orion-agent' }, { id: 'wizard', mentionName: 'orion-wizard' }],
  }])[0]
  assert.deepEqual(old.routes.map((r) => [r.triggerOnMention, r.triggerOnDirectMessage, r.followThreads, r.matchMentionsList, r.triggerPattern, r.triggerPatternFlags]), [
    [true, false, true, true, '^!ask\\s+(?<prompt>.+)', 'im'],
    [true, false, true, true, '^!ask\\s+(?<prompt>.+)', 'im'],
  ])
  const edited = normalizeConnections([{
    ...old,
    routes: [
      { id: 'agent', mentionName: 'orion-agent', triggerPattern: '', triggerOnMention: true, triggerOnDirectMessage: true },
      { id: 'wizard', mentionName: 'orion-wizard' },
    ],
  }])[0]
  assert.equal(edited.routes[0].triggerPattern, '', 'explicit empty pattern overrides old environment pattern')
  assert.equal(edited.routes[0].triggerOnMention, true)
  assert.deepEqual([edited.routes[1].triggerOnMention, edited.routes[1].triggerOnDirectMessage, edited.routes[1].followThreads], [true, false, false], 'partial new route configuration does not inherit legacy environment triggers')
  const implicit = normalizeConnections([{ triggerOnDirectMessage: false, triggerPattern: '^!ask' }])[0].routes[0]
  assert.equal(implicit.key, '')
  assert.equal(implicit.triggerOnDirectMessage, false)
  assert.equal(implicit.triggerPattern, '^!ask')
})

test('route scope overrides legacy environment lists, while omitted fields inherit them', () => {
  const [connection] = normalizeConnections([{
    channels: ['dev'], allowedUsers: ['alice'],
    routes: [
      { id: 'inherited', mentionName: 'agent' },
      { id: 'open', mentionName: 'open', channels: [], allowedUsers: [] },
      { id: 'custom', mentionName: 'custom', channels: ['sales'], allowedUsers: ['bob'], triggerOnMention: false },
    ],
  }])
  assert.deepEqual(connection.routes.map((route) => [route.channels, route.allowedUsers, route.triggerOnMention]), [
    [['dev'], ['alice'], true], [[], [], true], [['sales'], ['bob'], true],
  ])
  const [implicit] = normalizeConnections([{ channels: ['dev'], allowedUsers: ['alice'], triggerOnMention: false }])
  assert.deepEqual([implicit.routes[0].channels, implicit.routes[0].allowedUsers, implicit.routes[0].triggerOnMention], [['dev'], ['alice'], false])
})

test('mergeSettings overlays one environment on the shared settings', () => {
  const [connection] = normalizeConnections([{ id: 'p', name: 'Prod', serverUrl: 'https://x', token: 't', greetingEnabled: true, greetingChannelId: 'c1', routes: [{ mentionName: 'a' }] }])
  const merged = mergeSettings({ sessionTitle: ' Mattermost ', queueMaxSize: 3, maxConcurrent: 0, messages: { queued: 'Q' } }, connection)
  assert.equal(merged.serverUrl, 'https://x')
  assert.equal(merged.token, 't')
  assert.equal(merged.queueMaxSize, 3)
  assert.equal(merged.maxConcurrent, 3, 'invalid values fall back to the default')
  assert.equal(merged.sessionTitle, 'Mattermost')
  assert.equal(merged.connectionName, 'Prod')
  assert.deepEqual(merged.routes.map((route) => route.key), ['a'])
  assert.deepEqual(merged.greeting, { enabled: true, channelId: 'c1', message: '', goodbyeMessage: '' })
  assert.equal(merged.messages.queued, 'Q')
  assert.equal(merged.messages.processing, DEFAULT_MESSAGES.processing)
  assert.equal(mergeSettings({ maxConcurrent: 5 }, normalizeConnections([{ id: 'x' }])[0]).maxConcurrent, 5)
  assert.equal(mergeSettings({}, normalizeConnections([{ id: 'x' }])[0]).sessionTitle, 'Mattermost')
  assert.equal(mergeSettings({}, { mentionName: 'raw' }).routes[0].mentionName, 'raw', 'raw connections are normalized too')
  assert.equal(connectionLabel(connection), 'Prod')
  assert.equal(connectionLabel(normalizeConnections([{ serverUrl: 'https://mm.example.com' }])[0]), 'mm.example.com')
})
