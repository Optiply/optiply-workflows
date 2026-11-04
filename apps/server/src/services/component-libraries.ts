import {
  type ComponentLibraryDefinition,
  type ComponentLibraryInfo,
  canonicalizeComponentLibrary,
  componentLibraryHash,
  componentLibraryInterface,
  validateComponentLibrary,
} from '@ow/app-definition'
import {
  type ComponentLibrary,
  type ComponentLibraryRelease,
  componentBundles,
  componentLibraries,
  componentLibraryReleases,
  type Db,
} from '@ow/db'
import { canonicalJson, type VersionBump } from '@ow/definition'
import { TRPCError } from '@trpc/server'
import { type AnyColumn, and, eq, inArray, lt, notExists, type SQL, sql } from 'drizzle-orm'
import {
  type BuildOutcome,
  buildComponentLibrary,
  bundleHashOf,
  type ComponentBuildConfig,
  MAX_BUNDLE_BYTES,
} from './components/build'
import { type Dependent, dependents } from './dependents'
import { type Access, atLeast } from './permissions'
import { nextReleaseVersion } from './release-versions'

/**
 * Component libraries (M25, architecture §2.28): React components written in the platform, built on the server and
 * run in a sandboxed frame. This file holds what the router, the apps service and Git share; the build is
 * `components/build.ts`.
 */

/** Where an app's or module's definition places one of the library's components. */
const placesLibrary = (column: SQL | AnyColumn, slug: string) =>
  sql`${column} -> 'components' @> ${JSON.stringify([{ type: 'custom', props: { library: slug } }])}::jsonb`

/**
 * The apps and modules placing a library's components: in their draft, their live release or an open Git branch
 * draft. Deleting it is refused while any does.
 */
export const componentLibraryUsers = (db: Db, slug: string): Promise<Dependent[]> =>
  dependents(db, (column) => placesLibrary(column, slug), { modules: true })

/**
 * The component libraries an app uses, by slug, with what the validator needs (`ComponentLibraryInfo`: the live
 * version and each release's components' interfaces, without their files).
 */
export async function componentLibraryInfos(
  db: Db,
  slugs: string[],
): Promise<Map<string, { library: ComponentLibrary; info: ComponentLibraryInfo }>> {
  if (!slugs.length) return new Map()
  const rows = await db.select().from(componentLibraries).where(inArray(componentLibraries.slug, slugs))
  const releases = rows.length
    ? await db
        .select({
          libraryId: componentLibraryReleases.componentLibraryId,
          id: componentLibraryReleases.id,
          version: componentLibraryReleases.version,
          // Only the components, not every release's files.
          components: sql<
            ComponentLibraryDefinition['components']
          >`${componentLibraryReleases.definition} -> 'components'`,
        })
        .from(componentLibraryReleases)
        .where(
          inArray(
            componentLibraryReleases.componentLibraryId,
            rows.map((r) => r.id),
          ),
        )
    : []
  return new Map(
    rows.map((library) => {
      const own = releases.filter((r) => r.libraryId === library.id)
      const info: ComponentLibraryInfo = {
        liveVersion: own.find((r) => r.id === library.liveReleaseId)?.version ?? null,
        versions: Object.fromEntries(
          own.map((r) => [r.version, componentLibraryInterface({ components: r.components ?? [] } as never)]),
        ),
      }
      return [library.slug, { library, info }]
    }),
  )
}

/**
 * The release a custom component runs: the pinned version, or the live one for `latest` (whichever is live when the
 * page opens).
 */
export async function resolveComponentLibraryRelease(db: Db, slug: string, version: string) {
  const [library] = await db.select().from(componentLibraries).where(eq(componentLibraries.slug, slug))
  if (!library)
    throw new TRPCError({ code: 'BAD_REQUEST', message: `No component library has the slug "${slug}"` })
  const where =
    version === 'latest'
      ? library.liveReleaseId
        ? eq(componentLibraryReleases.id, library.liveReleaseId)
        : undefined
      : and(
          eq(componentLibraryReleases.componentLibraryId, library.id),
          eq(componentLibraryReleases.version, version),
        )
  const [release] = where ? await db.select().from(componentLibraryReleases).where(where) : []
  if (!release) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        version === 'latest'
          ? `Component library "${slug}" has no live release`
          : `Component library "${slug}" has no release ${version}`,
    })
  }
  return { library, release }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Whether two lists of allowed origins differ (as sets): publishing such a change needs an admin. */
export function originsChanged(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size !== right.size || [...left].some((o) => !right.has(o))
}

/**
 * What making a release live takes: Edit on the library, a valid definition, and, when its allowed origins differ
 * from the live release's (none before the first), an admin: they decide where components may send an app's data.
 * `access` null is Git sync (its merges are reviewed; the change is audited).
 */
