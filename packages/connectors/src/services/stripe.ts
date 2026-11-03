import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { type Connector, ConnectorError, type CredentialSource, type QueryResult } from '../types'
import { STRIPE_KINDS, STRIPE_SEARCHABLE } from './actions'
import {
  type ActionQuery,
  actionQuerySchema,
  answer,
  apiCall,
  call,
  fieldReader,
  limitOf,
  type ServiceCall,
  type ServiceSecrets,
  segment,
  serviceBase,
  serviceRestConfig,
  serviceRestSecrets,
  serviceSecretsSchema,
  validateActionQuery,
} from './common'

// Stripe (M29): a secret or restricted key; objects listed (auto-paged), searched, read, created, updated and
// deleted, and any /v1 endpoint. Stripe takes form-encoded bodies with bracketed keys; every POST carries an
// Idempotency-Key, by default one made from the run and the request, so a retried block doesn't charge twice.

const configSchema = z.object({
  /** A `Stripe-Version` to pin (empty: the account's default). */
  apiVersion: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}(\.\w+)?$/, 'A Stripe API version, such as 2025-01-27.acacia')
    .optional(),
  /** A connected account to act as (`Stripe-Account`), for Connect platforms. */
  account: z
    .string()
    .trim()
    .regex(/^acct_\w+$/, 'A connected account id (acct_…)')
    .optional(),
})
type Config = z.output<typeof configSchema>

interface StripeClient {
  http: HttpClient
  config: Config
}

function httpConfig(_config: Config) {
  return serviceRestConfig(serviceBase('stripe', 'https://api.stripe.com'), { type: 'bearer' })
}

/**
 * Form-encodes a JSON value the way Stripe reads it: nested objects as `a[b]`, arrays as `a[0]` (objects inside as
 * `a[0][b]`), booleans as true/false, null and empty strings as an empty value (which clears a field on update).
 */
export function stripeForm(value: Record<string, unknown>): string {
  const pairs: [string, string][] = []
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined) return
    if (v === null) pairs.push([prefix, ''])
    else if (Array.isArray(v)) {
      if (v.length === 0) pairs.push([prefix, ''])
      for (const [i, item] of v.entries()) walk(`${prefix}[${i}]`, item)
    } else if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>)
      if (entries.length === 0) pairs.push([prefix, ''])
      for (const [k, item] of entries) walk(`${prefix}[${k}]`, item)
    } else pairs.push([prefix, String(v)])
  }
  for (const [k, v] of Object.entries(value)) walk(k, v)
  return pairs
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k).replaceAll('%5B', '[').replaceAll('%5D', ']')}=${encodeURIComponent(v)}`,
    )
    .join('&')
}

/** Query parameters for a GET in Stripe's form: the same encoding, as pairs. */
function stripeQuery(value: Record<string, unknown>): [string, string][] {
  const form = stripeForm(value)
  if (!form) return []
  return form.split('&').map((pair) => {
    const [k, v] = pair.split('=')
    return [decodeURIComponent(k!), decodeURIComponent(v ?? '')]
  })
}

type Ctx = {
  signal: AbortSignal
  credentials?: CredentialSource | undefined
  labels?: Record<string, string> | undefined
}

async function stripe(
  client: StripeClient,
  request: ServiceCall & { idempotencyKey?: string },
  ctx: Ctx,
): Promise<HttpResponse> {
  const headers: [string, string][] = []
  if (client.config.apiVersion) headers.push(['stripe-version', client.config.apiVersion])
  if (client.config.account) headers.push(['stripe-account', client.config.account])
  if (request.idempotencyKey) headers.push(['idempotency-key', request.idempotencyKey])
  const res = await call(client.http, { ...request, extraHeaders: headers }, ctx)
  if (res.ok) return res
  const error = (res.data as { error?: Record<string, unknown> } | null)?.error
  const message = typeof error?.message === 'string' ? error.message : `HTTP ${res.status}`
  throw new ConnectorError('http', `Stripe: ${message}`, {
    status: res.status,
    ...(error && {
      type: error.type,
      code: error.code,
      ...(error.decline_code !== undefined && { declineCode: error.decline_code }),
      ...(error.param !== undefined && { param: error.param }),
    }),
    ...(res.headers['request-id'] && { requestId: res.headers['request-id'] }),
  })
}

/** The request's Idempotency-Key: the one given, or one from the run and the request (random outside a run). */
export function idempotencyKeyFor(
  given: string | undefined,
  labels: Record<string, string> | undefined,
  request: string,
): string {
  if (given) return given
  const run = labels?.ow_run
  if (!run) return `ow-${randomUUID()}`
  return `ow-${run}-${createHash('sha256').update(request).digest('hex').slice(0, 32)}`
}

function kindOf(value: string | undefined, allowed: readonly string[] = STRIPE_KINDS): string {
  const kind = value ?? 'customers'
  if (!allowed.includes(kind))
    throw new ConnectorError('invalid_query', `"${kind}" isn't an object kind this action takes`)
  return kind
}

