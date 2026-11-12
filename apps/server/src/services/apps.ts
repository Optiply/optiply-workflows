import {
  type AppDefinition,
  type AppDiagnostic,
  appDefinitionHash,
  canonicalizeApp,
  expressionSide,
  type InstanceStep,
  usedComponentLibraries,
  usedLibraries,
  usedModules,
  validateApp,
} from '@ow/app-definition'
import { getConnector } from '@ow/connectors'
import {
  type App,
  type AppRelease,
  appReleases,
  apps,
  type ComponentLibrary,
  type Db,
  environments,
  gitBranchDrafts,
  type LibraryQuery,
  type Module,
  type Resource,
  resources,
} from '@ow/db'
import { canonicalJson, type VersionBump } from '@ow/definition'
import { BlockFailure } from '@ow/engine'
import { TRPCError } from '@trpc/server'
import { and, eq, inArray } from 'drizzle-orm'
import { componentLibraryInfos } from './component-libraries'
import { type ReleaseJsBundle, releaseJsBundle } from './js-modules'
import { libraryEvaluator, libraryInfos, renderParams, resolveLibraryRelease } from './library-queries'
import { moduleInfos, walkInstancePath } from './modules'
import { type Access, atLeast } from './permissions'
import { nextReleaseVersion } from './release-versions'
import { type QueryOutcome, type QueryRunDeps, runStoredQuery } from './resource-query'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Each server-side `{{ }}` (one reading `current_user`) gets this long in the sandbox. */
const EXPRESSION_TIMEOUT_MS = 5_000

/** The resources an app's resource queries name, by slug. */
function queriedResources(def: AppDefinition): string[] {
  return [...new Set(def.queries.flatMap((q) => (q.kind === 'resource' ? [q.resource] : [])))].sort()
}

/**
 * Validates an app with its resource queries checked by their connectors and its library queries against the
 * library (the version exists, the parameters are declared); also returns those resources and library queries.
 */
