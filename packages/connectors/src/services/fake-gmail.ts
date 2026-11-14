import type { Handler } from './fake'
import type { GmailPart } from './mime'

// A fake of Gmail's API (M37) under `/gmail/gmail/v1/users/<mailbox>`, part of `startFakeServices`: mailboxes with
// messages, threads, labels and attachments; tokens are the fake Google token endpoint's (a service account acting as
// one mailbox through `sub`) or OAuth ones the test hands it. Sending keeps the raw MIME.

export interface FakeGmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  snippet: string
  internalDate: string
  payload: GmailPart
  /** Attachment bytes by attachment id (base64url). */
  attachments: Record<string, string>
  /** What was sent, decoded (sent and drafted messages). */
  raw?: string
}

export interface FakeGmailMailbox {
  messages: Map<string, FakeGmailMessage>
  labels: { id: string; name: string; type: 'system' | 'user' }[]
}

export interface FakeGmail {
  /** Tokens accepted, with the mailbox each acts as. */
  acceptTokens: Map<string, string>
  mailboxes: Map<string, FakeGmailMailbox>
  /** Every send and draft, with the mailbox and its decoded MIME. */
  sent: { mailbox: string; kind: 'send' | 'draft'; raw: string; threadId: string | null }[]
  /** Adds a message to a mailbox (made if new); returns its id. */
  seed(mailbox: string, message: SeedMessage): string
}

export interface SeedMessage {
  id?: string
  threadId?: string
  from: string
  to: string
  subject: string
  text?: string
  html?: string
  messageId?: string
  labels?: string[]
  date?: string
  attachments?: { filename: string; mimeType: string; content: string }[]
}

const SYSTEM_LABELS = ['INBOX', 'SENT', 'UNREAD', 'STARRED', 'TRASH', 'SPAM', 'DRAFT', 'IMPORTANT']

