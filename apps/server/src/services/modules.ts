import {
  type AppDefinition,
  appDefinitionHash,
  canonicalizeApp,
  type ModuleInfo,
  type ModuleInterface,
} from '@ow/app-definition'
import {
  type App,
  appReleases,
  apps,
  type Db,
  gitBranchDrafts,
  type Module,
  type ModuleRelease,
  moduleReleases,
  modules,
} from '@ow/db'
import type { VersionBump } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { type AnyColumn, and, asc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm'
import { type AppQueryDeps, type AppQueryOutcome, checkVouched, runDefinitionQuery } from './apps'
import { type Access, atLeast } from './permissions'
import { nextReleaseVersion } from './release-versions'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** The modules an app's components place, by slug. */
export function usedModules(def: AppDefinition): string[] {
  const slugs = def.components.flatMap((c) =>
    c.type === 'module' && typeof c.props?.module === 'string' ? [c.props.module] : [],
  )
  return [...new Set(slugs)].sort()
}

/** What an app sees of a module release: its inputs, outputs and events. */
export function moduleInterface(def: AppDefinition): ModuleInterface {
  return {
    inputs: def.module?.inputs.map((i) => i.name) ?? [],
    outputs: def.module?.outputs.map((o) => o.name) ?? [],
    events: def.module?.events.map((e) => e.name) ?? [],
  }
}

/** The modules an app places, by slug, with what the validator needs (the live version, each release's interface). */
export async function moduleInfos(
  db: Db,
  slugs: string[],
): Promise<Map<string, { module: Module; info: ModuleInfo }>> {
  if (!slugs.length) return new Map()
  const rows = await db.select().from(modules).where(inArray(modules.slug, slugs))
  const releases = rows.length
    ? await db
        .select({
          moduleId: moduleReleases.moduleId,
          id: moduleReleases.id,
          version: moduleReleases.version,
          definition: moduleReleases.definition,
        })
        .from(moduleReleases)
        .where(
          inArray(
            moduleReleases.moduleId,
            rows.map((r) => r.id),
          ),
        )
    : []
  return new Map(
    rows.map((module) => {
      const own = releases.filter((r) => r.moduleId === module.id)
      const info: ModuleInfo = {
        liveVersion: own.find((r) => r.id === module.liveReleaseId)?.version ?? null,
        versions: Object.fromEntries(own.map((r) => [r.version, moduleInterface(r.definition)])),
      }
      return [module.slug, { module, info }]
    }),
  )
}

/** Where an app definition places a module: `[{ "type": "module", "props": { "module": slug } }]`. */
const placesModule = (column: SQL | AnyColumn, slug: string) =>
  sql`${column} -> 'components' @> ${JSON.stringify([{ type: 'module', props: { module: slug } }])}::jsonb`

/** The apps placing a module: in their draft, their live release or an open Git branch draft. */
export async function moduleUsers(
  db: Db,
  slug: string,
): Promise<{ app: App; where: ('draft' | 'live' | 'branch')[] }[]> {
  const [drafts, live, branches] = await Promise.all([
    db.select({ id: apps.id }).from(apps).where(placesModule(apps.draftDefinition, slug)),
    db
      .select({ id: apps.id })
      .from(apps)
      .innerJoin(appReleases, eq(appReleases.id, apps.liveReleaseId))
      .where(placesModule(appReleases.definition, slug)),
    db
      .select({ id: gitBranchDrafts.appId })
      .from(gitBranchDrafts)
      .where(and(isNotNull(gitBranchDrafts.appId), placesModule(gitBranchDrafts.definition, slug))),
  ])
  const where = new Map<string, ('draft' | 'live' | 'branch')[]>()
  const add = (id: string | null, kind: 'draft' | 'live' | 'branch') => {
    if (!id) return
    const list = where.get(id) ?? []
    if (!list.includes(kind)) list.push(kind)
    where.set(id, list)
  }
  for (const r of drafts) add(r.id, 'draft')
  for (const r of live) add(r.id, 'live')
  for (const r of branches) add(r.id, 'branch')
  if (!where.size) return []
  const rows = await db
    .select()
    .from(apps)
    .where(inArray(apps.id, [...where.keys()]))
    .orderBy(asc(apps.name))
  return rows.map((app) => ({ app, where: where.get(app.id)! }))
}

/**
 * What making a module release live takes. Apps run its queries without their viewers or publishers holding any
 * grant on its resources, so whoever publishes it vouches for them, like an app's publisher (`checkVouched`), with
 * Edit on the module. It must be a module (a `module` part). `access` null is Git sync.
 */
async function checkReleasable(
  db: Db,
  access: Access | null,
  module: Module,
  definition: AppDefinition,
): Promise<void> {
  if (access && !atLeast(access.moduleLevel(module), 'edit')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You need edit access to this module to release it' })
  }
  if (!definition.module) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "The module isn't valid: it has no inputs, outputs or events part",
    })
  }
  await checkVouched(db, access, definition, 'module')
}

