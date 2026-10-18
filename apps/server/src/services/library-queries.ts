import {
  type LibraryDiagnostic,
  type LibraryQueryDefinition,
  libraryQueryHash,
  libraryScope,
  validateLibraryQuery,
} from '@ow/app-definition'
import { getConnector } from '@ow/connectors'
import {
  type Db,
  environments,
  type LibraryQuery,
  type LibraryQueryRelease,
  libraryQueries,
  libraryQueryReleases,
  type Resource,
  resources,
} from '@ow/db'
import { canonicalJson, type VersionBump } from '@ow/definition'
import type { CodeRuntime } from '@ow/sandbox'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { type Access, atLeast } from './permissions'
import { nextReleaseVersion } from './release-versions'
import { type QueryOutcome, type QueryRunDeps, runStoredQuery } from './resource-query'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Each `{{ }}` of a library query gets this long in the sandbox. */
const EXPRESSION_TIMEOUT_MS = 5_000

/** Validates a library query with its query checked by the resource's connector; also returns the resource. */
export async function checkLibraryQuery(
  db: Db,
  definition: LibraryQueryDefinition,
): Promise<{ resource: Resource | null; errors: LibraryDiagnostic[]; diagnostics: LibraryDiagnostic[] }> {
  const [resource] = await db.select().from(resources).where(eq(resources.slug, definition.resource))
  const { diagnostics } = validateLibraryQuery(definition, {
    resolveResource: (slug) => (resource && slug === resource.slug ? getConnector(resource.type) : undefined),
  })
  return {
    resource: resource ?? null,
    errors: diagnostics.filter((d) => d.severity === 'error'),
    diagnostics,
  }
}

/**
 * What making a library query's release live takes. Apps run it without their viewers or publishers holding any
 * grant on its resource, so whoever publishes it vouches for it: Edit on the library query and Use on its resource
 * in every environment. The definition must be valid. `access` null is Git sync: no grants are checked.
 */
async function checkReleasable(
  db: Db,
  access: Access | null,
  query: LibraryQuery,
  definition: LibraryQueryDefinition,
): Promise<void> {
  if (access && !atLeast(access.libraryQueryLevel(query), 'edit')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You need edit access to this library query to release it',
    })
  }
  const { resource, errors } = await checkLibraryQuery(db, definition)
  if (errors.length) {
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The library query isn't valid: ${errors[0]!.message}${more}`,
    })
  }
  if (!access || !resource) return
  const envIds = (await db.select({ id: environments.id }).from(environments)).map((e) => e.id)
  if (!atLeast(access.levelEverywhere(resource, envIds), 'use')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You need use access to resource "${resource.slug}" in every environment to release this library query`,
    })
  }
}

const changedSince = (revision: number) =>
  new TRPCError({
    code: 'CONFLICT',
    message: `The draft changed since revision ${revision}; reload before publishing`,
  })

/**
 * Publishes the draft as a new release and makes it live (apps following `latest` run it from then on). Refused
 * when someone saved since `draftRevision` or nothing changed since the live release.
 */
export async function publishLibraryRelease(
  db: Db,
  access: Access,
  user: { id: string },
  opts: {
    query: LibraryQuery
    draftRevision: number
    version?: string
    bump?: VersionBump
    notes?: string | null
  },
): Promise<LibraryQueryRelease> {
  const { query } = opts
  if (query.draftRevision !== opts.draftRevision) throw changedSince(opts.draftRevision)
  const definition = query.draftDefinition
  const hash = await libraryQueryHash(definition)
  await checkReleasable(db, access, query, definition)

  return db.transaction(async (tx) => {
    // Serializes publishing and setting the live release of one library query.
    const [locked] = await tx
      .select()
      .from(libraryQueries)
      .where(eq(libraryQueries.id, query.id))
      .for('update')
    if (!locked || locked.draftRevision !== opts.draftRevision) throw changedSince(opts.draftRevision)
    const release = await insertRelease(tx, locked, definition, hash, {
      version: opts.version,
      bump: opts.bump,
      notes: opts.notes,
      createdBy: user.id,
      gitCommit: null,
    })
    if ('unchanged' in release) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Nothing changed since the live release, v${release.unchanged}`,
      })
    }
    await tx.update(libraryQueries).set({ liveReleaseId: release.id }).where(eq(libraryQueries.id, query.id))
    return release
  })
}

