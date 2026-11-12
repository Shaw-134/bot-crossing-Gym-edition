import test from 'node:test'
import assert from 'node:assert/strict'
import { createSystemConnector } from '../server/connectors/system.mjs'
import { ConnectorHub, REGISTRY } from '../server/connectors/index.mjs'

const GB = 1024 ** 3
const fakeSi = (over = {}) => ({
  currentLoad: async () => ({ currentLoad: 12.4 }),
  mem: async () => ({ total: 16 * GB, available: 12 * GB, free: 1 * GB }),
  fsSize: async () => [
    { fs: '/dev/a', mount: '/', size: 500 * GB, use: 40 },
    { fs: '/dev/a', mount: '/again', size: 500 * GB, use: 40 },
    { fs: 'tmpfs', mount: '/run', size: 0.2 * GB, use: 99 },
  ],
  graphics: async () => ({ controllers: [{ model: 'Integrated' }, { model: 'RTX', utilizationGpu: 35, memoryUsed: 2048, memoryTotal: 8192 }] }),
  processes: async () => ({ list: [{ name: 'idle', cpu: 0.1, mem: 0.1 }, { name: 'node', cpu: 55, mem: 3 }, { name: 'ffmpeg', cpu: 20, mem: 1 }, { name: 'bash', cpu: 1, mem: 0 }] }),
  ...over,
})
const poll = (si, env = {}) => createSystemConnector(async () => si).poll({ env, now: 1000 })
const by = (items) => Object.fromEntries(items.map((i) => [i.title, i]))

test('system connector is on only when listed', () => {
  const c = createSystemConnector(async () => fakeSi())
  assert.equal(c.enabled({}), false)
  assert.equal(c.enabled({ HOMEBASE_CONNECTORS: 'http, system' }), true)
})

test('reports CPU, memory, real disks, a GPU that reports load, and top processes', async () => {
  const items = by(await poll(fakeSi()))
  assert.deepEqual(Object.keys(items), ['CPU', 'Memory', 'Disk /', 'GPU RTX', 'Process node', 'Process ffmpeg', 'Process bash'])
  assert.equal(items.CPU.status, '12%')
  assert.equal(items.Memory.status, '25% of 16.0 GB')
  assert.equal(items['Disk /'].status, '40% of 500 GB')
  assert.equal(items['GPU RTX'].status, '35%, 25% VRAM')
  assert.equal(items['Process node'].status, '55% CPU, 3% RAM')
  assert.ok(Object.values(items).every((i) => i.needsAttention === false))
})

test('readings at or over the threshold need attention', async () => {
  const items = by(await poll(fakeSi({
    currentLoad: async () => ({ currentLoad: 97 }),
    mem: async () => ({ total: 16 * GB, available: 1 * GB }),
    fsSize: async () => [{ fs: '/dev/a', mount: '/', size: 500 * GB, use: 90 }],
  })))
  assert.equal(items.CPU.needsAttention, true)
  assert.equal(items.Memory.needsAttention, true)
  assert.equal(items['Disk /'].needsAttention, true)
  assert.equal(items['Process node'].needsAttention, false)
})

test('thresholds come from the environment', async () => {
  const items = by(await poll(fakeSi(), { SYSTEM_CPU_WARN: '10', SYSTEM_DISK_WARN: '95', SYSTEM_GPU_WARN: 'junk' }))
  assert.equal(items.CPU.needsAttention, true)
  assert.equal(items['Disk /'].needsAttention, false)
  assert.equal(items['GPU RTX'].needsAttention, false)
})

test('one failed reading does not cost the others, and none at all is an error', async () => {
  const boom = async () => { throw new Error('nope') }
  const items = by(await poll(fakeSi({ graphics: boom, processes: boom })))
  assert.deepEqual(Object.keys(items), ['CPU', 'Memory', 'Disk /'])
  await assert.rejects(poll(fakeSi({ currentLoad: boom, mem: boom, fsSize: boom, graphics: boom, processes: boom })), /no readings/)
})

test('the real connector reads this machine through the hub', async () => {
  const out = await new ConnectorHub({ registry: REGISTRY, env: { HOMEBASE_CONNECTORS: 'system' } }).poll()
  assert.equal(out.connectors[0].state, 'ok')
  assert.ok(out.items.some((i) => i.title === 'CPU'))
  assert.ok(out.items.some((i) => i.title === 'Memory'))
})
