/**
 * Generic HTTP status checks, for anything that answers over HTTP on your own network: a
 * local agent system, a monitoring endpoint, a router page. Read-only GET requests.
 *
 * The list of checks lives in a local, gitignored JSON file (`data/http-checks.json`, or
 * `HTTP_CHECKS_FILE`). `http-checks.example.json` shows the format. Nothing about any
 * particular service is built in.
 *
 * Each check is one of:
 *   - status (default): 2xx (or `expectStatus`) is ok, anything else needs attention.
 *     With `json.statusPath`, the value at that path in the JSON reply is the status, and it
 *     is ok when it is one of `json.okValues`.
 *   - `"mode": "items"`: the service returns `{ "items": [...] }` (or a bare array) already
 *     in this project's item shape, and they are shown as they are.
 *
 * Secrets stay out of the file where possible: `"tokenEnv": "NAME"` sends the value of that
 * environment variable as a Bearer token.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataDir, enabledIds } from './lib.mjs'

const DEFAULT_OK = ['ok', 'up', 'healthy', 'pass', 'passing', 'running', 'true']
const MAX_CHECKS = 30
const MAX_ITEMS_PER_CHECK = 10

export const checksFile = (env = process.env) => env.HTTP_CHECKS_FILE || path.join(dataDir(env), 'http-checks.json')

/** `a.b.0.c` into an object. Undefined when any step is missing. */
function at(obj, dotted) {
  return String(dotted).split('.').reduce((v, key) => (v == null ? undefined : v[key]), obj)
}

async function runCheck(check, { env, now, fetch }) {
  const name = String(check.name || 'Unnamed check')
  const link = check.link || null
  const bad = (status) => [{ title: name, status, needsAttention: true, url: link, updatedAt: now }]

  const headers = { Accept: 'application/json, */*', ...(check.headers || {}) }
  if (check.tokenEnv) {
    const token = env[check.tokenEnv]
    if (!token) return bad(`${check.tokenEnv} is not set`)
    headers.Authorization = `Bearer ${token}`
  }

  let res
  try {
    res = await fetch(check.url, { method: 'GET', headers, signal: AbortSignal.timeout(Number(check.timeoutMs) || 5000) })
  } catch {
    return bad('unreachable')
  }

  const expected = check.expectStatus ? Number(check.expectStatus) === res.status : res.ok
  if (!expected) return bad(`HTTP ${res.status}`)

  if (check.mode === 'items') {
    let body
    try {
      body = await res.json()
    } catch {
      return bad('did not answer with JSON')
    }
    const list = Array.isArray(body) ? body : body?.items
    if (!Array.isArray(list)) return bad('answered without an items list')
    const items = list.slice(0, MAX_ITEMS_PER_CHECK).map((item) => ({ ...item, title: item?.title ? `${name}: ${item.title}` : '' }))
    return items.length ? items : [{ title: name, status: 'nothing to report', needsAttention: false, url: link, updatedAt: now }]
  }

  if (check.json?.statusPath) {
    let body
    try {
      body = await res.json()
    } catch {
      return bad('did not answer with JSON')
    }
    const value = at(body, check.json.statusPath)
    if (value === undefined) return bad(`no "${check.json.statusPath}" in the reply`)
    const ok = (check.json.okValues || DEFAULT_OK).map((v) => String(v).toLowerCase()).includes(String(value).toLowerCase())
    return [{ title: name, status: String(value), needsAttention: !ok, url: link, updatedAt: now }]
  }

  return [{ title: name, status: `HTTP ${res.status}`, needsAttention: false, url: link, updatedAt: now }]
}

export default {
  id: 'http',
  label: 'Services',
  intervalMs: 30_000,
  enabled: (env) => enabledIds(env).has('http') && fs.existsSync(checksFile(env)),

  async poll(ctx) {
    let config
    try {
      config = JSON.parse(await fsp.readFile(checksFile(ctx.env), 'utf8'))
    } catch {
      throw new Error('the checks file is not valid JSON')
    }
    const checks = (Array.isArray(config) ? config : config?.checks || []).filter((c) => c && c.url).slice(0, MAX_CHECKS)
    if (!checks.length) throw new Error('the checks file lists no checks')
    const results = await Promise.all(checks.map((c) => runCheck(c, ctx)))
    return results.flat()
  },
}
