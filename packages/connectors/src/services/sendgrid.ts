import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { responseMetadata } from '../rest'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from '../types'
import {
  type ActionQuery,
  actionQuerySchema,
  call,
  fieldReader,
  fileOf,
  type ServiceCall,
  type ServiceSecrets,
  serviceBase,
  serviceRestConfig,
  serviceRestSecrets,
  serviceSecretsSchema,
  validateActionQuery,
} from './common'

// SendGrid (M27): an API key; Mail Send with text, HTML or a dynamic template, and any /v3 endpoint. `eu` is the
// EU-pinned API host (for EU subusers), whose keys work only there.

const configSchema = z.object({ region: z.enum(['global', 'eu']).default('global') })
type Config = z.output<typeof configSchema>

function httpConfig(config: Config) {
  const base =
    config.region === 'eu'
      ? serviceBase('sendgridEu', 'https://api.eu.sendgrid.com')
      : serviceBase('sendgrid', 'https://api.sendgrid.com')
  return serviceRestConfig(base, { type: 'bearer' })
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

async function sendgrid(client: HttpClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  const res = await call(client, request, ctx)
  if (res.ok) return res
  const errors = (res.data as { errors?: { message?: string; field?: string | null }[] } | null)?.errors
  const first = errors?.[0]
  const message = first?.message
    ? `${first.message}${first.field ? ` (${first.field})` : ''}`
    : typeof res.data === 'string' && res.data
      ? res.data.slice(0, 300)
      : `HTTP ${res.status}`
  throw new ConnectorError('http', `SendGrid: ${message}`, { status: res.status, ...(errors && { errors }) })
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/

/** `Name <email>` or a bare address. */
function address(text: string, field: string): { email: string; name?: string } {
  const named = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(text)
  const email = (named ? named[2]! : text).trim()
  if (!EMAIL.test(email))
    throw new ConnectorError('invalid_query', `${field}: "${text}" isn't an email address`)
  const name = named?.[1]?.trim()
  return name ? { email, name } : { email }
}

/** Seconds since 1970, from a number or a date. */
function sendAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(n)) return Math.floor(n)
  const at = Date.parse(String(value))
  if (Number.isNaN(at)) throw new ConnectorError('invalid_query', `Send at: "${String(value)}" isn't a date`)
  return Math.floor(at / 1000)
}

export const sendgridConnector: Connector<Config, ServiceSecrets, ActionQuery, HttpClient> = {
  type: 'sendgrid',
  label: 'SendGrid',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema: actionQuerySchema('sendgrid'),
  scrubResultData: true,

  createClient({ config, secrets }) {
    if (!secrets.token) throw new ConnectorError('invalid_config', 'Add the SendGrid API key (SG.…)')
    return createHttpClient(httpConfig(config), serviceRestSecrets(secrets))
  },

  destroyClient: destroyHttpClient,

  async testConnection(client, ctx) {
    const res = await sendgrid(client, { method: 'GET', path: '/v3/scopes' }, ctx)
    const scopes = ((res.data as { scopes?: string[] }).scopes ?? []).filter((s) => typeof s === 'string')
    return {
      message: `SendGrid key with ${scopes.length} scopes${scopes.includes('mail.send') ? '' : ' (no mail.send: it can’t send email)'}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('sendgrid', query, ctx)
    if (query.action === 'api') {
      const path = await f.required('path')
      if (!path.startsWith('/v3/') || path.includes('..')) {
        throw new ConnectorError('invalid_query', 'The path starts with /v3/ and stays under the API')
      }
      const params = await f.object('query')
      const body = await f.json('body')
      const res = await sendgrid(
        client,
        {
          method: (await f.text('method')) ?? 'GET',
          path,
          ...(params && {
            query: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
          }),
          ...(body !== undefined && { json: body }),
        },
        ctx,
      )
      return { data: res.data, metadata: responseMetadata(res) }
    }
    if (query.action !== 'send') throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)

    const to = (await f.list('to')).map((a) => address(a, 'To'))
    if (to.length === 0) throw new ConnectorError('invalid_query', 'To is empty')
    const cc = (await f.list('cc')).map((a) => address(a, 'Cc'))
    const bcc = (await f.list('bcc')).map((a) => address(a, 'Bcc'))
    const templateId = await f.text('templateId')
    const templateData = await f.object('templateData')
    const text = await f.text('text')
    const html = await f.text('html')
    const subject = await f.text('subject')
    if (!templateId && !text && !html) {
      throw new ConnectorError('invalid_query', 'Give the email’s text or HTML, or a dynamic template')
    }
    if (!templateId && !subject) throw new ConnectorError('invalid_query', 'Subject is empty')
    const extra = {
      ...(cc.length && { cc }),
      ...(bcc.length && { bcc }),
      ...(templateData && { dynamic_template_data: templateData }),
    }
    // Separate: one personalization per recipient, so nobody sees the others (cc and bcc go with the first).
    const personalizations = (await f.bool('separate'))
      ? to.map((recipient, i) => ({
          to: [recipient],
          ...(i === 0 ? extra : templateData ? { dynamic_template_data: templateData } : {}),
        }))
      : [{ to, ...extra }]
    const attachments = await f.value('attachments')
    const files =
      attachments === undefined || attachments === null || attachments === ''
        ? []
        : (Array.isArray(attachments) ? attachments : [attachments]).map((value, i) => {
            const file = fileOf(value, `Attachment ${i + 1}`)
            if (!file.filename)
              throw new ConnectorError('invalid_query', `Attachment ${i + 1} has no filename`)
            return {
              content: file.bytes.toString('base64'),
              filename: file.filename,
              type: file.contentType ?? 'application/octet-stream',
              disposition: 'attachment',
            }
          })
    const categories = await f.list('categories')
    const customArgs = await f.object('customArgs')
    const at = sendAt(await f.value('sendAt'))
    const replyTo = await f.text('replyTo')
    const res = await sendgrid(
      client,
      {
        method: 'POST',
        path: '/v3/mail/send',
        json: {
          personalizations,
          from: address(await f.required('from'), 'From'),
          ...(replyTo && { reply_to: address(replyTo, 'Reply to') }),
          ...(subject && { subject }),
          ...((text || html) && {
            content: [
              ...(text ? [{ type: 'text/plain', value: text }] : []),
              ...(html ? [{ type: 'text/html', value: html }] : []),
            ],
          }),
          ...(templateId && { template_id: templateId }),
          ...(files.length && { attachments: files }),
          ...(categories.length && { categories }),
          ...(customArgs && {
            custom_args: Object.fromEntries(Object.entries(customArgs).map(([k, v]) => [k, String(v)])),
          }),
          ...(at !== undefined && { send_at: at }),
        },
      },
      ctx,
    )
    return {
      data: { messageId: res.headers['x-message-id'] ?? null, status: res.status, recipients: to.length },
      metadata: responseMetadata(res),
    }
  },
}
