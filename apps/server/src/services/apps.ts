import {
  type AppDefinition,
  type AppDiagnostic,
  appDefinitionHash,
  canonicalizeApp,
  expressionSide,
  validateApp,
} from '@ow/app-definition'
import { ConnectorError, getConnector, type PoolManager, runQuery } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import {
  type App,
  type AppRelease,
  appReleases,
  apps,
  type Db,
  environments,
  gitBranchDrafts,
  type Resource,
  resourceConfigs,
  resources,
} from '@ow/db'
import { bumpVersion, canonicalJson, compareVersions, parseSemver, type VersionBump } from '@ow/definition'
import type { CodeRuntime } from '@ow/sandbox'
import { TRPCError } from '@trpc/server'
import { and, eq, inArray } from 'drizzle-orm'
import { credentialsFor } from './oauth-tokens'
import { type Access, atLeast } from './permissions'
import { errorView, toJson } from './query-results'
import { toResolved } from './resources'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Each server-side `{{ }}` (one reading `current_user`) gets this long in the sandbox. */
const EXPRESSION_TIMEOUT_MS = 5_000

/** The resources an app's resource queries name, by slug. */
function queriedResources(def: AppDefinition): string[] {
  return [...new Set(def.queries.flatMap((q) => (q.kind === 'resource' ? [q.resource] : [])))].sort()
}

/** Validates an app with its resource queries checked by their connectors; also returns those resources. */
export async function checkApp(
  db: Db,
  definition: AppDefinition,
): Promise<{ resources: Resource[]; errors: AppDiagnostic[]; diagnostics: AppDiagnostic[] }> {
  const slugs = queriedResources(definition)
  const rows = slugs.length ? await db.select().from(resources).where(inArray(resources.slug, slugs)) : []
  const bySlug = new Map(rows.map((r) => [r.slug, r]))
  const { diagnostics } = validateApp(definition, {
    resolveResource: (slug) => {
      const resource = bySlug.get(slug)
      return resource ? getConnector(resource.type) : undefined
    },
  })
  return { resources: rows, errors: diagnostics.filter((d) => d.severity === 'error'), diagnostics }
}

/**
 * What making a definition live takes. People with only Use on the app run its queries, so whoever publishes
 * vouches for them: Edit on the app and Use on every resource it queries in every environment (the viewer picks
 * the environment). The definition must be valid, with each query checked by its connector. `access` null is Git
 * sync (M11): no grants are checked, the rest is.
 */
