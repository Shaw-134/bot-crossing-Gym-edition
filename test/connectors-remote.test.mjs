/**
 * Mail, Drive, Jellyfin and the generic HTTP connector, against canned responses.
 * No request leaves the machine: every one goes through the `fetch` handed in here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import email from '../server/connectors/email.mjs'
import drive from '../server/connectors/drive.mjs'
import jellyfin from '../server/connectors/jellyfin.mjs'
import httpChecks from '../server/connectors/http.mjs'
import { SCOPES, accessToken, buildAuthUrl, exchangeCode, hasGoogleConfig, pkcePair, saveToken } from '../server/connectors/google-auth.mjs'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/** A fetch that answers from a list of `[matcher, reply]` and records every call. */
function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    for (const [match, reply] of routes) {
      if (typeof match === 'string' ? String(url).includes(match) : match.test(String(url))) {
        const out = typeof reply === 'function' ? reply(String(url), init) : reply
        if (out instanceof Error) throw out
        return out
      }
    }
    return json({ error: 'no route' }, 404)
  }
  fn.calls = calls
  return fn
}

async function googleEnv(scope = `${SCOPES.email} ${SCOPES.drive}`, extra = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'homebase-google-'))
  const env = { BOT_CROSSING_DATA: dir, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', ...extra }
  await saveToken(path.join(dir, 'google-token.json'), { refresh_token: 'test-refresh', scope, obtained_at: Math.random() })
  return env
}
const TOKEN_ROUTE = ['oauth2.googleapis.com/token', json({ access_token: 'test-access', expires_in: 3600 })]

// ── Google sign-in ─────────────────────────────────────────────────────────────────

test('the consent URL asks only for the read-only scopes, with PKCE and offline access', () => {
  const { verifier, challenge } = pkcePair()
  assert.notEqual(verifier, challenge)
  const u = new URL(buildAuthUrl({ clientId: 'id', redirectUri: 'http://127.0.0.1:5555', scopes: Object.values(SCOPES), state: 's', challenge }))
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/drive.metadata.readonly')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('access_type'), 'offline')
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555')
})

test('exchangeCode keeps only the refresh token and scope; the file is owner-only', async () => {
  const fetch = fakeFetch([['oauth2.googleapis.com/token', json({ access_token: 'a', refresh_token: 'r', scope: SCOPES.email, id_token: 'x' })]])
  const token = await exchangeCode({ fetch, clientId: 'id', clientSecret: 'sec', code: 'c', redirectUri: 'http://127.0.0.1:1', verifier: 'v', now: 5 })
  assert.deepEqual(token, { refresh_token: 'r', scope: SCOPES.email, obtained_at: 5 })
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'homebase-token-')), 'nested', 't.json')
  await saveToken(file, token)
  if (process.platform !== 'win32') assert.equal((await fsp.stat(file)).mode & 0o777, 0o600)
})

test('accessToken refreshes once, then answers from memory until it is about to lapse', async () => {
  const env = await googleEnv()
  const fetch = fakeFetch([TOKEN_ROUTE])
  assert.equal(await accessToken({ env, fetch, now: NOW, scope: SCOPES.email }), 'test-access')
  await accessToken({ env, fetch, now: NOW + 60_000, scope: SCOPES.drive })
  assert.equal(fetch.calls.length, 1)
  await accessToken({ env, fetch, now: NOW + 3600_000, scope: SCOPES.email })
  assert.equal(fetch.calls.length, 2)
})

test('accessToken says what to do when not signed in, under-scoped or expired', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'homebase-none-'))
  const bare = { BOT_CROSSING_DATA: dir, GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's' }
  assert.equal(hasGoogleConfig(bare), false)
  await assert.rejects(accessToken({ env: bare, fetch: fakeFetch([]), scope: SCOPES.email }), /not signed in/)

  const driveOnly = await googleEnv(SCOPES.drive)
  assert.equal(hasGoogleConfig(driveOnly), true)
  await assert.rejects(accessToken({ env: driveOnly, fetch: fakeFetch([TOKEN_ROUTE]), scope: SCOPES.email }), /not granted/)

  const expired = await googleEnv()
  const fetch = fakeFetch([['oauth2.googleapis.com/token', json({ error: 'invalid_grant' }, 400)]])
  await assert.rejects(accessToken({ env: expired, fetch, scope: SCOPES.email }), (err) => {
    assert.match(err.message, /expired/)
    assert.doesNotMatch(err.message, /test-secret|test-refresh/)
    return true
  })
})

