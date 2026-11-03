import { createHash } from 'node:crypto'
import { parseTemplate, renderJson, renderTemplate, TemplateError } from '@ow/expressions'
import { FormData } from 'undici'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  createHttpClient,
  destroyHttpClient,
  fileValue,
  type HttpClient,
  httpError,
  httpRequest,
  testHttp,
} from './http-core'
import { responseMetadata, restConfigSchema, restSecretsSchema } from './rest'
import { type Connector, ConnectorError, type QueryContext, type QueryResult } from './types'

// An OpenAPI resource (M29): REST's settings plus an OpenAPI 3.0/3.1 or Swagger 2.0 document (pasted, or fetched from
// a URL into the settings), whose operations become the queries: an operation id, its parameters by name (placed in
// the path, query, headers or cookies as the document says, with its styles) and a body sent in its media type.

export const OPENAPI_MAX_SPEC = 5 * 1024 * 1024

export interface OpenApiSchema {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  items?: OpenApiSchema
  properties?: Record<string, OpenApiSchema>
  required?: string[]
  description?: string
  default?: unknown
  example?: unknown
  [key: string]: unknown
}

export interface OpenApiParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  description?: string
  schema?: OpenApiSchema
  style: string
  explode: boolean
}

export interface OpenApiOperation {
  id: string
  method: string
  path: string
  summary?: string
  description?: string
  tags: string[]
  deprecated?: boolean
  parameters: OpenApiParameter[]
  body?: { required: boolean; contentTypes: string[]; schema?: OpenApiSchema; example?: unknown }
}

export interface OpenApiDocument {
  title: string
  version: string
  /** OpenAPI 3.x or Swagger 2.0, as the document says. */
  openapi: string
  servers: string[]
  operations: OpenApiOperation[]
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

type Json = Record<string, unknown>

/** A local `$ref` (`#/a/b`) followed, again and again; remote refs are refused. */
function deref(doc: Json, node: unknown, depth = 0): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const ref = (node as Json).$ref
  if (typeof ref !== 'string') return node
  if (depth > 20) throw new ConnectorError('invalid_config', `The OpenAPI document's $ref ${ref} loops`)
  if (!ref.startsWith('#/'))
    throw new ConnectorError('invalid_config', `Only references inside the document are followed (${ref})`)
  let target: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~')
    target = target && typeof target === 'object' ? (target as Json)[key] : undefined
  }
  if (target === undefined) throw new ConnectorError('invalid_config', `The OpenAPI document has no ${ref}`)
  return deref(doc, target, depth + 1)
}

/**
 * A schema with its `$ref`s followed one level below the top: enough for parameters' types, a body's fields (and
 * which are files) and an example; deeper levels stay as their type only. Expanding further grows combinatorially on
 * large real documents (Stripe's, GitHub's), and the result is cached and sent to the browser.
 */
function schemaOf(doc: Json, node: unknown, depth = 0): OpenApiSchema | undefined {
  const s = deref(doc, node) as OpenApiSchema | undefined
  if (!s || typeof s !== 'object') return undefined
  if (depth > 1) return { type: s.type, ...(s.description && { description: s.description }) }
  const out: OpenApiSchema = { ...s }
  if (s.items) out.items = schemaOf(doc, s.items, depth + 1)
  if (s.properties)
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, schemaOf(doc, v, depth + 1) ?? {}]),
    )
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const list = s[key]
    if (Array.isArray(list)) out[key] = list.map((x) => schemaOf(doc, x, depth + 1))
  }
  // allOf's object parts merged, for forms and examples.
  if (Array.isArray(out.allOf)) {
    for (const part of out.allOf as OpenApiSchema[]) {
      if (part?.properties) out.properties = { ...(out.properties ?? {}), ...part.properties }
      if (part?.required) out.required = [...(out.required ?? []), ...part.required]
      if (!out.type && part?.type) out.type = part.type
    }
  }
  return out
}

/** An example value for a schema: its example or default, else built from its type (objects by their properties). */
export function exampleOf(schema: OpenApiSchema | undefined, depth = 0): unknown {
  if (!schema) return null
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
  if (depth > 4) return null
  if (type === 'object' || schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([k, v]) => [k, exampleOf(v, depth + 1)]),
    )
  }
  if (type === 'array') return [exampleOf(schema.items, depth + 1)]
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'string')
    return schema.format === 'date-time'
      ? '2026-01-01T00:00:00Z'
      : schema.format === 'date'
        ? '2026-01-01'
        : ''
  return null
}

