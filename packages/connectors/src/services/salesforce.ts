import { parseTemplate } from '@ow/expressions'
import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
import { type RestAuth, restConfigSchema, restSecretsSchema } from '../rest'
import {
  type Connector,
  ConnectorError,
  type CredentialSource,
  type QueryContext,
  type QueryResult,
} from '../types'
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
  serviceSecretsSchema,
  validateActionQuery,
} from './common'

// Salesforce (M29): the org's My Domain URL; M9's OAuth authorization code (each environment's connected user, or
// each person's) or a connected app's client credentials. SOQL with every {{ }} sent as an escaped literal (never
// pasted), pages followed through nextRecordsUrl; parameterized search; sObjects read, created, updated, upserted by
// an external id, deleted and described; any /services/data endpoint.

const configSchema = z.object({
  /** https://<name>.my.salesforce.com (sandboxes: …sandbox.my.salesforce.com). */
  domain: z
    .string()
    .trim()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  apiVersion: z
    .string()
    .trim()
    .regex(/^v\d{2}\.0$/, 'An API version, such as v62.0')
    .default('v62.0'),
  auth: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('oauth'),
      clientId: z.string().trim().min(1),
      scope: z.string().default('api refresh_token'),
      tokens: z.enum(['shared', 'perUser']).default('shared'),
    }),
    /** A connected app's client credentials flow (it runs as the app's "Run As" user). */
    z.object({ type: z.literal('clientCredentials'), clientId: z.string().trim().min(1) }),
  ]),
})
type Config = z.output<typeof configSchema>

interface SalesforceClient {
  http: HttpClient
  config: Config
  data: string
}

function httpConfig(config: Config) {
  const base = serviceBase('salesforce', config.domain)
  const auth: RestAuth =
    config.auth.type === 'clientCredentials'
      ? {
          type: 'oauth2ClientCredentials',
          tokenUrl: `${base.url}/services/oauth2/token`,
          clientId: config.auth.clientId,
          clientAuth: 'body',
        }
      : {
          type: 'oauth2AuthorizationCode',
          provider: 'custom',
          authorizeUrl: `${base.url}/services/oauth2/authorize`,
          tokenUrl: `${base.url}/services/oauth2/token`,
          revokeUrl: `${base.url}/services/oauth2/revoke`,
          clientId: config.auth.clientId,
          scope: config.auth.scope,
          authorizeParams: [],
          clientAuth: 'body',
          pkce: true,
          tokens: config.auth.tokens,
        }
  return restConfigSchema.parse({
    baseUrl: base.url,
    auth,
    allowedHosts: [],
    allowPrivateNetwork: base.overridden,
    maxResponseBytes: 20 * 1024 * 1024,
  })
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

async function salesforce(client: SalesforceClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  const res = await call(client.http, request, ctx)
  if (res.ok) return res
  const errors = Array.isArray(res.data)
    ? (res.data as { message?: string; errorCode?: string; fields?: string[] }[])
    : []
  const first = errors[0]
  const message = first?.message
    ? `${first.message}${first.errorCode ? ` (${first.errorCode})` : ''}`
    : typeof (res.data as { error_description?: string } | null)?.error_description === 'string'
      ? (res.data as { error_description: string }).error_description
      : `HTTP ${res.status}`
  throw new ConnectorError('http', `Salesforce: ${message}`, {
    status: res.status,
    ...(first?.errorCode && { errorCode: first.errorCode }),
    ...(first?.fields?.length && { fields: first.fields }),
  })
}

const SOQL_DATE = /^\d{4}-\d{2}-\d{2}$/
const SOQL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

/**
 * A value as a SOQL literal: strings quoted and escaped, numbers, booleans, null, lists for IN, and dates unquoted:
 * a Date, or a string that is exactly an ISO date (2026-11-03) or date-time with a zone (2026-11-03T10:00:00Z), since
 * values from expressions arrive as strings and SOQL refuses quoted dates. (A text field compared to such a string
 * needs its value changed, e.g. a trailing space; that is rare next to date filters.)
 */
export function soqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConnectorError('invalid_query', `${value} can't go into SOQL`)
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (typeof value === 'string' && (SOQL_DATE.test(value) || SOQL_DATETIME.test(value)))
    return value.replace(/\.\d{1,3}(?=Z|[+-])/, '')
  if (Array.isArray(value)) {
    if (value.length === 0)
      throw new ConnectorError('invalid_query', 'An empty list can’t go into SOQL (IN () is invalid)')
    return `(${value.map(soqlLiteral).join(', ')})`
  }
  if (typeof value === 'object')
    throw new ConnectorError('invalid_query', 'An object can’t go into SOQL: use one of its values')
  const escaped = String(value).replace(/[\\'"\n\r\t\b\f]/g, (ch) => {
    switch (ch) {
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      case '\b':
        return '\\b'
      case '\f':
        return '\\f'
      default:
        return `\\${ch}`
    }
  })
  return `'${escaped}'`
}