// ── Mail ───────────────────────────────────────────────────────────────────────────

const message = (id, subject, from, labelIds) => json({
  id, threadId: `t-${id}`, labelIds, internalDate: String(NOW - 1000),
  snippet: 'BODY TEXT THAT MUST NOT BE SHOWN',
  payload: { headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }] },
})

test('mail is off unless listed and signed in', async () => {
  const env = await googleEnv()
  assert.equal(email.enabled(env), false)
  assert.equal(email.enabled({ ...env, HOMEBASE_CONNECTORS: 'email' }), true)
  assert.equal(email.enabled({ HOMEBASE_CONNECTORS: 'email', BOT_CROSSING_DATA: os.tmpdir() }), false)
})

test('mail reports the unread count and the important or starred messages, without bodies', async () => {
  const env = await googleEnv()
  const fetch = fakeFetch([
    TOKEN_ROUTE,
    ['/labels/INBOX', json({ messagesUnread: 7 })],
    ['labelIds=IMPORTANT', json({ messages: [{ id: 'm1' }, { id: 'm2' }] })],
    ['labelIds=STARRED', json({ messages: [{ id: 'm2' }, { id: 'm3' }] })],
    ['/messages/m1', message('m1', 'Invoice due', '"Ada Lovelace" <ada@example.com>', ['INBOX', 'IMPORTANT', 'UNREAD'])],
    ['/messages/m2', message('m2', 'Contract', 'grace@example.com', ['INBOX', 'IMPORTANT', 'UNREAD', 'STARRED'])],
    ['/messages/m3', message('m3', '', 'Old <old@example.com>', ['STARRED'])],
  ])
  const items = await email.poll({ env, now: NOW, fetch })

  assert.deepEqual(items.map((i) => [i.title, i.status, i.needsAttention]), [
    ['Inbox', '7 unread', false],
    ['Invoice due', 'important, from Ada Lovelace', true],
    ['Contract', 'starred, from grace@example.com', true],
    ['(no subject)', 'starred, from Old', false],
  ])
  assert.equal(items[1].url, 'https://mail.google.com/mail/u/0/#inbox/t-m1')
  assert.equal(items[1].updatedAt, NOW - 1000)
  assert.doesNotMatch(JSON.stringify(items), /BODY TEXT/)

  const gmail = fetch.calls.filter((c) => c.url.includes('gmail.googleapis.com'))
  assert.equal(gmail.length, 6, 'each message is fetched once even when it is in both lists')
  assert.ok(gmail.every((c) => c.init.method === 'GET' && c.init.headers.Authorization === 'Bearer test-access'))
  assert.ok(gmail.filter((c) => c.url.includes('/messages/')).every((c) => c.url.includes('format=metadata')), 'bodies are never requested')
})

test('mail can flag a large unread count, and passes on an API refusal without the token', async () => {
  const env = await googleEnv(undefined, { EMAIL_UNREAD_WARN: '5' })
  const ok = fakeFetch([TOKEN_ROUTE, ['/labels/INBOX', json({ messagesUnread: 7 })], ['/messages', json({})]])
  assert.equal((await email.poll({ env, now: NOW, fetch: ok }))[0].needsAttention, true)

  const denied = fakeFetch([TOKEN_ROUTE, ['gmail.googleapis.com', json({}, 403)]])
  await assert.rejects(email.poll({ env, now: NOW, fetch: denied }), { message: 'HTTP 403 from gmail.googleapis.com' })
})

// ── Drive ──────────────────────────────────────────────────────────────────────────

