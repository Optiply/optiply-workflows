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
  limitOf,
  restAuthFor,
  type ServiceCall,
  type ServiceSecrets,
  segment,
  serviceBase,
  serviceRestConfig,
  serviceRestSecrets,
  serviceSecretsSchema,
  tokenOrOAuthSchema,
  validateActionQuery,
} from './common'

// HubSpot (M27): a private app's token or M9's OAuth; CRM records by the v3 objects API, associations by v4.

const configSchema = z.object({ auth: tokenOrOAuthSchema(oauthPresets.hubspot) })
type Config = z.output<typeof configSchema>

function httpConfig(config: Config) {
  return serviceRestConfig(
    serviceBase('hubspot', 'https://api.hubapi.com'),
    restAuthFor(config.auth, oauthPresets.hubspot),
  )
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

/** A CRM object type: a standard one's name, or a custom object's type id (`2-1234567`, `p123_cars`). */
function objectType(value: string): string {
  if (!/^[\w-]+$/.test(value))
    throw new ConnectorError('invalid_query', `"${value}" isn't a HubSpot object type`)
  return value
}

/** A call whose non-2xx answer is HubSpot's error: its message, category and correlation id. */
async function hubspot(client: HttpClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  const res = await call(client, request, ctx)
  if (res.ok) return res
  const body = (res.data !== null && typeof res.data === 'object' ? res.data : {}) as {
    message?: string
    category?: string
    correlationId?: string
    errors?: unknown
  }
  const message =
    body.message ?? (typeof res.data === 'string' ? res.data.slice(0, 300) : `HTTP ${res.status}`)
  throw new ConnectorError('http', `HubSpot: ${message}`, {
    status: res.status,
    ...(body.category && { category: body.category }),
    ...(body.correlationId && { correlationId: body.correlationId }),
    ...(body.errors !== undefined && { errors: body.errors }),
  })
}

/** Simple filters (`[{propertyName, operator, value}]`, all must match) or HubSpot's own `filterGroups`. */
function filterGroups(filters: unknown): unknown[] {
  if (filters === undefined || filters === null) return []
  if (!Array.isArray(filters)) throw new ConnectorError('invalid_query', 'Filters must be a JSON array')
  if (filters.length === 0) return []
  const groups = filters.every(
    (f) => f && typeof f === 'object' && Array.isArray((f as { filters?: unknown }).filters),
  )
  return groups ? filters : [{ filters }]
}

/** A property definition, as the forms list them. */
export interface HubSpotProperty {
  name: string
  label: string
  type: string
  fieldType: string
  options?: { label: string; value: string }[]
}

/** An object type's properties (`/crm/v3/properties/<type>`), for the editor's forms. */
export async function hubspotProperties(
  client: HttpClient,
  type: string,
  ctx: Ctx,
): Promise<HubSpotProperty[]> {
  const res = await hubspot(
    client,
    { method: 'GET', path: `/crm/v3/properties/${segment(objectType(type))}` },
    ctx,
  )
  const results = (res.data as { results?: Record<string, unknown>[] }).results ?? []
  return results
    .filter((p) => !p.hidden)
    .map((p) => ({
      name: String(p.name),
      label: String(p.label ?? p.name),
      type: String(p.type ?? 'string'),
      fieldType: String(p.fieldType ?? 'text'),
      ...(Array.isArray(p.options) &&
        p.options.length > 0 && {
          options: (p.options as { label: string; value: string }[]).map(({ label, value }) => ({
            label,
            value,
          })),
        }),
    }))
}

export const hubspotConnector: Connector<Config, ServiceSecrets, ActionQuery, HttpClient> = {
  type: 'hubspot',
  label: 'HubSpot',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema: actionQuerySchema('hubspot'),
  scrubResultData: true,

  createClient({ config, secrets }) {
    if (config.auth.type === 'token' && !secrets.token) {
      throw new ConnectorError('invalid_config', 'Add the private app’s access token (pat-…)')
    }
    return createHttpClient(httpConfig(config), serviceRestSecrets(secrets))
  },

  destroyClient: destroyHttpClient,

  httpConfig,

  async testConnection(client, ctx) {
    const res = await hubspot(client, { method: 'GET', path: '/account-info/v3/details' }, ctx)
    const account = res.data as { portalId?: number; companyCurrency?: string; uiDomain?: string }
    return {
      message: `HubSpot account ${account.portalId ?? '?'}${account.uiDomain ? ` (${account.uiDomain})` : ''}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('hubspot', query, ctx)
    const done = (data: unknown, res: HttpResponse, extra: Record<string, unknown> = {}) => ({
      data,
      metadata: { ...responseMetadata(res), ...extra },
    })
    const objects = async (key = 'objectType') =>
      `/crm/v3/objects/${segment(objectType(await f.required(key)))}`
    const idQuery = async () => {
      const idProperty = await f.text('idProperty')
      return idProperty ? { idProperty } : {}
    }
    switch (query.action) {
      case 'search': {
        const max = limitOf(await f.number('max'), 10_000, 1000)
        const properties = await f.list('properties')
        const sorts = await f.json('sorts')
        const text = await f.text('query')
        const results: unknown[] = []
        let after: string | undefined
        let total = 0
        let res: HttpResponse
        do {
          res = await hubspot(
            client,
            {
              method: 'POST',
              path: `${await objects()}/search`,
              json: {
                filterGroups: filterGroups(await f.json('filters')),
                ...(properties.length && { properties }),
                ...(sorts !== undefined && { sorts }),
                ...(text && { query: text }),
                limit: Math.min(200, max - results.length),
                ...(after && { after }),
              },
            },
            ctx,
          )
          const page = res.data as {
            total?: number
            results?: unknown[]
            paging?: { next?: { after?: string } }
          }
          total = page.total ?? total
          results.push(...(page.results ?? []))
          after = page.paging?.next?.after
        } while (after && results.length < max)
        return done(results.slice(0, max), res, { total, truncated: Boolean(after) })
      }
      case 'get': {
        const properties = await f.list('properties')
        const associations = await f.list('associations')
        const res = await hubspot(
          client,
          {
            method: 'GET',
            path: `${await objects()}/${segment(await f.required('id'))}`,
            query: {
              ...(await idQuery()),
              ...(properties.length && { properties: properties.join(',') }),
              ...(associations.length && { associations: associations.join(',') }),
            },
          },
          ctx,
        )
        return done(res.data, res)
      }
      case 'create': {
        const res = await hubspot(
          client,
          {
            method: 'POST',
            path: await objects(),
            json: { properties: await requiredObject(f, 'properties') },
          },
          ctx,
        )
        return done(res.data, res)
      }
      case 'update': {
        const res = await hubspot(
          client,
          {
            method: 'PATCH',
            path: `${await objects()}/${segment(await f.required('id'))}`,
            query: await idQuery(),
            json: { properties: await requiredObject(f, 'properties') },
          },
          ctx,
        )
        return done(res.data, res)
      }
      case 'archive': {
        const id = await f.required('id')
        const res = await hubspot(
          client,
          { method: 'DELETE', path: `${await objects()}/${segment(id)}` },
          ctx,
        )
        return done({ id, archived: true }, res)
      }
      case 'batchUpsert': {
        const idProperty = await f.required('idProperty')
        const records = await f.value('records')
        if (!Array.isArray(records))
          throw new ConnectorError('invalid_query', 'Records must be an array of objects')
        const inputs = records.map((record, i) => {
          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new ConnectorError('invalid_query', `Record ${i + 1} isn't an object`)
          }
          const properties = record as Record<string, unknown>
          const id = properties[idProperty]
          if (id === undefined || id === null || id === '') {
            throw new ConnectorError('invalid_query', `Record ${i + 1} has no ${idProperty}`)
          }
          return { idProperty, id: String(id), properties }
        })
        const results: unknown[] = []
        let res: HttpResponse | undefined
        for (let i = 0; i < inputs.length; i += 100) {
          res = await hubspot(
            client,
            {
              method: 'POST',
              path: `${await objects()}/batch/upsert`,
              json: { inputs: inputs.slice(i, i + 100) },
            },
            ctx,
          )
          results.push(...((res.data as { results?: unknown[] }).results ?? []))
        }
        if (!res) return { data: [], metadata: {} }
        return done(results, res)
      }
      case 'associate': {
        const from = `${segment(objectType(await f.required('fromType')))}/${segment(await f.required('fromId'))}`
        const to = `${segment(objectType(await f.required('toType')))}/${segment(await f.required('toId'))}`
        const res = await hubspot(
          client,
          { method: 'PUT', path: `/crm/v4/objects/${from}/associations/default/${to}` },
          ctx,
        )
        return done(res.data, res)
      }
      case 'api': {
        const path = await f.required('path')
        if (!path.startsWith('/') || path.includes('..')) {
          throw new ConnectorError('invalid_query', 'The path starts with / and stays under api.hubapi.com')
        }
        const params = await f.object('query')
        const body = await f.json('body')
        const res = await hubspot(
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
        return done(res.data, res)
      }
    }
    throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
  },
}

async function requiredObject(
  f: ReturnType<typeof fieldReader>,
  key: string,
): Promise<Record<string, unknown>> {
  const value = await f.object(key)
  if (!value || Object.keys(value).length === 0)
    throw new ConnectorError('invalid_query', 'Give at least one property')
  return value
}
