import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { fillPlaceholders, oauthPresets } from '../oauth-presets'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from '../types'
import {
  type ActionQuery,
  actionQuerySchema,
  answer,
  apiCall,
  call,
  fieldReader,
  limitOf,
  type ServiceCall,
  segment,
  serviceBase,
  serviceRestConfig,
  validateActionQuery,
} from './common'

// Microsoft Teams (M37, docs/architecture.md §2.41): Microsoft Graph with M9's Microsoft sign-in (delegated: Graph
// lets an app post to channels only as a person), for teams, channels, chats and messages; or a channel's Workflows
// webhook (Teams' "Post to a channel when a webhook request is received"), for posting only.

/** Delegated permissions for what the actions do. */
export const TEAMS_SCOPE =
  'offline_access openid email User.Read User.ReadBasic.All Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send ChannelMessage.Read.All Chat.ReadWrite TeamMember.Read.All'

/** Where Teams' webhooks live: Power Automate's Workflows (Logic Apps, Power Platform) and the old connectors. */
const WEBHOOK_HOSTS = [/\.logic\.azure\.com$/, /\.api\.powerplatform\.com$/, /\.webhook\.office\.com$/]

const configSchema = z.object({
  auth: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('oauth'),
        /** The Entra ID tenant: its id or domain, or `organizations` for any work account. */
        tenant: z
          .string()
          .trim()
          .regex(/^[\w.-]{1,100}$/, 'A tenant id or domain, or organizations')
          .default('organizations'),
        clientId: z.string().trim().default(''),
        scope: z.string().default(TEAMS_SCOPE),
        tokens: z.enum(['shared', 'perUser']).default('shared'),
      }),
      z.object({ type: z.literal('webhook') }),
    ])
    .default({ type: 'oauth', tenant: 'organizations', clientId: '', scope: TEAMS_SCOPE, tokens: 'shared' }),
})
type Config = z.output<typeof configSchema>

const secretsSchema = z.object({
  clientSecret: z.string().optional(),
  /** The Workflows webhook's URL: its signature is in it, so it's a secret. */
  webhookUrl: z.string().trim().url().optional(),
})
type Secrets = z.output<typeof secretsSchema>

const querySchema = actionQuerySchema('msteams')

function httpConfig(config: Config) {
  const microsoft = oauthPresets.microsoft
  const auth = config.auth
  return serviceRestConfig(
    serviceBase('graph', 'https://graph.microsoft.com/v1.0'),
    auth.type === 'oauth' && auth.clientId
      ? {
          type: 'oauth2AuthorizationCode',
          provider: 'microsoft',
          authorizeUrl: fillPlaceholders(microsoft.authorizeUrl, { tenant: auth.tenant }),
          tokenUrl: fillPlaceholders(microsoft.tokenUrl, { tenant: auth.tenant }),
          clientId: auth.clientId,
          scope: auth.scope,
          authorizeParams: microsoft.authorizeParams,
          clientAuth: microsoft.clientAuth,
          pkce: microsoft.pkce,
          tokens: auth.tokens,
        }
      : { type: 'none' },
  )
}

export interface TeamsClient {
  config: Config
  /** Graph (sign-in), or the webhook's own host. */
  http: HttpClient
  webhookUrl?: string
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

/** A webhook URL Teams would give: https on a Workflows host (or the tests' fake). */
function checkWebhookUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ConnectorError('invalid_config', "The webhook URL isn't a URL")
  }
  const fake = serviceBase('teamsWebhook', '')
  if (fake.overridden && url.startsWith(fake.url)) return parsed
  if (parsed.protocol !== 'https:' || !WEBHOOK_HOSTS.some((h) => h.test(parsed.hostname))) {
    throw new ConnectorError(
      'invalid_config',
      "That isn't a Teams Workflows webhook URL (https://…logic.azure.com/… or …api.powerplatform.com/…)",
    )
  }
  return parsed
}

/** A Graph call; Graph's errors (code, message, request id) as connector errors. */
async function graph(client: TeamsClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  if (client.webhookUrl) {
    throw new ConnectorError(
      'invalid_query',
      'This resource posts through a webhook: only "Post through the webhook" works with it. Sign in with Microsoft for the rest.',
    )
  }
  const res = await call(client.http, request, ctx)
  if (res.ok) return res
  const error = (
    res.data as { error?: { code?: string; message?: string; innerError?: Record<string, string> } } | null
  )?.error
  const requestId = error?.innerError?.['request-id'] ?? res.headers['request-id']
  const hint =
    res.status === 403
      ? ' (the signed-in account, or the app’s permissions, can’t do this: see the runbook’s scopes)'
      : ''
  throw new ConnectorError('http', `Teams: ${error?.message ?? `HTTP ${res.status}`}${hint}`, {
    status: res.status,
    ...(error?.code && { reason: error.code }),
    ...(requestId && { requestId }),
  })
}