const COLLECTION: Record<string, { style: string; explode: boolean }> = {
  csv: { style: 'form', explode: false },
  ssv: { style: 'spaceDelimited', explode: false },
  tsv: { style: 'tabDelimited', explode: false },
  pipes: { style: 'pipeDelimited', explode: false },
  multi: { style: 'form', explode: true },
}

/** Parses a document (JSON or YAML) into its operations, Swagger 2.0 read as OpenAPI 3. */
export function parseOpenApi(text: string): OpenApiDocument {
  if (text.length > OPENAPI_MAX_SPEC)
    throw new ConnectorError('invalid_config', 'The OpenAPI document is larger than 5 MB')
  let doc: Json
  try {
    const trimmed = text.trimStart()
    doc = (trimmed.startsWith('{') ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 })) as Json
  } catch (err) {
    throw new ConnectorError(
      'invalid_config',
      `The OpenAPI document doesn't parse: ${(err as Error).message.split('\n')[0]}`,
    )
  }
  if (!doc || typeof doc !== 'object')
    throw new ConnectorError('invalid_config', "The OpenAPI document isn't an object")
  const swagger = typeof doc.swagger === 'string' && doc.swagger.startsWith('2.')
  const openapi = swagger ? String(doc.swagger) : String(doc.openapi ?? '')
  if (!swagger && !/^3\.[01]/.test(openapi))
    throw new ConnectorError('invalid_config', 'Give an OpenAPI 3.0 or 3.1 document, or Swagger 2.0')
  const info = (doc.info ?? {}) as Json
  const servers = swagger
    ? (() => {
        const base = typeof doc.basePath === 'string' ? doc.basePath : ''
        if (typeof doc.host !== 'string') return base ? [base] : []
        const schemes =
          Array.isArray(doc.schemes) && doc.schemes.length ? (doc.schemes as string[]) : ['https']
        return schemes.map((s) => `${s}://${doc.host}${base}`)
      })()
    : (((doc.servers as Json[] | undefined) ?? [])
        .map((s) => {
          let url = String(s.url ?? '')
          // Server variables filled with their defaults.
          for (const [name, v] of Object.entries((s.variables ?? {}) as Record<string, Json>))
            url = url.replaceAll(`{${name}}`, String(v.default ?? ''))
          return url
        })
        .filter(Boolean) as string[])
  const consumes = Array.isArray(doc.consumes) ? (doc.consumes as string[]) : ['application/json']

  const operations: OpenApiOperation[] = []
  const ids = new Set<string>()
  for (const [path, rawItem] of Object.entries((doc.paths ?? {}) as Json)) {
    const item = deref(doc, rawItem) as Json
    const shared = (item.parameters as unknown[] | undefined) ?? []
    for (const method of METHODS) {
      const op = item[method] as Json | undefined
      if (!op) continue
      const params = new Map<string, OpenApiParameter>()
      let body: OpenApiOperation['body']
      const formData: Record<string, OpenApiSchema> = {}
      const formRequired: string[] = []
      let fileUpload = false
      for (const raw of [...shared, ...((op.parameters as unknown[] | undefined) ?? [])]) {
        const p = deref(doc, raw) as Json
        const where = String(p.in)
        if (swagger && where === 'body') {
          body = {
            required: p.required === true,
            contentTypes: Array.isArray(op.consumes) ? (op.consumes as string[]) : consumes,
            ...(p.schema !== undefined && { schema: schemaOf(doc, p.schema) }),
          }
          continue
        }
        if (swagger && where === 'formData') {
          formData[String(p.name)] = {
            type: String(p.type ?? 'string'),
            ...(p.description ? { description: String(p.description) } : {}),
          }
          if (p.type === 'file') fileUpload = true
          if (p.required) formRequired.push(String(p.name))
          continue
        }
        if (!['path', 'query', 'header', 'cookie'].includes(where)) continue
        const collection = swagger ? COLLECTION[String(p.collectionFormat ?? 'csv')] : undefined
        const style = String(
          p.style ?? collection?.style ?? (where === 'query' || where === 'cookie' ? 'form' : 'simple'),
        )
        const schema = swagger
          ? schemaOf(doc, {
              type: p.type,
              ...(p.items ? { items: p.items } : {}),
              ...(p.enum ? { enum: p.enum } : {}),
              ...(p.default !== undefined ? { default: p.default } : {}),
            })
          : schemaOf(doc, p.schema)
        params.set(`${where}:${p.name}`, {
          name: String(p.name),
          in: where as OpenApiParameter['in'],
          required: where === 'path' || p.required === true,
          ...(p.description ? { description: String(p.description) } : {}),
          ...(schema && { schema }),
          style,
          explode:
            typeof p.explode === 'boolean' ? p.explode : collection ? collection.explode : style === 'form',
        })
      }
      if (Object.keys(formData).length) {
        body = {
          required: formRequired.length > 0,
          contentTypes: [fileUpload ? 'multipart/form-data' : 'application/x-www-form-urlencoded'],
          schema: { type: 'object', properties: formData, required: formRequired },
        }
      }
      if (!swagger && op.requestBody) {
        const rb = deref(doc, op.requestBody) as Json
        const content = (rb.content ?? {}) as Record<string, Json>
        const types = Object.keys(content)
        const first = content[types[0] ?? ''] ?? {}
        body = {
          required: rb.required === true,
          contentTypes: types,
          ...(first.schema !== undefined && { schema: schemaOf(doc, first.schema) }),
          ...(first.example !== undefined && { example: first.example }),
        }
      }
      let id =
        typeof op.operationId === 'string' && op.operationId
          ? op.operationId
          : `${method.toUpperCase()} ${path}`
      if (ids.has(id)) id = `${id} (${method.toUpperCase()} ${path})`
      ids.add(id)
      operations.push({
        id,
        method: method.toUpperCase(),
        path,
        ...(typeof op.summary === 'string' && { summary: op.summary }),
        ...(typeof op.description === 'string' && { description: op.description.slice(0, 2000) }),
        tags: Array.isArray(op.tags) ? (op.tags as string[]) : [],
        ...(op.deprecated === true && { deprecated: true }),
        parameters: [...params.values()],
        ...(body && { body }),
      })
    }
  }
  return {
    title: String(info.title ?? 'API'),
    version: String(info.version ?? ''),
    openapi,
    servers,
    operations,
  }
}

