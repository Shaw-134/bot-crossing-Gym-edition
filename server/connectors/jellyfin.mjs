/**
 * A Jellyfin server, read-only: whether it is up, what is playing, and what was added last.
 * Configured with `JELLYFIN_URL` and `JELLYFIN_API_KEY` in `.env`; the address and key are
 * yours and are never part of this repository.
 *
 * A server that cannot be reached, refuses the key, or is waiting on a restart needs attention.
 */
import { enabledIds, envNumber, fetchJson } from './lib.mjs'

const base = (env) => String(env.JELLYFIN_URL || '').replace(/\/+$/, '')

export default {
  id: 'jellyfin',
  label: 'Jellyfin',
  intervalMs: 30_000,
  enabled: (env) => enabledIds(env).has('jellyfin') && Boolean(base(env) && env.JELLYFIN_API_KEY),

  async poll({ env, now, fetch }) {
    const root = base(env)
    const headers = { Authorization: `MediaBrowser Token="${env.JELLYFIN_API_KEY}"`, Accept: 'application/json' }
    const get = (path) => fetchJson(fetch, `${root}${path}`, { headers })
    const max = Math.max(1, Math.min(20, envNumber(env, 'JELLYFIN_MAX_ITEMS', 5)))
    const web = `${root}/web/`

    // Health first. If this fails the rest would too, and "it is down" is the item to show.
    let info
    try {
      info = await get('/System/Info')
    } catch (err) {
      return [{ title: 'Jellyfin server', status: err.message, needsAttention: true, url: web, updatedAt: now }]
    }
    const notes = [`up, v${info.Version || '?'}`]
    if (info.HasPendingRestart) notes.push('restart pending')
    if (info.HasUpdateAvailable) notes.push('update available')
    const items = [
      {
        title: info.ServerName ? `Jellyfin ${info.ServerName}` : 'Jellyfin server',
        status: notes.join(', '),
        needsAttention: Boolean(info.HasPendingRestart),
        url: web,
        updatedAt: now,
      },
    ]

    const [sessions, latest] = await Promise.all([
      get('/Sessions?ActiveWithinSeconds=300').catch(() => null),
      get(`/Items?Recursive=true&IncludeItemTypes=Movie,Series&SortBy=DateCreated&SortOrder=Descending&Fields=DateCreated&Limit=${max}`).catch(() => null),
    ])

    for (const s of Array.isArray(sessions) ? sessions : []) {
      const playing = s.NowPlayingItem
      if (!playing) continue
      const name = playing.SeriesName ? `${playing.SeriesName}: ${playing.Name}` : playing.Name
      items.push({
        title: `${s.UserName || 'Someone'} · ${name}`,
        status: `${s.PlayState?.IsPaused ? 'paused' : 'playing'} on ${s.DeviceName || s.Client || 'a device'}`,
        needsAttention: false,
        url: web,
        updatedAt: Date.parse(s.LastActivityDate) || now,
      })
    }

    for (const it of latest?.Items || []) {
      items.push({
        title: it.Name,
        status: `added ${String(it.Type || 'item').toLowerCase()}`,
        needsAttention: false,
        url: `${web}#/details?id=${encodeURIComponent(it.Id)}`,
        updatedAt: Date.parse(it.DateCreated) || now,
      })
    }
    return items
  },
}
