import { parseTemplate } from '@ow/expressions'
import type { RetoolPlugin } from '../model'
import type { ReportBuilder, ResourceNeed } from '../report'
import { findSecret, replaceSecret } from '../secrets'

/** Retool's REST queries without a resource; here, the built-in REST API resource. */
export const RETOOL_REST_WITHOUT_RESOURCE = 'REST-WithoutResource'
export const BUILTIN_REST_SLUG = 'rest_api'

/** Retool resource (name or uuid) → our resource slug, as the person mapped them. */
export type ResourceMapping = Record<string, string>

export interface QueryContext {
  report: ReportBuilder
  resources: ResourceMapping
}

export type ConvertedQuery =
  | { ok: true; resource: string; query: Record<string, unknown>; notes: string[]; approximated: boolean }
  | { ok: false; reason: string }

type KeyValue = { key: string; value: string }

const QUERY_KINDS: Record<string, ResourceNeed['kind']> = {
  SqlQueryUnified: 'sql',
  SqlQuery: 'sql',
  RESTQuery: 'rest',
  OpenAPIQuery: 'openapi',
  GraphQLQuery: 'graphql',
}

/** Whether Retool runs this editor's queries on a resource (rather than as code). */
export function isResourceEditor(editorType: string | null): boolean {
  return !!editorType && editorType in QUERY_KINDS
}

/**
 * A Retool resource query (its plugin's template) as one of ours: the resource's slug and the connector's query.
 * `where` names the part, for the report.
 */
export function convertQuery(
  ctx: QueryContext,
  editorType: string,
  resourceKey: string | null,
  plugin: Pick<RetoolPlugin, 'template' | 'resourceDisplayName'>,
  where: string,
): ConvertedQuery {
  const kind = QUERY_KINDS[editorType]
  if (!kind) return { ok: false, reason: `Retool ${editorType} queries aren't supported yet` }
  const t = plugin.template
  const notes: string[] = []
  const builtinRest = kind === 'rest' && (!resourceKey || resourceKey === RETOOL_REST_WITHOUT_RESOURCE)
  const resource = builtinRest
    ? ctx.report.resource(
        {
          key: RETOOL_REST_WITHOUT_RESOURCE,
          label: 'REST API (built in)',
          kind,
          slug: BUILTIN_REST_SLUG,
          mapped: true,
        },
        where,
      )
    : resourceFor(ctx, resourceKey ?? 'unknown', plugin.resourceDisplayName, kind, where)
  if (t.enableTransformer === true && typeof t.transformer === 'string' && t.transformer.trim()) {
    notes.push("Its transformer wasn't imported: add a code block after it")
  }
  const secrets = (value: string, at: string, name?: string) => scrub(ctx, value, `${where} ${at}`, name)

  switch (kind) {
    case 'sql': {
      const sql = str(t.query)
      if (t.editorMode === 'gui' || (!sql.trim() && t.actionType)) {
        return {
          ok: true,
          resource: resource.slug,
          query: {
            sql: `-- Retool's GUI ${str(t.actionType) || 'action'} on ${str(t.tableName) || 'a table'}: write it as SQL`,
          },
          notes: [...notes, "Retool's GUI mode (no SQL written) wasn't imported: write the query as SQL"],
          approximated: true,
        }
      }
      return {
        ok: true,
        resource: resource.slug,
        query: { sql: sql || 'select 1' },
        notes,
        approximated: notes.length > 0,
      }
    }
    case 'rest': {
      const method = (str(t.type) || 'GET').toUpperCase()
      const url = secrets(str(t.query), 'URL')
      const headers = keyValues(t.headers)
        .filter((h) => h.key.trim())
        .map((h) => ({ key: h.key, value: secrets(h.value, `header ${h.key}`, h.key) }))
      const params = keyValues(t.urlparams ?? t.params)
        .filter((p) => p.key.trim())
        .map((p) => ({ key: p.key, value: secrets(p.value, `parameter ${p.key}`, p.key) }))
      const body = restBody(t, headers, notes, (value, at, name) => secrets(value, at, name))
      if (keyValues(t.cookies).some((c) => c.key.trim()))
        notes.push("Its cookies weren't imported: send them as a Cookie header")
      if (t.paginationEnabled === true) notes.push("Retool's pagination wasn't imported: page in a loop")
      const query: Record<string, unknown> = builtinRest
        ? { method, url, params, headers, body, auth: { type: 'none' } }
        : { method, path: url, params, headers, body }
      return { ok: true, resource: resource.slug, query, notes, approximated: notes.length > 0 }
    }
    case 'openapi': {
      const parameters = str(t.parameters)
      const body = str(t.requestBody)
      return {
        ok: true,
        resource: resource.slug,
        query: {
          operationId: str(t.operationId),
          parameters: secrets(parameters, 'parameters'),
          body: secrets(body, 'body'),
          contentType: '',
        },
        notes,
        approximated: notes.length > 0,
      }
    }
    case 'graphql': {
      const text = str(t.query)
      if (text.includes('{{')) notes.push('Its query text uses {{ }}: move those values into variables')
      const variables = keyValues(t.variables)
      return {
        ok: true,
        resource: resource.slug,
        query: {
          query: text,
          variables: variables.length ? jsonFromPairs(variables) : str(t.variables),
          operationName: str(t.operationName),
          headers: keyValues(t.headers).filter((h) => h.key.trim()),
        },
        notes,
        approximated: notes.length > 0,
      }
    }
    default:
      return { ok: false, reason: `Retool ${editorType} queries aren't supported yet` }
  }
}