const parsed = new Map<string, OpenApiDocument>()
/** Parsed documents by their text's hash, the 20 latest. */
export function openApiDocument(text: string): OpenApiDocument {
  const key = createHash('sha256').update(text).digest('hex')
  const known = parsed.get(key)
  if (known) {
    parsed.delete(key)
    parsed.set(key, known)
    return known
  }
  const doc = parseOpenApi(text)
  parsed.set(key, doc)
  if (parsed.size > 20) parsed.delete(parsed.keys().next().value as string)
  return doc
}

const text = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))

/** How an array is joined: by its style (Swagger 2.0's ssv, tsv and pipes too), else commas. */
function separator(style: string): string {
  return style === 'spaceDelimited'
    ? ' '
    : style === 'pipeDelimited'
      ? '|'
      : style === 'tabDelimited'
        ? '\t'
        : ','
}

/** A parameter's value serialized by its style for its place: pairs for the query, one string otherwise. */
export function serializeParameter(
  p: OpenApiParameter,
  value: unknown,
): { pairs?: [string, string][]; value?: string } {
  const array = Array.isArray(value) ? value : null
  const object =
    !array && value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (p.in === 'query') {
    if (array) {
      if (p.style === 'form' && p.explode) return { pairs: array.map((v) => [p.name, text(v)]) }
      return { pairs: [[p.name, array.map(text).join(separator(p.style))]] }
    }
    if (object) {
      if (p.style === 'deepObject')
        return { pairs: Object.entries(object).map(([k, v]) => [`${p.name}[${k}]`, text(v)]) }
      if (p.explode) return { pairs: Object.entries(object).map(([k, v]) => [k, text(v)]) }
      return {
        pairs: [
          [
            p.name,
            Object.entries(object)
              .flatMap(([k, v]) => [k, text(v)])
              .join(','),
          ],
        ],
      }
    }
    return { pairs: [[p.name, text(value)]] }
  }
  if (array) return { value: array.map(text).join(separator(p.style)) }
  if (object)
    return {
      value: p.explode
        ? Object.entries(object)
            .map(([k, v]) => `${k}=${text(v)}`)
            .join(',')
        : Object.entries(object)
            .flatMap(([k, v]) => [k, text(v)])
            .join(','),
    }
  return { value: text(value) }
}

