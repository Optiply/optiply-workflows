import {
  type ComponentLibraryDefinition,
  type ComponentLibraryInfo,
  componentLibraryInterface,
} from '@ow/app-definition'
import { type ComponentLibrary, componentLibraries, componentLibraryReleases, type Db } from '@ow/db'
import { TRPCError } from '@trpc/server'
import { type AnyColumn, and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { type Dependent, dependents } from './dependents'

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
