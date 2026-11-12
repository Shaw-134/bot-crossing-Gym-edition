import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { browserConfig, frameUrl } from '../server/browser.mjs'

test('the remote browser is off by default', () => {
  assert.deepEqual(browserConfig({}), { enabled: false, persistent: null, throwaway: null })
})

test('either address turns it on, and each mode is independent', () => {
  assert.deepEqual(browserConfig({ BROWSER_URL: 'http://127.0.0.1:8081' }), { enabled: true, persistent: 'http://127.0.0.1:8081/', throwaway: null })
  const both = browserConfig({ BROWSER_URL: ' https://browser.example.com/x ', BROWSER_THROWAWAY_URL: 'http://127.0.0.1:8082' })
  assert.equal(both.persistent, 'https://browser.example.com/x')
  assert.equal(both.throwaway, 'http://127.0.0.1:8082/')
})

test('only plain http(s) addresses without credentials reach the page', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url', '', 'http://user:pass@browser.example.com/']) {
    assert.equal(frameUrl(bad), null, bad)
  }
  assert.deepEqual(browserConfig({ BROWSER_URL: 'javascript:alert(1)' }), { enabled: false, persistent: null, throwaway: null })
})

test('the example compose file binds to loopback only and carries no password', async () => {
  const text = await fsp.readFile(new URL('../docker-compose.browser.example.yml', import.meta.url), 'utf8')
  const ports = [...text.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]).filter((p) => /^\d|^127/.test(p))
  assert.equal(ports.length, 4)
  for (const p of ports) assert.ok(p.startsWith('127.0.0.1:'), `${p} is published beyond this machine`)
  for (const line of text.split('\n').filter((l) => /PASSWORD:/.test(l))) assert.match(line, /\$\{BROWSER_(USER|ADMIN)_PASSWORD:\?/)
})
