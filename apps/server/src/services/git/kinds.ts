import {
  type AppDefinition,
  appDefinitionHash,
  appDefinitionSchema,
  type ComponentLibraryDefinition,
  componentLibraryDefinitionSchema,
  componentLibraryHash,
  type LibraryQueryDefinition,
  libraryQueryDefinitionSchema,
  libraryQueryHash,
  validateApp,
  validateComponentLibrary,
  validateLibraryQuery,
} from '@ow/app-definition'
import {
  appRenamer,
  appSpec,
  type CollabSpec,
  componentLibrarySpec,
  libraryQuerySpec,
  type MergeObject,
  type MergeResult,
  mergeObject,
  type Renamer,
  type Resolution,
  workflowRenamer,
  workflowSpec,
} from '@ow/collab'
import {
  type App,
  appReleases,
  apps,
  type ComponentLibrary,
  componentLibraries,
  componentLibraryReleases,
  configVars,
  type Db,
  GIT_OBJECT_KINDS,
  gitBranchDrafts,
  type LibraryQuery,
  libraryQueries,
  libraryQueryReleases,
  type Module,
  moduleReleases,
  modules,
  type PermissionLevel,
  resources,
  type Workflow,
  workflowReleases,
  workflows,
} from '@ow/db'
import {
  definitionHash,
  validateDefinition,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '@ow/definition'
import { checkBodySchema } from '@ow/definition/body-schema'
import { KIND_LABELS, type ObjectKind } from '@ow/git-format'
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { Access } from '../permissions'

/**
 * What differs between the kinds Git sync keeps (workflows, apps, since M14 library queries and modules, since M25
 * component libraries): their
 * tables, levels, releases and definitions. Protect, branch drafts and deploy go through these.
 */

/** A kind with drafts and releases, as opposed to resources and config vars (M22, `settings-objects.ts`). */
export function isObjectKind(kind: string): kind is ObjectKind {
  return (GIT_OBJECT_KINDS as readonly string[]).includes(kind)
}

/** A row of any kind Git sync keeps; what they share is what Git needs. */
export type GitObjectRow = Workflow | App | LibraryQuery | Module | ComponentLibrary

/** The object of a kind by id or slug. */
export async function loadGitObject(
  db: Db,
  kind: ObjectKind,
  where: { id: string } | { slug: string },
): Promise<GitObjectRow | undefined> {
  const by = <T extends { id: unknown; slug: unknown }>(table: T) =>
    // biome-ignore lint/suspicious/noExplicitAny: the four tables share these columns
    'id' in where ? eq(table.id as any, where.id) : eq(table.slug as any, where.slug)
  switch (kind) {
    case 'workflow':
      return (await db.select().from(workflows).where(by(workflows)))[0]
    case 'app':
      return (await db.select().from(apps).where(by(apps)))[0]
    case 'library_query':
      return (await db.select().from(libraryQueries).where(by(libraryQueries)))[0]
    case 'module':
      return (await db.select().from(modules).where(by(modules)))[0]
    case 'component_library':
      return (await db.select().from(componentLibraries).where(by(componentLibraries)))[0]
  }
}

/** The caller's level on an object of a kind; null when they can't see it. */
export function gitObjectLevel(
  access: Access,
  kind: ObjectKind,
  object: GitObjectRow,
): PermissionLevel | null {
  switch (kind) {
    case 'workflow':
      return access.workflowLevel(object)
    case 'app':
      return access.appLevel(object)
    case 'library_query':
      return access.libraryQueryLevel(object)
    case 'module':
      return access.moduleLevel(object)
    case 'component_library':
      return access.componentLibraryLevel(object)
  }
}

/**
 * Sets whether an object is protected; with `from`, only while it still is the other way. Returns whether it
 * changed.
 */
export async function setGitProtected(
  db: Db,
  kind: ObjectKind,
  id: string,
  value: boolean,
  opts: { from?: boolean } = {},
): Promise<boolean> {
  const table = {
    workflow: workflows,
    app: apps,
    library_query: libraryQueries,
    module: modules,
    component_library: componentLibraries,
  }[kind]
  // biome-ignore lint/suspicious/noExplicitAny: the five tables share these columns
  const t = table as any
  const where = opts.from === undefined ? eq(t.id, id) : and(eq(t.id, id), eq(t.gitProtected, opts.from))
  const updated: unknown[] = await db
    .update(t)
    .set({ gitProtected: value })
    .where(where)
    .returning({ id: t.id })
  return updated.length > 0
}

/** What the instance holds of an object: its live release's definition, or its draft when nothing is live. */
export async function liveOrDraft(db: Db, kind: ObjectKind, object: GitObjectRow): Promise<unknown> {
  const id = object.liveReleaseId
  if (!id) return object.draftDefinition
  const [release] = await (async () => {
    switch (kind) {
      case 'workflow':
        return db.select().from(workflowReleases).where(eq(workflowReleases.id, id))
      case 'app':
        return db.select().from(appReleases).where(eq(appReleases.id, id))
      case 'library_query':
        return db.select().from(libraryQueryReleases).where(eq(libraryQueryReleases.id, id))
      case 'module':
        return db.select().from(moduleReleases).where(eq(moduleReleases.id, id))
      case 'component_library':
        return db.select().from(componentLibraryReleases).where(eq(componentLibraryReleases.id, id))
    }
  })()
  return release?.definition ?? object.draftDefinition
}

/** The branch draft column naming an object of the kind. */
export function draftColumn(kind: ObjectKind) {
  return {
    workflow: gitBranchDrafts.workflowId,
    app: gitBranchDrafts.appId,
    library_query: gitBranchDrafts.libraryQueryId,
    module: gitBranchDrafts.moduleId,
    component_library: gitBranchDrafts.componentLibraryId,
  }[kind]
}

/** The branch draft values naming an object of the kind. */
export function draftOwner(kind: ObjectKind, id: string) {
  return {
    workflow: { workflowId: id },
    app: { appId: id },
    library_query: { libraryQueryId: id },
    module: { moduleId: id },
    component_library: { componentLibraryId: id },
  }[kind]
}

/** A branch draft's kind and object id, from the column it fills. */
export function draftTarget(draft: {
  workflowId: string | null
  appId: string | null
  libraryQueryId: string | null
  moduleId: string | null
  componentLibraryId: string | null
}): { kind: ObjectKind; id: string } {
  if (draft.workflowId) return { kind: 'workflow', id: draft.workflowId }
  if (draft.appId) return { kind: 'app', id: draft.appId }
  if (draft.libraryQueryId) return { kind: 'library_query', id: draft.libraryQueryId }
  if (draft.componentLibraryId) return { kind: 'component_library', id: draft.componentLibraryId }
  return { kind: 'module', id: draft.moduleId! }
}

/** The schema a kind's definition must match to be saved. */
export function definitionSchema(kind: ObjectKind): z.ZodType {
  switch (kind) {
    case 'workflow':
      return workflowDefinitionSchema
    case 'library_query':
      return libraryQueryDefinitionSchema
    case 'component_library':
      return componentLibraryDefinitionSchema
    case 'module':
      return appDefinitionSchema.refine((d) => d.module !== undefined, {
        path: ['module'],
        message: 'A module needs its inputs, outputs and events',
      })
    default:
      return appDefinitionSchema
  }
}

/** A definition's hash, as its kind's releases compute it. */
export function kindDefinitionHash(kind: ObjectKind, definition: unknown): Promise<string> {
  switch (kind) {
    case 'workflow':
      return definitionHash(definition as WorkflowDefinition)
    case 'library_query':
      return libraryQueryHash(definition as LibraryQueryDefinition)
    case 'component_library':
      return componentLibraryHash(definition as ComponentLibraryDefinition)
    default:
      return appDefinitionHash(definition as AppDefinition)
  }
}

/** A definition's checks that need nothing from the database (the editor's). */
export function kindDiagnostics(kind: ObjectKind, definition: unknown) {
  switch (kind) {
    case 'workflow':
      return validateDefinition(definition as WorkflowDefinition, { checkBodySchema }).diagnostics
    case 'library_query':
      return validateLibraryQuery(definition).diagnostics
    case 'component_library':
      return validateComponentLibrary(definition).diagnostics
    default:
      return validateApp(definition).diagnostics
  }
}

/** "Workflow", "Library query", …: a kind at the start of a sentence. */
export function kindTitle(kind: ObjectKind): string {
  const label = KIND_LABELS[kind]
  return label[0]!.toUpperCase() + label.slice(1)
}

/** Every protected object's id, of any kind (deploy skips their unchanged directories). */
export async function protectedObjectIds(db: Db): Promise<Set<string>> {
  const rows = await Promise.all(
    [workflows, apps, libraryQueries, modules, componentLibraries, resources, configVars].map((table) =>
      db.select({ id: table.id }).from(table).where(eq(table.gitProtected, true)),
    ),
  )
  return new Set(rows.flat().map((r) => r.id))
}

/**
 * Makes an object of a kind from the repo, protected (a directory deploying for the first time); undefined when
 * one with that slug was just made on the instance.
 */
export async function insertGitObject(
  db: Db,
  kind: ObjectKind,
  values: { slug: string; name: string; description: string | null; definition: unknown },
): Promise<GitObjectRow | undefined> {
  const row = {
    slug: values.slug,
    name: values.name,
    description: values.description,
    gitProtected: true,
  }
  switch (kind) {
    case 'workflow':
      return (
        await db
          .insert(workflows)
          .values({ ...row, draftDefinition: values.definition as WorkflowDefinition })
          .onConflictDoNothing()
          .returning()
      )[0]
    case 'app':
      return (
        await db
          .insert(apps)
          .values({ ...row, draftDefinition: values.definition as AppDefinition })
          .onConflictDoNothing()
          .returning()
      )[0]
    case 'library_query':
      return (
        await db
          .insert(libraryQueries)
          .values({ ...row, draftDefinition: values.definition as LibraryQueryDefinition })
          .onConflictDoNothing()
          .returning()
      )[0]
    case 'module':
      return (
        await db
          .insert(modules)
          .values({ ...row, draftDefinition: values.definition as AppDefinition })
          .onConflictDoNothing()
          .returning()
      )[0]
    case 'component_library':
      return (
        await db
          .insert(componentLibraries)
          .values({ ...row, draftDefinition: values.definition as ComponentLibraryDefinition })
          .onConflictDoNothing()
          .returning()
      )[0]
  }
}

/** The collab spec a kind's definition merges by (a module is an app; a library query has its own). */
function kindSpec(kind: ObjectKind): CollabSpec {
  if (kind === 'workflow') return workflowSpec
  if (kind === 'library_query') return libraryQuerySpec
  if (kind === 'component_library') return componentLibrarySpec
  return appSpec
}

/** How a kind's renames are followed in a merge (§2.25): blocks for workflows, components and queries for apps and modules. */
function kindRenamer(kind: ObjectKind): Renamer<unknown> | undefined {
  if (kind === 'workflow') return workflowRenamer as Renamer<unknown>
  if (kind === 'library_query' || kind === 'component_library') return undefined
  return appRenamer as Renamer<unknown>
}

/** An object as a merge sees it: since M22 with the folder the repo keeps for it (undefined at the top level). */
export type GitMergeObject = MergeObject<unknown> & { folder?: string | null }

/**
 * A three-way merge of a kind's object (architecture §2.23), checked against the kind's schema: two sides' changes
 * that don't fit it together come back as one conflict on their item. The folder is never a conflict: the side that
 * changed it wins, ours when both did. Renames are followed: an item one side renamed and the other edited merges
 * as one item under its new name (only when all three definitions fit the schema: the renamer reads their items).
 */
export function mergeKindObject(
  kind: ObjectKind,
  base: GitMergeObject,
  ours: GitMergeObject,
  theirs: GitMergeObject,
  resolutions?: Readonly<Record<string, Resolution>>,
): MergeResult<GitMergeObject> {
  const schema = definitionSchema(kind)
  const folder = ours.folder === base.folder ? theirs.folder : ours.folder
  const bare = ({ name, description, definition }: GitMergeObject) => ({ name, description, definition })
  const wellFormed = [base, ours, theirs].every((o) => schema.safeParse(o.definition).success)
  const result = mergeObject(kindSpec(kind), bare(base), bare(ours), bare(theirs), {
    resolutions,
    renamer: wellFormed ? kindRenamer(kind) : undefined,
    check: (definition) => {
      const parsed = schema.safeParse(definition)
      return parsed.success
        ? []
        : parsed.error.issues.map((issue) =>
            issue.path.filter((k): k is string | number => typeof k !== 'symbol'),
          )
    },
  })
  return { ...result, merged: { ...result.merged, ...(folder !== undefined ? { folder } : {}) } }
}