const configSchema = restConfigSchema.extend({
  /** The OpenAPI document as text (JSON or YAML), pasted or fetched from `specUrl`. */
  spec: z
    .string()
    .min(1, 'Add the OpenAPI document')
    .max(OPENAPI_MAX_SPEC, 'The OpenAPI document is larger than 5 MB'),
  /** Where the document was fetched from, to fetch it again. */
  specUrl: z.url({ protocol: /^https?$/ }).optional(),
})
type Config = z.output<typeof configSchema>

const querySchema = z.object({
  operationId: z.string().min(1),
  /** A JSON object with {{ }}: values by parameter name (`query:name` where two places share a name). */
  parameters: z.string().default(''),
  /** The body: JSON with {{ }}, or a lone {{ }} for any value (a file object for uploads). */
  body: z.string().default(''),
  /** One of the operation's media types (empty: its first). */
  contentType: z.string().default(''),
})
type Query = z.output<typeof querySchema>

interface OpenApiClient {
  http: HttpClient
  doc: OpenApiDocument
}

/** The operation's request: URL path, query pairs, headers, body. */
export async function buildOperationRequest(
  op: OpenApiOperation,
  query: Query,
  ctx: Pick<QueryContext, 'evaluate'>,
): Promise<{
  path: string
  params: [string, string][]
  headers: [string, string][]
  body?: string | FormData
  contentType?: string
}> {
  const given = query.parameters.trim() ? await renderJson(query.parameters, ctx.evaluate) : {}
  if (!given || typeof given !== 'object' || Array.isArray(given))
    throw new ConnectorError('invalid_query', 'Parameters must be a JSON object of values by name')
  const values = new Map<OpenApiParameter, unknown>()
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    const colon = /^(path|query|header|cookie):(.+)$/.exec(key)
    const matches = op.parameters.filter((p) =>
      colon ? p.in === colon[1] && p.name === colon[2] : p.name === key,
    )
    if (matches.length === 0)
      throw new ConnectorError(
        'invalid_query',
        `${op.id} has no parameter "${key}" (it has: ${op.parameters.map((p) => p.name).join(', ') || 'none'})`,
      )
    if (matches.length > 1)
      throw new ConnectorError(
        'invalid_query',
        `"${key}" is in several places: write ${matches.map((p) => `${p.in}:${p.name}`).join(' or ')}`,
      )
    values.set(matches[0]!, value)
  }
  const missing = op.parameters.filter(
    (p) => p.required && (values.get(p) === undefined || values.get(p) === null || values.get(p) === ''),
  )
  if (missing.length)
    throw new ConnectorError('invalid_query', `Missing: ${missing.map((p) => p.name).join(', ')}`)

  let path = op.path
  const params: [string, string][] = []
  const headers: [string, string][] = []
  const cookies: string[] = []
  for (const [p, value] of values) {
    if (value === undefined || value === null) continue
    const out = serializeParameter(p, value)
    if (p.in === 'path') path = path.replaceAll(`{${p.name}}`, encodeURIComponent(out.value ?? ''))
    else if (p.in === 'query') params.push(...(out.pairs ?? []))
    else if (p.in === 'header') headers.push([p.name, out.value ?? ''])
    else cookies.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(out.value ?? '')}`)
  }
  if (cookies.length) headers.push(['cookie', cookies.join('; ')])

  const raw = query.body.trim()
  if (!op.body) {
    if (raw) throw new ConnectorError('invalid_query', `${op.id} takes no body`)
    return { path, params, headers }
  }
  if (!raw) {
    if (op.body.required) throw new ConnectorError('invalid_query', `${op.id} needs a body`)
    return { path, params, headers }
  }
  const type = (query.contentType || op.body.contentTypes[0] || 'application/json').toLowerCase()
  if (op.body.contentTypes.length && !op.body.contentTypes.some((t) => t.toLowerCase() === type))
    throw new ConnectorError(
      'invalid_query',
      `${op.id} takes ${op.body.contentTypes.join(', ')}, not ${type}`,
    )
  // A lone {{ }} is any value; otherwise JSON with {{ }}, as a REST body.
  const lone = /^\{\{[\s\S]*\}\}$/.test(raw) && raw.indexOf('{{', 2) === -1
  const value = lone ? await renderTemplate(raw, ctx.evaluate) : await renderJson(raw, ctx.evaluate)
  if (type === 'application/json' || type.endsWith('+json'))
    return { path, params, headers, body: JSON.stringify(value), contentType: type }
  if (type === 'application/x-www-form-urlencoded') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ConnectorError('invalid_query', 'A form body is a JSON object')
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const x of v) form.append(k, text(x))
      else if (v !== undefined && v !== null) form.append(k, text(v))
    }
    return { path, params, headers, body: form.toString(), contentType: type }
  }
  if (type === 'multipart/form-data') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ConnectorError('invalid_query', 'A multipart body is a JSON object')
    const form = new FormData()
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const binary = op.body.schema?.properties?.[k]
      const isFile =
        binary?.format === 'binary' ||
        binary?.type === 'file' ||
        (v !== null && typeof v === 'object' && 'base64' in (v as object))
      if (isFile) {
        const file = fileValue(v)
        if (!file)
          throw new ConnectorError(
            'invalid_query',
            `${k} needs base64 text or a file object ({ base64, filename, contentType })`,
          )
        form.append(
          k,
          new Blob([new Uint8Array(file.bytes)], { type: file.contentType ?? 'application/octet-stream' }),
          file.filename ?? k,
        )
      } else if (v !== undefined && v !== null) form.append(k, text(v))
    }
    return { path, params, headers, body: form }
  }
  if (!type.startsWith('text/') && typeof value !== 'string')
    throw new ConnectorError(
      'invalid_query',
      `A ${type} body is sent as text here; binary uploads go through multipart/form-data`,
    )
  return {
    path,
    params,
    headers,
    body: typeof value === 'string' ? value : JSON.stringify(value),
    contentType: type,
  }
}

export const openapiConnector: Connector<Config, z.output<typeof restSecretsSchema>, Query, OpenApiClient> = {
  type: 'openapi',
  label: 'OpenAPI',
  configSchema,
  secretsSchema: restSecretsSchema,
  querySchema,
  scrubResultData: true,

  createClient({ config, secrets }) {
    const doc = openApiDocument(config.spec)
    return { http: createHttpClient(config, secrets), doc }
  },

  async destroyClient(client) {
    await destroyHttpClient(client.http)
  },

  httpConfig: (config) => config,

  async testConnection(client, { signal, credentials }) {
    const res = await testHttp(client.http, { signal, credentials })
    return {
      message: `${client.doc.title}${client.doc.version ? ` ${client.doc.version}` : ''}: ${client.doc.operations.length} operations (base URL answered HTTP ${res.status})`,
    }
  },

  validateQuery(query) {
    const errors: TemplateError[] = []
    for (const template of [query.parameters, query.body]) {
      try {
        parseTemplate(template)
      } catch (err) {
        if (err instanceof TemplateError) errors.push(err)
        else throw err
      }
    }
    return errors
  },

  async execute(client, query, ctx): Promise<QueryResult> {
    const op = client.doc.operations.find((o) => o.id === query.operationId)
    if (!op)
      throw new ConnectorError(
        'invalid_query',
        `The OpenAPI document has no operation "${query.operationId}"`,
      )
    const req = await buildOperationRequest(op, query, ctx)
    const base = client.http.config.baseUrl.replace(/\/+$/, '')
    const res = await httpRequest(
      client.http,
      {
        method: op.method,
        url: new URL(`${base}${req.path}`),
        params: req.params,
        headers: req.headers,
        ...(req.body !== undefined && { body: req.body }),
        ...(req.contentType && { contentType: req.contentType }),
      },
      ctx,
    )
    if (op.method === 'HEAD') return { data: null, metadata: responseMetadata(res) }
    if (!res.ok) throw httpError(res)
    return { data: res.data, metadata: { ...responseMetadata(res), operation: op.id } }
  },
}
