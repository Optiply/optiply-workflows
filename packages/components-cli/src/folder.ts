import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { ComponentLibraryDefinition } from '@ow/app-definition'
import { decodeComponentLibrary, encodeComponentLibrary } from '@ow/git-format'

/**
 * A component library's folder (M33): M25's Git layout (`library.json`, `package.json`, the sources), read and
 * written with `@ow/git-format`'s codec, plus `.ow-components.json`, what the CLI last synced.
 */
export const STATE_FILE = '.ow-components.json'

/** What the folder was last synced with: the library, the draft revision it matched, its files' hash. */
export interface FolderState {
  url: string
  slug: string
  id: string
  revision: number
  /** The hash of the folder's files when synced (`filesHash`): a different one means local changes. */
  hash: string
  /** The paths the CLI wrote, so a pull can remove those the draft no longer has. */
  paths: string[]
}

/** Skipped when reading a folder: npm's and git's, build output, and hidden files (the state among them). */
export const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage'])

export type Files = Record<string, string>

/** The folder's files by `/`-separated path, as text. */
export async function readFolder(dir: string): Promise<Files> {
  const files: Files = {}
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files[relative(dir, path).split(sep).join('/')] = await readFile(path, 'utf8')
    }
  }
  await walk(dir)
  return files
}

/** A stable hash of a set of files (paths and contents), to tell whether the folder changed. */
export function filesHash(files: Files): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(files).sort())
    hash.update(path).update('\0').update(files[path]!).update('\0')
  return hash.digest('hex')
}

/** The library's files as the folder holds them (the lock isn't written: the instance keeps it). */
export function libraryFiles(
  meta: { name: string; description?: string | null },
  definition: ComponentLibraryDefinition,
): Files {
  const { files } = encodeComponentLibrary({
    name: meta.name,
    description: meta.description ?? null,
    definition,
  })
  return files
}

/** The folder's library: its name and description (library.json) and definition, or what's wrong, by file. */
export function folderLibrary(
  files: Files,
):
  | { ok: true; name: string; description: string | null; definition: ComponentLibraryDefinition }
  | { ok: false; problems: string[] } {
  const { 'package-lock.json': _lock, ...rest } = files
  const decoded = decodeComponentLibrary(rest)
  if (!decoded.ok) return { ok: false, problems: decoded.problems.map((p) => p.message) }
  const { name, description, definition } = decoded.value
  return { ok: true, name, description: description ?? null, definition }
}

/** Writes the files, removing those of `previous` (paths written before) that aren't among them any more. */
export async function writeFolder(dir: string, files: Files, previous: string[] = []): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  for (const path of previous) {
    if (!(path in files)) await rm(join(dir, ...path.split('/')), { force: true })
  }
}

export async function readState(dir: string): Promise<FolderState | null> {
  try {
    return JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')) as FolderState
  } catch {
    return null
  }
}

export async function writeState(dir: string, state: FolderState): Promise<void> {
  await writeFile(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