/** Inserts the next release of a locked library query, unless the live one already has this hash. */
async function insertRelease(
  tx: Tx,
  locked: LibraryQuery,
  definition: LibraryQueryDefinition,
  hash: string,
  opts: {
    version?: string
    bump?: VersionBump
    notes?: string | null
    createdBy: string | null
    gitCommit: string | null
  },
): Promise<LibraryQueryRelease | { unchanged: string }> {
  const existing = await tx
    .select({
      id: libraryQueryReleases.id,
      version: libraryQueryReleases.version,
      hash: libraryQueryReleases.definitionHash,
    })
    .from(libraryQueryReleases)
    .where(eq(libraryQueryReleases.libraryQueryId, locked.id))
  const live = existing.find((r) => r.id === locked.liveReleaseId)
  if (live?.hash === hash) return { unchanged: live.version }
  const version = nextReleaseVersion(
    existing.map((r) => r.version),
    opts,
  )
  const [release] = await tx
    .insert(libraryQueryReleases)
    .values({
      libraryQueryId: locked.id,
      version,
      // Stored canonically, like the hash: jsonb doesn't keep key order anyway.
      definition: JSON.parse(canonicalJson(definition)),
      definitionHash: hash,
      notes: opts.notes?.trim() || null,
      createdBy: opts.createdBy,
      gitCommit: opts.gitCommit,
    })
    .returning()
  return release!
}

/** Makes another release live (rollback, or forward again). The same checks as publishing apply. */
export async function setLiveLibraryRelease(
  db: Db,
  access: Access,
  opts: { query: LibraryQuery; releaseId: string },
): Promise<LibraryQueryRelease> {
  const [release] = await db
    .select()
    .from(libraryQueryReleases)
    .where(
      and(
        eq(libraryQueryReleases.id, opts.releaseId),
        eq(libraryQueryReleases.libraryQueryId, opts.query.id),
      ),
    )
  if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
  await checkReleasable(db, access, opts.query, release.definition)
  await db
    .update(libraryQueries)
    .set({ liveReleaseId: release.id })
    .where(eq(libraryQueries.id, opts.query.id))
  return release
}

/**
 * How a library query's `{{ }}`s get their values: each is evaluated in the sandbox with the parameters (whatever
 * the caller sent: untrusted data, never code) and the signed-in `current_user` in scope. The code itself comes
 * from the stored library query.
 */
export function libraryEvaluator(
  sandbox: CodeRuntime,
  definition: LibraryQueryDefinition,
  params: Record<string, unknown>,
  user: { id: string; email: string; name: string },
): (code: string) => Promise<unknown> {
  const scope = libraryScope(definition, params, { id: user.id, email: user.email, name: user.name })
  return (code) => sandbox.evalExpression(code, scope, { timeoutMs: EXPRESSION_TIMEOUT_MS })
}

/**
 * Runs a library query's draft in one environment, from its editor: Edit on the library query and Use on its
 * resource there. `params` defaults to the parameters' test values.
 */
export async function runLibraryDraft(
  deps: QueryRunDeps,
  access: Access,
  user: { id: string; email: string; name: string },
  opts: {
    query: LibraryQuery
    environmentId: string
    params?: Record<string, unknown>
    signal?: AbortSignal
  },
): Promise<QueryOutcome> {
  if (!atLeast(access.libraryQueryLevel(opts.query), 'edit')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You need edit access to this library query to run its draft',
    })
  }
  const definition = opts.query.draftDefinition
  const params =
    opts.params ?? Object.fromEntries(definition.params.map((p) => [p.name, p.testValue ?? null]))
  return runStoredQuery(deps, access, user, {
    resource: definition.resource,
    query: definition.query,
    environmentId: opts.environmentId,
    evaluate: libraryEvaluator(deps.sandbox, definition, params, user),
    draft: "this library query's draft",
    ...(definition.timeoutMs !== undefined && { timeoutMs: definition.timeoutMs }),
    ...(opts.signal && { signal: opts.signal }),
    labels: { ow_source: 'library', ow_library: opts.query.slug, ow_user: user.id },
  })
}
