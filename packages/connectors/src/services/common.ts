import { parseTemplate, renderJson, renderTemplate, renderText, TemplateError } from '@ow/expressions'
import type { FormData } from 'undici'
import { z } from 'zod'
import { type HttpClient, type HttpResponse, httpRequest } from '../http-core'
import type { OAuthProviderPreset } from '../oauth-presets'
import {
  type RestAuth,
  type RestConfig,
  type RestSecrets,
  restConfigSchema,
  restSecretsSchema,
} from '../rest'
import { ConnectorError, type CredentialSource, type QueryContext } from '../types'
import { actionSpec, SERVICE_ACTIONS, type ServiceType } from './actions'

// What the service connectors (M27) share: sign-in mapped onto REST's settings, the hosts, action queries, calls.

/** Where each service is reached; set by the server only for tests (`SLACK_API_URL`, …), never by a resource. */
export interface ServiceUrls {
  slack?: string
  hubspot?: string
  sendgrid?: string
  sendgridEu?: string
  sheets?: string
  drive?: string
}

let urls: ServiceUrls = {}

export function configureServiceUrls(next: ServiceUrls): void {
  urls = { ...next }
}

/** A service's base URL, and whether it was overridden (a test's fake on this machine: private addresses allowed). */
export function serviceBase(name: keyof ServiceUrls, real: string): { url: string; overridden: boolean } {
  const override = urls[name]
  return override ? { url: override.replace(/\/+$/, ''), overridden: true } : { url: real, overridden: false }
}

/** Signing in with a token kept in the settings, or with M9's OAuth (an app registered with the service). */
export function tokenOrOAuthSchema(preset: OAuthProviderPreset) {
  return z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('token') }),
      z.object({
        type: z.literal('oauth'),
        clientId: z.string().trim().min(1),
        scope: z.string().default(preset.scope),
        /** One connected account per environment, or each person connects their own. */
        tokens: z.enum(['shared', 'perUser']).default('shared'),
      }),
    ])
    .default({ type: 'token' })
}

export const serviceSecretsSchema = z.object({
  /** The API token (Slack bot or user token, HubSpot private app token, SendGrid API key). */
  token: z.string().optional(),
  /** The OAuth app's client secret (M9's connect flow reads it as REST's `clientSecret`). */
  clientSecret: z.string().optional(),
})
export type ServiceSecrets = z.output<typeof serviceSecretsSchema>

type ServiceAuth = z.output<ReturnType<typeof tokenOrOAuthSchema>>

/** REST's auth for a service's sign-in: a bearer token, or M9's authorization code with the provider's preset. */
export function restAuthFor(auth: ServiceAuth, preset: OAuthProviderPreset): RestAuth {
  if (auth.type === 'token') return { type: 'bearer' }
  return {
    type: 'oauth2AuthorizationCode',
    provider: preset.id,
    authorizeUrl: preset.authorizeUrl,
    tokenUrl: preset.tokenUrl,
    clientId: auth.clientId,
    scope: auth.scope,
    authorizeParams: preset.authorizeParams,
    clientAuth: preset.clientAuth,
    pkce: preset.pkce,
    tokens: auth.tokens,
  }
}

/** A service's REST-shaped settings: its API's base URL and hosts, the sign-in, no private network (except fakes). */
export function serviceRestConfig(
  base: { url: string; overridden: boolean },
  auth: RestAuth,
  allowedHosts: string[] = [],
): RestConfig {
  return restConfigSchema.parse({
    baseUrl: base.url,
    auth,
    allowedHosts,
    allowPrivateNetwork: base.overridden,
    maxResponseBytes: 20 * 1024 * 1024,
  })
}

export function serviceRestSecrets(secrets: ServiceSecrets): RestSecrets {
  return restSecretsSchema.parse({
    ...(secrets.token && { bearerToken: secrets.token }),
    ...(secrets.clientSecret && { clientSecret: secrets.clientSecret }),
  })
}

/** An action query: which action, and its fields (every one a template). */
export function actionQuerySchema(type: ServiceType) {
  const ids = SERVICE_ACTIONS[type].map((a) => a.id) as [string, ...string[]]
  return z.object({ action: z.enum(ids) }).catchall(z.string())
}
export type ActionQuery = { action: string } & Record<string, string>

/** Every field's template parses. */
export function validateActionQuery(query: ActionQuery): TemplateError[] {
  const errors: TemplateError[] = []
  for (const [key, template] of Object.entries(query)) {
    if (key === 'action') continue
    try {
      parseTemplate(template)
    } catch (err) {
      if (err instanceof TemplateError) errors.push(err)
      else throw err
    }
  }
  return errors
}

