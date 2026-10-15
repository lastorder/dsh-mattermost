import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Config } from '../index.js'
import { DEFAULT_MESSAGES, DEFAULT_PROMPT_HEADER } from '../lib/core.js'
import { CONNECTION_DEFAULTS, ROUTE_DEFAULTS, connectionKeys, normalizeConnections, routeKeys } from '../lib/config.js'

/** Evaluate client.js the way the page's module loader does and return its plugin object. */
async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let definition
  new Function('window', source)({ __ModuleLoader__: { load: (value) => { definition = value } } })
  assert.equal(definition.id, 'dsh-mattermost')
  return definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
}

const client = await loadClient()
const { toForm, buildOps, validate, newConnection, newRoute, duplicateRoute, zh, en, SettingsPage, ConnectionCard, RouteEditor, SharedSection, WorkspacePicker } = client.testing

/** The Host settings service's path-op semantics (dsh-settings `applyPathOp`), for simulation. */
function applyOp(section, op) {
  const edit = (input, path) => {
    const [head, ...rest] = path
    if (head === undefined) return op.op === 'set' ? op.value : undefined
    if (Array.isArray(input)) {
      const index = Number(head)
      assert.ok(/^(0|[1-9][0-9]*)$/.test(head) && index <= input.length && !(index === input.length && (rest.length > 0 || op.op === 'unset')), `index ${head} in range`)
      const result = [...input]
      if (rest.length === 0 && op.op === 'unset') result.splice(index, 1)
      else result[index] = edit(input[index], rest)
      return result
    }
    const result = input && typeof input === 'object' ? { ...input } : {}
    const child = edit(result[head], rest)
    if (child === undefined) delete result[head]
    else result[head] = child
    return result
  }
  return edit(section, op.path)
}

const stored = {
  connections: [
    { id: 'prod', name: 'Company', serverUrl: 'https://mm.corp.example', token: 'secret-prod', channels: ['dev'], allowedUsers: ['alice'] },
    { id: 'local', name: 'Local', serverUrl: 'http://localhost:8065', token: 'secret-local' },
  ],
  queueMaxSize: 10,
}
/** What the page receives: effective values without tokens. */
function redacted(value) {
  return { ...value, connections: value.connections.map(({ token, ...rest }) => rest) }
}

test('the page uses the same defaults and keys as the Host', () => {
  assert.deepEqual(client.testing.DEFAULT_MESSAGES, DEFAULT_MESSAGES)
  assert.equal(client.testing.DEFAULT_PROMPT_HEADER, DEFAULT_PROMPT_HEADER)
  for (const [field, value] of Object.entries(client.testing.CONNECTION_DEFAULTS)) assert.deepEqual(value, CONNECTION_DEFAULTS[field], field)
  assert.deepEqual(client.testing.ROUTE_DEFAULTS, { ...ROUTE_DEFAULTS })
  const defaults = Config({})
  for (const [field, value] of Object.entries(client.testing.SHARED_DEFAULTS)) {
    const actual = defaults[field]?.get ? defaults[field].get() : defaults[field]
    assert.deepEqual(actual ?? '', value, field)
  }
  const samples = [[{ id: 'a' }, { name: 'B c' }, { serverUrl: 'x.example' }, {}, { id: 'a' }]]
  for (const list of samples) assert.deepEqual(client.testing.connectionKeys(list), connectionKeys(list))
  const routeSamples = [[{ id: 'a' }, { mentionName: '@Orion-Agent' }, {}, { mentionName: 'orion-agent' }, { mentionName: ' ' }]]
  for (const list of routeSamples) assert.deepEqual(client.testing.routeKeys(list), routeKeys(list))
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en define the same keys')
})

test('an unchanged form produces no operations', () => {
  const form = toForm(redacted(stored))
  assert.deepEqual(buildOps(form, redacted(stored)).ops, [])
  assert.deepEqual(buildOps(toForm(undefined), undefined).ops, [])
})

