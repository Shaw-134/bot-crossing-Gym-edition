/**
 * The connector registry.
 *
 * A connector is an optional, read-only source of things worth a look that are not agent
 * threads: the machine's own load, a mailbox, a media server. Every one is off by default.
 * It is loaded only when its id is listed in `HOMEBASE_CONNECTORS`, so a connector that is
 * not enabled costs nothing and its module is never imported.
 *
 * The interface is three members:
 *
 *   id          a short lowercase name, also the name used in `HOMEBASE_CONNECTORS`
 *   enabled(env)  true when the settings it needs are present
 *   poll(ctx)   resolves to an array of raw items; `ctx` is `{ env, now, fetch }`
 *
 * Optional: `label` (shown in the panel) and `intervalMs` (how often it may be polled;
 * polls inside the interval are answered from memory).
 *
 * Items are normalised to `{ source, title, status, needsAttention, url, updatedAt }` here,
 * so a connector cannot hand the page anything else. Nothing a connector returns is written
 * to disk.
 */
import { enabledIds, normalizeItem } from './lib.mjs'

/** id → loader. Adding a connector is one module in this folder and one line here. */
export const REGISTRY = [
  { id: 'system', load: () => import('./system.mjs') },
]

const DEFAULT_INTERVAL_MS = 15_000
const POLL_TIMEOUT_MS = 20_000
const MAX_ITEMS_PER_CONNECTOR = 50

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const reason = (err) => String(err?.message || err || 'failed').slice(0, 200)

/**
 * Loads and polls the connectors that are switched on. One instance lives for the life of
 * the server; tests build their own with a registry and environment of their choosing.
 */
export class ConnectorHub {
  constructor({ registry = REGISTRY, env = process.env, fetch: fetchImpl = globalThis.fetch, timeoutMs = POLL_TIMEOUT_MS } = {}) {
    this.registry = registry
    this.env = env
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this._loaded = null
    this._cache = new Map()
  }

  /** Import the listed connectors once. A listed id with no connector is reported, not thrown. */
  async load() {
    if (this._loaded) return this._loaded
    const wanted = enabledIds(this.env)
    const known = new Set(this.registry.map((entry) => entry.id))
    const loaded = []
    for (const entry of this.registry) {
      if (!wanted.has(entry.id)) continue
      try {
        const mod = await entry.load()
        const connector = mod?.default ?? mod
        if (!connector || typeof connector.poll !== 'function' || typeof connector.enabled !== 'function') {
          throw new Error('does not implement the connector interface')
        }
        loaded.push({ id: entry.id, connector, error: null })
      } catch (err) {
        loaded.push({ id: entry.id, connector: null, error: reason(err) })
      }
    }
    for (const id of wanted) {
      if (!known.has(id)) loaded.push({ id, connector: null, error: 'no connector with this id' })
    }
    this._loaded = loaded
    return loaded
  }

  /**
   * Poll every enabled connector. One failing or hanging connector never takes the others
   * down: its error is reported beside its name and the rest still answer.
   */
  async poll(now = Date.now()) {
    const loaded = await this.load()
    const results = await Promise.all(loaded.map((entry) => this._pollOne(entry, now)))
    return {
      polledAt: now,
      connectors: results.map((r) => r.status),
      items: results.flatMap((r) => r.items),
    }
  }

  async _pollOne({ id, connector, error }, now) {
    const label = connector?.label || id
    const fail = (message, state = 'error') => ({ status: { id, label, state, error: message, count: 0 }, items: [] })
    if (!connector) return fail(error)

    let configured = false
    try {
      configured = (await connector.enabled(this.env)) === true
    } catch (err) {
      return fail(reason(err))
    }
    if (!configured) return fail('listed in HOMEBASE_CONNECTORS but its settings are missing', 'unconfigured')

    const interval = connector.intervalMs ?? DEFAULT_INTERVAL_MS
    const cached = this._cache.get(id)
    if (cached && now - cached.at < interval) return cached.result

    let result
    try {
      const raw = await withTimeout(Promise.resolve(connector.poll({ env: this.env, now, fetch: this.fetch })), this.timeoutMs)
      const items = (Array.isArray(raw) ? raw : [])
        .map((item) => normalizeItem(id, item, now))
        .filter(Boolean)
        .slice(0, MAX_ITEMS_PER_CONNECTOR)
      result = { status: { id, label, state: 'ok', error: null, count: items.length }, items }
    } catch (err) {
      result = fail(reason(err))
    }
    this._cache.set(id, { at: now, result })
    return result
  }
}

let hub = null
/** The server's own hub, built on first use so that `.env` has been read by then. */
export function connectorHub() {
  hub ??= new ConnectorHub()
  return hub
}
