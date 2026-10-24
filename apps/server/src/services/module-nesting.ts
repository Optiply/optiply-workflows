import {
  type AppComponent,
  type AppDefinition,
  instanceRelease,
  MAX_MODULE_DEPTH,
  type ModuleNesting,
  moduleNesting,
} from '@ow/app-definition'
import { appReleases, apps, type Db, moduleReleases, modules } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { eq, sql } from 'drizzle-orm'

/**
 * How module releases nest (M21): each release's depth and the modules it reaches, `latest` as the live release.
 * Modules are few, so every release's components are loaded once and the nesting is computed in memory.
 */
export interface NestingWorld {
  /** The nesting of a module's release (`latest`: the live one); undefined when there's no such release. */
  of(slug: string, version: string): ModuleNesting | undefined
}

/** A module release about to go live (`version` null until it has one), for checking what publishing it does. */
export interface NestingOverride {
  slug: string
  components: AppComponent[]
}

/** Past this, a depth is only "too deep": cycles would otherwise count forever. */
const DEPTH_CAP = MAX_MODULE_DEPTH + 2
const NEW = '\0new'

export async function loadNesting(db: Db, override?: NestingOverride): Promise<NestingWorld> {
  const rows = await db
    .select({
      slug: modules.slug,
      liveReleaseId: modules.liveReleaseId,
      id: moduleReleases.id,
      version: moduleReleases.version,
      components: sql<AppComponent[]>`${moduleReleases.definition} -> 'components'`,
    })
    .from(moduleReleases)
    .innerJoin(modules, eq(modules.id, moduleReleases.moduleId))
  type Release = { id: string; components: AppComponent[] }
  const releases = new Map<string, Release>()
  for (const r of rows) {
    releases.set(`${r.slug}@${r.version}`, r)
    if (r.id === r.liveReleaseId && r.slug !== override?.slug) releases.set(`${r.slug}@latest`, r)
  }
  if (override) {
    const release = { id: NEW, components: override.components }
    releases.set(`${override.slug}@latest`, release)
  }

  const memo = new Map<string, ModuleNesting>()
  const walking = new Set<string>()
  const ofRelease = (release: Release): ModuleNesting => {
    const known = memo.get(release.id)
    if (known) return known
    // Reached again while walking it: a cycle. The walk above records the slug in `reaches`.
    if (walking.has(release.id)) return { depth: DEPTH_CAP, reaches: [] }
    walking.add(release.id)
    const own = moduleNesting({ components: release.components } as AppDefinition, (slug, version) => {
      const inner = releases.get(`${slug}@${version}`)
      return inner ? ofRelease(inner) : undefined
    })
    walking.delete(release.id)
    const capped = { ...own, depth: Math.min(own.depth, DEPTH_CAP) }
    memo.set(release.id, capped)
    return capped
  }
  return {
    of(slug, version) {
      const release = releases.get(`${slug}@${version}`)
      return release ? ofRelease(release) : undefined
    },
  }
}

/**
 * What making `components` the live release of module `slug` does to the apps and modules running it on `latest`
 * (M21): refused when a module would come to hold itself, or an app's modules would nest deeper than the limit,
 * naming them. The module's own definition was checked by the validator (with `self`).
 */
export async function checkLiveNesting(db: Db, slug: string, components: AppComponent[]): Promise<void> {
  const world = await loadNesting(db, { slug, components })
  const through = (n: ModuleNesting | undefined, at: string) =>
    !!n && (at === slug || n.reaches.includes(slug))

  const cycles: string[] = []
  const deep: string[] = []
  const liveModules = await db
    .select({ slug: modules.slug, name: modules.name })
    .from(modules)
    .where(sql`${modules.liveReleaseId} is not null`)
  for (const m of liveModules) {
    const n = world.of(m.slug, 'latest')
    if (!through(n, m.slug)) continue
    if (n!.reaches.includes(m.slug)) cycles.push(`module "${m.name}"`)
    else if (n!.depth > MAX_MODULE_DEPTH) deep.push(`module "${m.name}"`)
  }
  const liveApps = await db
    .select({ name: apps.name, components: sql<AppComponent[]>`${appReleases.definition} -> 'components'` })
    .from(apps)
    .innerJoin(appReleases, eq(appReleases.id, apps.liveReleaseId))
    .where(sql`${appReleases.definition} -> 'components' @> '[{"type": "module"}]'::jsonb`)
  for (const app of liveApps) {
    const tooDeep = app.components.some((c) => {
      const ref = c.type === 'module' ? instanceRelease(c) : null
      const n = ref && world.of(ref.slug, ref.version)
      return !!ref && through(n ?? undefined, ref.slug) && n!.depth > MAX_MODULE_DEPTH
    })
    if (tooDeep) deep.push(`app "${app.name}"`)
  }

  if (cycles.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Making this release live would make ${list(cycles)} hold itself through this module`,
    })
  }
  if (deep.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Making this release live would nest modules more than ${MAX_MODULE_DEPTH} deep in ${list(deep)}, which follow it on latest`,
    })
  }
}

const list = (names: string[]) =>
  names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