function checkReleasable(
  access: Access | null,
  library: ComponentLibrary,
  definition: ComponentLibraryDefinition,
  liveOrigins: readonly string[],
  opts: { uploaded?: boolean } = {},
): { originsChanged: boolean } {
  if (access && !atLeast(access.componentLibraryLevel(library), 'edit')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You need edit access to this component library to release it',
    })
  }
  const errors = validateComponentLibrary(definition).diagnostics.filter(
    (d) => d.severity === 'error' && !(opts.uploaded && d.code === 'unknown_entry'),
  )
  if (errors.length) {
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The component library isn't valid: ${errors[0]!.message}${more}`,
    })
  }
  const changed = originsChanged(definition.allowedOrigins, liveOrigins)
  if (changed && access && !access.isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'The allowed origins changed: only an admin can publish that (they decide where components may send data)',
    })
  }
  return { originsChanged: changed }
}

const changedSince = (revision: number) =>
  new TRPCError({
    code: 'CONFLICT',
    message: `The draft changed since revision ${revision}; reload before publishing`,
  })

/** The live release's origins and lock (none before the first release). */
async function liveOf(db: Db | Tx, library: ComponentLibrary) {
  if (!library.liveReleaseId) return { origins: [] as string[], lock: null, hash: null }
  const [live] = await db
    .select({
      definition: componentLibraryReleases.definition,
      lock: componentLibraryReleases.lock,
      hash: componentLibraryReleases.definitionHash,
    })
    .from(componentLibraryReleases)
    .where(eq(componentLibraryReleases.id, library.liveReleaseId))
  return {
    origins: live?.definition.allowedOrigins ?? [],
    lock: live?.lock ?? null,
    hash: live?.hash ?? null,
  }
}

const buildFailed = (outcome: Extract<BuildOutcome, { ok: false }>) => {
  const [first] = outcome.problems
  const at = first?.file ? `${first.file}${first.line ? `:${first.line}` : ''}: ` : ''
  const more = outcome.problems.length > 1 ? ` (and ${outcome.problems.length - 1} more)` : ''
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: `The build failed: ${at}${first?.message ?? outcome.stage}${more}`,
  })
}

/**
 * Builds the draft and publishes it as a new release made live (apps following `latest` get it when their page next
 * opens). Refused when someone saved since `draftRevision`, the build fails, or nothing changed since the live one.
 */
export async function publishComponentLibraryRelease(
  db: Db,
  build: ComponentBuildConfig,
  access: Access,
  user: { id: string },
  opts: {
    library: ComponentLibrary
    draftRevision: number
    version?: string
    bump?: VersionBump
    notes?: string | null
  },
): Promise<{ release: ComponentLibraryRelease; originsChanged: boolean }> {
  const { library } = opts
  if (library.draftRevision !== opts.draftRevision) throw changedSince(opts.draftRevision)
  const definition = library.draftDefinition
  const { originsChanged } = checkReleasable(access, library, definition, (await liveOf(db, library)).origins)
  const built = await buildComponentLibrary(db, build, definition, library.draftLock)
  if (!built.ok) throw buildFailed(built)
  const hash = await componentLibraryHash(definition)
  const release = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(componentLibraries)
      .where(eq(componentLibraries.id, library.id))
      .for('update')
    if (!locked || locked.draftRevision !== opts.draftRevision) throw changedSince(opts.draftRevision)
    const inserted = await insertRelease(tx, locked, definition, hash, {
      bundleHash: built.bundleHash,
      lock: built.lock,
      version: opts.version,
      bump: opts.bump,
      notes: opts.notes,
      createdBy: user.id,
      gitCommit: null,
    })
    if ('unchanged' in inserted) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Nothing changed since the live release, v${inserted.unchanged}`,
      })
    }
    await tx
      .update(componentLibraries)
      .set({ liveReleaseId: inserted.id, draftLock: built.lock })
      .where(eq(componentLibraries.id, library.id))
    return inserted
  })
  return { release, originsChanged }
}

/**
 * Makes a release from a bundle built elsewhere (`uploadBuild`): its JS and CSS, and the components it exports,
 * declared like a draft's. The release has no files (Compare and Git show none) and is marked uploaded.
 */
export async function uploadComponentLibraryBuild(
  db: Db,
  access: Access,
  user: { id: string },
  opts: {
    library: ComponentLibrary
    js: string
    css: string
    components: ComponentLibraryDefinition['components']
    allowedOrigins?: string[]
    version?: string
    bump?: VersionBump
    notes?: string | null
  },
): Promise<{ release: ComponentLibraryRelease; originsChanged: boolean }> {
  const { library } = opts
  const live = await liveOf(db, library)
  const definition: ComponentLibraryDefinition = {
    schemaVersion: 1,
    files: [],
    dependencies: {},
    allowedOrigins: opts.allowedOrigins ?? live.origins,
    components: opts.components,
  }
  const { originsChanged } = checkReleasable(access, library, definition, live.origins, { uploaded: true })
  const sizeBytes = Buffer.byteLength(opts.js) + Buffer.byteLength(opts.css)
  if (sizeBytes > MAX_BUNDLE_BYTES) {
    throw new TRPCError({
      code: 'PAYLOAD_TOO_LARGE',
      message: `A bundle is ${MAX_BUNDLE_BYTES / 1024 / 1024} MB at most`,
    })
  }
  const bundleHash = bundleHashOf(opts.js, opts.css)
  await db
    .insert(componentBundles)
    .values({ hash: bundleHash, inputHash: null, js: opts.js, css: opts.css, lock: null, sizeBytes })
    .onConflictDoNothing()
  const hash = await componentLibraryHash(definition)
  const release = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(componentLibraries)
      .where(eq(componentLibraries.id, library.id))
      .for('update')
    if (!locked)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'The component library was deleted meanwhile' })
    const inserted = await insertRelease(tx, locked, definition, hash, {
      bundleHash,
      lock: null,
      uploaded: true,
      version: opts.version,
      bump: opts.bump,
      notes: opts.notes,
      createdBy: user.id,
      gitCommit: null,
    })
    if ('unchanged' in inserted) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Nothing changed since the live release, v${inserted.unchanged}`,
      })
    }
    await tx
      .update(componentLibraries)
      .set({ liveReleaseId: inserted.id })
      .where(eq(componentLibraries.id, locked.id))
    return inserted
  })
  return { release, originsChanged }
}

