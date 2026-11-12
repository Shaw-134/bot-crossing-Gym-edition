/**
 * The optional remote browser: a self-hosted, containerised browser (for example Neko,
 * https://github.com/m1k1o/neko) that the page shows in a frame. The browsing happens inside
 * the container, not on this machine.
 *
 * This project does not run, bundle or control that browser. It only reads the addresses you
 * configured and hands them to the page:
 *
 *   BROWSER_URL            a browser whose profile is kept, for signed-in sites
 *   BROWSER_THROWAWAY_URL  a browser with no stored profile, for links you do not trust
 *
 * Both unset (the default) means the feature is off and its button is not shown.
 * `docker-compose.browser.example.yml` runs one of each.
 */

/** An http(s) address, or null. Credentials in the address are refused, not passed on. */
export function frameUrl(value) {
  if (!value) return null
  try {
    const u = new URL(String(value).trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u.href
  } catch {
    return null
  }
}

export function browserConfig(env = process.env) {
  const persistent = frameUrl(env.BROWSER_URL)
  const throwaway = frameUrl(env.BROWSER_THROWAWAY_URL)
  return { enabled: Boolean(persistent || throwaway), persistent, throwaway }
}
