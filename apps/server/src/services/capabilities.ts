import { type Db, environments, resources, userTasks } from '@ow/db'
import { and, isNotNull, sql } from 'drizzle-orm'
import { loadAccess } from './permissions'
import { assignedTo, groupIdsOf } from './tasks'

/** The sidebar's sections. */
export const SECTION_KEYS = [
  'workflows',
  'apps',
  'library',
  'modules',
  'componentLibraries',
  'resources',
  'database',
  'runs',
  'inbox',
] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

export interface Capabilities {
  /** Which sections show: the ones where the person can reach something. */
  sections: Record<SectionKey, boolean>
  /** Where they may create (Edit on all of that kind). */
  canCreate: Record<
    'workflows' | 'apps' | 'library' | 'modules' | 'componentLibraries' | 'resources',
    boolean
  >
}

const ALL = (value: boolean) =>
  Object.fromEntries(SECTION_KEYS.map((k) => [k, value])) as Capabilities['sections']

/** Every section and every New button, or none. */
const everything = (value: boolean): Capabilities => ({
  sections: ALL(value),
  canCreate: {
    workflows: value,
    apps: value,
    library: value,
    modules: value,
    componentLibraries: value,
    resources: value,
  },
})

/**
 * What one person can reach, for the sidebar, ⌘K and the New buttons: a section shows when any grant (theirs or
 * their groups', on one object, all of a kind, or a folder of that kind) reaches it. The server still checks every
 * object; this only keeps people from wandering into empty sections. Admins reach everything; someone whose access
 * is apps only no section at all (their apps open from their own page, never the platform's Apps).
 */
export async function capabilities(
  db: Db,
  user: { id: string; isAdmin: boolean; appsOnly?: boolean },
): Promise<Capabilities> {
  if (user.isAdmin) return everything(true)
  // Their apps open from their own page, never the platform's sections (`appsOnly` is never true for an admin).
  if (user.appsOnly) return everything(false)
  // `me` asks on every navigation now and then: the independent reads go together.
  const [access, builtIn, envRows, groupIds] = await Promise.all([
    loadAccess(db, user),
    // Built-in resources (the REST API everyone may call, the database) don't make Resources show.
    db
      .select({ id: resources.id, systemKind: resources.systemKind, folderId: resources.folderId })
      .from(resources)
      .where(isNotNull(resources.systemKind)),
    db.select({ id: environments.id }).from(environments),
    groupIdsOf(db, user.id),
  ])
  const database = builtIn.find((r) => r.systemKind === 'database')
  const envIds = envRows.map((e) => e.id)
  const workflows = access.reaches('workflow')
  const [task] = workflows
    ? []
    : await db
        .select({ one: sql<number>`1` })
        .from(userTasks)
        .where(and(assignedTo(user.id, groupIds)))
        .limit(1)
  return {
    sections: {
      workflows,
      apps: access.reaches('app'),
      library: access.reaches('library_query'),
      modules: access.reaches('module'),
      componentLibraries: access.reaches('component_library'),
      resources: access.reaches('resource', new Set(builtIn.map((r) => r.id))),
      database: !!database && envIds.some((env) => access.level(database, env) !== null),
      runs: workflows,
      inbox: workflows || !!task,
    },
    canCreate: {
      workflows: access.canCreate('workflow'),
      apps: access.canCreate('app'),
      library: access.canCreate('library_query'),
      modules: access.canCreate('module'),
      componentLibraries: access.canCreate('component_library'),
      resources: access.canCreateResources,
    },
  }
}
