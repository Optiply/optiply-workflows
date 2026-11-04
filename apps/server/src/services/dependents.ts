import {
  type App,
  appReleases,
  apps,
  type Db,
  gitBranchDrafts,
  type Module,
  moduleReleases,
  modules,
  type Workflow,
  workflowReleases,
  workflows,
} from '@ow/db'
import { type AnyColumn, and, asc, eq, inArray, isNotNull, type SQL } from 'drizzle-orm'
import type { Access } from './permissions'

/** Where a definition uses something: its draft, its live release or an open Git branch draft. */
export type UseSite = 'draft' | 'live' | 'branch'

/** An app, module or (M21: of a library query) workflow that uses a library query or module (M14). */
export type Dependent =
  | { kind: 'app'; object: App; where: UseSite[] }
  | { kind: 'module'; object: Module; where: UseSite[] }
  | { kind: 'workflow'; object: Workflow; where: UseSite[] }

/** A condition on a definition column: whether that definition uses the thing. */
type Uses = (column: SQL | AnyColumn) => SQL

const SITE_TABLES = {
  app: [apps, appReleases, gitBranchDrafts.appId],
  module: [modules, moduleReleases, gitBranchDrafts.moduleId],
  workflow: [workflows, workflowReleases, gitBranchDrafts.workflowId],
} as const

async function sites(db: Db, kind: Dependent['kind'], uses: Uses): Promise<Map<string, UseSite[]>> {
  const [table, releases, draftColumn] = SITE_TABLES[kind]
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
 * The apps (and, with `modules`, the modules; with `workflows`, the workflows: M21) whose draft, live release or Git
 * branch draft `uses`, by kind then name. Deleting what they use is refused while any does. `uses` gets the
 * definition column and the kind it holds.
 */
export async function dependents(
  db: Db,
  uses: (column: SQL | AnyColumn, kind: Dependent['kind']) => SQL,
  opts: { modules: boolean; workflows?: boolean },
): Promise<Dependent[]> {
  const kinds: Dependent['kind'][] = [
    'app',
    ...(opts.modules ? (['module'] as const) : []),
    ...(opts.workflows ? (['workflow'] as const) : []),
  ]
  const found = await Promise.all(
    kinds.map(async (kind) => {
      const where = await sites(db, kind, (column) => uses(column, kind))
      if (!where.size) return []
      const table = SITE_TABLES[kind][0]
      const rows = await db
        .select()
        .from(table)
        .where(inArray(table.id, [...where.keys()]))
        .orderBy(asc(table.name))
      return rows.map((object) => ({ kind, object, where: where.get(object.id)! }) as Dependent)
    }),
  )
  return found.flat()
}

/** Whether the caller can see a dependent (only those are named). */
export const canSeeDependent = (access: Access, d: Dependent): boolean =>
  (d.kind === 'app'
    ? access.appLevel(d.object)
    : d.kind === 'module'
      ? access.moduleLevel(d.object)
      : access.workflowLevel(d.object)) !== null

/** What `usedBy` returns: the apps, modules and workflows the caller can see, and how many others. */
export function usedByView(access: Access, users: Dependent[]) {
  const visible = users.filter((d) => canSeeDependent(access, d))
  const view = (kind: Dependent['kind']) =>
    visible
      .filter((d) => d.kind === kind)
      .map(({ object, where }) => ({ id: object.id, slug: object.slug, name: object.name, where }))
  return {
    apps: view('app'),
    modules: view('module'),
    workflows: view('workflow'),
    hidden: users.length - visible.length,
  }
}

/** The CONFLICT message refusing to delete something `users` still use (naming up to 3 the caller can see). */
export function inUseMessage(access: Access, users: Dependent[], what: string): string {
  const names = users
    .filter((d) => canSeeDependent(access, d))
    .slice(0, 3)
    .map((d) => `"${d.object.name}"`)
  const others = users.length - names.length
  const kinds = (['app', 'module', 'workflow'] as const).filter((k) => users.some((d) => d.kind === k))
  const count = (n: number) => kinds.map((k) => (n === 1 ? k : `${k}s`)).join(' or ')
  const more = others
    ? `${names.length ? ' and ' : ''}${others} ${names.length ? 'more' : count(others)}`
    : ''
  const subject = count(2)
  return `${subject[0]!.toUpperCase()}${subject.slice(1)} use this ${what}: ${names.join(', ')}${more}. Remove it from them first`
}
