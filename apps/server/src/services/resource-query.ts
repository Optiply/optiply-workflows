import { ConnectorError, getConnector, type PoolManager, runQuery } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import { type Db, resourceConfigs, resources } from '@ow/db'
import type { CodeRuntime } from '@ow/sandbox'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { credentialsFor } from './oauth-tokens'
import { type Access, atLeast } from './permissions'
import { errorView, toJson } from './query-results'
import { toResolved } from './resources'

export interface QueryRunDeps {
  db: Db
  keyring: Keyring
  pool: PoolManager
  sandbox: CodeRuntime
}

export type QueryOutcome =
  | { ok: true; data: unknown; metadata: Record<string, unknown>; durationMs: number }
  | { ok: false; error: { code: string; message: string; details: unknown }; durationMs: number }

/**
 * Runs a stored resource query (an app's or a library query's) for a person in one environment. `evaluate` gives
 * each `{{ }}`'s value; values that came from the browser are untrusted (`untrustedValues`: SQL binds them as
 * parameters, a REST path gets each as one encoded segment). With `draft` set, the person also needs Use on the
 * resource in that environment (a draft is vouched for by nobody); a release was vouched for by its publisher.
 * Connector errors come back as an outcome; anything else throws.
 */
export async function runStoredQuery(
  deps: QueryRunDeps,
  access: Access,
  user: { id: string },
  opts: {
    resource: string
    query: Record<string, unknown>
    environmentId: string
    evaluate: (code: string) => unknown
    /** What the person is running, for the error without Use on the resource ("the draft's queries"). */
    draft: string | null
    timeoutMs?: number
    signal?: AbortSignal
    labels: Record<string, string>
  },
): Promise<QueryOutcome> {
  const { db } = deps
  const [resource] = await db.select().from(resources).where(eq(resources.slug, opts.resource))
  if (!resource) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `No resource has the slug "${opts.resource}"` })
  }
  if (opts.draft !== null && !atLeast(access.level(resource, opts.environmentId), 'use')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You need use access to resource "${resource.slug}" in this environment to run ${opts.draft}`,
    })
  }
  const connector = getConnector(resource.type)
  if (!connector)
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown resource type "${resource.type}"` })
  const [row] = await db
    .select()
    .from(resourceConfigs)
    .where(
      and(eq(resourceConfigs.resourceId, resource.id), eq(resourceConfigs.environmentId, opts.environmentId)),
    )
  if (!row) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Resource "${resource.slug}" isn't configured in this environment`,
    })
  }

  const started = performance.now()
  try {
    const resolved = toResolved(deps.keyring, row)
    // A person is always behind these queries: per-user resources use their own account.
    const credentials = credentialsFor(
      { db, keyring: deps.keyring, sandbox: deps.sandbox },
      resolved,
      user.id,
    )
    const result = await runQuery(deps.pool, connector, resolved, opts.query, {
      evaluate: opts.evaluate,
      ...(credentials && { credentials }),
      ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
      ...(opts.signal && { signal: opts.signal }),
      labels: opts.labels,
      untrustedValues: true,
    })
    return {
      ok: true,
      data: toJson(result.data),
      metadata: toJson(result.metadata) as Record<string, unknown>,
      durationMs: Math.round(performance.now() - started),
    }
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err
    return { ok: false, error: errorView(err), durationMs: Math.round(performance.now() - started) }
  }
}
