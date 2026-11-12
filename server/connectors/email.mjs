/**
 * Mail, through the Gmail API, read-only.
 *
 * Shows the inbox's unread count and the messages that are unread-and-important or starred.
 * Only the subject, sender and date of those messages are requested, and they are held in
 * memory for the panel: nothing about your mail is written to disk. The `gmail.metadata`
 * scope this uses cannot read a message body at all.
 *
 * Needs `email` in HOMEBASE_CONNECTORS and a Google sign-in (see google-auth.mjs).
 */
import { enabledIds, envNumber, fetchJson } from './lib.mjs'
import { SCOPES, accessToken, hasGoogleConfig } from './google-auth.mjs'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const WEB = 'https://mail.google.com/mail/u/0/#inbox'

const header = (message, name) =>
  (message?.payload?.headers || []).find((h) => String(h.name).toLowerCase() === name)?.value || ''

/** `"Ada Lovelace" <ada@example.com>` → `Ada Lovelace`; a bare address stays as it is. */
function senderName(from) {
  const name = String(from).replace(/<[^>]*>/g, '').replace(/"/g, '').trim()
  return name || String(from).replace(/[<>]/g, '').trim() || 'unknown sender'
}

export default {
  id: 'email',
  label: 'Mail',
  intervalMs: 60_000,
  enabled: (env) => enabledIds(env).has('email') && hasGoogleConfig(env),

  async poll({ env, now, fetch }) {
    const token = await accessToken({ env, fetch, now, scope: SCOPES.email })
    const get = (path) => fetchJson(fetch, `${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    const max = Math.max(1, Math.min(20, envNumber(env, 'EMAIL_MAX_ITEMS', 5)))
    const unreadWarn = envNumber(env, 'EMAIL_UNREAD_WARN', Infinity)

    const [inbox, important, starred] = await Promise.all([
      get('/labels/INBOX'),
      get(`/messages?labelIds=INBOX&labelIds=IMPORTANT&labelIds=UNREAD&maxResults=${max}`),
      get(`/messages?labelIds=STARRED&maxResults=${max}`),
    ])

    const unread = Number(inbox.messagesUnread) || 0
    const items = [
      { title: 'Inbox', status: `${unread} unread`, needsAttention: unread >= unreadWarn, url: WEB, updatedAt: now },
    ]

    const ids = [...new Set([...(important.messages || []), ...(starred.messages || [])].map((m) => m.id))]
    const messages = await Promise.all(
      ids.map((id) =>
        get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`).catch(() => null)
      )
    )
    for (const m of messages) {
      if (!m) continue
      const labels = new Set(m.labelIds || [])
      const isUnread = labels.has('UNREAD')
      const kind = labels.has('STARRED') ? 'starred' : 'important'
      items.push({
        title: header(m, 'subject') || '(no subject)',
        status: `${kind}, from ${senderName(header(m, 'from'))}`,
        // Unread and marked is the mail equivalent of an astronaut waiting on you.
        needsAttention: isUnread,
        url: m.threadId ? `${WEB}/${encodeURIComponent(m.threadId)}` : WEB,
        updatedAt: Number(m.internalDate) || now,
      })
    }
    return items
  },
}
