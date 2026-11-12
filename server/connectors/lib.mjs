/**
 * Shared pieces for connectors: the item shape every connector returns, and a fetch helper
 * whose errors never carry a URL, a query string or a header (any of which may hold a token).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Ids listed in `HOMEBASE_CONNECTORS`, e.g. `system,http`. Empty or unset means none. */
export function enabledIds(env = process.env) {
  return new Set(
    String(env.HOMEBASE_CONNECTORS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )
}

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Only http(s) links reach the page; anything else (file:, javascript:, garbage) is dropped. */
function safeUrl(value) {
  if (!value) return null
  try {
    const u = new URL(String(value))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * The one shape the page ever sees:
 * `{ source, title, status, needsAttention, url, updatedAt }`.
 * Returns null for an item with no title, so a connector cannot put an empty row on screen.
 */
export function normalizeItem(source, raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const title = clip(raw.title, 200)
  if (!title) return null
  const at = Number(raw.updatedAt)
  return {
    source: String(source),
    title,
    status: clip(raw.status, 120) || 'ok',
    needsAttention: raw.needsAttention === true,
    url: safeUrl(raw.url),
    updatedAt: Number.isFinite(at) && at > 0 ? at : now,
  }
}

/** A number from the environment, or the fallback when it is unset or not a number. */
export function envNumber(env, name, fallback) {
  const n = Number(env[name])
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(n) ? n : fallback
}

/**
 * GET (or other) JSON with a timeout. Failures are reported as `HTTP 401 from host` or
 * `could not reach host`: never the full URL, because a query string can carry a key.
 */
export async function fetchJson(fetchImpl, url, { headers = {}, timeoutMs = 8000, method = 'GET', body } = {}) {
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return 'the configured address'
    }
  })()
  let res
  try {
    res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw new Error(`could not reach ${host}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  try {
    return await res.json()
  } catch {
    throw new Error(`${host} did not answer with JSON`)
  }
}


/** The gitignored folder local state lives in: the same one `colony.json` uses. */
export function dataDir(env = process.env) {
  return env.BOT_CROSSING_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
}
