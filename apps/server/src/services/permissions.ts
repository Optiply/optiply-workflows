import {
  type Db,
  environments,
  folders,
  groupMembers,
  groups,
  PERMISSION_LEVELS,
  type PermissionLevel,
  permissions,
  resourceConfigs,
  users,
} from '@ow/db'
import { KIND_LABELS, type ObjectKind } from '@ow/git-format'
import { TRPCError } from '@trpc/server'
import { and, eq, inArray, or } from 'drizzle-orm'
import { systemGroupId } from './users'

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
    /** Environments only admins may use (session 56: Staging); everyone else has no access to anything in them. */
    private readonly adminOnlyEnvironmentIds: ReadonlySet<string> = new Set(),
  ) {}

  /** Whether the user may use an environment at all: admins every one, everyone else all but the admins-only ones. */
  canUseEnvironment(environmentId: string): boolean {
    return this.isAdmin || !this.adminOnlyEnvironmentIds.has(environmentId)
  }

  /** The user's level on a resource in one environment, or null for no access. */
  level(resource: { id: string; folderId: string | null }, environmentId: string): PermissionLevel | null {
    if (this.isAdmin) return 'own'
    if (!this.canUseEnvironment(environmentId)) return null
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

  /**
   * The level the user holds in *every* environment they may use (what resource-wide actions like delete require):
   * the admins-only ones don't count for everyone else, who can't hold anything there.
   */
  levelEverywhere(
    resource: { id: string; folderId: string | null },
    environmentIds: string[],
  ): PermissionLevel | null {
    if (this.isAdmin) return 'own'
    let lowest: PermissionLevel | null = null
    for (const envId of environmentIds) {
      if (!this.canUseEnvironment(envId)) continue
      const level = this.level(resource, envId)
      if (level === null) return null
      if (lowest === null || RANK[level] < RANK[lowest]) lowest = level
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

  /**
   * Whether any grant reaches something of a kind: on one of them, on all of them, or on a folder of that kind
   * (`ignore`: object ids that don't count, like built-in resources everyone may use). What shows a sidebar section.
   */
  reaches(type: ObjectKind | 'resource', ignore: ReadonlySet<string> = new Set()): boolean {
    if (this.isAdmin) return true
    return this.grants.some((g) => {
      // As `objectLevel`: only grants for every environment count for kinds without environments.
      if (type !== 'resource' && g.environmentId !== null) return false
      if (g.objectType === type) return g.objectId === null || !ignore.has(g.objectId)
      if (g.objectType !== 'folder' || g.objectId === null) return false
      // As `folderGrant`: a folder of that kind, or one whose kind isn't known.
      const folderType = this.folderTypes.get(g.objectId)
      return folderType === undefined || folderType === type
    })
  }

  /** Whether they can share anything: admins, and anyone owning something (Own manages access). */
  get canShare(): boolean {
    return this.isAdmin || this.grants.some((g) => g.level === 'own')
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

/**
 * What one person may do. Someone whose access is apps only (`users.access`, read here so no caller can forget it)
 * keeps only their grants on apps and app folders, at most Use, and not those All Users holds: the apps an admin gave
 * them (or a group of theirs), and nothing of the platform's default sharing.
 */
export async function loadAccess(db: Db, user: { id: string; isAdmin: boolean }): Promise<Access> {
  if (user.isAdmin) return new Access(true, [], new Map())
  // Their access comes with their memberships (everyone is in All Users), in one round trip; with it, the
  // environments only admins may use.
  const [memberships, adminOnly] = await Promise.all([
    db
      .select({ groupId: groupMembers.groupId, systemKind: groups.systemKind, access: users.access })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.userId, user.id)),
    db.select({ id: environments.id }).from(environments).where(eq(environments.adminOnly, true)),
  ])
  const [person] = memberships.length
    ? memberships
    : await db.select({ access: users.access }).from(users).where(eq(users.id, user.id))
  const appsOnly = person?.access === 'apps_only'
  const groupIds = memberships
    .filter((m) => !(appsOnly && m.systemKind === 'all_users'))
    .map((m) => m.groupId)
  // Their groups' grants and their own.
  const rows = await db
    .select({
      objectType: permissions.objectType,
      objectId: permissions.objectId,
      environmentId: permissions.environmentId,
      level: permissions.level,
    })
    .from(permissions)
    .where(
      groupIds.length
        ? or(inArray(permissions.groupId, groupIds), eq(permissions.userId, user.id))
        : eq(permissions.userId, user.id),
    )
  const folderRows = rows.some((g) => g.objectType === 'folder')
    ? await db
        .select({ id: folders.id, parentId: folders.parentId, objectType: folders.objectType })
        .from(folders)
    : []
  const folderTypes = new Map(folderRows.map((f) => [f.id, f.objectType]))
  const grants = appsOnly
    ? rows
        .filter(
          (g) =>
            g.environmentId === null &&
            (g.objectType === 'app' ||
              (g.objectType === 'folder' && g.objectId !== null && folderTypes.get(g.objectId) === 'app')),
        )
        .map((g) => ({ ...g, level: 'use' as const }))
    : rows
  return new Access(
    false,
    grants,
    new Map(folderRows.map((f) => [f.id, f.parentId])),
    folderTypes,
    new Set(adminOnly.map((e) => e.id)),
  )
}

/**
 * A resource with settings in an environment only admins may use: changes to all of it at once (deleting it, putting it
 * in Git or taking it out) are theirs, since they'd reach settings nobody else may touch.
 */
export async function requireNoAdminOnlySettings(
  db: Db,
  access: Access,
  resourceId: string,
  action: string,
): Promise<void> {
  if (access.isAdmin) return
  const [hidden] = await db
    .select({ name: environments.name })
    .from(resourceConfigs)
    .innerJoin(environments, eq(environments.id, resourceConfigs.environmentId))
    .where(and(eq(resourceConfigs.resourceId, resourceId), eq(environments.adminOnly, true)))
    .limit(1)
  if (hidden) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Only admins can ${action} this resource: it has settings in ${hidden.name}`,
    })
  }
}

/** Refuses an environment only admins may use (session 56: Staging) to everyone else. */
export function requireEnvironment(access: Access, environmentId: string): void {
  if (!access.canUseEnvironment(environmentId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins can use this environment' })
  }
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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** `SHARE_NEW_WITH_EVERYONE` (on unless set off; set once at start, buildApp). */
let shareNewWithEveryone = true
export function setShareNewWithEveryone(on: boolean) {
  shareNewWithEveryone = on
}

/**
 * What something new starts with (the owner's choice, session 54): everyone (All Users) may Use it, and the person who
 * made it may Edit it; admins change it afterwards. Admins can do everything anyway, so they get no grant of their own.
 * Objects Git sync creates don't come here: an admin approves those and shares them.
 */
export async function grantDefaultAccess(
  db: Db | Tx,
  kind: ObjectKind,
  objectId: string,
  creator: { id: string; isAdmin: boolean },
): Promise<void> {
  if (!shareNewWithEveryone) return
  const allUsers = await systemGroupId(db, 'all_users')
  await db
    .insert(permissions)
    .values([
      { groupId: allUsers, objectType: kind, objectId, environmentId: null, level: 'use' as const },
      ...(!creator.isAdmin
        ? [{ userId: creator.id, objectType: kind, objectId, environmentId: null, level: 'edit' as const }]
        : []),
    ])
}
