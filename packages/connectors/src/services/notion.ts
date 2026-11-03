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
  serviceBase,
  serviceRestConfig,
  serviceRestSecrets,
  serviceSecretsSchema,
  validateActionQuery,
} from './common'

// Notion (M29): an internal integration's token; databases queried and pages read, created and updated with their
// properties as plain values (turned into Notion's property objects by the database's or page's own schema), pages
// archived, content added from simple lines and read back as text, search, and any /v1 endpoint.

const NOTION_VERSION = '2022-06-28'

const configSchema = z.object({})
type Config = z.output<typeof configSchema>

function httpConfig(_config: Config) {
  return serviceRestConfig(serviceBase('notion', 'https://api.notion.com'), { type: 'bearer' })
}

type Ctx = { signal: AbortSignal; credentials?: CredentialSource | undefined }

async function notion(client: HttpClient, request: ServiceCall, ctx: Ctx): Promise<HttpResponse> {
  const res = await call(client, { ...request, extraHeaders: [['notion-version', NOTION_VERSION]] }, ctx)
  if (res.ok) return res
  const body = res.data as { code?: string; message?: string } | null
  throw new ConnectorError('http', `Notion: ${body?.message ?? `HTTP ${res.status}`}`, {
    status: res.status,
    ...(body?.code && { code: body.code }),
  })
}

/** An id from an id (with or without dashes) or a Notion URL (the 32 hex characters at its end). */
export function notionId(value: string): string {
  const hex = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(value.replaceAll('-', ''))
  if (!hex) throw new ConnectorError('invalid_query', `"${value}" isn't a Notion id or URL`)
  const h = hex[1]!.toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

type RichText = { plain_text?: string; text?: { content?: string } }[]
const plainText = (rich: RichText | undefined) =>
  (rich ?? []).map((t) => t.plain_text ?? t.text?.content ?? '').join('')
const richText = (text: string) => (text ? [{ type: 'text', text: { content: text } }] : [])

/** A property's plain value: text, a number, a name or names, a date, ids… */
export function plainProperty(prop: Record<string, unknown>): unknown {
  const type = prop.type as string
  const v = prop[type] as unknown
  switch (type) {
    case 'title':
    case 'rich_text':
      return plainText(v as RichText)
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return v ?? null
    case 'select':
    case 'status':
      return (v as { name?: string } | null)?.name ?? null
    case 'multi_select':
      return ((v as { name: string }[] | null) ?? []).map((o) => o.name)
    case 'date': {
      const d = v as { start?: string; end?: string | null } | null
      if (!d) return null
      return d.end ? { start: d.start, end: d.end } : (d.start ?? null)
    }
    case 'people':
      return ((v as { id: string; name?: string }[] | null) ?? []).map((p) => p.name ?? p.id)
    case 'relation':
      return ((v as { id: string }[] | null) ?? []).map((r) => r.id)
    case 'files':
      return (
        (v as { name?: string; file?: { url?: string }; external?: { url?: string } }[] | null) ?? []
      ).map((f) => f.file?.url ?? f.external?.url ?? f.name)
    case 'formula': {
      const fv = v as Record<string, unknown> | null
      return fv ? (fv[fv.type as string] ?? null) : null
    }
    case 'rollup': {
      const rv = v as Record<string, unknown> | null
      if (!rv) return null
      const inner = rv[rv.type as string]
      return Array.isArray(inner)
        ? inner.map((x) =>
            x && typeof x === 'object' && 'type' in x ? plainProperty(x as Record<string, unknown>) : x,
          )
        : (inner ?? null)
    }
    case 'unique_id': {
      const u = v as { prefix?: string | null; number?: number } | null
      return u ? `${u.prefix ? `${u.prefix}-` : ''}${u.number}` : null
    }
    case 'created_by':
    case 'last_edited_by':
      return (v as { id?: string; name?: string } | null)?.name ?? (v as { id?: string } | null)?.id ?? null
    default:
      return v ?? null
  }
}

/** A page as a row: id, url, times, then each property's plain value. */
export function flatPage(page: Record<string, unknown>): Record<string, unknown> {
  const props = (page.properties ?? {}) as Record<string, Record<string, unknown>>
  return {
    id: page.id,
    url: page.url,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    ...(page.archived ? { archived: true } : {}),
    ...Object.fromEntries(Object.entries(props).map(([name, p]) => [name, plainProperty(p)])),
  }
}

/** A plain value as a property of `type`; an object already in Notion's shape (`{[type]: …}`) passes through. */
export function notionProperty(type: string, value: unknown, name: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value) && type in (value as object))
    return value as Record<string, unknown>
  const list = (x: unknown) =>
    Array.isArray(x)
      ? x
      : x === null || x === undefined || x === ''
        ? []
        : String(x)
            .split(',')
            .map((s) => s.trim())
  switch (type) {
    case 'title':
    case 'rich_text':
      return { [type]: richText(value === null || value === undefined ? '' : String(value)) }
    case 'number': {
      if (value === null || value === '') return { number: null }
      const n = Number(value)
      if (!Number.isFinite(n))
        throw new ConnectorError('invalid_query', `${name}: "${String(value)}" isn't a number`)
      return { number: n }
    }
    case 'checkbox':
      return { checkbox: value === true || /^(true|yes|1|on)$/i.test(String(value)) }
    case 'select':
    case 'status':
      return { [type]: value === null || value === '' ? null : { name: String(value) } }
    case 'multi_select':
      return { multi_select: list(value).map((n) => ({ name: String(n) })) }
    case 'date': {
      if (value === null || value === '') return { date: null }
      if (value && typeof value === 'object' && 'start' in (value as object)) return { date: value }
      return { date: { start: value instanceof Date ? value.toISOString() : String(value) } }
    }
    case 'url':
    case 'email':
    case 'phone_number':
      return { [type]: value === '' || value === undefined ? null : value }
    case 'people':
      return { people: list(value).map((id) => ({ id: String(id) })) }
    case 'relation':
      return { relation: list(value).map((id) => ({ id: notionId(String(id)) })) }
    default:
      throw new ConnectorError(
        'invalid_query',
        `${name}: a ${type} property can't be set from a plain value (give Notion's object)`,
      )
  }
}

