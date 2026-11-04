import { z } from 'zod'
import { canonicalJson } from './canonical'
import { blockNameSchema, resourceSlugSchema } from './schema'

/**
 * A library query (M14): one resource query written once and used by many apps and workflows (M21), with declared
 * parameters they pass. Its `{{ }}`s read **only its parameters** (by bare name: `{{ customerId }}`),
 * `current_user` and the stdlib, never an app's state or a run's blocks, so it means the same everywhere. It runs on
 * the server: the caller's parameter values are evaluated first, then the `{{ }}`s with them in scope, and the
 * results are bound as parameters. Its validator lives in `@ow/app-definition` (it shares the app's names).
 */

export const LIBRARY_QUERY_SCHEMA_VERSION = 1

const MAX_PARAMS = 50

export const libraryParamSchema = z.strictObject({
  /** Read in the query's `{{ }}`s by this name; apps and workflows pass a value for it. */
  name: blockNameSchema,
  description: z.string().max(2000).optional(),
  /** What the library editor's Run passes. Never used by apps or workflows. */
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

/** What a validator needs to know about a library query an app or workflow uses (M14, M21). */
export interface LibraryInfo {
  /** The live release's version, or null when it has none. */
  liveVersion: string | null
  /** Each release's parameter names, by version. */
  versions: Record<string, readonly string[]>
  /**
   * The library query exists but the person may not use it (M21): reported as needing use access, with nothing
   * else of it shown (`liveVersion` null, no versions).
   */
  noUse?: boolean
}

/** The person whose `current_user` a library query sees; null in a run nobody started (M21). */
export interface LibraryUser {
  id: string
  email: string
  name: string
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
  currentUser: LibraryUser | null,
): Record<string, unknown> {
  const scope: Record<string, unknown> = {}
  for (const p of def.params) scope[p.name] = Object.hasOwn(values, p.name) ? (values[p.name] ?? null) : null
  scope.current_user = currentUser
  return scope
}

/** What an app query or a workflow block names to use a library query (M14, M21). */
export interface LibraryReference {
  library: string
  version: string
  params?: Record<string, unknown> | undefined
}

export type LibraryReferenceCode =
  | 'unknown_library'
  | 'no_use_access'
  | 'unpublished_library'
  | 'unknown_version'
  | 'unknown_param'
  | 'missing_param'

export interface LibraryReferenceProblem {
  severity: 'error' | 'warning'
  code: LibraryReferenceCode
  message: string
  /** Relative to the reference: `['library']`, `['version']`, `['params', name]` or `['params']`. */
  path: (string | number)[]
}

/**
 * A library query's reference: the library query exists (and the person may use it), the version is live
 * (`latest`) or released, and the parameters passed are the ones that release declares (one not passed is null: a
 * warning). Shared by the app and workflow validators, which add where the reference sits.
 */
export function checkLibraryReference(
  ref: LibraryReference,
  resolve: (slug: string) => LibraryInfo | undefined,
): LibraryReferenceProblem[] {
  const info = resolve(ref.library)
  if (!info) {
    return [
      {
        severity: 'error',
        code: 'unknown_library',
        message: `No library query has the slug "${ref.library}"`,
        path: ['library'],
      },
    ]
  }
  if (info.noUse) {
    return [
      {
        severity: 'error',
        code: 'no_use_access',
        message: `You need use access to library query "${ref.library}"`,
        path: ['library'],
      },
    ]
  }
  const version = ref.version === 'latest' ? info.liveVersion : ref.version
  if (version === null) {
    return [
      {
        severity: 'error',
        code: 'unpublished_library',
        message: `Library query "${ref.library}" has no live release yet`,
        path: ['version'],
      },
    ]
  }
  const params = Object.hasOwn(info.versions, version) ? info.versions[version] : undefined
  if (!params) {
    return [
      {
        severity: 'error',
        code: 'unknown_version',
        message: `Library query "${ref.library}" has no release ${version}`,
        path: ['version'],
      },
    ]
  }
  const problems: LibraryReferenceProblem[] = []
  for (const name of Object.keys(ref.params ?? {})) {
    if (!params.includes(name)) {
      problems.push({
        severity: 'error',
        code: 'unknown_param',
        message: `"${ref.library}" v${version} has no parameter "${name}"`,
        path: ['params', name],
      })
    }
  }
  for (const name of params) {
    if (!Object.hasOwn(ref.params ?? {}, name)) {
      problems.push({
        severity: 'warning',
        code: 'missing_param',
        message: `No value for the parameter "${name}"; it will be null`,
        path: ['params'],
      })
    }
  }
  return problems
}