export function fakeGmail(opts: { trust?: (token: string) => string | null } = {}): {
  state: FakeGmail
  handler: Handler
} {
  let ids = 0
  const mailboxes = new Map<string, FakeGmailMailbox>()
  const mailboxOf = (email: string) => {
    let box = mailboxes.get(email)
    if (!box) {
      box = {
        messages: new Map(),
        labels: [
          ...SYSTEM_LABELS.map((id) => ({ id, name: id, type: 'system' as const })),
          { id: 'Label_1', name: 'Orders', type: 'user' as const },
        ],
      }
      mailboxes.set(email, box)
    }
    return box
  }
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

  const state: FakeGmail = {
    acceptTokens: new Map(),
    mailboxes,
    sent: [],
    seed(mailbox, m) {
      const id = m.id ?? `msg${++ids}`
      const headers = [
        { name: 'From', value: m.from },
        { name: 'To', value: m.to },
        { name: 'Subject', value: m.subject },
        { name: 'Date', value: m.date ?? 'Fri, 13 Nov 2026 10:00:00 +0000' },
        { name: 'Message-ID', value: m.messageId ?? `<${id}@mail.example.com>` },
      ]
      const bodies: GmailPart[] = [
        ...(m.text !== undefined
          ? [
              {
                partId: '0.0',
                mimeType: 'text/plain',
                filename: '',
                headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
                body: { size: m.text.length, data: b64(m.text) },
              },
            ]
          : []),
        ...(m.html !== undefined
          ? [
              {
                partId: '0.1',
                mimeType: 'text/html',
                filename: '',
                headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
                body: { size: m.html.length, data: b64(m.html) },
              },
            ]
          : []),
      ]
      const attachments: Record<string, string> = {}
      const files: GmailPart[] = (m.attachments ?? []).map((a, i) => {
        const aid = `att-${id}-${i}`
        attachments[aid] = b64(a.content)
        return {
          partId: String(i + 1),
          mimeType: a.mimeType,
          filename: a.filename,
          headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.filename}"` }],
          body: { attachmentId: aid, size: a.content.length },
        }
      })
      const alternative: GmailPart = {
        partId: '0',
        mimeType: 'multipart/alternative',
        filename: '',
        body: { size: 0 },
        parts: bodies,
      }
      mailboxOf(mailbox).messages.set(id, {
        id,
        threadId: m.threadId ?? id,
        labelIds: m.labels ?? ['INBOX', 'UNREAD'],
        snippet: (m.text ?? m.html ?? '').slice(0, 100),
        internalDate: String(Date.parse('2026-11-13T10:00:00Z') + ids * 1000),
        payload: {
          partId: '',
          mimeType: 'multipart/mixed',
          filename: '',
          headers,
          body: { size: 0 },
          parts: [alternative, ...files],
        },
        attachments,
      })
      return id
    },
  }

  const fail = (status: number, message: string, reason: string) => ({
    status,
    json: { error: { code: status, message, status: reason } },
  })

  /** A message as Gmail shows it in a format: `metadata` keeps only the asked headers and no parts. */
  const shown = (m: FakeGmailMessage, format: string, wanted: string[]) => {
    const base = {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds,
      snippet: m.snippet,
      internalDate: m.internalDate,
    }
    if (format === 'minimal') return base
    if (format === 'metadata') {
      const keep = wanted.map((h) => h.toLowerCase())
      return {
        ...base,
        payload: {
          mimeType: m.payload.mimeType,
          headers: (m.payload.headers ?? []).filter(
            (h) => !keep.length || keep.includes(h.name.toLowerCase()),
          ),
        },
      }
    }
    return { ...base, payload: m.payload, sizeEstimate: 1000 }
  }

  /** Gmail's search, a little: `from:`, `subject:`, `is:unread`, `label:`, and words in the subject or snippet. */
  const matches = (m: FakeGmailMessage, q: string) =>
    q
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => {
        const header = (name: string) =>
          (m.payload.headers ?? []).find((h) => h.name.toLowerCase() === name)?.value.toLowerCase() ?? ''
        const [key, value] = term.includes(':') ? (term.split(/:(.*)/) as [string, string]) : ['', term]
        const v = value.toLowerCase()
        if (key === 'from') return header('from').includes(v)
        if (key === 'subject') return header('subject').includes(v)
        if (key === 'is' && v === 'unread') return m.labelIds.includes('UNREAD')
        if (key === 'label') return m.labelIds.some((l) => l.toLowerCase() === v)
        if (key) return true
        return header('subject').includes(v) || m.snippet.toLowerCase().includes(v)
      })

  /** The decoded MIME's headers, to make a sent message readable in the mailbox. */
  const sentMessage = (raw: string, threadId: string | null, labels: string[]): FakeGmailMessage => {
    const id = `msg${++ids}`
    const head = raw.split(/\r\n\r\n/)[0] ?? ''
    const headers = head
      .replace(/\r\n\s+/g, ' ')
      .split('\r\n')
      .flatMap((line) => {
        const m = /^([\w-]+):\s*(.*)$/.exec(line)
        return m ? [{ name: m[1]!, value: m[2]! }] : []
      })
    return {
      id,
      threadId: threadId ?? id,
      labelIds: labels,
      snippet: '',
      internalDate: String(Date.now()),
      payload: { partId: '', mimeType: 'message/rfc822', filename: '', headers, body: { size: raw.length } },
      attachments: {},
      raw,
    }
  }

  const handler: Handler = async (req, url, body) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const owner = state.acceptTokens.get(token) ?? opts.trust?.(token) ?? null
    if (!owner) return fail(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED')
    const m = /^\/gmail\/gmail\/v1\/users\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!m) return fail(404, 'Not found', 'NOT_FOUND')
    const user = decodeURIComponent(m[1]!)
    if (user !== 'me' && user.toLowerCase() !== owner.toLowerCase()) {
      return fail(403, 'Delegation denied for ' + owner, 'PERMISSION_DENIED')
    }
    const box = mailboxOf(owner)
    const path = m[2] ?? ''
    const json = body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : {}
    const format = url.searchParams.get('format') ?? 'full'
    const message = (id: string) => box.messages.get(id)

    if (path === '/profile') {
      return {
        status: 200,
        json: {
          emailAddress: owner,
          messagesTotal: box.messages.size,
          threadsTotal: box.messages.size,
          historyId: '1',
        },
      }
    }
    if (path === '/labels' && req.method === 'GET') return { status: 200, json: { labels: box.labels } }
    if (path === '/messages' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const labelIds = url.searchParams.getAll('labelIds')
      const spam = url.searchParams.get('includeSpamTrash') === 'true'
      const all = [...box.messages.values()]
        .filter((x) => spam || !x.labelIds.some((l) => l === 'SPAM' || l === 'TRASH'))
        .filter((x) => labelIds.every((l) => x.labelIds.includes(l)))
        .filter((x) => matches(x, q))
        .reverse()
      const start = Number(url.searchParams.get('pageToken') ?? '0')
      const size = Math.min(500, Number(url.searchParams.get('maxResults') ?? '100'))
      const page = all.slice(start, start + size)
      return {
        status: 200,
        json: {
          ...(page.length && { messages: page.map((x) => ({ id: x.id, threadId: x.threadId })) }),
          ...(start + size < all.length && { nextPageToken: String(start + size) }),
          resultSizeEstimate: all.length,
        },
      }
    }
    if ((path === '/messages/send' || path === '/drafts') && req.method === 'POST') {
      const draft = path === '/drafts'
      const source = (draft ? (json.message as Record<string, unknown>) : json) ?? {}
      const raw = Buffer.from(String(source.raw ?? ''), 'base64url').toString('utf8')
      const threadId = typeof source.threadId === 'string' ? source.threadId : null
      if (!/^(To|Cc|Bcc):/m.test(raw)) return fail(400, 'Invalid To header', 'INVALID_ARGUMENT')
      state.sent.push({ mailbox: owner, kind: draft ? 'draft' : 'send', raw, threadId })
      const sent = sentMessage(raw, threadId, draft ? ['DRAFT'] : ['SENT'])
      box.messages.set(sent.id, sent)
      const shownSent = { id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds }
      return { status: 200, json: draft ? { id: `r-${sent.id}`, message: shownSent } : shownSent }
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path)
    if (thread && req.method === 'GET') {
      const messages = [...box.messages.values()].filter((x) => x.threadId === thread[1])
      if (!messages.length) return fail(404, 'Requested entity was not found.', 'NOT_FOUND')
      return { status: 200, json: { id: thread[1], messages: messages.map((x) => shown(x, format, [])) } }
    }
    const att = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path)
    if (att) {
      const data = message(att[1]!)?.attachments[att[2]!]
      if (!data) return fail(404, 'Requested entity was not found.', 'NOT_FOUND')
      return { status: 200, json: { size: Buffer.from(data, 'base64url').length, data } }
    }
    const one = /^\/messages\/([^/]+)(\/modify|\/trash)?$/.exec(path)
    if (one) {
      const found = message(one[1]!)
      if (!found) return fail(404, 'Requested entity was not found.', 'NOT_FOUND')
      if (one[2] === '/modify' && req.method === 'POST') {
        const known = new Set(box.labels.map((l) => l.id))
        const add = (json.addLabelIds as string[] | undefined) ?? []
        const remove = (json.removeLabelIds as string[] | undefined) ?? []
        const unknown = [...add, ...remove].find((l) => !known.has(l))
        if (unknown) return fail(400, `Invalid label: ${unknown}`, 'INVALID_ARGUMENT')
        found.labelIds = [...new Set([...found.labelIds.filter((l) => !remove.includes(l)), ...add])]
        return { status: 200, json: shown(found, 'minimal', []) }
      }
      if (one[2] === '/trash' && req.method === 'POST') {
        found.labelIds = [...found.labelIds.filter((l) => l !== 'INBOX'), 'TRASH']
        return { status: 200, json: shown(found, 'minimal', []) }
      }
      if (!one[2] && req.method === 'GET') {
        return { status: 200, json: shown(found, format, url.searchParams.getAll('metadataHeaders')) }
      }
    }
    return fail(404, 'Not found', 'NOT_FOUND')
  }
  return { state, handler }
}
