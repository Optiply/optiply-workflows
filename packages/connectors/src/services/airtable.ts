import { z } from 'zod'
import { createHttpClient, destroyHttpClient, type HttpClient, type HttpResponse } from '../http-core'
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
  type ServiceSecrets,
  segment,
  serviceBase,
  serviceRestConfig,
  serviceRestSecrets,
  serviceSecretsSchema,
  validateActionQuery,
} from './common'

// Airtable (M29): a personal access token; records listed (by view or formula, paged through `offset`), read,
// created, updated, upserted and deleted in batches of 10 (Airtable's limit), a base's schema, and any /v0 endpoint.
// Records come back flat: `{id, createdTime, ...fields}`.

const configSchema = z.object({
  /** The base queries use when they name none (app…). */
  base: z
    .string()
    .trim()
    .regex(/^app\w{14}$/, 'A base id (app followed by 14 characters)')
    .optional(),
})
type Config = z.output<typeof configSchema>

interface AirtableClient {
  http: HttpClient
  config: Config
}

function httpConfig(_config: Config) {
  return serviceRestConfig(serviceBase('airtable', 'https://api.airtable.com'), { type: 'bearer' })
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

async function airtable(client: AirtableClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  const res = await call(client.http, request, ctx)
  if (res.ok) return res
  const error = (res.data as { error?: string | { type?: string; message?: string } } | null)?.error
  const message =
    typeof error === 'string'
      ? error
      : error?.message
        ? `${error.message}${error.type ? ` (${error.type})` : ''}`
        : `HTTP ${res.status}`
  throw new ConnectorError('http', `Airtable: ${message}`, {
    status: res.status,
    ...(typeof error === 'object' && error?.type && { type: error.type }),
  })
}

interface AirtableRecord {
  id: string
  createdTime?: string
  fields?: Record<string, unknown>
}

/** A record as a row: its id and creation time, then its fields. */
export function flatRecord(record: AirtableRecord): Record<string, unknown> {
  return {
    id: record.id,
    ...(record.createdTime && { createdTime: record.createdTime }),
    ...(record.fields ?? {}),
  }
}

/** Records given as one object or an array, each `{fields}` or a plain object of fields (with `id` for updates). */
export function recordsOf(
  value: unknown,
  needId: boolean,
): { id?: string; fields: Record<string, unknown> }[] {
  if (value === undefined || value === null) throw new ConnectorError('invalid_query', 'Records is empty')
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new ConnectorError('invalid_query', 'Records is empty')
  return list.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new ConnectorError('invalid_query', `Record ${i + 1} must be an object`)
    const { id, fields, ...rest } = item as { id?: unknown; fields?: unknown } & Record<string, unknown>
    const values =
      fields && typeof fields === 'object' && !Array.isArray(fields)
        ? (fields as Record<string, unknown>)
        : rest
    if (needId && (typeof id !== 'string' || !id))
      throw new ConnectorError('invalid_query', `Record ${i + 1} has no id`)
    return { ...(typeof id === 'string' && id && { id }), fields: values }
  })
}

/** In tens: Airtable takes at most 10 records per write. */
function tens<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += 10) out.push(items.slice(i, i + 10))
  return out
}