test('editing, removing and adding environments keeps hidden tokens', () => {
  const view = redacted(stored)
  const form = structuredClone(toForm(view))
  form.connections[1].name = 'Local test'
  form.connections[1].token = '  new-local  '
  form.connections[1].channels = 'town-square, , dev'
  form.connections[1].enabled = false
  form.connections.splice(0, 1)
  const added = newConnection(new Set(['local']))
  Object.assign(added, { name: 'Staging', serverUrl: 'mm.staging.example', token: 'secret-staging', allowedUsers: 'bob' })
  form.connections.push(added)
  const { ops, problems } = buildOps(form, view)
  assert.deepEqual(problems, {})
  assert.deepEqual(ops.slice(0, 4), [
    { op: 'set', path: ['connections', '1', 'name'], value: 'Local test' },
    { op: 'set', path: ['connections', '1', 'enabled'], value: false },
    { op: 'set', path: ['connections', '1', 'channels'], value: ['town-square', 'dev'] },
    { op: 'set', path: ['connections', '1', 'token'], value: 'new-local' },
  ])
  assert.deepEqual(ops[4], { op: 'unset', path: ['connections', '0'] })
  assert.deepEqual(ops[5].path, ['connections', '1'])
  // Apply on the Host side (with real tokens) and parse with the real schema.
  const result = ops.reduce(applyOp, structuredClone(stored))
  const environments = normalizeConnections(Config(result).connections.get())
  assert.deepEqual(environments.map((entry) => [entry.key, entry.name, entry.token, entry.enabled]), [
    ['local', 'Local test', 'new-local', false],
    [added.id, 'Staging', 'secret-staging', true],
  ])
  assert.deepEqual(environments[0].channels, ['town-square', 'dev'])
  assert.deepEqual(environments[1].allowedUsers, ['bob'])
  assert.equal(environments[1].serverUrl, 'mm.staging.example')
})

test('a blank token is never written and an untouched environment keeps its token', () => {
  const view = redacted(stored)
  const form = structuredClone(toForm(view))
  form.connections[0].serverUrl = 'https://mm2.corp.example'
  const { ops } = buildOps(form, view)
  assert.deepEqual(ops, [{ op: 'set', path: ['connections', '0', 'serverUrl'], value: 'https://mm2.corp.example' }])
  const result = ops.reduce(applyOp, structuredClone(stored))
  assert.equal(result.connections[0].token, 'secret-prod')
  assert.equal(result.connections[1].token, 'secret-local')
})

test('clearing a field unsets it; shared settings and texts round-trip', () => {
  const view = { ...redacted(stored), promptHeader: DEFAULT_PROMPT_HEADER, messages: { ...DEFAULT_MESSAGES, queued: 'Wait please' } }
  const form = structuredClone(toForm(view))
  assert.equal(form.messages.queued, 'Wait please')
  assert.equal(form.messages.processing, '', 'default texts show as empty')
  form.connections[0].channels = ''
  form.shared.queueMaxSize = '3'
  form.shared.replyMode = 'all'
  form.shared.showHost = true
  form.shared.promptHeader = ''
  form.messages.queued = ''
  form.messages.error = 'Oops'
  const { ops } = buildOps(form, view)
  assert.deepEqual(ops, [
    { op: 'set', path: ['promptHeader'], value: '' },
    { op: 'set', path: ['showHost'], value: true },
    { op: 'set', path: ['replyMode'], value: 'all' },
    { op: 'set', path: ['queueMaxSize'], value: 3 },
    { op: 'unset', path: ['messages', 'queued'] },
    { op: 'set', path: ['messages', 'error'], value: 'Oops' },
    { op: 'unset', path: ['connections', '0', 'channels'] },
  ])
  const back = structuredClone(form)
  back.shared.promptHeader = DEFAULT_PROMPT_HEADER
  assert.ok(buildOps(back, { ...view, promptHeader: '' }).ops.some((op) => op.op === 'unset' && op.path[0] === 'promptHeader'))
})

test('validation flags bad URLs, patterns, flags and numbers', () => {
  const form = structuredClone(toForm(redacted(stored)))
  form.connections[0].serverUrl = 'https://'
  form.connections[1].routes.push({ ...newRoute(new Set()), triggerPattern: '(unclosed' })
  const routeKey = form.connections[1].routes[0].key
  form.shared.maxPostLength = '500'
  form.shared.queueMaxSize = 'ten'
  form.shared.replyTimeoutMinutes = '1.5'
  const problems = validate(form)
  assert.deepEqual(Object.keys(problems).sort(), [`local.routes.${routeKey}.triggerPattern`, 'prod.serverUrl', 'shared.maxPostLength', 'shared.queueMaxSize'].sort())
  assert.deepEqual(problems['shared.maxPostLength'], { key: 'tooSmall', values: { min: 1000 } })
  form.connections[1].routes[0].triggerPattern = 'ok'
  form.connections[1].routes[0].triggerPatternFlags = 'iq'
  assert.deepEqual(validate(form)[`local.routes.${routeKey}.triggerPatternFlags`], { key: 'invalidFlags' })
  assert.ok(buildOps(form, redacted(stored)).problems['prod.serverUrl'])
})