export async function checkApp(
  db: Db,
  definition: AppDefinition,
  /** Checking a module (M21): its slug, so instances reaching it back are cycles. */
  self?: string,
): Promise<{
  resources: Resource[]
  libraries: LibraryQuery[]
  modules: Module[]
  componentLibraries: ComponentLibrary[]
  errors: AppDiagnostic[]
  diagnostics: AppDiagnostic[]
}> {
  const slugs = queriedResources(definition)
  const [rows, libraries, placed, components] = await Promise.all([
    slugs.length ? db.select().from(resources).where(inArray(resources.slug, slugs)) : [],
    libraryInfos(db, usedLibraries(definition)),
    moduleInfos(db, usedModules(definition)),
    componentLibraryInfos(db, usedComponentLibraries(definition)),
  ])
  const bySlug = new Map(rows.map((r) => [r.slug, r]))
  const { diagnostics } = validateApp(definition, {
    resolveModule: (slug) => placed.get(slug)?.info,
    resolveResource: (slug) => {
      const resource = bySlug.get(slug)
      return resource ? getConnector(resource.type) : undefined
    },
    resolveLibrary: (slug) => libraries.get(slug)?.info,
    resolveComponentLibrary: (slug) => components.get(slug)?.info,
    ...(self && { self }),
  })
  return {
    resources: rows,
    libraries: [...libraries.values()].map((l) => l.query),
    modules: [...placed.values()].map((m) => m.module),
    componentLibraries: [...components.values()].map((c) => c.library),
    errors: diagnostics.filter((d) => d.severity === 'error'),
    diagnostics,
  }
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
  /** Whose release it is, and (a rollback) the release's own JavaScript bundle and lock. */
  js: { actorUserId: string | null; existing?: { jsLock: string | null; jsBundleHash: string | null } },
): Promise<ReleaseJsBundle | null> {
  if (access && !atLeast(access.appLevel(app), 'edit')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to this app to release it' })
  }
  await checkVouched(db, access, definition, 'app')
  // Last, as it may take a while (a first install): every cheaper reason to refuse comes first.
  try {
    return await releaseJsBundle(db, definition.javascript?.packages, js.existing ?? null, {
      objectType: 'app',
      objectId: app.id,
      actorUserId: js.actorUserId,
    })
  } catch (err) {
    if (!(err instanceof BlockFailure)) throw err
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
}

/**
 * What vouching for a definition's queries takes (an app's or a module's, M14): it's valid, and the publisher has
 * Use on every resource it queries in every environment, and on every library query and module it uses (whose
 * own publishers vouched for theirs). `access` null is Git sync: grants aren't checked.
 */
export async function checkVouched(
  db: Db,
  access: Access | null,
  definition: AppDefinition,
  what: 'app' | 'module',
  /** A module's slug (M21; see `checkApp`). */
  self?: string,
): Promise<void> {
  const {
    resources: used,
    libraries,
    modules: placed,
    componentLibraries,
    errors,
  } = await checkApp(db, definition, self)
  if (errors.length) {
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The ${what} isn't valid: ${errors[0]!.message}${more}`,
    })
  }
  if (!access) return
  for (const library of libraries) {
    if (!atLeast(access.libraryQueryLevel(library), 'use')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to library query "${library.slug}" to release this ${what}, which uses it`,
      })
    }
  }
  for (const module of placed) {
    if (!atLeast(access.moduleLevel(module), 'use')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to module "${module.slug}" to release this ${what}, which uses it`,
      })
    }
  }
  for (const library of componentLibraries) {
    if (!atLeast(access.componentLibraryLevel(library), 'use')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to component library "${library.slug}" to release this ${what}, which uses it`,
      })
    }
  }
  const envIds = (await db.select({ id: environments.id }).from(environments)).map((e) => e.id)
  for (const resource of used) {
    if (!atLeast(access.levelEverywhere(resource, envIds), 'use')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You need use access to resource "${resource.slug}" in every environment to release this ${what}`,
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
  const js = await checkReleasable(db, access, app, definition, { actorUserId: user.id })

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
      js,
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
  const js = await checkReleasable(db, null, opts.app, definition, { actorUserId: null })
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
      js,
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
    js: ReleaseJsBundle | null
  },
): Promise<AppRelease | { unchanged: string }> {
  const existing = await tx
    .select({ id: appReleases.id, version: appReleases.version, hash: appReleases.definitionHash })
    .from(appReleases)
    .where(eq(appReleases.appId, locked.id))
  const live = existing.find((r) => r.id === locked.liveReleaseId)
  if (live?.hash === hash) return { unchanged: live.version }
  const version = nextReleaseVersion(
    existing.map((r) => r.version),
    opts,
  )
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
      jsLock: opts.js?.jsLock ?? null,
      jsBundleHash: opts.js?.jsBundleHash ?? null,
    })
    .returning()
  return release!
}

/** Makes another release live (rollback, or forward again). The same checks as publishing apply. */
export async function setLiveAppRelease(
  db: Db,
  access: Access,
  opts: { app: App; releaseId: string; actorUserId?: string | null },
): Promise<AppRelease> {
  const [release] = await db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.id, opts.releaseId), eq(appReleases.appId, opts.app.id)))
  if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
  const js = await checkReleasable(db, access, opts.app, release.definition, {
    actorUserId: opts.actorUserId ?? null,
    existing: { jsLock: release.jsLock, jsBundleHash: release.jsBundleHash },
  })
  // Its JavaScript packages' bundle, when it had none or lost it (rebuilt from its lock).
  if (js && (js.jsBundleHash !== release.jsBundleHash || js.jsLock !== release.jsLock)) {
    await db.update(appReleases).set(js).where(eq(appReleases.id, release.id))
    Object.assign(release, js)
  }
  await db.update(apps).set({ liveReleaseId: release.id }).where(eq(apps.id, opts.app.id))
  return release
}

