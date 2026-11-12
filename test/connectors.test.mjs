import test from 'node:test'
import assert from 'node:assert/strict'
import { ConnectorHub } from '../server/connectors/index.mjs'
import { enabledIds, normalizeItem, fetchJson } from '../server/connectors/lib.mjs'

/** A connector that counts its polls and returns whatever it is given. */
function mockConnector(id, items, extra = {}) {
  const c = {
    id,
    polls: 0,
    enabled: () => true,
    async poll() {
      c.polls++
      return typeof items === 'function' ? items() : items
    },
    ...extra,
  }
  return c
}

const registryOf = (...connectors) => connectors.map((c) => ({ id: c.id, load: async () => ({ default: c }) }))

test('enabledIds parses the list and is empty by default', () => {
  assert.deepEqual([...enabledIds({})], [])
  assert.deepEqual([...enabledIds({ HOMEBASE_CONNECTORS: ' System, http ,,' })], ['system', 'http'])
})

test('normalizeItem keeps only the documented shape', () => {
  const item = normalizeItem('mock', { title: '  CPU  load ', status: '93%', needsAttention: true, url: 'https://example.com/x', updatedAt: 5, secret: 'nope' }, 100)
  assert.deepEqual(item, { source: 'mock', title: 'CPU load', status: '93%', needsAttention: true, url: 'https://example.com/x', updatedAt: 5 })
})

test('normalizeItem drops untitled items, unsafe links and truthy-but-not-true flags', () => {
  assert.equal(normalizeItem('mock', { status: 'x' }), null)
  assert.equal(normalizeItem('mock', null), null)
  const item = normalizeItem('mock', { title: 't', url: 'javascript:alert(1)', needsAttention: 'yes' }, 42)
  assert.equal(item.url, null)
  assert.equal(item.needsAttention, false)
  assert.equal(item.status, 'ok')
  assert.equal(item.updatedAt, 42)
})

test('nothing is loaded or polled when no connector is enabled', async () => {
  const mock = mockConnector('mock', [{ title: 'a' }])
  let loads = 0
  const registry = [{ id: 'mock', load: async () => (loads++, { default: mock }) }]
  const out = await new ConnectorHub({ registry, env: {} }).poll(1000)
  assert.deepEqual(out, { polledAt: 1000, connectors: [], items: [] })
  assert.equal(loads, 0)
  assert.equal(mock.polls, 0)
})

test('only the connectors listed in the environment are loaded', async () => {
  const a = mockConnector('a', [{ title: 'from a' }])
  const b = mockConnector('b', [{ title: 'from b' }])
  const out = await new ConnectorHub({ registry: registryOf(a, b), env: { HOMEBASE_CONNECTORS: 'b' } }).poll(1000)
  assert.deepEqual(out.connectors, [{ id: 'b', label: 'b', state: 'ok', error: null, count: 1 }])
  assert.deepEqual(out.items.map((i) => [i.source, i.title]), [['b', 'from b']])
  assert.equal(a.polls, 0)
})

test('a mock connector’s items come back normalised', async () => {
  const mock = mockConnector('mock', [
    { title: 'Disk almost full', status: '97% used', needsAttention: true },
    { title: '' },
    { title: 'Fine', url: 'ftp://example.com' },
  ], { label: 'Mock' })
  const out = await new ConnectorHub({ registry: registryOf(mock), env: { HOMEBASE_CONNECTORS: 'mock' } }).poll(2000)
  assert.equal(out.connectors[0].label, 'Mock')
  assert.equal(out.items.length, 2)
  assert.deepEqual(out.items[0], { source: 'mock', title: 'Disk almost full', status: '97% used', needsAttention: true, url: null, updatedAt: 2000 })
  assert.equal(out.items[1].url, null)
})

test('a failing connector is reported and does not take the others down', async () => {
  const good = mockConnector('good', [{ title: 'ok' }])
  const bad = mockConnector('bad', () => { throw new Error('boom') })
  const out = await new ConnectorHub({ registry: registryOf(good, bad), env: { HOMEBASE_CONNECTORS: 'good,bad' } }).poll(1)
  assert.equal(out.items.length, 1)
  assert.deepEqual(out.connectors.find((c) => c.id === 'bad'), { id: 'bad', label: 'bad', state: 'error', error: 'boom', count: 0 })
})

test('a hanging connector times out', async () => {
  const slow = mockConnector('slow', () => new Promise(() => {}))
  const out = await new ConnectorHub({ registry: registryOf(slow), env: { HOMEBASE_CONNECTORS: 'slow' }, timeoutMs: 20 }).poll(1)
  assert.equal(out.connectors[0].error, 'timed out')
})

test('unconfigured, unknown and broken connectors say so', async () => {
  const unset = mockConnector('unset', [], { enabled: () => false })
  const registry = [...registryOf(unset), { id: 'broken', load: async () => ({ default: { id: 'broken' } }) }]
  const out = await new ConnectorHub({ registry, env: { HOMEBASE_CONNECTORS: 'unset,broken,typo' } }).poll(1)
  const by = Object.fromEntries(out.connectors.map((c) => [c.id, c]))
  assert.equal(by.unset.state, 'unconfigured')
  assert.equal(by.broken.state, 'error')
  assert.match(by.typo.error, /no connector/)
  assert.equal(unset.polls, 0)
})

test('polls inside a connector’s interval are answered from memory', async () => {
  const mock = mockConnector('mock', [{ title: 'a' }], { intervalMs: 1000 })
  const hub = new ConnectorHub({ registry: registryOf(mock), env: { HOMEBASE_CONNECTORS: 'mock' } })
  await hub.poll(10_000)
  await hub.poll(10_500)
  assert.equal(mock.polls, 1)
  await hub.poll(11_001)
  assert.equal(mock.polls, 2)
})

test('fetchJson errors name the host and never the path, query or headers', async () => {
  const url = 'https://media.example.com/secret/path?api_key=SHOULD-NOT-APPEAR'
  const denied = async () => ({ ok: false, status: 401, json: async () => ({}) })
  await assert.rejects(fetchJson(denied, url, { headers: { 'X-Token': 'SHOULD-NOT-APPEAR' } }), (err) => {
    assert.equal(err.message, 'HTTP 401 from media.example.com')
    return true
  })
  const down = async () => { throw new Error(`connect ECONNREFUSED ${url}`) }
  await assert.rejects(fetchJson(down, url), { message: 'could not reach media.example.com' })
})