function fakeForm(snapshot) {
  return { subscribe: () => () => {}, getSnapshot: () => snapshot, mutate: async () => true }
}
const t = (key) => zh[key] ?? key

test('the page renders environments, shared settings and the save footer', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsPage, { form: fakeForm({ status: 'ready', writable: true, revision: 3, value: redacted(stored) }), t }))
  for (const text of [zh.environments, zh.addEnvironment, 'Company', 'Local', zh.shared, zh.messages, zh.advanced, zh.save, zh.commandsHint.replace('<', '&lt;').replace('>', '&gt;')]) {
    assert.ok(html.includes(text), `page shows ${text}`)
  }
  assert.ok(!html.includes('secret-prod'))
  assert.match(html, /role="switch"/)
})

test('the page renders the empty, loading and read-only states', () => {
  const empty = renderToStaticMarkup(React.createElement(SettingsPage, { form: fakeForm({ status: 'ready', writable: true, revision: 1, value: {} }), t }))
  assert.ok(empty.includes(zh.noEnvironments))
  const loading = renderToStaticMarkup(React.createElement(SettingsPage, { form: fakeForm({ status: 'loading', writable: false }), t }))
  assert.ok(loading.includes(zh.loading))
  const readOnly = renderToStaticMarkup(React.createElement(SettingsPage, { form: fakeForm({ status: 'ready', writable: false, revision: 1, value: {} }), t: (key) => en[key] ?? key }))
  assert.ok(readOnly.includes(en.unavailable))
})

test('the client plugin registers the settings page in the bundle config slot', () => {
  const registrations = []
  const effects = []
  const ctx = {
    effect: (body) => effects.push(body()),
    locale: { register: () => () => {}, bind: () => t },
    configForms: { get: (row) => ({ row }) },
    slots: {
      inject: (owner, body) => body(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)
  assert.deepEqual(client.inject, ['slots', 'locale', 'configForms'])
  assert.equal(registrations.length, 1)
  assert.deepEqual(registrations[0].options, { name: 'plugins.bundle.config', key: 'dsh-mattermost', locale: 'dshMattermost' })
  assert.equal(registrations[0].component({ view: 'list', t }), null)
  assert.equal(registrations[0].component({ view: 'page', t }).props.form.row, 'mattermost')
})

const withRoutes = {
  connections: [
    {
      id: 'local',
      name: 'Local',
      serverUrl: 'http://localhost:8065',
      token: 'secret-local',
      routes: [{ id: 'agent', mentionName: 'orion-agent', workspace: '/ws/orion-agent', sessionMode: 'shared', sessionId: 'session-a' }],
    },
  ],
}

test('route edits are written as one route list and keep the environment token', () => {
  const page = redacted(withRoutes)
  const form = structuredClone(toForm(page))
  assert.deepEqual(buildOps(form, page).ops, [])
  form.connections[0].routes[0].sessionMode = 'new'
  const added = newRoute(new Set(['agent']), undefined, 1)
  Object.assign(added, { mentionName: '@orion-wizard', workspace: '/ws/orion-wizard', sessionMode: 'thread' })
  form.connections[0].routes.push(added)
  const { ops, problems } = buildOps(form, page)
  assert.deepEqual(problems, {})
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0].path, ['connections', '0', 'routes'])
  assert.deepEqual(ops[0].value.map((route) => [route.id, route.mentionName, route.workspace, route.sessionMode, route.triggerOnDirectMessage]), [
    ['agent', 'orion-agent', '/ws/orion-agent', 'new', true],
    [added.id, 'orion-wizard', '/ws/orion-wizard', 'thread', false],
  ])
  assert.ok(ops[0].value.every((route) => !Object.hasOwn(route, 'triggerOnMention') && route.triggerPattern === '' && route.triggerPatternFlags === 'i' && Array.isArray(route.channels) && Array.isArray(route.allowedUsers)))
  const result = ops.reduce(applyOp, structuredClone(withRoutes))
  const [environment] = normalizeConnections(Config(result).connections.get())
  assert.equal(environment.token, 'secret-local')
  assert.deepEqual(environment.routes.map((route) => [route.key, route.mentionName, route.workspace, route.sessionMode, route.sessionId]), [
    ['agent', 'orion-agent', '/ws/orion-agent', 'new', ''],
    [added.id, 'orion-wizard', '/ws/orion-wizard', 'thread', ''],
  ])

  form.connections[0].routes = []
  assert.deepEqual(buildOps(form, page).ops, [{ op: 'unset', path: ['connections', '0', 'routes'] }])

  const fresh = newConnection(new Set(['local']))
  fresh.routes.push({ ...newRoute(new Set()), mentionName: 'orion-agent' })
  form.connections = [structuredClone(toForm(page).connections[0]), fresh]
  const appended = buildOps(form, page).ops
  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0].path, ['connections', '1'])
  assert.deepEqual(appended[0].value.routes, [{ id: fresh.routes[0].id, mentionName: 'orion-agent', sessionMode: 'shared', triggerOnDirectMessage: true, followThreads: false, matchMentionsList: false, channels: [], allowedUsers: [], triggerPattern: '', triggerPatternFlags: 'i' }])
})

