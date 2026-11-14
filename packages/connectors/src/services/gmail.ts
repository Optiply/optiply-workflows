import { z } from 'zod'
import {
  GOOGLE_TOKEN_URL,
  type GoogleTokens,
  isServiceAccountKey,
  parseServiceAccountKey,
  type ServiceAccountKey,
  serviceAccountTokens,
} from '../google-auth'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { oauthPresets } from '../oauth-presets'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from '../types'
import {
  type ActionQuery,
  actionQuerySchema,
  answer,
  apiCall,
  call,
  fieldReader,
  fileOf,
  limitOf,
  type ServiceCall,
  segment,
  serviceBase,
  serviceRestConfig,
  validateActionQuery,
} from './common'
import { base64url, buildMime, type GmailPart, type Mail, readPayload } from './mime'

// Gmail (M37, docs/architecture.md §2.41): a mailbox through Google sign-in (M9's Google preset; shared or per
// person), or any mailbox of a Google Workspace domain through a service account with domain-wide delegation (its
// JWT's `sub`; admins only). Messages sent as MIME (`mime.ts`), read back decoded.

/** Read, label, draft and send (everything but deleting for good). */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

/** This process's Gmail settings, set once by the server (tests: Google's token endpoint). */
export interface GmailDefaults {
  tokenUrl?: string
}

let defaults: GmailDefaults = {}

export function configureGmail(next: GmailDefaults): void {
  defaults = next
}

const configSchema = z.object({
  auth: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('oauth'),
        clientId: z.string().trim().default(''),
        scope: z.string().default(`openid email ${GMAIL_SCOPE}`),
        tokens: z.enum(['shared', 'perUser']).default('shared'),
      }),
      z.object({
        type: z.literal('delegation'),
        /** The mailbox queries act as unless they name another (`support@optiply.nl`). */
        mailbox: z.preprocess(
          (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
          z.string().trim().email().optional(),
        ),
      }),
    ])
    .default({ type: 'oauth', clientId: '', scope: `openid email ${GMAIL_SCOPE}`, tokens: 'shared' }),
})
type Config = z.output<typeof configSchema>

const secretsSchema = z.object({
  serviceAccountKey: z
    .string()
    .min(1)
    .refine(isServiceAccountKey, 'Paste the JSON key file of a service account')
    .optional(),
  clientSecret: z.string().optional(),
})
type Secrets = z.output<typeof secretsSchema>

const querySchema = actionQuerySchema('gmail')

function httpConfig(config: Config) {
  const google = oauthPresets.google
  return serviceRestConfig(
    serviceBase('gmail', 'https://gmail.googleapis.com/gmail/v1'),
    config.auth.type === 'oauth' && config.auth.clientId
      ? {
          type: 'oauth2AuthorizationCode',
          provider: 'google',
          authorizeUrl: google.authorizeUrl,
          tokenUrl: google.tokenUrl,
          revokeUrl: google.revokeUrl,
          clientId: config.auth.clientId,
          scope: config.auth.scope,
          authorizeParams: google.authorizeParams,
          clientAuth: google.clientAuth,
          pkce: google.pkce,
          tokens: config.auth.tokens,
        }
      : { type: 'none' },
  )
}