/** Reads an action query's fields by their kinds, in the query's scope. Empty fields are undefined. */
export function fieldReader(type: ServiceType, query: ActionQuery, ctx: Pick<QueryContext, 'evaluate'>) {
  const spec = actionSpec(type, query.action)
  const label = (key: string) => spec?.fields.find((f) => f.key === key)?.label ?? key
  const raw = (key: string) => (query[key] ?? '').trim()
  const read = {
    async text(key: string): Promise<string | undefined> {
      const value = raw(key) ? (await renderText(raw(key), ctx.evaluate)).trim() : ''
      return value || undefined
    },
    async required(key: string): Promise<string> {
      const value = await read.text(key)
      if (!value) throw new ConnectorError('invalid_query', `${label(key)} is empty`)
      return value
    },
    async value(key: string): Promise<unknown> {
      return raw(key) ? renderTemplate(raw(key), ctx.evaluate) : undefined
    },
    async json(key: string): Promise<unknown> {
      return raw(key) ? renderJson(raw(key), ctx.evaluate) : undefined
    },
    async list(key: string): Promise<string[]> {
      const value = await read.value(key)
      if (value === undefined || value === null || value === '') return []
      const items = Array.isArray(value) ? value.map((v) => String(v)) : String(value).split(/[,\n]/)
      return items.map((s) => s.trim()).filter(Boolean)
    },
    async bool(key: string): Promise<boolean | undefined> {
      const value = await read.value(key)
      if (value === undefined || value === '') return undefined
      if (typeof value === 'boolean') return value
      return /^(true|yes|1|on)$/i.test(String(value).trim())
    },
    async number(key: string): Promise<number | undefined> {
      const value = await read.value(key)
      if (value === undefined || value === '' || value === null) return undefined
      const n = Number(value)
      if (!Number.isFinite(n)) throw new ConnectorError('invalid_query', `${label(key)} isn't a number`)
      return n
    },
    /** A JSON object (or nothing). */
    async object(key: string): Promise<Record<string, unknown> | undefined> {
      const value = await read.json(key)
      if (value === undefined || value === null) return undefined
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ConnectorError('invalid_query', `${label(key)} must be a JSON object`)
      }
      return value as Record<string, unknown>
    },
  }
  return read
}

export interface ServiceCall {
  method: string
  /** Under the client's base URL (segments already encoded), or a full URL on an allowed host. */
  path: string
  query?: Record<string, string | number | boolean | readonly string[] | undefined>
  json?: unknown
  body?: string | FormData
  contentType?: string
  /** Credentials sent with this call only (a Google token), dropped on a redirect to another origin. */
  authorization?: string
}

/** One call to a service's API; a 429 is waited out once (up to 30 s, as `Retry-After` says), then answered. */
export async function call(
  client: HttpClient,
  request: ServiceCall,
  ctx: { signal: AbortSignal; credentials?: CredentialSource | undefined },
): Promise<HttpResponse> {
  const url = /^https?:\/\//.test(request.path)
    ? new URL(request.path)
    : new URL(`${client.config.baseUrl.replace(/\/+$/, '')}${request.path}`)
  const params: [string, string][] = []
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) params.push([key, v])
    else params.push([key, String(value)])
  }
  const send = () =>
    httpRequest(
      client,
      {
        method: request.method,
        url,
        params,
        ...(request.authorization && {
          headers: [['authorization', request.authorization]] as [string, string][],
          sensitive: ['authorization'],
        }),
        ...(request.json !== undefined
          ? { body: JSON.stringify(request.json), contentType: 'application/json; charset=utf-8' }
          : request.body !== undefined
            ? { body: request.body, ...(request.contentType && { contentType: request.contentType }) }
            : {}),
      },
      ctx,
    )
  const res = await send()
  if (res.status !== 429) return res
  const wait = Number(res.headers['retry-after'] ?? '1')
  if (!(wait >= 0 && wait <= 30)) return res
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, wait * 1000)
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(ctx.signal.reason)
      },
      { once: true },
    )
  })
  return send()
}

/** A path segment from a value: encoded whole, whoever gave it. */
export function segment(value: string): string {
  return encodeURIComponent(value)
}

/** `max` results by default, at most `cap`. */
export function limitOf(max: number | undefined, cap = 10_000, fallback = 1000): number {
  if (max === undefined) return fallback
  return Math.max(1, Math.min(cap, Math.floor(max)))
}

/** A file from base64 text or a webhook's file object (`{ base64, filename?, contentType? }`). */
export function fileOf(
  value: unknown,
  what: string,
): { bytes: Buffer; filename?: string; contentType?: string } {
  const object = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const base64 = typeof value === 'string' ? value : object?.base64
  const text = typeof base64 === 'string' ? base64.replace(/\s+/g, '') : null
  if (text === null || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) {
    throw new ConnectorError(
      'invalid_query',
      `${what} needs base64 text or a file object ({ base64, filename, contentType })`,
    )
  }
  return {
    bytes: Buffer.from(text, 'base64'),
    ...(typeof object?.filename === 'string' && { filename: object.filename }),
    ...(typeof object?.contentType === 'string' && { contentType: object.contentType }),
  }
}
