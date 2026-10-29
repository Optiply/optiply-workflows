import { type Db, folders, groupMembers, PERMISSION_LEVELS, type PermissionLevel, permissions } from '@ow/db'
import { KIND_LABELS, type ObjectKind } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { eq, inArray } from 'drizzle-orm'

const RANK: Record<PermissionLevel, number> = { use: 1, edit: 2, own: 3 }

export function atLeast(level: PermissionLevel | null, required: PermissionLevel): boolean {
  return level !== null && RANK[level] >= RANK[required]
}

function higher(a: PermissionLevel | null, b: PermissionLevel | null): PermissionLevel | null {
  if (a === null) return b
  if (b === null) return a
  return RANK[a] >= RANK[b] ? a : b
}

/** Objects with grants, folders, drafts and releases but no environments (resources have those): Git's kinds. */
export type { ObjectKind }

interface Grant {
  objectType: string
  objectId: string | null
  environmentId: string | null
  level: PermissionLevel
}

/**
 * What one user may do with resources, workflows and apps. A user's level on a resource in an environment is the highest
 * of the grants their groups hold on that resource, on all resources (`objectId` null), or on any folder containing
 * it, scoped to that environment or to all (`environmentId` null). Workflows and apps work the same way without
 * environments: only grants for all environments count. Admins implicitly own everything.
 */
export class Access {
  constructor(
    readonly isAdmin: boolean,
    private readonly grants: Grant[],
    private readonly folderParents: Map<string, string | null>,
    /** Each folder's object type: a folder grant only reaches objects of its folder's type. */
    private readonly folderTypes: Map<string, string> = new Map(),
  ) {}

  /** The user's level on a resource in one environment, or null for no access. */
  level(resource: { id: string; folderId: string | null }, environmentId: string): PermissionLevel | null {
    if (this.isAdmin) return 'own'
    const folderIds = this.ancestors(resource.folderId)
    let best: PermissionLevel | null = null
    for (const g of this.grants) {
      if (g.environmentId !== null && g.environmentId !== environmentId) continue
      const matches =
        (g.objectType === 'resource' && (g.objectId === null || g.objectId === resource.id)) ||
        this.folderGrant(g, folderIds, 'resource')
      if (matches) best = higher(best, g.level)
    }
    return best
  }

  /** The level the user holds in *every* environment (what resource-wide actions like delete require). */
  levelEverywhere(
    resource: { id: string; folderId: string | null },
    environmentIds: string[],
  ): PermissionLevel | null {
    if (this.isAdmin) return 'own'
    let lowest: PermissionLevel | null = 'own'
    for (const envId of environmentIds) {
      const level = this.level(resource, envId)
      if (level === null) return null
      if (RANK[level] < RANK[lowest!]) lowest = level
    }
    return lowest
  }

  /** Creating resources (and managing resource folders) needs Edit on all resources in all environments. */
  get canCreateResources(): boolean {
    return (
      this.isAdmin ||
      this.grants.some(
        (g) =>
          g.objectType === 'resource' &&
          g.objectId === null &&
          g.environmentId === null &&
          atLeast(g.level, 'edit'),
      )
    )
  }

  /** The user's level on a workflow, or null for no access. Use = run and view runs, Edit = change the draft. */
  workflowLevel(workflow: { id: string; folderId: string | null }): PermissionLevel | null {
    return this.objectLevel('workflow', workflow)
  }

  /** Creating workflows needs Edit on all workflows. */
  get canCreateWorkflows(): boolean {
    return this.canCreate('workflow')
  }

  /**
   * The user's level on an app, or null for no access. Use = open the live release and run its queries, Edit =
   * change the draft and publish, Own = delete and manage access.
   */
  appLevel(app: { id: string; folderId: string | null }): PermissionLevel | null {
    return this.objectLevel('app', app)
  }

  /** Creating apps needs Edit on all apps. */
  get canCreateApps(): boolean {
    return this.canCreate('app')
  }

  /**
   * The user's level on a library query (M14), or null for no access. Use = use it in an app (whoever publishes or
   * runs the draft of an app using it needs it), Edit = change the draft, run it and publish, Own = delete and
   * manage access.
   */
  libraryQueryLevel(query: { id: string; folderId: string | null }): PermissionLevel | null {
    return this.objectLevel('library_query', query)
  }

  /** Creating library queries needs Edit on all library queries. */
  get canCreateLibraryQueries(): boolean {
    return this.canCreate('library_query')
  }

