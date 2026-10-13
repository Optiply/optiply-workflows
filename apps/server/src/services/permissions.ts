import { type Db, folders, groupMembers, PERMISSION_LEVELS, type PermissionLevel, permissions } from '@ow/db'
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

interface Grant {
  objectType: string
  objectId: string | null
  environmentId: string | null
  level: PermissionLevel
}

/**
 * What one user may do with resources. A user's level on a resource in an environment is the highest of the grants
 * their groups hold on that resource, on all resources (`objectId` null), or on any folder containing it, scoped to
 * that environment or to all (`environmentId` null). Admins implicitly own everything.
 */
export class ResourceAccess {
  constructor(
    readonly isAdmin: boolean,
    private readonly grants: Grant[],
    private readonly folderParents: Map<string, string | null>,
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
        (g.objectType === 'folder' && g.objectId !== null && folderIds.has(g.objectId))
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

  private ancestors(folderId: string | null): Set<string> {
    const seen = new Set<string>()
    for (let id = folderId; id && !seen.has(id); id = this.folderParents.get(id) ?? null) seen.add(id)
    return seen
  }
}

export async function loadResourceAccess(
  db: Db,
  user: { id: string; isAdmin: boolean },
): Promise<ResourceAccess> {
  if (user.isAdmin) return new ResourceAccess(true, [], new Map())
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
    ? await db.select({ id: folders.id, parentId: folders.parentId }).from(folders)
    : []
  return new ResourceAccess(false, grants, new Map(folderRows.map((f) => [f.id, f.parentId])))
}

export function requireLevel(level: PermissionLevel | null, required: PermissionLevel, what: string): void {
  if (!atLeast(level, required)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `You need ${required} access to ${what}` })
  }
}

export { PERMISSION_LEVELS }