test('route scope edits override legacy environment filters without rewriting the token', () => {
  const actual = { connections: [{ id: 'local', token: 'hidden', channels: ['dev'], allowedUsers: ['alice'], routes: [{ id: 'agent', mentionName: 'agent' }] }] }
  const page = redacted(actual)
  const draft = structuredClone(toForm(page))
  assert.equal(draft.connections[0].routes[0].channels, 'dev')
  assert.equal(draft.connections[0].routes[0].allowedUsers, 'alice')
  assert.deepEqual(buildOps(draft, page).ops, [])
  draft.connections[0].routes[0].channels = ''
  draft.connections[0].routes[0].allowedUsers = 'bob'
  const { ops } = buildOps(draft, page)
  assert.deepEqual(ops.map(({ path }) => path), [['connections', '0', 'routes']])
  assert.deepEqual(ops[0].value[0].channels, [])
  assert.deepEqual(ops[0].value[0].allowedUsers, ['bob'])
  const [env] = normalizeConnections(Config(ops.reduce(applyOp, actual)).connections.get())
  assert.equal(env.token, 'hidden')
  assert.deepEqual([env.routes[0].channels, env.routes[0].allowedUsers], [[], ['bob']])
})

test('the independent all-matching-routes switch is saved without changing triggers or secrets', () => {
  const page = redacted(withRoutes)
  const draft = structuredClone(toForm(page))
  draft.connections[0].routeToAllMatches = true
  assert.deepEqual(buildOps(draft, page).ops, [{ op: 'set', path: ['connections', '0', 'routeToAllMatches'], value: true }])
  const resulting = normalizeConnections(Config({ ...withRoutes, connections: [{ ...withRoutes.connections[0], routeToAllMatches: true }] }).connections.get())[0]
  assert.equal(resulting.routeToAllMatches, true)
  assert.equal(resulting.token, 'secret-local')
  const noop = () => {}
  draft.connections[0].routes.push({ ...newRoute(new Set(['agent']), undefined, 1), mentionName: 'wizard' })
  const html = renderToStaticMarkup(React.createElement(ConnectionCard, {
    form: draft.connections[0], expanded: true, disabled: false, problems: {}, t,
    status: { state: 'connected', bot: 'dsh-bot', routes: [] }, workspaces: [], sessions: [],
    onChange: noop, onToggle: noop, onRemove: noop, onTest: noop, onReconnect: noop,
    onRefreshSessions: noop, onRefreshWorkspaces: noop, onRouteChange: noop, onAddRoute: noop,
    onDuplicateRoute: noop, onRemoveRoute: noop, onToggleRoute: noop,
  }))
  assert.ok(html.includes(zh.routeToAllMatchesHint))
  assert.match(html, /id="dshmm-local-routeToAllMatches"[^>]+aria-checked="true"/)
})

test('route names must be valid and unique', () => {
  const form = structuredClone(toForm(redacted(withRoutes)))
  const second = { ...newRoute(new Set(['agent'])), mentionName: 'Orion-Agent' }
  const third = { ...newRoute(new Set(['agent', second.key])), mentionName: 'bad name' }
  form.connections[0].routes.push(second, third)
  const problems = validate(form)
  assert.deepEqual(problems[`local.routes.${second.key}.mentionName`], { key: 'duplicateMention' })
  assert.deepEqual(problems[`local.routes.${third.key}.mentionName`], { key: 'invalidMention' })
})

