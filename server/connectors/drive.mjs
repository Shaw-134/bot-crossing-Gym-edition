/**
 * Google Drive, read-only: files recently shared with you and files recently changed.
 * Only names, dates and who touched them are requested (`drive.metadata.readonly`, which
 * cannot read a file's contents), and nothing is written to disk.
 *
 * A file shared with you inside the last `DRIVE_SHARED_ATTENTION_HOURS` (default 24) needs
 * attention. Needs `drive` in HOMEBASE_CONNECTORS and a Google sign-in (see google-auth.mjs).
 */
import { enabledIds, envNumber, fetchJson } from './lib.mjs'
import { SCOPES, accessToken, hasGoogleConfig } from './google-auth.mjs'

const API = 'https://www.googleapis.com/drive/v3/files'
const FIELDS = 'files(id,name,modifiedTime,webViewLink,sharedWithMeTime,sharingUser/displayName,lastModifyingUser/displayName)'

const listUrl = (q, orderBy, pageSize) =>
  `${API}?${new URLSearchParams({ q, orderBy, pageSize: String(pageSize), fields: FIELDS, spaces: 'drive' })}`

export default {
  id: 'drive',
  label: 'Drive',
  intervalMs: 120_000,
  enabled: (env) => enabledIds(env).has('drive') && hasGoogleConfig(env),

  async poll({ env, now, fetch }) {
    const token = await accessToken({ env, fetch, now, scope: SCOPES.drive })
    const get = (url) => fetchJson(fetch, url, { headers: { Authorization: `Bearer ${token}` } })
    const max = Math.max(1, Math.min(20, envNumber(env, 'DRIVE_MAX_ITEMS', 5)))
    const freshMs = envNumber(env, 'DRIVE_SHARED_ATTENTION_HOURS', 24) * 3600_000

    const [shared, recent] = await Promise.all([
      get(listUrl('sharedWithMe = true and trashed = false', 'sharedWithMeTime desc', max)),
      get(listUrl('trashed = false', 'modifiedTime desc', max)),
    ])

    const items = []
    const seen = new Set()
    for (const f of shared.files || []) {
      seen.add(f.id)
      const at = Date.parse(f.sharedWithMeTime) || now
      items.push({
        title: f.name,
        status: `shared by ${f.sharingUser?.displayName || 'someone'}`,
        needsAttention: now - at <= freshMs,
        url: f.webViewLink,
        updatedAt: at,
      })
    }
    for (const f of recent.files || []) {
      if (seen.has(f.id)) continue
      items.push({
        title: f.name,
        status: `changed by ${f.lastModifyingUser?.displayName || 'someone'}`,
        needsAttention: false,
        url: f.webViewLink,
        updatedAt: Date.parse(f.modifiedTime) || now,
      })
    }
    return items
  },
}
