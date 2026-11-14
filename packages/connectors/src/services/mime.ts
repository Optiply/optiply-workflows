import { randomBytes } from 'node:crypto'
import { ConnectorError } from '../types'

// Mail as MIME (M37, Gmail): an RFC 5322 message built from a query's fields (Gmail's API sends what it's given,
// base64url as `raw`), and a Gmail message's payload tree read back into headers, bodies and attachments.

export interface MailAttachment {
  bytes: Buffer
  filename: string
  contentType: string
}

export interface Mail {
  from?: string | undefined
  to: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string | undefined
  subject?: string | undefined
  text?: string | undefined
  html?: string | undefined
  attachments?: MailAttachment[]
  /** Replying: the Message-ID answered, and the thread's References. */
  inReplyTo?: string | undefined
  references?: string | undefined
}

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+$/

/** `Name <a@b>` or `a@b`, checked; the name encoded when it isn't plain ASCII. A line break anywhere is refused. */
export function formatAddress(value: string, field: string): string {
  const v = value.trim()
  if (/[\r\n]/.test(v)) throw new ConnectorError('invalid_query', `${field} can't hold a line break`)
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(v)
  const email = (m ? m[2]! : v).trim()
  if (!ADDRESS.test(email))
    throw new ConnectorError('invalid_query', `${field}: "${email}" isn't an email address`)
  const name = m?.[1]?.trim().replace(/^"(.*)"$/, '$1')
  if (!name) return email
  if (/^[\x20-\x7e]*$/.test(name)) {
    return /^[\w .!#$%&'*+/=?^`{|}~-]*$/.test(name)
      ? `${name} <${email}>`
      : `"${name.replace(/["\\]/g, '\\$&')}" <${email}>`
  }
  return `${encodeWords(name)} <${email}>`
}

/** RFC 2047 encoded words (UTF-8, base64), split so each stays within 75 characters and no character is cut. */
export function encodeWords(text: string): string {
  const words: string[] = []
  let chunk = ''
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ')
}

function headerText(value: string, field: string): string {
  if (/[\r\n]/.test(value)) throw new ConnectorError('invalid_query', `${field} can't hold a line break`)
  return /^[\x20-\x7e]*$/.test(value) ? value : encodeWords(value)
}

function base64Lines(bytes: Buffer): string {
  return (bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
}

function boundary(): string {
  return `ow_${randomBytes(12).toString('hex')}`
}

function textPart(type: 'plain' | 'html', body: string): string {
  return [
    `Content-Type: text/${type}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(body, 'utf8')),
  ].join('\r\n')
}

function multipart(kind: 'mixed' | 'alternative', parts: string[]): string {
  const b = boundary()
  return [
    `Content-Type: multipart/${kind}; boundary="${b}"`,
    '',
    ...parts.flatMap((p) => [`--${b}`, p]),
    `--${b}--`,
    '',
  ].join('\r\n')
}

function attachmentPart(a: MailAttachment): string {
  const ascii = /^[\x20-\x7e]*$/.test(a.filename)
  const plain = a.filename.replace(/["\\\r\n]/g, '_')
  const name = ascii
    ? `filename="${plain}"`
    : `filename="${plain.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`
  if (/[\r\n]/.test(a.contentType) || !/^[\w.+-]+\/[\w.+-]+$/.test(a.contentType)) {
    throw new ConnectorError('invalid_query', `"${a.contentType}" isn't a content type`)
  }
  return [
    `Content-Type: ${a.contentType}; name="${plain.replace(/[^\x20-\x7e]/g, '_')}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; ${name}`,
    '',
    base64Lines(a.bytes),
  ].join('\r\n')
}

/** The message as RFC 5322 text: headers, then a text and/or HTML body, attachments in a mixed part. */
export function buildMime(mail: Mail): string {
  const headers: string[] = ['MIME-Version: 1.0']
  if (mail.from) headers.push(`From: ${formatAddress(mail.from, 'From')}`)
  const list = (values: string[] | undefined, field: string) =>
    values?.length ? [`${field}: ${values.map((v) => formatAddress(v, field)).join(', ')}`] : []
  headers.push(...list(mail.to, 'To'), ...list(mail.cc, 'Cc'), ...list(mail.bcc, 'Bcc'))
  if (!mail.to.length && !mail.cc?.length && !mail.bcc?.length) {
    throw new ConnectorError('invalid_query', 'To is empty')
  }
  if (mail.replyTo) headers.push(`Reply-To: ${formatAddress(mail.replyTo, 'Reply to')}`)
  headers.push(`Subject: ${headerText(mail.subject ?? '', 'Subject')}`)
  for (const [field, value] of [
    ['In-Reply-To', mail.inReplyTo],
    ['References', mail.references ?? mail.inReplyTo],
  ] as const) {
    if (!value) continue
    if (/[\r\n]/.test(value)) throw new ConnectorError('invalid_query', `${field} can't hold a line break`)
    headers.push(`${field}: ${value}`)
  }
  const bodies = [
    ...(mail.text !== undefined ? [textPart('plain', mail.text)] : []),
    ...(mail.html !== undefined ? [textPart('html', mail.html)] : []),
  ]
  const body = bodies.length > 1 ? multipart('alternative', bodies) : (bodies[0] ?? textPart('plain', ''))
  const content = mail.attachments?.length
    ? multipart('mixed', [body, ...mail.attachments.map(attachmentPart)])
    : body
  return `${headers.join('\r\n')}\r\n${content}`
}

/** Base64url without padding, as Gmail takes `raw`. */
export function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

// Reading Gmail's `format=full` messages.

export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { attachmentId?: string; size?: number; data?: string }
  parts?: GmailPart[]
}

export interface ReadMessage {
  headers: Record<string, string>
  text: string | null
  html: string | null
  attachments: {
    attachmentId: string | null
    filename: string
    mimeType: string
    size: number
    partId: string | null
  }[]
}

const WANTED = [
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
]

/** Headers worth showing (lower-cased names, the first of each), the first text and HTML bodies, the attachments. */
export function readPayload(payload: GmailPart | undefined): ReadMessage {
  const out: ReadMessage = { headers: {}, text: null, html: null, attachments: [] }
  for (const h of payload?.headers ?? []) {
    const name = h.name.toLowerCase()
    if (WANTED.includes(name) && !(name in out.headers)) out.headers[name] = decodeWords(h.value)
  }
  const walk = (part: GmailPart) => {
    const disposition = part.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? ''
    if (part.filename || /^attachment/i.test(disposition)) {
      out.attachments.push({
        attachmentId: part.body?.attachmentId ?? null,
        filename: part.filename || 'attachment',
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body?.size ?? 0,
        partId: part.partId ?? null,
      })
      return
    }
    if (part.parts?.length) {
      for (const p of part.parts) walk(p)
      return
    }
    const data = part.body?.data
    if (!data) return
    const charset = /charset="?([\w-]+)/i.exec(
      part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '',
    )?.[1]
    const text = Buffer.from(data, 'base64url').toString(
      /^(iso-8859-1|latin1|windows-1252)$/i.test(charset ?? '') ? 'latin1' : 'utf8',
    )
    if (part.mimeType === 'text/plain' && out.text === null) out.text = text
    else if (part.mimeType === 'text/html' && out.html === null) out.html = text
  }
  if (payload) walk(payload)
  return out
}

/** RFC 2047 encoded words back to text (Gmail mostly decodes them already). */
export function decodeWords(value: string): string {
  return value.replace(
    /=\?([\w-]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g,
    (_all, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
                  String.fromCharCode(Number.parseInt(h, 16)),
                ),
              'latin1',
            )
      return bytes.toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1')
    },
  )
}