test('an expanded environment shows its routes with workspaces, modes and sessions', () => {
  const form = toForm(redacted(withRoutes)).connections[0]
  form.routes.push({ ...newRoute(new Set(['agent']), undefined, 1), mentionName: 'orion-wizard', workspace: '/ws/orion-wizard', sessionMode: 'new' })
  const expandedRoutes = new Set(form.routes.map((route) => JSON.stringify(['local', route.key])))
  const noop = () => {}
  const html = renderToStaticMarkup(React.createElement(ConnectionCard, {
    form,
    expanded: true,
    expandedRoutes,
    disabled: false,
    problems: {},
    t,
    status: { key: 'local', state: 'connected', bot: 'dsh-bot', hasToken: true, routes: [{ key: 'agent', target: { id: 'session-a', source: 'config', title: 'Agent work' } }] },
    sessions: [
      { id: 'session-a', title: 'Agent work', workspace: 'orion-agent', path: '/ws/orion-agent' },
      { id: 'session-x', title: 'Elsewhere', workspace: 'other', path: '/ws/other' },
    ],
    workspaces: [
      { id: 'ws-a', title: 'orion-agent', path: '/ws/orion-agent' },
      { id: 'ws-w', title: 'orion-wizard', path: '/ws/orion-wizard' },
    ],
    onChange: noop, onToggle: noop, onRemove: noop, onTest: noop, onReconnect: noop, onRefreshSessions: noop, onRefreshWorkspaces: noop, onRouteChange: noop, onAddRoute: noop, onDuplicateRoute: noop, onRemoveRoute: noop, onToggleRoute: noop,
  }))
  assert.ok(html.includes('@orion-agent → orion-agent'))
  assert.ok(html.includes('@orion-wizard → orion-wizard'))
  assert.ok(html.includes(zh.tagShared) && html.includes(zh.tagNew))
  assert.ok(html.includes('Agent work · orion-agent'), 'sessions of the route workspace are offered')
  assert.ok(!html.includes('Elsewhere'), 'sessions of other workspaces are not')
  assert.match(html, /<select id="dshmm-local-agent-workspace"/)
  assert.ok(html.includes('value="/ws/orion-agent" selected=""'), 'the configured route workspace remains selected')
  assert.ok(html.includes('orion-wizard — /ws/orion-wizard'), 'each DSH workspace has a distinct title and path')
  assert.ok(!html.includes('<datalist'), 'workspace selection is a real dropdown, not a free-text input')
  assert.ok(html.includes(zh.addRoute))
})

test('routes are collapsed by default and expanded individually with triggers and one regex row', () => {
  const form = toForm(redacted(withRoutes)).connections[0]
  form.routes[0].triggerPattern = '^!ask\\s+(?<prompt>.+)'
  const events = []
  const noop = () => {}
  const props = {
    form, status: { bot: 'dsh-bot', routes: [] }, sessions: [], workspaces: [],
    expandedRoutes: new Set(), disabled: false, problems: {}, t,
    onToggleRoute: (connection, route) => events.push(['toggle', connection, route]),
    onRouteChange: noop, onAddRoute: noop, onDuplicateRoute: (connection, route) => events.push(['duplicate', connection, route]), onRemoveRoute: noop,
    onRefreshSessions: noop, onRefreshWorkspaces: noop,
  }
  const collapsed = renderToStaticMarkup(React.createElement(RouteEditor, props))
  assert.ok(collapsed.includes('aria-expanded="false"'))
  assert.ok(collapsed.includes(zh.duplicateRoute))
  assert.ok(!collapsed.includes(zh.routeExpand) && !collapsed.includes(zh.routeCollapse))
  assert.ok(!collapsed.includes('id="dshmm-local-agent-triggerPattern"'))
  const row = RouteEditor(props).props.children[4][0].props.children[0]
  row.props.onClick()
  let stopped = false
  row.props.children[3].props.onClick({ stopPropagation: () => { stopped = true } })
  assert.ok(stopped, 'Duplicate does not also toggle the route')
  assert.deepEqual(events, [['toggle', 'local', 'agent'], ['duplicate', 'local', 'agent']], 'header and Duplicate target only their own route')

  const html = renderToStaticMarkup(React.createElement(RouteEditor, {
    ...props, expandedRoutes: new Set([JSON.stringify(['local', 'agent'])]),
    problems: { 'local.routes.agent.triggerPatternFlags': { key: 'invalidFlags' } },
  }))
  assert.ok(html.includes('aria-expanded="true"'))
  assert.match(html, /<div class="dshmm-row"><input id="dshmm-local-agent-triggerPattern"[^>]*><input id="dshmm-local-agent-triggerPatternFlags"[^>]*>/)
  assert.ok(html.includes('aria-label="Regex flags"'))
  assert.ok(html.includes(zh.routeTriggerHint) && html.includes(zh.patternHint.replace('<', '&lt;').replace('>', '&gt;')))
  assert.ok(html.includes(zh.routeMentionHint) && html.includes(zh.scope))
  assert.match(html, /id="dshmm-local-agent-channels"/)
  assert.match(html, /id="dshmm-local-agent-allowedUsers"/)
  assert.ok(!html.includes('id="dshmm-local-agent-triggerOnMention"'))
  assert.ok(html.includes(zh.routeInvalid) && html.includes(zh.invalidFlags))
})

