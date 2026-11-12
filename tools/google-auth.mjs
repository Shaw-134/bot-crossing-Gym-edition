/**
 * `npm run google-auth [email] [drive]` — sign in to Google for the mail and Drive
 * connectors. Runs the consent screen against a loopback address on this machine and stores
 * the refresh token in the gitignored data folder. With no arguments it asks for both.
 */
import '../server/lib/env.mjs'
import http from 'node:http'
import crypto from 'node:crypto'
import { SCOPES, buildAuthUrl, exchangeCode, googleConfig, pkcePair, saveToken } from '../server/connectors/google-auth.mjs'

const { clientId, clientSecret, tokenFile } = googleConfig()
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see .env.example).')
  process.exit(1)
}

const wanted = process.argv.slice(2).filter((a) => a in SCOPES)
const scopes = (wanted.length ? wanted : Object.keys(SCOPES)).map((k) => SCOPES[k])
const state = crypto.randomBytes(16).toString('hex')
const { verifier, challenge } = pkcePair()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const say = (code, text) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(text)
  }
  if (url.pathname !== '/') return say(404, 'Not found')
  if (url.searchParams.get('state') !== state) return say(400, 'State mismatch. Start again.')
  if (url.searchParams.get('error')) {
    say(400, 'Sign-in was cancelled.')
    console.error('Sign-in was cancelled.')
    return server.close()
  }
  try {
    const redirectUri = `http://127.0.0.1:${server.address().port}`
    const token = await exchangeCode({ clientId, clientSecret, code: url.searchParams.get('code'), redirectUri, verifier })
    await saveToken(tokenFile, token)
    say(200, 'Signed in. You can close this tab.')
    console.log(`Signed in. Token stored in ${tokenFile} (gitignored).`)
  } catch (err) {
    say(500, 'Sign-in failed. See the terminal.')
    console.error(err.message)
    process.exitCode = 1
  }
  server.close()
})

server.listen(0, '127.0.0.1', () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`
  console.log('Open this address in your browser to sign in (read-only access):\n')
  console.log(buildAuthUrl({ clientId, redirectUri, scopes, state, challenge }) + '\n')
})