export const airtableConnector: Connector<Config, ServiceSecrets, ActionQuery, AirtableClient> = {
  type: 'airtable',
  label: 'Airtable',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema: actionQuerySchema('airtable'),
  scrubResultData: true,
  httpConfig,

  createClient({ config, secrets }) {
    if (!secrets.token) throw new ConnectorError('invalid_config', 'Add the personal access token (pat…)')
    return { http: createHttpClient(httpConfig(config), serviceRestSecrets(secrets)), config }
  },

  async destroyClient(client) {
    await destroyHttpClient(client.http)
  },

  async testConnection(client, ctx) {
    const res = await airtable(client, { method: 'GET', path: '/v0/meta/whoami' }, ctx)
    const me = res.data as { id?: string; email?: string; scopes?: string[] }
    return {
      message: `Airtable as ${me.email ?? me.id ?? 'the token'}${me.scopes ? ` (${me.scopes.join(', ')})` : ''}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('airtable', query, ctx)
    const base = async () => {
      const id = (await f.text('base')) ?? client.config.base
      if (!id)
        throw new ConnectorError('invalid_query', 'Name the base, or set a default base on the resource')
      return segment(id)
    }
    const table = async () => `/v0/${await base()}/${segment(await f.required('table'))}`
    const typecast = async () => ((await f.bool('typecast')) ? { typecast: true } : {})

    switch (query.action) {
      case 'list': {
        const path = `${await table()}/listRecords`
        const max = limitOf(await f.number('max'), 100_000)
        const view = await f.text('view')
        const formula = await f.text('filterByFormula')
        const sort = await f.json('sort')
        const fields = await f.list('fields')
        const records: Record<string, unknown>[] = []
        let offset: string | undefined
        do {
          const res = await airtable(
            client,
            {
              method: 'POST',
              path,
              json: {
                pageSize: Math.min(100, max - records.length),
                ...(view && { view }),
                ...(formula && { filterByFormula: formula }),
                ...(Array.isArray(sort) && sort.length && { sort }),
                ...(fields.length && { fields }),
                ...(offset && { offset }),
              },
            },
            ctx,
          )
          const body = res.data as { records?: AirtableRecord[]; offset?: string }
          records.push(...(body.records ?? []).map(flatRecord))
          offset = body.offset
        } while (offset && records.length < max)
        return {
          data: records.slice(0, max),
          metadata: { count: Math.min(records.length, max), more: !!offset },
        }
      }
      case 'get': {
        const res = await airtable(
          client,
          { method: 'GET', path: `${await table()}/${segment(await f.required('id'))}` },
          ctx,
        )
        return answer(flatRecord(res.data as AirtableRecord), res)
      }
      case 'create':
      case 'update':
      case 'upsert': {
        const path = await table()
        const records = recordsOf(await f.json('records'), query.action === 'update')
        const mergeOn = query.action === 'upsert' ? await f.list('mergeOn') : []
        if (query.action === 'upsert' && mergeOn.length === 0)
          throw new ConnectorError('invalid_query', 'Match on is empty')
        const extra = await typecast()
        const out: Record<string, unknown>[] = []
        const created: string[] = []
        const updated: string[] = []
        for (const batch of tens(records)) {
          const res = await airtable(
            client,
            {
              method: query.action === 'create' ? 'POST' : 'PATCH',
              path,
              json: {
                records: batch.map((r) =>
                  query.action === 'update' ? { id: r.id, fields: r.fields } : { fields: r.fields },
                ),
                ...(query.action === 'upsert' && { performUpsert: { fieldsToMergeOn: mergeOn } }),
                ...extra,
              },
            },
            ctx,
          )
          const body = res.data as {
            records?: AirtableRecord[]
            createdRecords?: string[]
            updatedRecords?: string[]
          }
          out.push(...(body.records ?? []).map(flatRecord))
          created.push(...(body.createdRecords ?? []))
          updated.push(...(body.updatedRecords ?? []))
        }
        return {
          data: out,
          metadata: { count: out.length, ...(query.action === 'upsert' && { created, updated }) },
        }
      }
      case 'delete': {
        const path = await table()
        const ids = await f.list('ids')
        if (ids.length === 0) throw new ConnectorError('invalid_query', 'Record ids is empty')
        const deleted: string[] = []
        for (const batch of tens(ids)) {
          const res = await airtable(
            client,
            { method: 'DELETE', path, pairs: batch.map((id) => ['records[]', id] as [string, string]) },
            ctx,
          )
          for (const r of (res.data as { records?: { id: string; deleted?: boolean }[] }).records ?? [])
            if (r.deleted) deleted.push(r.id)
        }
        return { data: { deleted }, metadata: { count: deleted.length } }
      }
      case 'schema': {
        const res = await airtable(
          client,
          { method: 'GET', path: `/v0/meta/bases/${await base()}/tables` },
          ctx,
        )
        return answer((res.data as { tables?: unknown[] }).tables ?? [], res)
      }
      case 'api': {
        const res = await airtable(client, await apiCall(f, '/v0/', 'the API'), ctx)
        return answer(res.data, res)
      }
      default:
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    }
  },
}