/**
 * Deploys a protected library from Git, like a module: the repo's name, description and draft, then a build (from
 * the live release's lock, so packages move only as far as the ranges make them) and a release made by Git sync when
 * the definition differs from the live one. Returns the release, or null when it was already live.
 */
export async function deployComponentLibraryFromGit(
  db: Db,
  build: ComponentBuildConfig,
  opts: {
    library: ComponentLibrary
    name: string
    description: string | null
    definition: ComponentLibraryDefinition
    commit: string
    notes: string | null
  },
): Promise<(ComponentLibraryRelease & { originsChanged: boolean }) | null> {
  const { definition, library } = opts
  const live = await liveOf(db, library)
  const { originsChanged } = checkReleasable(null, library, definition, live.origins)
  const hash = await componentLibraryHash(definition)
  // What's live already (a commit changing only the name or folder): no build, no release.
  const built =
    hash === live.hash
      ? null
      : await buildComponentLibrary(db, build, definition, live.lock ?? library.draftLock)
  if (built && !built.ok) throw buildFailed(built)
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(componentLibraries)
      .where(eq(componentLibraries.id, library.id))
      .for('update')
    if (!locked)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'The component library was deleted meanwhile' })
    const draftChanged = canonicalJson(locked.draftDefinition) !== canonicalJson(definition)
    await tx
      .update(componentLibraries)
      .set({
        name: opts.name,
        description: opts.description,
        ...(built && { draftLock: built.lock }),
        ...(draftChanged
          ? { draftDefinition: definition, draftRevision: locked.draftRevision + 1, updatedBy: null }
          : {}),
      })
      .where(eq(componentLibraries.id, locked.id))
    if (!built) return null
    const release = await insertRelease(tx, locked, definition, hash, {
      bundleHash: built.bundleHash,
      lock: built.lock,
      notes: opts.notes,
      createdBy: null,
      gitCommit: opts.commit,
    })
    if ('unchanged' in release) return null
    await tx
      .update(componentLibraries)
      .set({ liveReleaseId: release.id })
      .where(eq(componentLibraries.id, locked.id))
    return { ...release, originsChanged }
  })
}

/** Inserts the next release of a locked library, unless the live one already has this hash. */
async function insertRelease(
  tx: Tx,
  locked: ComponentLibrary,
  definition: ComponentLibraryDefinition,
  hash: string,
  opts: {
    bundleHash: string
    lock: string | null
    uploaded?: boolean
    version?: string
    bump?: VersionBump
    notes?: string | null
    createdBy: string | null
    gitCommit: string | null
  },
): Promise<ComponentLibraryRelease | { unchanged: string }> {
  const existing = await tx
    .select({
      id: componentLibraryReleases.id,
      version: componentLibraryReleases.version,
      hash: componentLibraryReleases.definitionHash,
      bundleHash: componentLibraryReleases.bundleHash,
    })
    .from(componentLibraryReleases)
    .where(eq(componentLibraryReleases.componentLibraryId, locked.id))
  const live = existing.find((r) => r.id === locked.liveReleaseId)
  // The same source and the same build (an upload's definition can stay the same while its bundle changes).
  if (live?.hash === hash && live.bundleHash === opts.bundleHash) return { unchanged: live.version }
  const version = nextReleaseVersion(
    existing.map((r) => r.version),
    opts,
  )
  const [release] = await tx
    .insert(componentLibraryReleases)
    .values({
      componentLibraryId: locked.id,
      version,
      definition: JSON.parse(canonicalJson(canonicalizeComponentLibrary(definition))),
      definitionHash: hash,
      bundleHash: opts.bundleHash,
      lock: opts.lock,
      uploaded: opts.uploaded ?? false,
      notes: opts.notes?.trim() || null,
      createdBy: opts.createdBy,
      gitCommit: opts.gitCommit,
    })
    .returning()
  return release!
}