/**
 * SOQL from a template: text as written, each {{ }} as a literal. A {{ }} inside a quoted string is refused (it would
 * be pasted into the string), as the SQL connectors refuse it.
 */
export async function renderSoql(src: string, evaluate: QueryContext['evaluate']): Promise<string> {
  let out = ''
  let quoted = false
  for (const part of parseTemplate(src)) {
    if (part.type === 'text') {
      for (let i = 0; i < part.value.length; i++) {
        const ch = part.value[i]!
        if (ch === '\\' && quoted) {
          i++
          continue
        }
        if (ch === "'") quoted = !quoted
      }
      out += part.value
    } else {
      if (quoted)
        throw new ConnectorError(
          'invalid_query',
          'Put {{ }} outside quotes in SOQL: values are quoted and escaped for you',
        )
      out += soqlLiteral(await evaluate(part.code))
    }
  }
  return out
}

/** A record without Salesforce's `attributes` (its type and URL), nested ones too. */
export function dropAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropAttributes)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'attributes') continue
      // A sub-query's result ({totalSize, done, records}) becomes its records.
      out[k] =
        v && typeof v === 'object' && 'records' in v && 'done' in v
          ? dropAttributes((v as { records: unknown }).records)
          : dropAttributes(v)
    }
    return out
  }
  return value
}