test('drive lists files shared with you and recently changed, flagging fresh shares', async () => {
  const env = await googleEnv()
  const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
  const fetch = fakeFetch([
    TOKEN_ROUTE,
    [/q=sharedWithMe/, json({ files: [
      { id: 'a', name: 'Budget', webViewLink: 'https://docs.google.com/a', sharedWithMeTime: iso(3600_000), sharingUser: { displayName: 'Ada' } },
      { id: 'b', name: 'Old deck', webViewLink: 'https://docs.google.com/b', sharedWithMeTime: iso(72 * 3600_000) },
    ] })],
    ['drive/v3/files', json({ files: [
      { id: 'a', name: 'Budget', modifiedTime: iso(10) },
      { id: 'c', name: 'Notes', webViewLink: 'https://docs.google.com/c', modifiedTime: iso(120_000), lastModifyingUser: { displayName: 'Me' } },
    ] })],
  ])
  const items = await drive.poll({ env, now: NOW, fetch })
  assert.deepEqual(items.map((i) => [i.title, i.status, i.needsAttention]), [
    ['Budget', 'shared by Ada', true],
    ['Old deck', 'shared by someone', false],
    ['Notes', 'changed by Me', false],
  ])
  assert.equal(items[2].updatedAt, NOW - 120_000)

  const calls = fetch.calls.filter((c) => c.url.includes('drive/v3'))
  assert.equal(calls.length, 2)
  for (const c of calls) {
    assert.equal(c.init.method, 'GET')
    assert.ok(!new URL(c.url).searchParams.get('fields').includes('content'), 'only metadata fields are asked for')
  }
  assert.equal(drive.enabled({ ...env, HOMEBASE_CONNECTORS: 'drive' }), true)
  assert.equal(drive.enabled(env), false)
})

// ── Jellyfin ───────────────────────────────────────────────────────────────────────

const JF = { HOMEBASE_CONNECTORS: 'jellyfin', JELLYFIN_URL: 'http://media.example.com:8096/', JELLYFIN_API_KEY: 'test-key' }

test('jellyfin needs both an address and a key', () => {
  assert.equal(jellyfin.enabled(JF), true)
  assert.equal(jellyfin.enabled({ ...JF, JELLYFIN_API_KEY: '' }), false)
  assert.equal(jellyfin.enabled({ ...JF, HOMEBASE_CONNECTORS: '' }), false)
})

test('jellyfin reports health, active streams and recent additions', async () => {
  const fetch = fakeFetch([
    ['/System/Info', json({ ServerName: 'den', Version: '10.10.3', HasPendingRestart: false })],
    ['/Sessions', json([
      { UserName: 'sam', DeviceName: 'TV', PlayState: { IsPaused: false }, NowPlayingItem: { Name: 'Pilot', SeriesName: 'Show' } },
      { UserName: 'idle', DeviceName: 'Phone' },
    ])],
    ['/Items', json({ Items: [{ Id: 'x1', Name: 'A Film', Type: 'Movie', DateCreated: '2026-11-11T10:00:00Z' }] })],
  ])
  const items = await jellyfin.poll({ env: JF, now: NOW, fetch })
  assert.deepEqual(items.map((i) => [i.title, i.status, i.needsAttention]), [
    ['Jellyfin den', 'up, v10.10.3', false],
    ['sam · Show: Pilot', 'playing on TV', false],
    ['A Film', 'added movie', false],
  ])
  assert.equal(items[2].url, 'http://media.example.com:8096/web/#/details?id=x1')
  assert.ok(fetch.calls.every((c) => c.url.startsWith('http://media.example.com:8096/') && !c.url.includes('test-key')), 'the key travels in a header, never in the address')
  assert.ok(fetch.calls.every((c) => c.init.headers.Authorization === 'MediaBrowser Token="test-key"'))
})

test('jellyfin down, refusing the key, or awaiting a restart needs attention', async () => {
  const down = await jellyfin.poll({ env: JF, now: NOW, fetch: fakeFetch([['/System/Info', new Error('ECONNREFUSED')]]) })
  assert.deepEqual([down.length, down[0].status, down[0].needsAttention], [1, 'could not reach media.example.com:8096', true])

  const denied = await jellyfin.poll({ env: JF, now: NOW, fetch: fakeFetch([['/System/Info', json({}, 401)]]) })
  assert.equal(denied[0].status, 'HTTP 401 from media.example.com:8096')

  const restart = await jellyfin.poll({ env: JF, now: NOW, fetch: fakeFetch([['/System/Info', json({ Version: '10', HasPendingRestart: true })], ['/Sessions', json({}, 500)]]) })
  assert.deepEqual([restart.length, restart[0].status, restart[0].needsAttention], [1, 'up, v10, restart pending', true])
})

// ── Generic HTTP checks ────────────────────────────────────────────────────────────

async function checksEnv(checks, extra = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'homebase-http-'))
  await fsp.writeFile(path.join(dir, 'http-checks.json'), typeof checks === 'string' ? checks : JSON.stringify({ checks }))
  return { HOMEBASE_CONNECTORS: 'http', BOT_CROSSING_DATA: dir, ...extra }
}