export type AppQueryDeps = QueryRunDeps
export type AppQueryOutcome = QueryOutcome

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
 *
 * With `module` (M14), the query is a module instance's: it runs from the module release the instance names (its
 * publisher vouched for what it reaches), which must be the one the page runs (`releaseId`), or the page is told
 * to reload. Running the app's draft also needs Use on the module.
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
    /** A module instance's query (M14): the path of instances from the app, outermost first (M21). */
    module?: InstanceStep[]
    environmentId: string
    values: Record<string, unknown>
    signal?: AbortSignal
  },
): Promise<{
  outcome: AppQueryOutcome
  manual: boolean
  version: string | null
  /** For a library query: the release that ran. */
  library: { slug: string; version: string } | null
  /** For a module instance's query: the module release that ran. */
  module: { slug: string; version: string } | null
}> {
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

  const labels = { ow_source: 'app', ow_app: app.slug, ow_user: user.id }
  if (opts.module?.length) {
    const { module, release } = await walkInstancePath(db, access, definition, opts.module, {
      draft: opts.releaseId === null,
      what: 'app',
    })
    const ran = await runDefinitionQuery(deps, access, user, {
      definition: release.definition,
      what: 'module',
      query: opts.query,
      environmentId: opts.environmentId,
      values: opts.values,
      draft: false,
      labels: { ...labels, ow_module: module.slug },
      ...(opts.signal && { signal: opts.signal }),
    })
    return { ...ran, version, module: { slug: module.slug, version: release.version } }
  }

  const ran = await runDefinitionQuery(deps, access, user, {
    definition,
    what: 'app',
    query: opts.query,
    environmentId: opts.environmentId,
    values: opts.values,
    draft: opts.releaseId === null,
    labels,
    ...(opts.signal && { signal: opts.signal }),
  })
  return { ...ran, version, module: null }
}

/**
 * Runs one of a definition's server queries (an app's or a module's) by name with the values the browser sent:
 * a resource query on its resource, a library query from its release. `draft`: nobody vouched for the definition,
 * so the person needs Use on the resources and library queries themselves.
 */
export async function runDefinitionQuery(
  deps: AppQueryDeps,
  access: Access,
  user: { id: string; email: string; name: string },
  opts: {
    definition: AppDefinition
    /** Whose definition it is, for messages. */
    what: 'app' | 'module'
    query: string
    environmentId: string
    values: Record<string, unknown>
    draft: boolean
    labels: Record<string, string>
    signal?: AbortSignal
  },
): Promise<{
  outcome: AppQueryOutcome
  manual: boolean
  /** For a library query: the release that ran. */
  library: { slug: string; version: string } | null
}> {
  const { db } = deps
  const { definition } = opts
  const query = definition.queries.find((q) => q.name === opts.query)
  if (!query)
    throw new TRPCError({ code: 'NOT_FOUND', message: `The ${opts.what} has no query named "${opts.query}"` })
  if (query.kind === 'js') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `"${query.name}" is a JS query; it runs in the browser`,
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

  const { labels } = opts
  if (query.kind === 'resource') {
    const outcome = await runStoredQuery(deps, access, user, {
      resource: query.resource,
      query: query.query,
      environmentId: opts.environmentId,
      evaluate,
      draft: opts.draft ? "the draft's queries" : null,
      ...(query.timeoutMs !== undefined && { timeoutMs: query.timeoutMs }),
      ...(opts.signal && { signal: opts.signal }),
      labels,
    })
    return { outcome, manual: query.run === 'manual', library: null }
  }

  // A library query (M14): the release's resource and query run, vouched for by whoever published it. The app's
  // publisher vouched for using it; a draft's runner needs Use on it themselves.
  const { query: libraryQuery, release } = await resolveLibraryRelease(db, query.library, query.version)
  if (opts.draft && !atLeast(access.libraryQueryLevel(libraryQuery), 'use')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You need use access to library query "${libraryQuery.slug}" to run the draft's queries`,
    })
  }
  const library = release.definition
  // The parameters are rendered when the library query's first {{ }} needs them, so a broken one is reported as
  // that expression's error.
  let scoped: Promise<(code: string) => Promise<unknown>> | undefined
  const evaluateLibrary = async (code: string) => {
    scoped ??= renderParams(query.params ?? {}, evaluate).then((params) =>
      libraryEvaluator(deps.sandbox, library, params, user),
    )
    return (await scoped)(code)
  }
  const timeoutMs = query.timeoutMs ?? library.timeoutMs
  const outcome = await runStoredQuery(deps, access, user, {
    resource: library.resource,
    query: library.query,
    environmentId: opts.environmentId,
    evaluate: evaluateLibrary,
    draft: null,
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(opts.signal && { signal: opts.signal }),
    labels: { ...labels, ow_library: libraryQuery.slug },
  })
  return {
    outcome,
    manual: query.run === 'manual',
    library: { slug: libraryQuery.slug, version: release.version },
  }
}