  /**
   * The user's level on a module (M14), or null for no access. Use = place it in an app (whoever publishes or runs
   * the draft of an app placing it needs it), Edit = change the draft, run it and publish, Own = delete and manage
   * access.
   */
  moduleLevel(module: { id: string; folderId: string | null }): PermissionLevel | null {
    return this.objectLevel('module', module)
  }

  /** Creating modules needs Edit on all modules. */
  get canCreateModules(): boolean {
    return this.canCreate('module')
  }

  /**
   * The user's level on a component library (M25), or null for no access. Use = place its components in an app or
   * module, Edit = change the draft, build it and publish, Own = delete and manage access.
   */
  componentLibraryLevel(library: { id: string; folderId: string | null }): PermissionLevel | null {
    return this.objectLevel('component_library', library)
  }

  /** Creating component libraries needs Edit on all of them. */
  get canCreateComponentLibraries(): boolean {
    return this.canCreate('component_library')
  }

  /** Creating objects of a kind needs Edit on all of them. */
  canCreate(type: ObjectKind): boolean {
    return (
      this.isAdmin ||
      this.grants.some(
        (g) =>
          g.objectType === type &&
          g.objectId === null &&
          g.environmentId === null &&
          atLeast(g.level, 'edit'),
      )
    )
  }

  /** The level on an object of any kind but resources: grants on it, on all of its kind, or on a folder holding it. */
  objectLevel(type: ObjectKind, object: { id: string; folderId: string | null }): PermissionLevel | null {
    if (this.isAdmin) return 'own'
    const folderIds = this.ancestors(object.folderId)
    let best: PermissionLevel | null = null
    for (const g of this.grants) {
      if (g.environmentId !== null) continue
      const matches =
        (g.objectType === type && (g.objectId === null || g.objectId === object.id)) ||
        this.folderGrant(g, folderIds, type)
      if (matches) best = higher(best, g.level)
    }
    return best
  }

  /** A grant on one of the object's folders, a folder of the object's own type. */
  private folderGrant(g: Grant, folderIds: Set<string>, type: string): boolean {
    if (g.objectType !== 'folder' || g.objectId === null || !folderIds.has(g.objectId)) return false
    const folderType = this.folderTypes.get(g.objectId)
    return folderType === undefined || folderType === type
  }

  private ancestors(folderId: string | null): Set<string> {
    const seen = new Set<string>()
    for (let id = folderId; id && !seen.has(id); id = this.folderParents.get(id) ?? null) seen.add(id)
    return seen
  }
}

export async function loadAccess(db: Db, user: { id: string; isAdmin: boolean }): Promise<Access> {
  if (user.isAdmin) return new Access(true, [], new Map())
  const memberships = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, user.id))
  const groupIds = memberships.map((m) => m.groupId)
  const grants = groupIds.length
    ? await db
        .select({
          objectType: permissions.objectType,
          objectId: permissions.objectId,
          environmentId: permissions.environmentId,
          level: permissions.level,
        })
        .from(permissions)
        .where(inArray(permissions.groupId, groupIds))
    : []
  const folderRows = grants.some((g) => g.objectType === 'folder')
    ? await db
        .select({ id: folders.id, parentId: folders.parentId, objectType: folders.objectType })
        .from(folders)
    : []
  return new Access(
    false,
    grants,
    new Map(folderRows.map((f) => [f.id, f.parentId])),
    new Map(folderRows.map((f) => [f.id, f.objectType])),
  )
}

export function requireLevel(level: PermissionLevel | null, required: PermissionLevel, what: string): void {
  if (!atLeast(level, required)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `You need ${required} access to ${what}` })
  }
}

export { PERMISSION_LEVELS }

/** A folder that can hold a workflow, app or library query: one of its own type (a resource folder's grants mean something else). */
export async function checkFolderType(db: Db, type: ObjectKind, folderId: string | null | undefined) {
  if (folderId === null || folderId === undefined) return
  const [folder] = await db
    .select({ objectType: folders.objectType })
    .from(folders)
    .where(eq(folders.id, folderId))
  if (!folder || folder.objectType !== type) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `No ${KIND_LABELS[type]} folder has that id` })
  }
}

/**
 * Moving a workflow or app into or out of a folder changes who can reach it (folder grants apply to what's inside),
 * so it needs Own, like managing its access directly.
 */
export async function checkFolderMove(
  db: Db,
  opts: {
    type: ObjectKind
    level: PermissionLevel | null
    from: string | null
    to: string | null | undefined
  },
) {
  if (opts.to === undefined || opts.to === opts.from) return
  requireLevel(opts.level, 'own', `this ${KIND_LABELS[opts.type]} to move it between folders`)
  await checkFolderType(db, opts.type, opts.to)
}