export const stripeConnector: Connector<Config, ServiceSecrets, ActionQuery, StripeClient> = {
  type: 'stripe',
  label: 'Stripe',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema: actionQuerySchema('stripe'),
  scrubResultData: true,
  httpConfig,

  createClient({ config, secrets }) {
    if (!secrets.token) throw new ConnectorError('invalid_config', 'Add the secret key (sk_… or rk_…)')
    return { http: createHttpClient(httpConfig(config), serviceRestSecrets(secrets)), config }
  },

  async destroyClient(client) {
    await destroyHttpClient(client.http)
  },

  async testConnection(client, ctx) {
    const res = await stripe(client, { method: 'GET', path: '/v1/balance' }, ctx)
    const live = (res.data as { livemode?: boolean }).livemode
    return {
      message: `Stripe in ${live ? 'live' : 'test'} mode${client.config.account ? ` as ${client.config.account}` : ''}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('stripe', query, ctx)
    const post = async (path: string, params: Record<string, unknown>, given?: string) => {
      const body = stripeForm(params)
      const idempotencyKey = idempotencyKeyFor(given, ctx.labels, `POST ${path}\n${body}`)
      return stripe(
        client,
        { method: 'POST', path, body, contentType: 'application/x-www-form-urlencoded', idempotencyKey },
        ctx,
      )
    }
    switch (query.action) {
      case 'list':
      case 'search': {
        const search = query.action === 'search'
        const kind = kindOf(await f.text('kind'), search ? STRIPE_SEARCHABLE : STRIPE_KINDS)
        const max = limitOf(await f.number('max'))
        const filters = search ? { query: await f.required('query') } : ((await f.object('filters')) ?? {})
        const items: unknown[] = []
        let after: string | undefined
        let page: string | undefined
        let more = false
        do {
          const params = {
            ...filters,
            limit: Math.min(100, max - items.length),
            ...(after && { starting_after: after }),
            ...(page && { page }),
          }
          const res = await stripe(
            client,
            { method: 'GET', path: `/v1/${kind}${search ? '/search' : ''}`, pairs: stripeQuery(params) },
            ctx,
          )
          const body = res.data as { data?: { id?: string }[]; has_more?: boolean; next_page?: string | null }
          const got = body.data ?? []
          items.push(...got)
          more = !!body.has_more
          after = got.at(-1)?.id
          page = body.next_page ?? undefined
        } while (more && items.length < max && (search ? page : after))
        return { data: items.slice(0, max), metadata: { count: Math.min(items.length, max), hasMore: more } }
      }
      case 'retrieve': {
        const kind = kindOf(await f.text('kind'))
        const expand = await f.list('expand')
        const res = await stripe(
          client,
          {
            method: 'GET',
            path: `/v1/${kind}/${segment(await f.required('id'))}`,
            pairs: stripeQuery(expand.length ? { expand } : {}),
          },
          ctx,
        )
        return answer(res.data, res)
      }
      case 'create': {
        const kind = kindOf(await f.text('kind'))
        const res = await post(
          `/v1/${kind}`,
          (await f.object('params')) ?? {},
          await f.text('idempotencyKey'),
        )
        return answer(res.data, res)
      }
      case 'update': {
        const kind = kindOf(await f.text('kind'))
        const res = await post(
          `/v1/${kind}/${segment(await f.required('id'))}`,
          (await f.object('params')) ?? {},
          await f.text('idempotencyKey'),
        )
        return answer(res.data, res)
      }
      case 'delete': {
        const kind = kindOf(await f.text('kind'))
        const res = await stripe(
          client,
          { method: 'DELETE', path: `/v1/${kind}/${segment(await f.required('id'))}` },
          ctx,
        )
        return answer(res.data, res)
      }
      case 'api': {
        const request = await apiCall(f, '/v1/', 'the API')
        if (request.json !== undefined) {
          if (typeof request.json !== 'object' || request.json === null || Array.isArray(request.json))
            throw new ConnectorError('invalid_query', 'Body must be a JSON object (Stripe takes form fields)')
          const res = await post(request.path, request.json as Record<string, unknown>)
          return answer(res.data, res)
        }
        const res =
          request.method === 'POST' ? await post(request.path, {}) : await stripe(client, request, ctx)
        return answer(res.data, res)
      }
      default:
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    }
  },
}