/** Follows `@odata.nextLink` until `max` items. */
async function paged(client: TeamsClient, path: string, query: ServiceCall['query'], max: number, ctx: Ctx) {
  const items: unknown[] = []
  let next: string | undefined
  let last: HttpResponse | undefined
  do {
    const res = await graph(
      client,
      next ? { method: 'GET', path: next } : { method: 'GET', path, query },
      ctx,
    )
    last = res
    const body = res.data as { value?: unknown[]; '@odata.nextLink'?: string }
    items.push(...(body.value ?? []))
    next = body['@odata.nextLink']
  } while (next && items.length < max)
  return { items: items.slice(0, max), res: last!, truncated: Boolean(next) || items.length > max }
}

type Fields = ReturnType<typeof fieldReader>

/**
 * A chat message's body: text or HTML, people @mentioned (by email or id, looked up for their names), an Adaptive
 * Card as an attachment, the importance and (channels) a subject.
 */
async function messageBody(client: TeamsClient, f: Fields, ctx: Ctx) {
  const text = await f.text('text')
  const format = (await f.text('format')) ?? 'text'
  const card = await f.json('card')
  const people = await f.list('mentions')
  if (!text && card === undefined)
    throw new ConnectorError('invalid_query', 'Give the message text or a card')
  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const mentions = await Promise.all(
    people.map(async (who, i) => {
      const res = await graph(
        client,
        { method: 'GET', path: `/users/${segment(who)}`, query: { $select: 'id,displayName' } },
        ctx,
      )
      const user = res.data as { id: string; displayName?: string }
      const name = user.displayName ?? who
      return {
        tag: `<at id="${i}">${escapeHtml(name)}</at>`,
        mention: {
          id: i,
          mentionText: name,
          mentioned: { user: { id: user.id, displayName: name, userIdentityType: 'aadUser' } },
        },
      }
    }),
  )
  const html = format === 'html' || mentions.length > 0 || card !== undefined
  let content = text ? (format === 'html' ? text : html ? escapeHtml(text).replace(/\n/g, '<br>') : text) : ''
  if (mentions.length) content = `${mentions.map((m) => m.tag).join(' ')} ${content}`
  if (card !== undefined) content += '<attachment id="card"></attachment>'
  const importance = await f.text('importance')
  const subject = await f.text('subject')
  return {
    body: { contentType: html ? 'html' : 'text', content },
    ...(mentions.length && { mentions: mentions.map((m) => m.mention) }),
    ...(card !== undefined && {
      attachments: [
        { id: 'card', contentType: 'application/vnd.microsoft.card.adaptive', content: JSON.stringify(card) },
      ],
    }),
    ...(importance && importance !== 'normal' && { importance }),
    ...(subject && { subject }),
  }
}

/** A chat to post in: its id, or the one-on-one chat with a person (made if there's none yet). */
async function chatOf(client: TeamsClient, f: Fields, ctx: Ctx): Promise<string> {
  const chat = await f.text('chatId')
  if (chat) return chat
  const user = await f.text('user')
  if (!user) throw new ConnectorError('invalid_query', 'Give a chat id or a person (email) to message')
  const me = (await graph(client, { method: 'GET', path: '/me', query: { $select: 'id' } }, ctx)).data as {
    id: string
  }
  const member = (id: string) => ({
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    roles: ['owner'],
    'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${id.replace(/'/g, "''")}')`,
  })
  // Graph answers the existing one-on-one chat when there is one.
  const res = await graph(
    client,
    {
      method: 'POST',
      path: '/chats',
      json: { chatType: 'oneOnOne', members: [member(me.id), member(user)] },
    },
    ctx,
  )
  return (res.data as { id: string }).id
}

/** A Workflows webhook's payload: the card given, or the text as one. */
function webhookPayload(text: string | undefined, card: unknown) {
  const content =
    card ??
    ({
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [{ type: 'TextBlock', text, wrap: true }],
    } as const)
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }],
  }
}

