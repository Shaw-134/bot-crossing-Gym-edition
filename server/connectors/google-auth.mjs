/**
 * Google sign-in for the mail and Drive connectors, kept entirely on this machine.
 *
 * You bring your own OAuth client (a "Desktop app" client in your own Google Cloud project):
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. `npm run google-auth` then runs
 * the consent screen against a loopback address and stores the refresh token in
 * `data/google-token.json`, which is gitignored. Access tokens are held in memory only.
 *
 * Scopes are the narrowest that do the job, and both are read-only:
 *   mail   gmail.metadata           labels and headers; message bodies cannot be read at all
 *   Drive  drive.metadata.readonly  names and dates; file contents cannot be read at all
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataDir } from './lib.mjs'

export const SCOPES = {
  email: 'https://www.googleapis.com/auth/gmail.metadata',
  drive: 'https://www.googleapis.com/auth/drive.metadata.readonly',
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const RERUN = 'run `npm run google-auth`'

export function googleConfig(env = process.env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    tokenFile: env.GOOGLE_TOKEN_FILE || path.join(dataDir(env), 'google-token.json'),
  }
}

/** True when a client is configured and a token has been stored for it. */
export function hasGoogleConfig(env = process.env) {
  const { clientId, clientSecret, tokenFile } = googleConfig(env)
  return Boolean(clientId && clientSecret) && fs.existsSync(tokenFile)
}

/** PKCE verifier and its S256 challenge. */
export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function buildAuthUrl({ clientId, redirectUri, scopes, state, challenge }) {
  const u = new URL(AUTH_URL)
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString()
  return u.href
}

async function tokenRequest(fetchImpl, params) {
  let res
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('could not reach Google to sign in')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // `invalid_grant` is an expired or revoked refresh token. The error code is safe to show;
    // the request (which held the client secret) is not echoed.
    throw new Error(body.error === 'invalid_grant' ? `Google sign-in has expired; ${RERUN} again` : `Google refused the sign-in (${body.error || res.status})`)
  }
  return body
}

/** Trade the code from the consent screen for tokens. Returns what is stored on disk. */
export async function exchangeCode({ fetch: fetchImpl = globalThis.fetch, clientId, clientSecret, code, redirectUri, verifier, now = Date.now() }) {
  const body = await tokenRequest(fetchImpl, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  if (!body.refresh_token) throw new Error('Google did not return a refresh token')
  return { refresh_token: body.refresh_token, scope: body.scope || '', obtained_at: now }
}

/** Written readable by the owner only. The folder is gitignored. */
export async function saveToken(tokenFile, token) {
  await fsp.mkdir(path.dirname(tokenFile), { recursive: true })
  await fsp.writeFile(tokenFile, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 })
  await fsp.chmod(tokenFile, 0o600).catch(() => {})
}

const cache = new Map()

/**
 * A current access token for `scope`, refreshed when it is about to lapse. Held in memory
 * and never written anywhere.
 */
export async function accessToken({ env = process.env, fetch: fetchImpl = globalThis.fetch, now = Date.now(), scope }) {
  const { clientId, clientSecret, tokenFile } = googleConfig(env)
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set')

  let stored
  try {
    stored = JSON.parse(await fsp.readFile(tokenFile, 'utf8'))
  } catch {
    throw new Error(`not signed in to Google; ${RERUN}`)
  }
  if (!stored.refresh_token) throw new Error(`the stored Google token is incomplete; ${RERUN} again`)
  if (scope && !String(stored.scope || '').split(/\s+/).includes(scope)) {
    throw new Error(`Google access for this connector was not granted; ${RERUN} again`)
  }

  const key = `${tokenFile}|${stored.obtained_at}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt - 60_000 > now) return hit.token

  const body = await tokenRequest(fetchImpl, {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: stored.refresh_token,
  })
  if (!body.access_token) throw new Error('Google returned no access token')
  cache.set(key, { token: body.access_token, expiresAt: now + (Number(body.expires_in) || 3600) * 1000 })
  return body.access_token
}