/** Plain values by property name, as Notion's properties, by a schema of `{name: {type}}`. */
export function notionProperties(
  values: Record<string, unknown>,
  schema: Record<string, { type?: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const type = schema[name]?.type
    if (!type)
      throw new ConnectorError(
        'invalid_query',
        `There's no property "${name}" (have: ${Object.keys(schema).join(', ')})`,
      )
    out[name] = notionProperty(type, value, name)
  }
  return out
}

/** Simple lines as blocks: `# `/`## `/`### ` headings, `- `/`* ` bullets, `1. ` numbered, `[ ]`/`[x]` to-dos, paragraphs. */
export function notionBlocks(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return [value]
  const blocks: unknown[] = []
  const block = (type: string, text: string, extra: object = {}) => ({
    object: 'block',
    type,
    [type]: { rich_text: richText(text), ...extra },
  })
  const rules: [RegExp, (m: RegExpExecArray) => unknown][] = [
    [/^(#{1,3}) (.*)$/, (m) => block(`heading_${m[1]!.length}`, m[2]!)],
    [/^\s*(?:[-*] )?\[( |x|X)\] (.*)$/, (m) => block('to_do', m[2]!, { checked: m[1] !== ' ' })],
    [/^\s*[-*] (.*)$/, (m) => block('bulleted_list_item', m[1]!)],
    [/^\s*\d+[.)] (.*)$/, (m) => block('numbered_list_item', m[1]!)],
  ]
  for (const line of String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')) {
    if (!line.trim()) continue
    let made: unknown = block('paragraph', line)
    for (const [pattern, make] of rules) {
      const m = pattern.exec(line)
      if (m) {
        made = make(m)
        break
      }
    }
    blocks.push(made)
  }
  return blocks
}

/** A block's plain text (its rich text joined), for reading content back. */
function blockText(block: Record<string, unknown>): string {
  const inner = block[block.type as string] as { rich_text?: RichText } | undefined
  return plainText(inner?.rich_text)
}

export const notionConnector: Connector<Config, ServiceSecrets, ActionQuery, HttpClient> = {
  type: 'notion',
  label: 'Notion',
  configSchema,
  secretsSchema: serviceSecretsSchema,
  querySchema: actionQuerySchema('notion'),
  scrubResultData: true,
  httpConfig,

  createClient({ config, secrets }) {
    if (!secrets.token)
      throw new ConnectorError('invalid_config', 'Add the integration’s token (ntn_… or secret_…)')
    return createHttpClient(httpConfig(config), serviceRestSecrets(secrets))
  },

  destroyClient: destroyHttpClient,

  async testConnection(client, ctx) {
    const res = await notion(client, { method: 'GET', path: '/v1/users/me' }, ctx)
    const me = res.data as { name?: string; bot?: { workspace_name?: string } }
    return {
      message: `Notion as ${me.name ?? 'the integration'}${me.bot?.workspace_name ? ` in ${me.bot.workspace_name}` : ''}`,
    }
  },

  validateQuery: validateActionQuery,

  async execute(client, query, ctx): Promise<QueryResult> {
    const f = fieldReader('notion', query, ctx)
    const idOf = async (key = 'id') => notionId(await f.required(key))
    const paged = async (
      path: string,
      method: 'GET' | 'POST',
      body: Record<string, unknown>,
      max: number,
    ) => {
      const results: Record<string, unknown>[] = []
      let cursor: string | undefined
      let more = false
      do {
        const pageSize = Math.min(100, max - results.length)
        const res = await notion(
          client,
          method === 'POST'
            ? {
                method,
                path,
                json: { ...body, page_size: pageSize, ...(cursor && { start_cursor: cursor }) },
              }
            : { method, path, query: { page_size: pageSize, ...(cursor && { start_cursor: cursor }) } },
          ctx,
        )
        const out = res.data as {
          results?: Record<string, unknown>[]
          has_more?: boolean
          next_cursor?: string | null
        }
        results.push(...(out.results ?? []))
        more = !!out.has_more
        cursor = out.next_cursor ?? undefined
      } while (more && cursor && results.length < max)
      return { results: results.slice(0, max), more }
    }

    switch (query.action) {
      case 'queryDatabase': {
        const filter = await f.object('filter')
        const sorts = await f.json('sorts')
        const { results, more } = await paged(
          `/v1/databases/${await idOf()}/query`,
          'POST',
          { ...(filter && { filter }), ...(Array.isArray(sorts) && sorts.length && { sorts }) },
          limitOf(await f.number('max')),
        )
        return { data: results.map(flatPage), metadata: { count: results.length, more } }
      }
      case 'getPage': {
        const res = await notion(client, { method: 'GET', path: `/v1/pages/${await idOf()}` }, ctx)
        return answer(flatPage(res.data as Record<string, unknown>), res)
      }
      case 'createPage': {
        const parent = await idOf('parent')
        const values = (await f.object('properties')) ?? {}
        const content = await f.value('content')
        const children = content === undefined || content === '' ? [] : notionBlocks(content)
        // A database takes properties by its schema; a page takes a title. Which one it is, Notion says.
        const db = await call(
          client,
          {
            method: 'GET',
            path: `/v1/databases/${parent}`,
            extraHeaders: [['notion-version', NOTION_VERSION]],
          },
          ctx,
        )
        let body: Record<string, unknown>
        if (db.ok) {
          const schema = (db.data as { properties?: Record<string, { type?: string }> }).properties ?? {}
          body = { parent: { database_id: parent }, properties: notionProperties(values, schema) }
        } else if (db.status === 404 || db.status === 400) {
          const title =
            (await f.text('title')) ?? (typeof values.title === 'string' ? values.title : undefined)
          if (!title) throw new ConnectorError('invalid_query', 'A page under a page needs a title')
          body = { parent: { page_id: parent }, properties: { title: { title: richText(title) } } }
        } else {
          const e = db.data as { message?: string } | null
          throw new ConnectorError('http', `Notion: ${e?.message ?? `HTTP ${db.status}`}`, {
            status: db.status,
          })
        }
        const res = await notion(
          client,
          {
            method: 'POST',
            path: '/v1/pages',
            json: { ...body, ...(children.length && { children: children.slice(0, 100) }) },
          },
          ctx,
        )
        const page = res.data as Record<string, unknown>
        if (children.length > 100) {
          for (let i = 100; i < children.length; i += 100)
            await notion(
              client,
              {
                method: 'PATCH',
                path: `/v1/blocks/${page.id}/children`,
                json: { children: children.slice(i, i + 100) },
              },
              ctx,
            )
        }
        return answer(flatPage(page), res)
      }
      case 'updatePage': {
        const id = await idOf()
        const values = (await f.object('properties')) ?? {}
        if (Object.keys(values).length === 0) throw new ConnectorError('invalid_query', 'Properties is empty')
        const current = await notion(client, { method: 'GET', path: `/v1/pages/${id}` }, ctx)
        const page = current.data as {
          properties?: Record<string, { type?: string }>
          parent?: { database_id?: string }
        }
        // A database page: its database's schema (every property, set or not), then the page's own.
        let schema = page.properties ?? {}
        if (page.parent?.database_id) {
          const db = await notion(
            client,
            { method: 'GET', path: `/v1/databases/${page.parent.database_id}` },
            ctx,
          )
          schema = {
            ...((db.data as { properties?: Record<string, { type?: string }> }).properties ?? {}),
            ...schema,
          }
        }
        const res = await notion(
          client,
          {
            method: 'PATCH',
            path: `/v1/pages/${id}`,
            json: { properties: notionProperties(values, schema) },
          },
          ctx,
        )
        return answer(flatPage(res.data as Record<string, unknown>), res)
      }
      case 'archivePage': {
        const res = await notion(
          client,
          { method: 'PATCH', path: `/v1/pages/${await idOf()}`, json: { archived: true } },
          ctx,
        )
        return answer(flatPage(res.data as Record<string, unknown>), res)
      }
      case 'appendBlocks': {
        const id = await idOf()
        const children = notionBlocks(await f.value('content'))
        if (children.length === 0) throw new ConnectorError('invalid_query', 'Content is empty')
        const added: unknown[] = []
        for (let i = 0; i < children.length; i += 100) {
          const res = await notion(
            client,
            {
              method: 'PATCH',
              path: `/v1/blocks/${id}/children`,
              json: { children: children.slice(i, i + 100) },
            },
            ctx,
          )
          added.push(...((res.data as { results?: unknown[] }).results ?? []))
        }
        return { data: { added: added.length }, metadata: {} }
      }
      case 'getBlocks': {
        const { results, more } = await paged(
          `/v1/blocks/${await idOf()}/children`,
          'GET',
          {},
          limitOf(await f.number('max')),
        )
        return {
          data: results.map((b) => ({
            id: b.id,
            type: b.type,
            text: blockText(b),
            hasChildren: !!b.has_children,
          })),
          metadata: { count: results.length, more },
        }
      }
      case 'search': {
        const text = await f.text('query')
        const only = await f.text('only')
        const { results, more } = await paged(
          '/v1/search',
          'POST',
          { ...(text && { query: text }), ...(only && { filter: { property: 'object', value: only } }) },
          limitOf(await f.number('max')),
        )
        return {
          data: results.map((r) =>
            r.object === 'database'
              ? { id: r.id, object: 'database', title: plainText(r.title as RichText), url: r.url }
              : { object: 'page', ...flatPage(r) },
          ),
          metadata: { count: results.length, more },
        }
      }
      case 'api': {
        const res = await notion(client, await apiCall(f, '/v1/', 'the API'), ctx)
        return answer(res.data, res)
      }
      default:
        throw new ConnectorError('invalid_query', `Unknown action "${query.action}"`)
    }
  },
}