export const salesforceConnector: Connector<Config, ServiceSecrets, ActionQuery, SalesforceClient> = {
  type: 'salesforce',
  label: 'Salesforce',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema: actionQuerySchema('salesforce'),
  scrubResultData: true,
  httpConfig,

  createClient({ config, secrets }) {
    if (!secrets.clientSecret)
      throw new ConnectorError('invalid_config', 'Add the connected app’s consumer secret')
    return {
      http: createHttpClient(
        httpConfig(config),
        restSecretsSchema.parse({ clientSecret: secrets.clientSecret }),
      ),
      config,
      data: `/services/data/${config.apiVersion}`,
    }
  },

  async destroyClient(client) {
    await destroyHttpClient(client.http)
  },

  async testConnection(client, ctx) {
    await salesforce(client, { method: 'GET', path: `${client.data}/` }, ctx)
    const limits = await salesforce(client, { method: 'GET', path: `${client.data}/limits` }, ctx).catch(
      () => null,
    )
    const api = (limits?.data as { DailyApiRequests?: { Max?: number; Remaining?: number } } | null)
      ?.DailyApiRequests
    return {
      message: `Salesforce at ${new URL(client.config.domain).host}, API ${client.config.apiVersion}${api ? ` (${api.Remaining} of ${api.Max} daily API calls left)` : ''}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('salesforce', query, ctx)
    const sobject = async () => `${client.data}/sobjects/${segment(await f.required('object'))}`
    const record = async () => {
      const value = await f.object('record')
      if (!value) throw new ConnectorError('invalid_query', 'Fields is empty')
      return value
    }

    switch (query.action) {
      case 'query': {
        const raw = (query.soql ?? '').trim()
        if (!raw) throw new ConnectorError('invalid_query', 'SOQL is empty')
        const soql = await renderSoql(raw, ctx.evaluate)
        const max = limitOf(await f.number('max'), 100_000)
        const all = await f.bool('all')
        const records: unknown[] = []
        let next: string | undefined
        let total = 0
        let res = await salesforce(
          client,
          { method: 'GET', path: `${client.data}/${all ? 'queryAll' : 'query'}`, query: { q: soql } },
          ctx,
        )
        for (;;) {
          const body = res.data as {
            records?: unknown[]
            totalSize?: number
            done?: boolean
            nextRecordsUrl?: string
          }
          total = body.totalSize ?? total
          records.push(...(body.records ?? []))
          next = body.done ? undefined : body.nextRecordsUrl
          if (!next || records.length >= max) break
          // nextRecordsUrl is a path on the same host, under /services/data.
          if (!next.startsWith('/services/data/'))
            throw new ConnectorError('query', 'Salesforce answered an unexpected next page')
          res = await salesforce(client, { method: 'GET', path: next }, ctx)
        }
        return {
          data: dropAttributes(records.slice(0, max)),
          metadata: { count: Math.min(records.length, max), totalSize: total, more: !!next, soql },
        }
      }
      case 'search': {
        const objects = await f.list('objects')
        const fields = await f.list('fieldList')
        const max = limitOf(await f.number('max'), 2000, 200)
        const res = await salesforce(
          client,
          {
            method: 'POST',
            path: `${client.data}/parameterizedSearch`,
            json: {
              q: await f.required('term'),
              overallLimit: max,
              ...(objects.length && {
                sobjects: objects.map((name) => ({ name, ...(fields.length && { fields }) })),
              }),
              ...(!objects.length && fields.length && { fields }),
            },
          },
          ctx,
        )
        const found = (res.data as { searchRecords?: unknown[] }).searchRecords ?? []
        return {
          data: (found as Record<string, unknown>[]).map((r) => ({
            type: (r.attributes as { type?: string } | undefined)?.type ?? null,
            ...(dropAttributes(r) as object),
          })),
          metadata: { count: found.length },
        }
      }
      case 'get': {
        const fields = await f.list('fieldList')
        const res = await salesforce(
          client,
          {
            method: 'GET',
            path: `${await sobject()}/${segment(await f.required('id'))}`,
            ...(fields.length && { query: { fields: fields.join(',') } }),
          },
          ctx,
        )
        return answer(dropAttributes(res.data), res)
      }
      case 'create': {
        const res = await salesforce(
          client,
          { method: 'POST', path: await sobject(), json: await record() },
          ctx,
        )
        return answer(res.data, res)
      }
      case 'update': {
        const id = await f.required('id')
        const res = await salesforce(
          client,
          { method: 'PATCH', path: `${await sobject()}/${segment(id)}`, json: await record() },
          ctx,
        )
        return answer({ id, updated: true }, res)
      }
      case 'upsert': {
        const path = `${await sobject()}/${segment(await f.required('externalIdField'))}/${segment(await f.required('externalId'))}`
        const res = await salesforce(client, { method: 'PATCH', path, json: await record() }, ctx)
        const body = (res.data ?? null) as { id?: string; created?: boolean } | null
        return answer({ id: body?.id ?? null, created: res.status === 201 || body?.created === true }, res)
      }
      case 'delete': {
        const id = await f.required('id')
        const res = await salesforce(
          client,
          { method: 'DELETE', path: `${await sobject()}/${segment(id)}` },
          ctx,
        )
        return answer({ id, deleted: true }, res)
      }
      case 'describe': {
        const res = await salesforce(client, { method: 'GET', path: `${await sobject()}/describe` }, ctx)
        const body = res.data as { name?: string; label?: string; fields?: Record<string, unknown>[] }
        return answer(
          (body.fields ?? []).map((fd) => ({
            name: fd.name,
            label: fd.label,
            type: fd.type,
            required: fd.nillable === false && fd.defaultedOnCreate === false && fd.createable === true,
            updateable: fd.updateable,
            ...(Array.isArray(fd.picklistValues) &&
              fd.picklistValues.length && {
                values: (fd.picklistValues as { value: string }[]).map((p) => p.value),
              }),
          })),
          res,
          { object: body.name, label: body.label },
        )
      }
      case 'api': {
        const res = await salesforce(client, await apiCall(f, '/services/data/', 'the data API'), ctx)
        return answer(res.data, res)
      }
      default:
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    }
  },
}