test('duplicate gives a route unique identity and @name, but not the source session', () => {
  const form = toForm(redacted(withRoutes)).connections[0]
  const source = form.routes[0]
  Object.assign(source, { triggerPattern: '^!ask\\s+(?<prompt>.+)', triggerPatternFlags: 'im', followThreads: true, triggerOnDirectMessage: true, channels: 'dev', allowedUsers: 'alice, bob' })
  const copy = duplicateRoute(source, new Set([source.key]), [source.mentionName], 'dsh-bot')
  assert.notEqual(copy.key, source.key)
  assert.equal(copy.id, copy.key)
  assert.equal(copy.mentionName, 'orion-agent-copy')
  assert.equal(copy.sessionId, '', 'a duplicated route must not pin the original workspace session')
  for (const field of ['workspace', 'sessionMode', 'triggerPattern', 'triggerPatternFlags', 'followThreads', 'triggerOnDirectMessage', 'channels', 'allowedUsers']) assert.equal(copy[field], source[field], field)
  const next = duplicateRoute(source, new Set([source.key, copy.key]), [source.mentionName, copy.mentionName], 'dsh-bot')
  assert.equal(next.mentionName, 'orion-agent-copy-2')
  form.routes.push(copy)
  assert.deepEqual(validate({ connections: [form], shared: toForm({}).shared, messages: toForm({}).messages }), {})
  const { ops } = buildOps({ ...toForm(redacted(withRoutes)), connections: [form] }, redacted(withRoutes))
  assert.deepEqual(ops.map((op) => op.path), [['connections', '0', 'routes']])
  assert.equal(ops[0].value[1].sessionId, undefined)
  assert.equal(ops[0].value[1].triggerPatternFlags, 'im')
})

test('client migrates legacy environment triggers when an old route is edited', () => {
  const saved = { connections: [{
    id: 'local', serverUrl: 'http://localhost:8065', token: 'hidden', followThreads: true,
    triggerPattern: '^!ask\\s+(?<prompt>.+)', triggerPatternFlags: 'im',
    routes: [{ id: 'agent', mentionName: 'orion-agent' }, { id: 'wizard', mentionName: 'orion-wizard' }],
  }] }
  const exposed = redacted(saved)
  const draft = toForm(exposed)
  assert.deepEqual(buildOps(draft, exposed).ops, [], 'viewing legacy config does not modify it')
  assert.equal(draft.connections[0].routes[0].triggerPattern, '^!ask\\s+(?<prompt>.+)')
  assert.equal(draft.connections[0].routes[1].followThreads, true)
  assert.equal(draft.connections[0].routes[1].triggerPattern, '^!ask\\s+(?<prompt>.+)', 'legacy regex also follows threads handled by another route')
  draft.connections[0].routes[1].triggerPattern = '^!wizard\\s+(?<prompt>.+)'
  const { ops } = buildOps(draft, exposed)
  assert.deepEqual(ops.map((op) => op.path), [['connections', '0', 'routes']])
  assert.ok(ops[0].value.every((route) => route.followThreads === true && route.triggerPatternFlags === 'im'))
  const parsed = normalizeConnections(Config({ ...saved, connections: [{ ...saved.connections[0], routes: ops[0].value }] }).connections.get())[0]
  assert.equal(parsed.token, 'hidden')
  assert.equal(parsed.routes[0].triggerPattern, '^!ask\\s+(?<prompt>.+)')
  assert.equal(parsed.routes[1].triggerPattern, '^!wizard\\s+(?<prompt>.+)')
})
