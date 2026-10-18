import { canonicalJson, fieldRefs, JS_GLOBALS, type QueryValidator, resourceSlugSchema } from '@ow/definition'
import { z } from 'zod'
import { templateStrings } from './fields'
import { APP_STDLIB_GLOBALS, appNameReason } from './names'
import { SERVER_QUERY_GLOBALS } from './query-values'
import { appNameSchema } from './schema'
import type { AppDiagnostic } from './validate'

/**
 * A library query (M14): one resource query written once and used by many apps, with declared parameters the
 * apps pass. Its `{{ }}`s read **only its parameters** (by bare name: `{{ customerId }}`), `current_user` and the
 * stdlib, never an app's state, so it means the same in every app. It runs on the server: the app sends the
 * parameters' values, the server evaluates the `{{ }}`s with them in scope and binds the results as parameters.
 */

export const LIBRARY_QUERY_SCHEMA_VERSION = 1

const MAX_PARAMS = 50

export const libraryParamSchema = z.strictObject({
  /** Read in the query's `{{ }}`s by this name; apps pass a value for it. */
  name: appNameSchema,
  description: z.string().max(2000).optional(),
  /** What the library editor's Run passes. Never used by apps. */
  testValue: z.json().optional(),
})

export const libraryQueryDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(LIBRARY_QUERY_SCHEMA_VERSION),
  resource: resourceSlugSchema,
  /** The connector's query (`{ sql }` for SQL resources); every string is a template. */
  query: z.record(z.string(), z.json()),
  /** In the order the editor shows them. */
  params: z.array(libraryParamSchema).max(MAX_PARAMS),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
})

export type LibraryParam = z.infer<typeof libraryParamSchema>
export type LibraryQueryDefinition = z.infer<typeof libraryQueryDefinitionSchema>

/** A new library query: a `select 1` on the managed database, like a new app query. */
export function emptyLibraryQuery(): LibraryQueryDefinition {
  return {
    schemaVersion: LIBRARY_QUERY_SCHEMA_VERSION,
    resource: 'optiply_db',
    query: { sql: 'select 1' },
    params: [],
  }
}

/** Names a library query's `{{ }}`s may read besides its parameters. */
export function isLibraryGlobalName(name: string): boolean {
  return SERVER_QUERY_GLOBALS.has(name) || JS_GLOBALS.has(name) || APP_STDLIB_GLOBALS.has(name)
}

export type LibraryDiagnosticCode =
  | 'schema'
  | 'invalid_name'
  | 'duplicate_name'
  | 'syntax'
  | 'unknown_identifier'
  | 'unused_param'
  | 'unknown_resource'
  | 'invalid_query'

export type LibraryDiagnostic = Omit<AppDiagnostic, 'code' | 'entity'> & { code: LibraryDiagnosticCode }

export interface LibraryValidationResult {
  ok: boolean
  definition?: LibraryQueryDefinition
  diagnostics: LibraryDiagnostic[]
}

/**
 * Checks a library query: the schema, its parameters' names, its `{{ }}`s (syntax, and reading nothing but its
 * parameters and the globals) and, server side, its query against the resource's connector. A parameter nothing
 * reads is a warning.
 */
export function validateLibraryQuery(
  input: unknown,
  options: { resolveResource?: (slug: string) => QueryValidator | undefined } = {},
): LibraryValidationResult {
  const parsed = libraryQueryDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: 'error',
        code: 'schema',
        message: issue.message,
        path: issue.path.map((k) => (typeof k === 'number' ? k : String(k))),
      })),
    }
  }
  const def = parsed.data
  const diagnostics: LibraryDiagnostic[] = []
  const report = (d: Omit<LibraryDiagnostic, 'severity'> & { severity?: LibraryDiagnostic['severity'] }) =>
    diagnostics.push({ severity: 'error', ...d })

  const params = new Set<string>()
  const badName = new Set<number>()
  def.params.forEach((p, i) => {
    const path = ['params', i, 'name']
    const reason = appNameReason(p.name) ?? (isLibraryGlobalName(p.name) ? `"${p.name}" is a global` : null)
    if (reason) report({ code: 'invalid_name', message: reason, path })
    if (params.has(p.name)) {
      report({ code: 'duplicate_name', message: `Another parameter is already named "${p.name}"`, path })
    }
    if (reason || params.has(p.name)) badName.add(i)
    params.add(p.name)
  })

  const read = new Set<string>()
  templateStrings(def.query, ['query'], (path, source) => {
    const { refs, errors } = fieldRefs({ kind: 'template', source })
    for (const err of errors) {
      report({
        code: 'syntax',
        message: err.message,
        path,
        start: err.start,
        end: err.end,
        ...(err.hint && { hint: err.hint }),
      })
    }
    for (const ref of refs) {
      read.add(ref.name)
      if (params.has(ref.name) || isLibraryGlobalName(ref.name)) continue
      report({
        code: 'unknown_identifier',
        message: `"${ref.name}" is not a parameter`,
        hint: 'A library query reads only its parameters, current_user and the stdlib; add a parameter and let apps pass the value',
        path,
        start: ref.start,
        end: ref.end,
      })
    }
  })
  def.params.forEach((p, i) => {
    if (!badName.has(i) && !read.has(p.name)) {
      report({
        severity: 'warning',
        code: 'unused_param',
        message: `Nothing reads the parameter "${p.name}"`,
        path: ['params', i, 'name'],
      })
    }
  })

  if (options.resolveResource) checkLibraryResource(def, options.resolveResource, report)
  return { ok: !diagnostics.some((d) => d.severity === 'error'), definition: def, diagnostics }
}

function checkLibraryResource(
  def: LibraryQueryDefinition,
  resolve: (slug: string) => QueryValidator | undefined,
  report: (d: Omit<LibraryDiagnostic, 'severity'>) => void,
) {
  const connector = resolve(def.resource)
  if (!connector) {
    report({
      code: 'unknown_resource',
      message: `No resource has the slug "${def.resource}"`,
      path: ['resource'],
    })
    return
  }
  const query = connector.querySchema.safeParse(def.query)
  if (!query.success) {
    for (const issue of query.error.issues) {
      report({
        code: 'invalid_query',
        message: issue.message,
        path: ['query', ...issue.path.map((k) => (typeof k === 'number' ? k : String(k)))],
      })
    }
    return
  }
  for (const err of connector.validateQuery(query.data as never)) {
    report({
      code: 'invalid_query',
      message: err.message,
      path: ['query'],
      start: err.start,
      end: err.end,
      ...(err.hint && { hint: err.hint }),
    })
  }
}

/**
 * SHA-256 (hex) of a library query's canonical JSON: the identity of a release. Parameters keep their order (the
 * editor's), so reordering them is a change.
 */
export async function libraryQueryHash(def: LibraryQueryDefinition): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(def))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The values a library query's `{{ }}`s see: each declared parameter's value (null when not given; undeclared
 * names are dropped) and `current_user`.
 */
export function libraryScope(
  def: LibraryQueryDefinition,
  values: Record<string, unknown>,
  currentUser: { id: string; email: string; name: string },
): Record<string, unknown> {
  const scope: Record<string, unknown> = {}
  for (const p of def.params) scope[p.name] = Object.hasOwn(values, p.name) ? (values[p.name] ?? null) : null
  scope.current_user = currentUser
  return scope
}