async function checkReleasable(
  db: Db,
  access: Access | null,
  app: App,
  definition: AppDefinition,
): Promise<void> {
  if (access && !atLeast(access.appLevel(app), 'edit')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to this app to release it' })
  }
  const { resources: used, errors } = await checkApp(db, definition)
  if (errors.length) {
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''
    throw new TRPCError({ code: 'BAD_REQUEST', message: `The app isn't valid: ${errors[0]!.message}${more}` })
  }
  const envIds = (await db.select({ id: environments.id }).from(environments)).map((e) => e.id)
  for (const resource of access ? used : []) {
    if (!atLeast(access!.levelEverywhere(resource, envIds), 'use')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to resource "${resource.slug}" in every environment to release this app`,
      })
    }
  }
}

const changedSince = (revision: number) =>
  new TRPCError({
    code: 'CONFLICT',
    message: `The draft changed since revision ${revision}; reload before publishing`,
  })

/**
 * Publishes the draft as a new release and makes it live. Refused when someone saved since `draftRevision` (the
 * publisher would release changes they haven't seen) or when nothing changed since the live release. The version
 * is given or bumped from the highest one, and must be higher than every existing release.
 */
export async function publishAppRelease(
  db: Db,
  access: Access,
  user: { id: string },
  opts: { app: App; draftRevision: number; version?: string; bump?: VersionBump; notes?: string | null },
): Promise<AppRelease> {
  const { app } = opts
  if (app.draftRevision !== opts.draftRevision) throw changedSince(opts.draftRevision)
  const definition = canonicalizeApp(app.draftDefinition)
  const hash = await appDefinitionHash(definition)
  await checkReleasable(db, access, app, definition)

  return db.transaction(async (tx) => {
    // Serializes publishing and setting the live release of one app.
    const [locked] = await tx.select().from(apps).where(eq(apps.id, app.id)).for('update')
    if (!locked || locked.draftRevision !== opts.draftRevision) throw changedSince(opts.draftRevision)
    const release = await insertAppRelease(tx, locked, definition, hash, {
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
    await tx.update(apps).set({ liveReleaseId: release.id }).where(eq(apps.id, app.id))
    return release
  })
}

/**
 * Deploys an app from Git (M11): its draft, name and description become what the branch holds, and when the
 * definition differs from the live release's, a new patch release made by Git sync (`created_by` null, the commit
 * SHA) goes live. Nobody's grants are checked; everything else publishing checks is. Returns the release, or null
 * when the definition was already live.
 */
export async function deployAppFromGit(
  db: Db,
  opts: {
    app: App
    name: string
    description: string | null
    definition: AppDefinition
    commit: string
    notes: string | null
  },
): Promise<AppRelease | null> {
  const definition = canonicalizeApp(opts.definition)
  const hash = await appDefinitionHash(definition)
  await checkReleasable(db, null, opts.app, definition)
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(apps).where(eq(apps.id, opts.app.id)).for('update')
    if (!locked) throw new TRPCError({ code: 'NOT_FOUND', message: 'The app was deleted meanwhile' })
    // Compared canonically: jsonb doesn't keep key order.
    const draftChanged = canonicalJson(canonicalizeApp(locked.draftDefinition)) !== canonicalJson(definition)
    await tx
      .update(apps)
      .set({
        name: opts.name,
        description: opts.description,
        ...(draftChanged
          ? { draftDefinition: definition, draftRevision: locked.draftRevision + 1, updatedBy: null }
          : {}),
      })
      .where(eq(apps.id, locked.id))
    const release = await insertAppRelease(tx, locked, definition, hash, {
      notes: opts.notes,
      createdBy: null,
      gitCommit: opts.commit,
    })
    if ('unchanged' in release) return null
    await tx.update(apps).set({ liveReleaseId: release.id }).where(eq(apps.id, locked.id))
    return release
  })
}

/** Inserts the next release of a locked app, unless the live one already has this hash. */
async function insertAppRelease(
  tx: Tx,
  locked: App,
  definition: AppDefinition,
  hash: string,
  opts: {
    version?: string
    bump?: VersionBump
    notes?: string | null
    createdBy: string | null
    gitCommit: string | null
  },
): Promise<AppRelease | { unchanged: string }> {
  const existing = await tx
    .select({ id: appReleases.id, version: appReleases.version, hash: appReleases.definitionHash })
    .from(appReleases)
    .where(eq(appReleases.appId, locked.id))
  const live = existing.find((r) => r.id === locked.liveReleaseId)
  if (live?.hash === hash) return { unchanged: live.version }
  const highest =
    existing
      .map((r) => r.version)
      .sort(compareVersions)
      .at(-1) ?? null
  const version = opts.version ?? bumpVersion(highest, opts.bump ?? 'patch')
  if (!parseSemver(version)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Use a version like 1.2.3' })
  if (highest && compareVersions(version, highest) <= 0) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `The version must be higher than v${highest}, the latest release`,
    })
  }
  const [release] = await tx
    .insert(appReleases)
    .values({
      appId: locked.id,
      version,
      definition,
      definitionHash: hash,
      notes: opts.notes?.trim() || null,
      createdBy: opts.createdBy,
      gitCommit: opts.gitCommit,
    })
    .returning()
  return release!
}

/** Makes another release live (rollback, or forward again). The same checks as publishing apply. */
export async function setLiveAppRelease(
  db: Db,
  access: Access,
  opts: { app: App; releaseId: string },
): Promise<AppRelease> {
  const [release] = await db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.id, opts.releaseId), eq(appReleases.appId, opts.app.id)))
  if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
  await checkReleasable(db, access, opts.app, release.definition)
  await db.update(apps).set({ liveReleaseId: release.id }).where(eq(apps.id, opts.app.id))
  return release
}

export interface AppQueryDeps {
  db: Db
  keyring: Keyring
  pool: PoolManager
  sandbox: CodeRuntime
}

export type AppQueryOutcome =
  | { ok: true; data: unknown; metadata: Record<string, unknown>; durationMs: number }
  | { ok: false; error: { code: string; message: string; details: unknown }; durationMs: number }

/**
 * Runs one of an app's resource queries, as stored in the draft (`releaseId` null) or the live release, in one
 * environment. The browser sends the values of the query's `{{ }}`s keyed by their code. Those values are whatever
 * the viewer sends: SQL connectors bind them as parameters (a value never becomes SQL); a REST request's path gets
 * each one as a single encoded segment (`untrustedValues`); elsewhere (query string, headers, body) they're the
 * request's own data, as the publisher wrote it.
 * Expressions reading `current_user` are evaluated here instead.
 *
 * Who may: for the draft, Edit on the app and Use on the resource in that environment (like a workflow's draft
 * run); for the live release, Use on the app (its publisher vouched for the resources). A release that is no
 * longer live is refused, so a page left open can't keep running an old version's queries.
 */
export async function runAppQuery(
  deps: AppQueryDeps,
  access: Access,
  user: { id: string; email: string; name: string },
  opts: {
    app: App
    releaseId: string | null
    /** With `releaseId` null: a Git branch draft of a protected app (M11) instead of the main draft. */
    branchDraftId?: string
    query: string
    environmentId: string
    values: Record<string, unknown>
    signal?: AbortSignal
  },
): Promise<{ outcome: AppQueryOutcome; manual: boolean; version: string | null }> {
  const { db } = deps
  const { app } = opts
  let definition: AppDefinition
  let version: string | null = null
  if (opts.releaseId === null) {
    if (!atLeast(access.appLevel(app), 'edit')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to this app to run its draft' })
    }
    if (opts.branchDraftId) {
      const [draft] = await db
        .select()
        .from(gitBranchDrafts)
        .where(and(eq(gitBranchDrafts.id, opts.branchDraftId), eq(gitBranchDrafts.appId, app.id)))
      if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'This app has no such branch draft' })
      definition = draft.definition as AppDefinition
    } else {
      definition = app.draftDefinition
    }
  } else {
    if (!atLeast(access.appLevel(app), 'use')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You need use access to this app' })
    }
    if (opts.releaseId !== app.liveReleaseId) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This version of the app is no longer live; reload to get the current one',
      })
    }
    const [release] = await db.select().from(appReleases).where(eq(appReleases.id, opts.releaseId))
    if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
    definition = release.definition
    version = release.version
  }

  const query = definition.queries.find((q) => q.name === opts.query)
  if (!query)
    throw new TRPCError({ code: 'NOT_FOUND', message: `The app has no query named "${opts.query}"` })
  if (query.kind !== 'resource') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `"${query.name}" is a JS query; it runs in the browser`,
    })
  }
  const [resource] = await db.select().from(resources).where(eq(resources.slug, query.resource))
  if (!resource) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `No resource has the slug "${query.resource}"` })
  }
  if (opts.releaseId === null && !atLeast(access.level(resource, opts.environmentId), 'use')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You need use access to resource "${resource.slug}" in this environment to run the draft's queries`,
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

  const currentUser = { id: user.id, email: user.email, name: user.name }
  const evaluate = (code: string): unknown => {
    switch (expressionSide(code)) {
      case 'server':
        return deps.sandbox.evalExpression(
          code,
          { current_user: currentUser },
          { timeoutMs: EXPRESSION_TIMEOUT_MS },
        )
      case 'mixed':
        throw new Error('current_user must be in a {{ }} of its own')
      case 'browser':
        if (!Object.hasOwn(opts.values, code)) {
          throw new Error('The browser sent no value for it; reload the app')
        }
        return opts.values[code]
    }
  }

  const started = performance.now()
  let outcome: AppQueryOutcome
  try {
    const resolved = toResolved(deps.keyring, row)
    // Apps always have a person behind them: per-user resources use the viewer's own account.
    const credentials = credentialsFor(
      { db, keyring: deps.keyring, sandbox: deps.sandbox },
      resolved,
      user.id,
    )
    const result = await runQuery(deps.pool, connector, resolved, query.query, {
      evaluate,
      ...(credentials && { credentials }),
      ...(query.timeoutMs !== undefined && { timeoutMs: query.timeoutMs }),
      ...(opts.signal && { signal: opts.signal }),
      labels: { ow_source: 'app', ow_app: app.slug, ow_user: user.id },
      // The values came from the browser: a REST path gets each as one encoded segment.
      untrustedValues: true,
    })
    outcome = {
      ok: true,
      data: toJson(result.data),
      metadata: toJson(result.metadata) as Record<string, unknown>,
      durationMs: Math.round(performance.now() - started),
    }
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err
    outcome = {
      ok: false,
      error: errorView(err),
      durationMs: Math.round(performance.now() - started),
    }
  }
  return { outcome, manual: query.run === 'manual', version }
}
