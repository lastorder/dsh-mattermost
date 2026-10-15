import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Config } from '../index.js'
import { normalizeConnections } from '../lib/config.js'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let definition
new Function('window', source)({ __ModuleLoader__: { load: (value) => { definition = value } } })
const { testing: { toForm, buildOps, SharedSection, WorkspacePicker, fetchConfiguredWorkspaces, zh } } = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
const t = (key) => zh[key] ?? key
const workspaces = [
  { id: 'agent', path: '/ws/orion-agent', title: 'orion-agent' },
  { id: 'wizard', path: '/ws/orion-wizard', title: 'orion-wizard' },
  { id: 'other', path: '/ws/other', title: 'orion-agent' },
]

test('workspace options are fetched from the authenticated DSH Host endpoint', async () => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const urls = []
  try {
    globalThis.fetch = async (url, init) => {
      urls.push(String(url))
      assert.equal(init.headers.accept, 'application/json')
      assert.equal(init.method, undefined)
      return Response.json({ ok: true, workspaces })
    }
    for (const baseURI of ['http://127.0.0.1:19387/', 'dsh-app://app/']) {
      globalThis.document = { baseURI }
      assert.deepEqual(await fetchConfiguredWorkspaces(), workspaces)
    }
    assert.deepEqual(urls, [
      'http://127.0.0.1:19387/api/dsh-mattermost/mattermost/workspaces',
      'dsh-app://app/api/dsh-mattermost/mattermost/workspaces',
    ])
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('shared workspace is a dropdown of currently configured DSH workspaces', () => {
  const { shared } = toForm({ workspace: '/ws/orion-wizard' })
  const html = renderToStaticMarkup(React.createElement(SharedSection, {
    shared, workspaces, problems: {}, disabled: false, onChange: () => {}, onRefreshWorkspaces: () => {}, t,
  }))
  assert.match(html, /<select id="dshmm-shared-workspace"/)
  assert.ok(html.includes('value="/ws/orion-wizard" selected=""'))
  assert.ok(html.includes('orion-agent — /ws/orion-agent'))
  assert.ok(html.includes('orion-agent — /ws/other'), 'different paths with the same title stay distinguishable')
  assert.ok(html.includes(zh.workspaceFirst), 'empty choice preserves first-workspace behavior')
  assert.ok(!html.includes('<input id="dshmm-shared-workspace"'))
  assert.ok(!html.includes('<datalist'))
})

test('workspace select preserves an old unregistered path and shows loading/failure states', () => {
  const props = {
    id: 'workspace-chooser', value: '/old/missing-workspace', workspaces,
    disabled: false, onChange: () => {}, onRefresh: () => {}, emptyLabel: zh.workspaceInherit, t,
  }
  const html = renderToStaticMarkup(React.createElement(WorkspacePicker, props))
  assert.ok(html.includes('value="/old/missing-workspace" selected=""'))
  assert.ok(html.includes('/old/missing-workspace'))
  assert.ok(html.includes('orion-wizard — /ws/orion-wizard'))
  for (const unavailable of [undefined, null]) {
    const blocked = renderToStaticMarkup(React.createElement(WorkspacePicker, { ...props, workspaces: unavailable }))
    assert.match(blocked, /<select[^>]+disabled=""/)
    assert.ok(blocked.includes('value="/old/missing-workspace" selected=""'), 'the saved value remains visible while the API is unavailable')
    assert.ok(blocked.includes(`>${zh.refresh}</button>`), 'Refresh remains available')
  }
  let choice
  const picker = WorkspacePicker({ ...props, onChange: (value) => { choice = value } })
  picker.props.children[0].props.onChange({ target: { value: '/ws/orion-agent' } })
  assert.equal(choice, '/ws/orion-agent', 'select stores the workspace path, not the workspace title/id')
})

test('selecting a workspace writes settings paths without overwriting the bot token', () => {
  const actual = {
    workspace: '/ws/orion-agent',
    connections: [{
      id: 'local', token: 'stored-secret', serverUrl: 'http://localhost:8065',
      routes: [{ id: 'agent', mentionName: 'orion-agent', workspace: '/ws/orion-agent', sessionMode: 'shared' }],
    }],
  }
  const exposed = {
    ...actual,
    connections: actual.connections.map(({ token, ...publicFields }) => publicFields),
  }
  const draft = structuredClone(toForm(exposed))
  draft.shared.workspace = '/ws/orion-wizard'
  draft.connections[0].routes[0].workspace = '/ws/orion-wizard'
  const { ops, problems } = buildOps(draft, exposed)
  assert.deepEqual(problems, {})
  assert.deepEqual(ops.map(({ path }) => path), [
    ['workspace'],
    ['connections', '0', 'routes'],
  ])
  assert.equal(ops[0].value, '/ws/orion-wizard')
  const updated = { ...actual, workspace: ops[0].value, connections: [{ ...actual.connections[0], routes: ops[1].value }] }
  assert.equal(updated.connections[0].token, 'stored-secret')
  assert.equal(Config(updated).workspace.get(), '/ws/orion-wizard')
  assert.equal(normalizeConnections(Config(updated).connections.get())[0].routes[0].workspace, '/ws/orion-wizard')
})