export const msteamsConnector: Connector<Config, Secrets, ActionQuery, TeamsClient> = {
  type: 'msteams',
  label: 'Microsoft Teams',
  configSchema,
  secretsSchema,
  querySchema,
  scrubResultData: true,

  createClient({ config, secrets }) {
    if (config.auth.type === 'webhook') {
      if (!secrets.webhookUrl) throw new ConnectorError('invalid_config', 'Add the webhook URL (webhookUrl)')
      const url = checkWebhookUrl(secrets.webhookUrl)
      const fake = serviceBase('teamsWebhook', '')
      const http = createHttpClient(
        serviceRestConfig(
          { url: url.origin, overridden: fake.overridden && secrets.webhookUrl.startsWith(fake.url) },
          { type: 'none' },
        ),
        { headers: {}, values: {} },
      )
      return { config, http, webhookUrl: secrets.webhookUrl }
    }
    return {
      config,
      http: createHttpClient(httpConfig(config), {
        headers: {},
        values: {},
        ...(secrets.clientSecret && { clientSecret: secrets.clientSecret }),
      }),
    }
  },

  destroyClient: (client) => destroyHttpClient(client.http),

  httpConfig,

  async testConnection(client, ctx) {
    if (client.webhookUrl) {
      return { message: 'A Workflows webhook: nothing is sent to test it (a test would post in the channel)' }
    }
    const me = (
      await graph(
        client,
        { method: 'GET', path: '/me', query: { $select: 'displayName,mail,userPrincipalName' } },
        ctx,
      )
    ).data as { displayName?: string; mail?: string; userPrincipalName?: string }
    const teams = await paged(client, '/me/joinedTeams', {}, 1000, ctx)
    return {
      message: `Teams: ${me.displayName ?? me.mail ?? me.userPrincipalName ?? 'signed in'}, in ${teams.items.length} team${teams.items.length === 1 ? '' : 's'}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('msteams', query, ctx)
    const team = () => f.required('teamId').then(segment)
    const channel = () => f.required('channelId').then(segment)
    switch (query.action) {
      case 'postWebhook': {
        if (!client.webhookUrl) {
          throw new ConnectorError(
            'invalid_query',
            'This resource signs in with Microsoft: use "Post to a channel"',
          )
        }
        const text = await f.text('text')
        const card = await f.json('card')
        if (!text && card === undefined)
          throw new ConnectorError('invalid_query', 'Give the message text or a card')
        const res = await call(
          client.http,
          { method: 'POST', path: client.webhookUrl, json: webhookPayload(text, card) },
          ctx,
        )
        if (!res.ok) {
          throw new ConnectorError('http', `The Teams webhook answered ${res.status}`, { status: res.status })
        }
        return { data: { status: res.status }, metadata: { status: res.status } }
      }
      case 'listTeams': {
        const { items, res, truncated } = await paged(
          client,
          '/me/joinedTeams',
          {},
          limitOf(await f.number('max')),
          ctx,
        )
        return answer(items, res, { truncated })
      }
      case 'listChannels': {
        const { items, res, truncated } = await paged(
          client,
          `/teams/${await team()}/channels`,
          {},
          limitOf(await f.number('max')),
          ctx,
        )
        return answer(items, res, { truncated })
      }
      case 'postChannelMessage': {
        const res = await graph(
          client,
          {
            method: 'POST',
            path: `/teams/${await team()}/channels/${await channel()}/messages`,
            json: await messageBody(client, f, ctx),
          },
          ctx,
        )
        return answer(res.data, res)
      }
      case 'replyToMessage': {
        const message = segment(await f.required('messageId'))
        const res = await graph(
          client,
          {
            method: 'POST',
            path: `/teams/${await team()}/channels/${await channel()}/messages/${message}/replies`,
            json: await messageBody(client, f, ctx),
          },
          ctx,
        )
        return answer(res.data, res)
      }
      case 'listChannelMessages': {
        const replies = (await f.bool('replies')) ?? false
        const { items, res, truncated } = await paged(
          client,
          `/teams/${await team()}/channels/${await channel()}/messages`,
          { $top: 50, ...(replies && { $expand: 'replies' }) },
          limitOf(await f.number('max'), 1000, 50),
          ctx,
        )
        return answer(items, res, { truncated })
      }
      case 'listChats': {
        const { items, res, truncated } = await paged(
          client,
          '/me/chats',
          { $expand: 'members', $top: 50 },
          limitOf(await f.number('max'), 1000, 50),
          ctx,
        )
        return answer(items, res, { truncated })
      }
      case 'postChatMessage': {
        const chat = await chatOf(client, f, ctx)
        const res = await graph(
          client,
          {
            method: 'POST',
            path: `/chats/${segment(chat)}/messages`,
            json: await messageBody(client, f, ctx),
          },
          ctx,
        )
        return answer(res.data, res, { chatId: chat })
      }
      case 'listMembers': {
        const chat = await f.text('chatId')
        const path = chat ? `/chats/${segment(chat)}/members` : `/teams/${await team()}/members`
        const { items, res, truncated } = await paged(client, path, {}, limitOf(await f.number('max')), ctx)
        return answer(items, res, { truncated })
      }
      case 'api': {
        const res = await graph(client, await apiCall(f, '/', 'graph.microsoft.com/v1.0'), ctx)
        return answer(res.data, res)
      }
    }
    throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
  },
}
