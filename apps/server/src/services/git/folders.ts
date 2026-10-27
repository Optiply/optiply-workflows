import {
  apps,
  type Db,
  type FOLDER_OBJECT_TYPES,
  folders,
  libraryQueries,
  modules,
  resources,
  workflows,
} from '@ow/db'
import { folderNames } from '@ow/git-format'
import { and, eq, isNull } from 'drizzle-orm'
import { recordAudit } from '../../audit'

/**
 * Folders in Git (M22): an object's JSON names its folder as a path, `Finance/Reports`; on the instance that's a
 * chain of folders of the object's kind. Deploys make the missing ones and move objects into them.
 */

export type FolderKind = (typeof FOLDER_OBJECT_TYPES)[number]

/** Where an object moved to: its folder paths before and after, null at the top level. */
export interface FolderMove {
  from: string | null
  to: string | null
}

const TABLES = {
  resource: resources,
  workflow: workflows,
  app: apps,
  library_query: libraryQueries,
  module: modules,
}

/** The folder's path from the top, `Finance/Reports`; undefined at the top level. */
export async function folderPathOf(db: Db, folderId: string | null): Promise<string | undefined> {
  if (!folderId) return undefined
  const names: string[] = []
  const seen = new Set<string>()
  let id: string | null = folderId
  while (id && !seen.has(id)) {
    seen.add(id)
    const [folder]: Array<{ name: string; parentId: string | null }> = await db
      .select({ name: folders.name, parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.id, id))
    if (!folder) break
    names.unshift(folder.name)
    id = folder.parentId
  }
  return names.length > 0 ? names.join('/') : undefined
}

/**
 * The folder of a kind at a path, each missing one on the way made (audited as Git's); null for the top level.
 * Another process making the same folder meanwhile is fine: the unique name per parent picks one.
 */
export async function ensureFolderPath(
  db: Db,
  kind: FolderKind,
  path: string | undefined,
  git: { commit: string },
): Promise<string | null> {
  if (!path) return null
  let parentId: string | null = null
  for (const name of folderNames(path)) {
    const where = and(
      eq(folders.objectType, kind),
      parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
      eq(folders.name, name),
    )
    let [folder] = await db.select({ id: folders.id }).from(folders).where(where)
    if (!folder) {
      const [inserted]: Array<{ id: string }> = await db
        .insert(folders)
        .values({ objectType: kind, name, parentId })
        .onConflictDoNothing()
        .returning({ id: folders.id })
      if (inserted) {
        await recordAudit(db, {
          actorUserId: null,
          action: 'folder.created',
          objectType: 'folder',
          objectId: inserted.id,
          metadata: { name, parentId, type: kind, source: 'git', commit: git.commit },
        })
      }
      folder = inserted ?? (await db.select({ id: folders.id }).from(folders).where(where))[0]
    }
    parentId = folder!.id
  }
  return parentId
}

/**
 * Puts an object into the folder Git names (made when missing). Returns the move, or undefined when it was already
 * there.
 */
export async function moveToGitFolder(
  db: Db,
  kind: FolderKind,
  object: { id: string; folderId: string | null },
  path: string | undefined,
  git: { commit: string },
): Promise<FolderMove | undefined> {
  const folderId = await ensureFolderPath(db, kind, path, git)
  if (folderId === object.folderId) return undefined
  const table = TABLES[kind]
  const from = (await folderPathOf(db, object.folderId)) ?? null
  await db.update(table).set({ folderId }).where(eq(table.id, object.id))
  return { from, to: path ?? null }
}
