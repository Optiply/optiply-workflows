import { FormData } from 'undici'
import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { oauthPresets } from '../oauth-presets'
import { responseMetadata } from '../rest'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from '../types'
import {
  type ActionQuery,
  actionQuerySchema,
  call,
  fieldReader,
  fileOf,
  limitOf,
  restAuthFor,
  type ServiceCall,
  type ServiceSecrets,
  serviceBase,
  serviceRestConfig,
  serviceRestSecrets,
  serviceSecretsSchema,
  tokenOrOAuthSchema,
  validateActionQuery,
} from './common'

// Slack (M27): a bot or user token, or M9's OAuth; the Web API's methods, whose errors come back as `ok: false`.

const configSchema = z.object({ auth: tokenOrOAuthSchema(oauthPresets.slack) })
type Config = z.output<typeof configSchema>

const querySchema = actionQuerySchema('slack')

function httpConfig(config: Config) {
  // The two-step upload sends the bytes to files.slack.com.
  return serviceRestConfig(
    serviceBase('slack', 'https://slack.com/api'),
    restAuthFor(config.auth, oauthPresets.slack),
    ['files.slack.com'],
  )
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

interface SlackBody {
  ok?: boolean
  error?: string
  warning?: string
  response_metadata?: { next_cursor?: string; messages?: string[] }
  [key: string]: unknown
}

/** A Web API method: GET with parameters (reads) or POST with JSON (writes). Slack's `ok: false` is an error. */
async function slack(
  client: HttpClient,
  method: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  as: 'get' | 'json' = 'json',
): Promise<{ body: SlackBody; res: HttpResponse }> {
  const request: ServiceCall =
    as === 'get'
      ? {
          method: 'GET',
          path: `/${method}`,
          query: Object.fromEntries(
            Object.entries(args)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]),
          ),
        }
      : { method: 'POST', path: `/${method}`, json: args }
  const res = await call(client, request, ctx)
  const body = (res.data !== null && typeof res.data === 'object' ? res.data : null) as SlackBody | null
  if (!body || typeof body.ok !== 'boolean') {
    if (res.status === 429) {
      throw new ConnectorError('http', `Slack is rate limiting ${method}; try again later`, { status: 429 })
    }
    throw new ConnectorError('http', `Slack answered ${method} with HTTP ${res.status}`, {
      status: res.status,
    })
  }
  if (!body.ok) {
    const details = body.response_metadata?.messages?.join('; ')
    throw new ConnectorError('query', `Slack: ${body.error ?? 'error'}${details ? ` (${details})` : ''}`, {
      error: body.error,
      method,
      ...(body.response_metadata && { responseMetadata: body.response_metadata }),
    })
  }
  return { body, res }
}

/** Every page of a cursor-paged method, up to `max` items of `key`. */
async function paged(
  client: HttpClient,
  method: string,
  key: string,
  args: Record<string, unknown>,
  max: number,
  ctx: Ctx,
): Promise<{ items: unknown[]; res: HttpResponse; truncated: boolean }> {
  const items: unknown[] = []
  let cursor: string | undefined
  let last: HttpResponse
  for (;;) {
    const { body, res } = await slack(
      client,
      method,
      { ...args, limit: Math.min(200, max - items.length), ...(cursor && { cursor }) },
      ctx,
      'get',
    )
    last = res
    items.push(...((body[key] as unknown[] | undefined) ?? []))
    cursor = body.response_metadata?.next_cursor || undefined
    if (!cursor || items.length >= max) break
  }
  return { items: items.slice(0, max), res: last, truncated: Boolean(cursor) && items.length >= max }
}

