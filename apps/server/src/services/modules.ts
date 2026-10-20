import {
  type AppDefinition,
  appDefinitionHash,
  canonicalizeApp,
  type ModuleInfo,
  moduleInterface,
} from '@ow/app-definition'
import { type Db, type Module, type ModuleRelease, moduleReleases, modules } from '@ow/db'
import { canonicalJson, type VersionBump } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { type AnyColumn, and, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import { type AppQueryDeps, type AppQueryOutcome, checkVouched, runDefinitionQuery } from './apps'
import { type Dependent, dependents } from './dependents'
import { type Access, atLeast } from './permissions'
import { nextReleaseVersion } from './release-versions'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

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
          // Only the interface part, not the whole definition of every release.
          module: sql<AppDefinition['module'] | null>`${moduleReleases.definition} -> 'module'`,
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
        versions: Object.fromEntries(
          own.map((r) => [r.version, moduleInterface({ module: r.module ?? undefined })]),
        ),
      }
      return [module.slug, { module, info }]
    }),
  )
}

/** A module release as the page runs it (M14): the runtime's `ModuleRelease` plus its version. */
export interface InstanceRelease {
  releaseId: string
  version: string
  definition: AppDefinition
}

/**
 * The module releases named by `slug@version` keys: pinned, or the live one for `latest`. Keys naming a module
 * that doesn't exist, isn't `visible`, or has no such release are left out (those instances don't run).
 */
export async function moduleReleasesByKey(
  db: Db,
  keys: string[],
  visible: (module: Module) => boolean = () => true,
): Promise<Record<string, InstanceRelease>> {
  const refs = [...new Set(keys)].flatMap((key) => {
    const at = key.lastIndexOf('@')
    return at > 0 ? [{ key, slug: key.slice(0, at), version: key.slice(at + 1) }] : []
  })
  if (!refs.length) return {}
  const rows = (
    await db
      .select()
      .from(modules)
      .where(inArray(modules.slug, [...new Set(refs.map((r) => r.slug))]))
  ).filter(visible)
  if (!rows.length) return {}
  const liveIds = rows.flatMap((m) => (m.liveReleaseId ? [m.liveReleaseId] : []))
  const pinned = refs.flatMap((r) => (r.version === 'latest' ? [] : [r.version]))
  const conditions = [
    ...(liveIds.length ? [inArray(moduleReleases.id, liveIds)] : []),
    ...(pinned.length ? [inArray(moduleReleases.version, pinned)] : []),
  ]
  const releases = conditions.length
    ? await db
        .select({
          id: moduleReleases.id,
          moduleId: moduleReleases.moduleId,
          version: moduleReleases.version,
          definition: moduleReleases.definition,
        })
        .from(moduleReleases)
        .where(
          and(
            inArray(
              moduleReleases.moduleId,
              rows.map((m) => m.id),
            ),
            or(...conditions),
          ),
        )
    : []
  const found: Record<string, InstanceRelease> = {}
  for (const ref of refs) {
    const module = rows.find((m) => m.slug === ref.slug)
    const release =
      module &&
      releases.find((r) =>
        ref.version === 'latest'
          ? r.id === module.liveReleaseId
          : r.moduleId === module.id && r.version === ref.version,
      )
    if (release)
      found[ref.key] = { releaseId: release.id, version: release.version, definition: release.definition }
  }
  return found
}

/** The release a module instance names: pinned, or the live one for `latest`. */
export async function resolveModuleRelease(
  db: Db,
  slug: string,
  version: string,
): Promise<{ module: Module; release: ModuleRelease }> {
  const [module] = await db.select().from(modules).where(eq(modules.slug, slug))
  if (!module) throw new TRPCError({ code: 'BAD_REQUEST', message: `No module has the slug "${slug}"` })
  const where =
    version === 'latest'
      ? module.liveReleaseId
        ? eq(moduleReleases.id, module.liveReleaseId)
        : undefined
      : and(eq(moduleReleases.moduleId, module.id), eq(moduleReleases.version, version))
  const [release] = where ? await db.select().from(moduleReleases).where(where) : []
  if (!release) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        version === 'latest'
          ? `Module "${slug}" has no live release`
          : `Module "${slug}" has no release ${version}`,
    })
  }
  return { module, release }
}

/** Where an app definition places a module: `[{ "type": "module", "props": { "module": slug } }]`. */
const placesModule = (column: SQL | AnyColumn, slug: string) =>
  sql`${column} -> 'components' @> ${JSON.stringify([{ type: 'module', props: { module: slug } }])}::jsonb`

/** The apps placing a module: in their draft, their live release or an open Git branch draft (no modules in modules). */
export const moduleUsers = (db: Db, slug: string): Promise<Dependent[]> =>
  dependents(db, (column) => placesModule(column, slug), { modules: false })

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

/**
 * Deploys a protected module from Git (M14): the name, description and draft follow the repo, and when the
 * definition differs from the live release's, a new release made by Git sync (`created_by` null, the commit SHA)
 * goes live. Nobody's grants are checked; everything else publishing checks is. Returns the release, or null when
 * the definition was already live.
 */
export async function deployModuleFromGit(
  db: Db,
  opts: {
    module: Module
    name: string
    description: string | null
    definition: AppDefinition
    commit: string
    notes: string | null
  },
): Promise<ModuleRelease | null> {
  const definition = canonicalizeApp(opts.definition)
  const hash = await appDefinitionHash(definition)
  await checkReleasable(db, null, opts.module, definition)
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(modules).where(eq(modules.id, opts.module.id)).for('update')
    if (!locked) throw new TRPCError({ code: 'NOT_FOUND', message: 'The module was deleted meanwhile' })
    // Compared canonically: jsonb doesn't keep key order.
    const draftChanged = canonicalJson(canonicalizeApp(locked.draftDefinition)) !== canonicalJson(definition)
    await tx
      .update(modules)
      .set({
        name: opts.name,
        description: opts.description,
        ...(draftChanged
          ? { draftDefinition: definition, draftRevision: locked.draftRevision + 1, updatedBy: null }
          : {}),
      })
      .where(eq(modules.id, locked.id))
    const release = await insertRelease(tx, locked, definition, hash, {
      notes: opts.notes,
      createdBy: null,
      gitCommit: opts.commit,
    })
    if ('unchanged' in release) return null
    await tx.update(modules).set({ liveReleaseId: release.id }).where(eq(modules.id, locked.id))
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
    /** A Git branch draft's definition (M14), instead of the main draft. */
    definition?: AppDefinition
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
    definition: opts.definition ?? opts.module.draftDefinition,
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