/** Makes another release live (rollback, or forward again): Edit; its origins were approved when it was published. */
export async function setLiveComponentLibraryRelease(
  db: Db,
  access: Access,
  opts: { library: ComponentLibrary; releaseId: string },
): Promise<ComponentLibraryRelease> {
  if (!atLeast(access.componentLibraryLevel(opts.library), 'edit')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You need edit access to this component library to change its live release',
    })
  }
  const [release] = await db
    .select()
    .from(componentLibraryReleases)
    .where(
      and(
        eq(componentLibraryReleases.id, opts.releaseId),
        eq(componentLibraryReleases.componentLibraryId, opts.library.id),
      ),
    )
  if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' })
  await db
    .update(componentLibraries)
    .set({ liveReleaseId: release.id })
    .where(eq(componentLibraries.id, opts.library.id))
  return release
}

/**
 * The names `droppedUses` compares for a library: each component, its props (`Chart.title`), events (`Chart:select`)
 * and methods (`Chart.highlight()`).
 */
export function componentNames(def: Pick<ComponentLibraryDefinition, 'components'>): string[] {
  return def.components.flatMap((c) => [
    c.name,
    ...Object.keys(c.props).map((p) => `${c.name}.${p}`),
    ...c.events.map((e) => `${c.name}:${e}`),
    ...Object.keys(c.methods).map((m) => `${c.name}.${m}()`),
  ])
}

/**
 * Bundles no release keeps and no build made or found in the last `days` (drafts' builds): retention removes them.
 * One a publish took meanwhile stays (the release's reference refuses the delete): nothing is removed this time.
 */
export async function deleteUnusedBundles(db: Db, days = 7): Promise<number> {
  const deleted = await db
    .delete(componentBundles)
    .where(
      and(
        lt(componentBundles.createdAt, sql`now() - make_interval(days => ${days})`),
        notExists(
          db
            .select({ one: sql`1` })
            .from(componentLibraryReleases)
            .where(eq(componentLibraryReleases.bundleHash, componentBundles.hash)),
        ),
      ),
    )
    .returning({ hash: componentBundles.hash })
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === '23503') return []
      throw err
    })
  return deleted.length
}

/** A library release as a page running an app needs it (`@ow/app-runtime`'s `ComponentLibraryRelease`). */
export interface PlacedLibraryRelease {
  releaseId: string
  version: string
  bundleHash: string
  allowedOrigins: string[]
  components: ReturnType<typeof componentLibraryInterface>
}

/**
 * The library releases named by `slug@version` keys: pinned, or the live one for `latest`. Keys naming a library
 * that doesn't exist, isn't `visible`, or has no such release are left out (those components don't run).
 */
export async function componentLibraryReleasesByKey(
  db: Db,
  keys: string[],
  visible: (library: ComponentLibrary) => boolean = () => true,
): Promise<Record<string, PlacedLibraryRelease>> {
  const refs = [...new Set(keys)].flatMap((key) => {
    const at = key.lastIndexOf('@')
    return at > 0 ? [{ key, slug: key.slice(0, at), version: key.slice(at + 1) }] : []
  })
  if (!refs.length) return {}
  const rows = (
    await db
      .select()
      .from(componentLibraries)
      .where(inArray(componentLibraries.slug, [...new Set(refs.map((r) => r.slug))]))
  ).filter(visible)
  if (!rows.length) return {}
  const releases = await db
    .select()
    .from(componentLibraryReleases)
    .where(
      inArray(
        componentLibraryReleases.componentLibraryId,
        rows.map((l) => l.id),
      ),
    )
  const found: Record<string, PlacedLibraryRelease> = {}
  for (const ref of refs) {
    const library = rows.find((l) => l.slug === ref.slug)
    const release =
      library &&
      releases.find((r) =>
        ref.version === 'latest'
          ? r.id === library.liveReleaseId
          : r.componentLibraryId === library.id && r.version === ref.version,
      )
    if (release) {
      found[ref.key] = {
        releaseId: release.id,
        version: release.version,
        bundleHash: release.bundleHash,
        allowedOrigins: release.definition.allowedOrigins,
        components: componentLibraryInterface(release.definition),
      }
    }
  }
  return found
}