const changedSince = (revision: number) =>
  new TRPCError({
    code: 'CONFLICT',
    message: `The draft changed since revision ${revision}; reload before publishing`,
  })

/**
 * Publishes the draft as a new release and makes it live (instances following `latest` run it from then on).
 * Refused when someone saved since `draftRevision` or nothing changed since the live release.
 */
export async function publishModuleRelease(
  db: Db,
  access: Access,
  user: { id: string },
  opts: {
    module: Module
    draftRevision: number
    version?: string
    bump?: VersionBump
    notes?: string | null
  },
): Promise<ModuleRelease> {
  const { module } = opts
  if (module.draftRevision !== opts.draftRevision) throw changedSince(opts.draftRevision)
  const definition = canonicalizeApp(module.draftDefinition)
  const hash = await appDefinitionHash(definition)
  await checkReleasable(db, access, module, definition)
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(modules).where(eq(modules.id, module.id)).for('update')
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
    await tx.update(modules).set({ liveReleaseId: release.id }).where(eq(modules.id, module.id))
    return release
  })
}

async function insertRelease(
  tx: Tx,
  locked: Module,
  definition: AppDefinition,
  hash: string,
  opts: {
    version?: string
    bump?: VersionBump
    notes?: string | null
    createdBy: string | null
    gitCommit: string | null
  },
): Promise<ModuleRelease | { unchanged: string }> {
  const existing = await tx
    .select({ id: moduleReleases.id, version: moduleReleases.version, hash: moduleReleases.definitionHash })
    .from(moduleReleases)
    .where(eq(moduleReleases.moduleId, locked.id))
  const live = existing.find((r) => r.id === locked.liveReleaseId)
  if (live?.hash === hash) return { unchanged: live.version }
  const version = nextReleaseVersion(
    existing.map((r) => r.version),
    opts,
  )
  const [release] = await tx
    .insert(moduleReleases)
    .values({
      moduleId: locked.id,
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
export async function setLiveModuleRelease(
  db: Db,
  access: Access,
  opts: { module: Module; releaseId: string },
): Promise<ModuleRelease> {
  const [release] = await db
    .select()
    .from(moduleReleases)
    .where(and(eq(moduleReleases.id, opts.releaseId), eq(moduleReleases.moduleId, opts.module.id)))
  if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
  await checkReleasable(db, access, opts.module, release.definition)
  await db.update(modules).set({ liveReleaseId: release.id }).where(eq(modules.id, opts.module.id))
  return release
}

/**
 * Runs one of a module draft's queries, from its editor: Edit on the module, and Use on what the query reaches (a
 * draft is vouched for by nobody).
 */
export async function runModuleDraftQuery(
  deps: AppQueryDeps,
  access: Access,
  user: { id: string; email: string; name: string },
  opts: {
    module: Module
    query: string
    environmentId: string
    values: Record<string, unknown>
    signal?: AbortSignal
  },
): Promise<{ outcome: AppQueryOutcome; manual: boolean }> {
  if (!atLeast(access.moduleLevel(opts.module), 'edit')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You need edit access to this module to run its draft',
    })
  }
  const { outcome, manual } = await runDefinitionQuery(deps, access, user, {
    definition: opts.module.draftDefinition,
    what: 'module',
    query: opts.query,
    environmentId: opts.environmentId,
    values: opts.values,
    draft: true,
    labels: { ow_source: 'module', ow_module: opts.module.slug, ow_user: user.id },
    ...(opts.signal && { signal: opts.signal }),
  })
  return { outcome, manual }
}