test('http checks are off without a checks file', async () => {
  assert.equal(httpChecks.enabled({ HOMEBASE_CONNECTORS: 'http', BOT_CROSSING_DATA: path.join(os.tmpdir(), 'homebase-nope') }), false)
  assert.equal(httpChecks.enabled(await checksEnv([])), true)
})

test('status codes and JSON status values map to items', async () => {
  const env = await checksEnv([
    { name: 'Up', url: 'http://a.example.com/health', link: 'http://a.example.com/' },
    { name: 'Down', url: 'http://b.example.com/health' },
    { name: 'Gone', url: 'http://c.example.com/health' },
    { name: 'Teapot', url: 'http://d.example.com/', expectStatus: 418 },
    { name: 'Healthy', url: 'http://e.example.com/', json: { statusPath: 'checks.0.state' } },
    { name: 'Degraded', url: 'http://f.example.com/', json: { statusPath: 'status', okValues: ['green'] } },
    { name: 'Odd', url: 'http://g.example.com/', json: { statusPath: 'missing.path' } },
  ])
  const fetch = fakeFetch([
    ['a.example.com', json({})],
    ['b.example.com', json({}, 503)],
    ['c.example.com', new Error('ENOTFOUND')],
    ['d.example.com', json({}, 418)],
    ['e.example.com', json({ checks: [{ state: 'Healthy' }] })],
    ['f.example.com', json({ status: 'yellow' })],
    ['g.example.com', json({ status: 'ok' })],
  ])
  const items = await httpChecks.poll({ env, now: NOW, fetch })
  assert.deepEqual(items.map((i) => [i.title, i.status, i.needsAttention]), [
    ['Up', 'HTTP 200', false],
    ['Down', 'HTTP 503', true],
    ['Gone', 'unreachable', true],
    ['Teapot', 'HTTP 418', false],
    ['Healthy', 'Healthy', false],
    ['Degraded', 'yellow', true],
    ['Odd', 'no "missing.path" in the reply', true],
  ])
  assert.equal(items[0].url, 'http://a.example.com/')
  assert.equal(items[1].url, null, 'the checked address is not shown unless a link is given')
  assert.ok(fetch.calls.every((c) => c.init.method === 'GET'))
})

test('items mode passes a service’s own items through, and tokenEnv sends a bearer token', async () => {
  const env = await checksEnv(
    [{ name: 'Agents', url: 'http://agents.example.com/attention', mode: 'items', tokenEnv: 'EXAMPLE_AGENT_TOKEN' }],
    { EXAMPLE_AGENT_TOKEN: 'test-token' }
  )
  const fetch = fakeFetch([['agents.example.com', json({ items: [{ title: 'Job 12', status: 'waiting for approval', needsAttention: true, url: 'http://agents.example.com/jobs/12' }, { status: 'untitled' }] })]])
  const items = await httpChecks.poll({ env, now: NOW, fetch })
  assert.equal(items[0].title, 'Agents: Job 12')
  assert.equal(items[0].needsAttention, true)
  assert.equal(items[1].title, '', 'an untitled item is left for the registry to drop')
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer test-token')

  const unset = await httpChecks.poll({ env: { ...env, EXAMPLE_AGENT_TOKEN: '' }, now: NOW, fetch })
  assert.deepEqual([unset[0].status, unset[0].needsAttention], ['EXAMPLE_AGENT_TOKEN is not set', true])
  assert.equal(fetch.calls.length, 1, 'no request is made without the token')
})

test('a broken or empty checks file is an error, not a crash', async () => {
  await assert.rejects(httpChecks.poll({ env: await checksEnv('{nope'), now: NOW, fetch: fakeFetch([]) }), /not valid JSON/)
  await assert.rejects(httpChecks.poll({ env: await checksEnv([]), now: NOW, fetch: fakeFetch([]) }), /no checks/)
})

test('the committed example checks file is valid and uses example addresses only', async () => {
  const example = JSON.parse(await fsp.readFile(new URL('../http-checks.example.json', import.meta.url), 'utf8'))
  assert.ok(example.checks.length > 0)
  for (const c of example.checks) assert.match(new URL(c.url).hostname, /\.example\.com$/)
})
