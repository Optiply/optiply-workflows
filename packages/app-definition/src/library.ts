import {
  fieldRefs,
  JS_GLOBALS,
  type LibraryQueryDefinition,
  libraryQueryDefinitionSchema,
  type QueryValidator,
} from '@ow/definition'
import { templateStrings } from './fields'
import { APP_STDLIB_GLOBALS, appNameReason } from './names'
import { SERVER_QUERY_GLOBALS } from './query-values'
import type { AppDiagnostic } from './validate'

// The schema, `libraryScope` and `LibraryInfo` live in `@ow/definition` (M21: workflows and the engine use them);
// the validator stays here, as it shares the app's names and stdlib.
export {
  emptyLibraryQuery,
  LIBRARY_QUERY_SCHEMA_VERSION,
  type LibraryInfo,
  type LibraryParam,
  type LibraryQueryDefinition,
  type LibraryUser,
  libraryParamSchema,
  libraryQueryDefinitionSchema,
  libraryQueryHash,
  libraryScope,
} from '@ow/definition'

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