export interface GmailClient {
  http: HttpClient
  config: Config
  /** Delegation: the service account's key, and its tokens per mailbox acted as. */
  key?: ServiceAccountKey
  tokens: Map<string, GoogleTokens>
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

/** The mailbox a query acts as: its own, the resource's default (delegation), or the signed-in account (`me`). */
function mailboxOf(client: GmailClient, given: string | undefined): string {
  if (client.config.auth.type === 'oauth') return given ?? 'me'
  const mailbox = given ?? client.config.auth.mailbox
  if (!mailbox) {
    throw new ConnectorError(
      'invalid_query',
      'Name the mailbox to act as (or set a default one on the resource)',
    )
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(mailbox)) {
    throw new ConnectorError('invalid_query', `"${mailbox}" isn't a mailbox (an email address)`)
  }
  return mailbox
}

/** A call to the mailbox's API (one retry with a fresh token on 401); Google's errors as connector errors. */
async function gmail(
  client: GmailClient,
  mailbox: string,
  request: ServiceCall,
  ctx: Ctx,
): Promise<HttpResponse> {
  const key = client.key
  let tokens: GoogleTokens | undefined
  if (key) {
    tokens = client.tokens.get(mailbox)
    if (!tokens) {
      tokens = serviceAccountTokens(key, {
        scope: GMAIL_SCOPE,
        field: 'serviceAccountKey',
        subject: mailbox,
        tokenUrl: defaults.tokenUrl ?? GOOGLE_TOKEN_URL,
        dispatcher: client.http.agent,
      })
      client.tokens.set(mailbox, tokens)
    }
  }
  const path = `/users/${segment(mailbox)}${request.path}`
  const send = async (force: boolean) =>
    call(
      client.http,
      tokens
        ? { ...request, path, authorization: `Bearer ${await tokens.token(ctx.signal, force)}` }
        : { ...request, path },
      ctx,
    )
  let res = await send(false)
  if (res.status === 401 && tokens) res = await send(true)
  if (res.ok) return res
  const error = (res.data as { error?: { message?: string; status?: string } } | null)?.error
  let message = `Gmail: ${error?.message ?? `HTTP ${res.status}`}`
  if (res.status === 400 && /precondition/i.test(error?.message ?? '') && key) {
    message += ` (does ${mailbox} have Gmail, in the delegated domain?)`
  }
  throw new ConnectorError('http', message, {
    status: res.status,
    ...(error?.status && { reason: error.status }),
  })
}

interface GmailMessage {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailPart
}

/** A message as a workflow wants it: ids, labels, the main headers, the bodies decoded, its attachments listed. */
function messageView(m: GmailMessage) {
  const read = readPayload(m.payload)
  return {
    id: m.id,
    threadId: m.threadId ?? null,
    labelIds: m.labelIds ?? [],
    snippet: m.snippet ?? '',
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    from: read.headers.from ?? null,
    to: read.headers.to ?? null,
    cc: read.headers.cc ?? null,
    subject: read.headers.subject ?? null,
    messageId: read.headers['message-id'] ?? null,
    headers: read.headers,
    text: read.text,
    html: read.html,
    attachments: read.attachments,
  }
}

/** A search result row: the headers Gmail's metadata format gives, no bodies. */
function summaryView(m: GmailMessage) {
  const read = readPayload(m.payload)
  return {
    id: m.id,
    threadId: m.threadId ?? null,
    labelIds: m.labelIds ?? [],
    snippet: m.snippet ?? '',
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    from: read.headers.from ?? null,
    to: read.headers.to ?? null,
    subject: read.headers.subject ?? null,
  }
}

type Fields = ReturnType<typeof fieldReader>

/** The mail a send or a draft makes; replying to a message fills its thread, In-Reply-To, References and Re:. */
async function mailOf(client: GmailClient, mailbox: string, f: Fields, ctx: Ctx) {
  const replyTo = await f.text('replyToMessage')
  let reply: { threadId?: string; inReplyTo?: string; references?: string; subject?: string; from?: string } =
    {}
  if (replyTo) {
    const res = await gmail(
      client,
      mailbox,
      {
        method: 'GET',
        path: `/messages/${segment(replyTo)}`,
        query: { format: 'metadata' },
        pairs: ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'].map((h) => ['metadataHeaders', h]),
      },
      ctx,
    )
    const original = res.data as GmailMessage
    const h = readPayload(original.payload).headers
    const id = h['message-id']
    reply = {
      ...(original.threadId && { threadId: original.threadId }),
      ...(id && { inReplyTo: id, references: [h.references, id].filter(Boolean).join(' ') }),
      ...(h.subject && { subject: /^re:/i.test(h.subject) ? h.subject : `Re: ${h.subject}` }),
      ...((h['reply-to'] ?? h.from) && { from: h['reply-to'] ?? h.from }),
    }
  }
  const to = await f.list('to')
  const attachments = await attachmentsOf(await f.value('attachments'))
  const mail: Mail = {
    from: await f.text('from'),
    to: to.length ? to : reply.from ? [reply.from] : [],
    cc: await f.list('cc'),
    bcc: await f.list('bcc'),
    replyTo: await f.text('replyTo'),
    subject: (await f.text('subject')) ?? reply.subject,
    text: await f.text('text'),
    html: await f.text('html'),
    attachments,
    inReplyTo: reply.inReplyTo,
    references: reply.references,
  }
  const threadId = (await f.text('threadId')) ?? reply.threadId
  return { raw: base64url(buildMime(mail)), ...(threadId && { threadId }) }
}

/** Attachments from a file object, a list of them, or base64 text. */
async function attachmentsOf(value: unknown) {
  if (value === undefined || value === null || value === '') return []
  const items = Array.isArray(value) ? value : [value]
  return items.map((item, i) => {
    const file = fileOf(item, items.length > 1 ? `Attachment ${i + 1}` : 'Attachments')
    return {
      bytes: file.bytes,
      filename: file.filename ?? `attachment-${i + 1}`,
      contentType: file.contentType ?? 'application/octet-stream',
    }
  })
}

/** Gmail's system labels, whose ids are their names. */
const SYSTEM_LABELS = new Set([
  'INBOX',
  'SPAM',
  'TRASH',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'SENT',
  'DRAFT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
])

/** Label names to ids (system labels such as UNREAD are ids already); one listing only when a name needs it. */
async function labelIds(client: GmailClient, mailbox: string, names: string[], ctx: Ctx): Promise<string[]> {
  // A user's label named in capitals ("VIP") is a name, not a system id.
  const plain = (n: string) => SYSTEM_LABELS.has(n) || /^Label_\w+$/.test(n)
  if (names.every(plain)) return names
  const res = await gmail(client, mailbox, { method: 'GET', path: '/labels' }, ctx)
  const labels = ((res.data as { labels?: { id: string; name: string }[] }).labels ?? []).map((l) => ({
    id: l.id,
    name: l.name.toLowerCase(),
  }))
  return names.map((n) => {
    if (plain(n)) return n
    const found = labels.find((l) => l.name === n.toLowerCase())
    if (!found) throw new ConnectorError('invalid_query', `No label "${n}" in ${mailbox}`)
    return found.id
  })
}

/** Runs `fn` over `items`, `limit` at a time, keeping their order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export const gmailConnector: Connector<Config, Secrets, ActionQuery, GmailClient> = {
  type: 'gmail',
  label: 'Gmail',
  configSchema,
  secretsSchema,
  querySchema,
  scrubResultData: true,

  createClient({ config, secrets }) {
    const http = createHttpClient(httpConfig(config), {
      headers: {},
      values: {},
      ...(secrets.clientSecret && { clientSecret: secrets.clientSecret }),
    })
    if (config.auth.type === 'oauth') return { http, config, tokens: new Map() }
    if (!secrets.serviceAccountKey) {
      throw new ConnectorError('invalid_config', 'Add the service account key (serviceAccountKey)')
    }
    return {
      http,
      config,
      key: parseServiceAccountKey(secrets.serviceAccountKey, 'serviceAccountKey'),
      tokens: new Map(),
    }
  },

  destroyClient: (client) => destroyHttpClient(client.http),

  httpConfig,

  async testConnection(client, ctx) {
    const mailbox = mailboxOf(client, undefined)
    const res = await gmail(client, mailbox, { method: 'GET', path: '/profile' }, ctx)
    const profile = res.data as { emailAddress?: string; messagesTotal?: number }
    return {
      message: `Gmail: ${profile.emailAddress ?? mailbox}, ${profile.messagesTotal ?? '?'} messages${client.key ? ` (as ${client.key.client_email}, delegated)` : ''}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('gmail', query, ctx)
    const mailbox = mailboxOf(client, await f.text('mailbox'))
    const send = (request: ServiceCall) => gmail(client, mailbox, request, ctx)
    switch (query.action) {
      case 'send': {
        const res = await send({
          method: 'POST',
          path: '/messages/send',
          json: await mailOf(client, mailbox, f, ctx),
        })
        return answer(res.data, res, { mailbox })
      }
      case 'createDraft': {
        const res = await send({
          method: 'POST',
          path: '/drafts',
          json: { message: await mailOf(client, mailbox, f, ctx) },
        })
        return answer(res.data, res, { mailbox })
      }
      case 'search': {
        const max = limitOf(await f.number('max'), 500, 50)
        const labels = await f.list('labels')
        const ids = labels.length ? await labelIds(client, mailbox, labels, ctx) : []
        const includeSpamTrash = (await f.bool('includeSpamTrash')) ?? false
        const q = await f.text('q')
        const found: { id: string; threadId: string }[] = []
        let pageToken: string | undefined
        let estimate: number | undefined
        let last: HttpResponse | undefined
        do {
          const res = await send({
            method: 'GET',
            path: '/messages',
            query: {
              ...(q && { q }),
              maxResults: Math.min(500, max - found.length),
              includeSpamTrash,
              ...(pageToken && { pageToken }),
            },
            pairs: ids.map((id) => ['labelIds', id]),
          })
          last = res
          const page = res.data as {
            messages?: { id: string; threadId: string }[]
            nextPageToken?: string
            resultSizeEstimate?: number
          }
          found.push(...(page.messages ?? []))
          estimate ??= page.resultSizeEstimate
          pageToken = page.nextPageToken
        } while (pageToken && found.length < max)
        const list = found.slice(0, max)
        const truncated = Boolean(pageToken)
        if ((await f.bool('details')) === false)
          return answer(list, last!, { mailbox, truncated, resultSizeEstimate: estimate ?? null })
        const rows = await mapLimited(list, 5, async (m) => {
          const res = await send({
            method: 'GET',
            path: `/messages/${segment(m.id)}`,
            query: { format: 'metadata' },
            pairs: ['From', 'To', 'Subject', 'Date'].map((h) => ['metadataHeaders', h]),
          })
          return summaryView(res.data as GmailMessage)
        })
        return answer(rows, last!, { mailbox, truncated, resultSizeEstimate: estimate ?? null })
      }
      case 'getMessage': {
        const res = await send({
          method: 'GET',
          path: `/messages/${segment(await f.required('id'))}`,
          query: { format: 'full' },
        })
        return answer(messageView(res.data as GmailMessage), res, { mailbox })
      }
      case 'getThread': {
        const res = await send({
          method: 'GET',
          path: `/threads/${segment(await f.required('id'))}`,
          query: { format: 'full' },
        })
        const thread = res.data as { id: string; messages?: GmailMessage[] }
        return answer({ id: thread.id, messages: (thread.messages ?? []).map(messageView) }, res, { mailbox })
      }
      case 'getAttachment': {
        const messageId = await f.required('messageId')
        const res = await send({
          method: 'GET',
          path: `/messages/${segment(messageId)}/attachments/${segment(await f.required('attachmentId'))}`,
        })
        const body = res.data as { data?: string; size?: number }
        const filename = await f.text('filename')
        const contentType = await f.text('contentType')
        // A file object: Slack's upload, SendGrid's attachments and Gmail's own take it as is.
        return answer(
          {
            base64: Buffer.from(body.data ?? '', 'base64url').toString('base64'),
            size: body.size ?? 0,
            ...(filename && { filename }),
            ...(contentType && { contentType }),
          },
          res,
          { mailbox },
        )
      }
      case 'modifyLabels': {
        const add = await labelIds(client, mailbox, await f.list('add'), ctx)
        const remove = await labelIds(client, mailbox, await f.list('remove'), ctx)
        if (!add.length && !remove.length)
          throw new ConnectorError('invalid_query', 'Give labels to add or remove')
        const res = await send({
          method: 'POST',
          path: `/messages/${segment(await f.required('id'))}/modify`,
          json: { addLabelIds: add, removeLabelIds: remove },
        })
        return answer(res.data, res, { mailbox })
      }
      case 'trash': {
        const res = await send({ method: 'POST', path: `/messages/${segment(await f.required('id'))}/trash` })
        return answer(res.data, res, { mailbox })
      }
      case 'listLabels': {
        const res = await send({ method: 'GET', path: '/labels' })
        return answer((res.data as { labels?: unknown[] }).labels ?? [], res, { mailbox })
      }
      case 'api': {
        const request = await apiCall(f, '/', `gmail/v1/users/${mailbox}`)
        const res = await send(request)
        return answer(res.data, res, { mailbox })
      }
    }
    throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
  },
}