function resourceFor(
  ctx: QueryContext,
  key: string,
  label: string | null,
  kind: ResourceNeed['kind'],
  where: string,
): ResourceNeed {
  const mapped = ctx.resources[key]
  return ctx.report.resource(
    { key, label: label || key, kind, slug: mapped ?? placeholderSlug(label || key), mapped: !!mapped },
    where,
  )
}

/** A resource slug that stands in until the person maps the Retool resource: `retool_<name>`. */
export function placeholderSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `retool_${base || 'resource'}`.slice(0, 63).replace(/_+$/, '')
}

function scrub(ctx: QueryContext, value: string, where: string, name?: string): string {
  const found = findSecret(value, name)
  if (!found) return value
  return replaceSecret(value, found, ctx.report.secret(where, found))
}

/** Retool keeps key-value lists as JSON text (`[{"key":…,"value":…}]`), sometimes as a list. */
export function keyValues(raw: unknown): KeyValue[] {
  let list: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const { key, value } = item as { key?: unknown; value?: unknown }
    return [{ key: typeof key === 'string' ? key : '', value: value == null ? '' : String(value) }]
  })
}

/** A REST body: Retool's `none`, `json` (a key-value list or JSON text), `raw`, `form`, `form-data`. */
function restBody(
  t: Record<string, unknown>,
  headers: KeyValue[],
  notes: string[],
  secrets: (value: string, at: string, name?: string) => string,
): Record<string, unknown> {
  const type = str(t.bodyType) || 'none'
  const raw = str(t.body)
  if (type === 'none' || (!raw.trim() && type !== 'form')) return { type: 'none' }
  const pairs = keyValues(raw)
  const fields = pairs
    .filter((p) => p.key.trim())
    .map((p) => ({ key: p.key, value: secrets(p.value, `body ${p.key}`, p.key) }))
  switch (type) {
    case 'json':
      return pairs.length
        ? { type: 'json', json: jsonFromPairs(fields) }
        : { type: 'json', json: secrets(raw, 'body') }
    case 'form':
    case 'x-www-form-urlencoded':
      return { type: 'form', fields }
    case 'form-data':
      return { type: 'multipart', parts: fields.map((f) => ({ kind: 'text', key: f.key, value: f.value })) }
    case 'raw': {
      const body = secrets(raw, 'body')
      const trimmed = body.trim()
      // JSON with {{ }}, or one {{ }} (an object sent as JSON): our JSON body renders both.
      if (/^[[{]/.test(trimmed) || isLoneTemplate(trimmed)) return { type: 'json', json: body }
      const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || 'text/plain'
      return { type: 'raw', raw: body, contentType }
    }
    default:
      notes.push(`Its ${type} body was imported as raw text`)
      return { type: 'raw', raw, contentType: 'text/plain' }
  }
}

/** Key-value pairs as a JSON object template: a value that is one `{{ }}` goes in as JSON, others as strings. */
export function jsonFromPairs(pairs: KeyValue[]): string {
  const entries = pairs.map(({ key, value }) => `  ${JSON.stringify(key)}: ${jsonValue(value)}`)
  return entries.length ? `{\n${entries.join(',\n')}\n}` : '{}'
}

function jsonValue(value: string): string {
  const trimmed = value.trim()
  if (isLoneTemplate(trimmed)) return trimmed
  try {
    const parts = parseTemplate(value)
    return `"${parts.map((p) => (p.type === 'text' ? JSON.stringify(p.value).slice(1, -1) : `{{${p.code}}}`)).join('')}"`
  } catch {
    return JSON.stringify(value)
  }
}

/** One `{{ }}` and nothing else. */
export function isLoneTemplate(text: string): boolean {
  try {
    const parts = parseTemplate(text.trim())
    return parts.length === 1 && parts[0]!.type === 'expression'
  } catch {
    return false
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