export const slackConnector: Connector<Config, ServiceSecrets, ActionQuery, HttpClient> = {
  type: 'slack',
  label: 'Slack',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema,
  scrubResultData: true,

  createClient({ config, secrets }) {
    if (config.auth.type === 'token' && !secrets.token) {
      throw new ConnectorError('invalid_config', 'Add the Slack token (xoxb-… or xoxp-…)')
    }
    return createHttpClient(httpConfig(config), serviceRestSecrets(secrets))
  },

  destroyClient: destroyHttpClient,

  httpConfig,

  async testConnection(client, ctx) {
    const { body } = await slack(client, 'auth.test', {}, ctx)
    return { message: `Slack: ${body.team ?? 'a workspace'}, as ${body.user ?? 'the token’s user'}` }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('slack', query, ctx)
    const done = (data: unknown, res: HttpResponse, extra: Record<string, unknown> = {}) => ({
      data,
      metadata: { ...responseMetadata(res), ...extra },
    })
    switch (query.action) {
      case 'postMessage': {
        const text = await f.text('text')
        const blocks = await f.json('blocks')
        if (!text && blocks === undefined)
          throw new ConnectorError('invalid_query', 'Give the message text or blocks')
        const { body, res } = await slack(
          client,
          'chat.postMessage',
          {
            channel: await f.required('channel'),
            ...(text && { text }),
            ...(blocks !== undefined && { blocks }),
            ...(await optional('thread_ts', f.text('threadTs'))),
            ...(await optional('reply_broadcast', f.bool('replyBroadcast'))),
            ...(await optional('unfurl_links', f.bool('unfurlLinks'))),
            ...(await optional('username', f.text('username'))),
            ...(await optional('icon_emoji', f.text('iconEmoji'))),
          },
          ctx,
        )
        return done({ channel: body.channel, ts: body.ts, message: body.message }, res)
      }
      case 'updateMessage': {
        const text = await f.text('text')
        const blocks = await f.json('blocks')
        const { body, res } = await slack(
          client,
          'chat.update',
          {
            channel: await f.required('channel'),
            ts: await f.required('ts'),
            ...(text && { text }),
            ...(blocks !== undefined && { blocks }),
          },
          ctx,
        )
        return done({ channel: body.channel, ts: body.ts, text: body.text }, res)
      }
      case 'deleteMessage': {
        const { body, res } = await slack(
          client,
          'chat.delete',
          { channel: await f.required('channel'), ts: await f.required('ts') },
          ctx,
        )
        return done({ channel: body.channel, ts: body.ts }, res)
      }
      case 'listChannels': {
        const { items, res, truncated } = await paged(
          client,
          'conversations.list',
          'channels',
          {
            types: (await f.text('types')) ?? 'public_channel',
            exclude_archived: (await f.bool('excludeArchived')) ?? true,
          },
          limitOf(await f.number('max')),
          ctx,
        )
        return done(items, res, { truncated })
      }
      case 'listUsers': {
        const { items, res, truncated } = await paged(
          client,
          'users.list',
          'members',
          {},
          limitOf(await f.number('max')),
          ctx,
        )
        return done(items, res, { truncated })
      }
      case 'lookupUserByEmail': {
        const { body, res } = await slack(
          client,
          'users.lookupByEmail',
          { email: await f.required('email') },
          ctx,
          'get',
        )
        return done(body.user, res)
      }
      case 'uploadFile': {
        const file = fileOf(await f.value('file'), 'File')
        const filename = (await f.text('filename')) ?? file.filename
        if (!filename) throw new ConnectorError('invalid_query', 'File name is empty')
        const { body: upload } = await slack(
          client,
          'files.getUploadURLExternal',
          { filename, length: file.bytes.length },
          ctx,
          'get',
        )
        const form = new FormData()
        form.append(
          'file',
          new Blob([new Uint8Array(file.bytes)], { type: file.contentType ?? 'application/octet-stream' }),
          filename,
        )
        const sent = await call(client, { method: 'POST', path: String(upload.upload_url), body: form }, ctx)
        if (!sent.ok)
          throw new ConnectorError('http', `Slack refused the file's bytes (HTTP ${sent.status})`, {
            status: sent.status,
          })
        const channel = await f.text('channel')
        const { body, res } = await slack(
          client,
          'files.completeUploadExternal',
          {
            files: [{ id: upload.file_id, title: (await f.text('title')) ?? filename }],
            ...(channel && { channel_id: channel }),
            ...(await optional('initial_comment', f.text('comment'))),
            ...(await optional('thread_ts', f.text('threadTs'))),
          },
          ctx,
        )
        return done((body.files as unknown[] | undefined)?.[0] ?? null, res)
      }
      case 'api': {
        const method = await f.required('method')
        if (!/^[a-zA-Z][\w.]*$/.test(method))
          throw new ConnectorError('invalid_query', `"${method}" isn't a Slack method name`)
        const args = (await f.object('args')) ?? {}
        const { body, res } = await slack(client, method, args, ctx)
        return done(body, res)
      }
    }
    throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
  },
}

/** `{ [key]: value }` when the value is there, for spreading. */
async function optional(key: string, value: Promise<unknown>): Promise<Record<string, unknown>> {
  const v = await value
  return v === undefined ? {} : { [key]: v }
}
