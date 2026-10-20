import {
  type App,
  appReleases,
  apps,
  type Db,
  gitBranchDrafts,
  type Module,
  moduleReleases,
  modules,
} from '@ow/db'
import { type AnyColumn, and, asc, eq, inArray, isNotNull, type SQL } from 'drizzle-orm'
import type { Access } from './permissions'

/** Where a definition uses something: its draft, its live release or an open Git branch draft. */
export type UseSite = 'draft' | 'live' | 'branch'

/** An app or module that uses a library query or module (M14). */
export type Dependent =
  | { kind: 'app'; object: App; where: UseSite[] }
  | { kind: 'module'; object: Module; where: UseSite[] }

/** A condition on a definition column: whether that definition uses the thing. */
type Uses = (column: SQL | AnyColumn) => SQL

async function sites(db: Db, kind: 'app' | 'module', uses: Uses): Promise<Map<string, UseSite[]>> {
  const [table, releases, draftColumn] =
    kind === 'app'
      ? ([apps, appReleases, gitBranchDrafts.appId] as const)
      : ([modules, moduleReleases, gitBranchDrafts.moduleId] as const)
  const [drafts, live, branches] = await Promise.all([
    db.select({ id: table.id }).from(table).where(uses(table.draftDefinition)),
    db
      .select({ id: table.id })
      .from(table)
      .innerJoin(releases, eq(releases.id, table.liveReleaseId))
      .where(uses(releases.definition)),
    db
      .select({ id: draftColumn })
      .from(gitBranchDrafts)
      .where(and(isNotNull(draftColumn), uses(gitBranchDrafts.definition))),
  ])
  const where = new Map<string, UseSite[]>()
  const add = (id: string | null, site: UseSite) => {
    if (!id) return
    const list = where.get(id) ?? []
    if (!list.includes(site)) list.push(site)
    where.set(id, list)
  }
  for (const r of drafts) add(r.id, 'draft')
  for (const r of live) add(r.id, 'live')
  for (const r of branches) add(r.id, 'branch')
  return where
}

/**
 * The apps (and, with `modules`, the modules) whose draft, live release or Git branch draft `uses`: apps first,
 * each by name. Deleting what they use is refused while any does.
 */
export async function dependents(db: Db, uses: Uses, opts: { modules: boolean }): Promise<Dependent[]> {
  const [appSites, moduleSites] = await Promise.all([
    sites(db, 'app', uses),
    opts.modules ? sites(db, 'module', uses) : new Map<string, UseSite[]>(),
  ])
  const [appRows, moduleRows] = await Promise.all([
    appSites.size
      ? db
          .select()
          .from(apps)
          .where(inArray(apps.id, [...appSites.keys()]))
          .orderBy(asc(apps.name))
      : [],
    moduleSites.size
      ? db
          .select()
          .from(modules)
          .where(inArray(modules.id, [...moduleSites.keys()]))
          .orderBy(asc(modules.name))
      : [],
  ])
  return [
    ...appRows.map((object) => ({ kind: 'app' as const, object, where: appSites.get(object.id)! })),
    ...moduleRows.map((object) => ({ kind: 'module' as const, object, where: moduleSites.get(object.id)! })),
  ]
}

/** Whether the caller can see a dependent (only those are named). */
export const canSeeDependent = (access: Access, d: Dependent): boolean =>
  (d.kind === 'app' ? access.appLevel(d.object) : access.moduleLevel(d.object)) !== null

/** What `usedBy` returns: the apps and modules the caller can see, and how many others. */
export function usedByView(access: Access, users: Dependent[]) {
  const visible = users.filter((d) => canSeeDependent(access, d))
  const view = (kind: Dependent['kind']) =>
    visible
      .filter((d) => d.kind === kind)
      .map(({ object, where }) => ({ id: object.id, slug: object.slug, name: object.name, where }))
  return { apps: view('app'), modules: view('module'), hidden: users.length - visible.length }
}

/** The CONFLICT message refusing to delete something `users` still use (naming up to 3 the caller can see). */
export function inUseMessage(access: Access, users: Dependent[], what: string): string {
  const names = users
    .filter((d) => canSeeDependent(access, d))
    .slice(0, 3)
    .map((d) => `"${d.object.name}"`)
  const others = users.length - names.length
  const modules = users.some((d) => d.kind === 'module')
  const count = (n: number) =>
    modules ? (n === 1 ? 'app or module' : 'apps or modules') : n === 1 ? 'app' : 'apps'
  const more = others
    ? `${names.length ? ' and ' : ''}${others} ${names.length ? 'more' : count(others)}`
    : ''
  return `${modules ? 'Apps or modules' : 'Apps'} use this ${what}: ${names.join(', ')}${more}. Remove it from them first`
}
