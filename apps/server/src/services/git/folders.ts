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
import { TRPCError } from '@trpc/server'
import { and, eq, inArray, isNull } from 'drizzle-orm'
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

/**
 * Whether a folder or any folder below it holds a protected object (M22): Git names their folders by path, so
 * renaming or deleting one would leave them apart from Git with nothing to put them back.
 */
export async function holdsProtected(db: Db, kind: FolderKind, folderId: string): Promise<boolean> {
  const ids = [folderId]
  for (let i = 0; i < ids.length; i++) {
    const children = await db.select({ id: folders.id }).from(folders).where(eq(folders.parentId, ids[i]!))
    for (const child of children) if (!ids.includes(child.id)) ids.push(child.id)
  }
  const table = TABLES[kind]
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(inArray(table.folderId, ids), eq(table.gitProtected, true)))
    .limit(1)
  return Boolean(row)
}

/** The folder's path from the top, `Finance/Reports`; null at the top level. */
export async function folderPathOf(db: Db, folderId: string | null): Promise<string | null> {
  const names = await folderNamesOf(db, folderId)
  return names.length > 0 ? names.join('/') : null
}

/**
 * The folder's path as Git keeps it, for writing an object's files: refused when a folder's name holds a `/`
 * (the path couldn't be read back as the same folders).
 */
export async function gitFolderPath(db: Db, folderId: string | null): Promise<string | null> {
  const names = await folderNamesOf(db, folderId)
  const slashed = names.find((name) => name.includes('/'))
  if (slashed) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Rename the folder "${slashed}" first: Git separates folders with /`,
    })
  }
  return names.length > 0 ? names.join('/') : null
}

/** The folder's names from the top; none at the top level. */
async function folderNamesOf(db: Db, folderId: string | null): Promise<string[]> {
  if (!folderId) return []
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
  return names
}

/**
 * The folder of a kind at a path, each missing one on the way made (audited as Git's); null for the top level.
 * Another process making the same folder meanwhile is fine: the unique name per parent picks one.
 */
export async function ensureFolderPath(
  db: Db,
  kind: FolderKind,
  path: string | null | undefined,
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
 * there or the file names none.
 */
export async function moveToGitFolder(
  db: Db,
  kind: FolderKind,
  object: { id: string; folderId: string | null },
  path: string | null | undefined,
  git: { commit: string },
): Promise<FolderMove | undefined> {
  // A file from before M22 doesn't say: the object stays where it is (null is the top level).
  if (path === undefined) return undefined
  const folderId = await ensureFolderPath(db, kind, path, git)
  if (folderId === object.folderId) return undefined
  const table = TABLES[kind]
  const from = await folderPathOf(db, object.folderId)
  await db.update(table).set({ folderId }).where(eq(table.id, object.id))
  return { from, to: path }
}
