import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ComponentLibraryDefinition } from '@ow/app-definition'
import { Api, ApiError } from './api'
import {
  exists,
  type FolderState,
  filesHash,
  folderLibrary,
  libraryFiles,
  readFolder,
  readState,
  writeFolder,
  writeState,
} from './folder'

/** Where the CLI writes what it says: stdout and stderr, replaceable in tests. */
export interface Output {
  out(line: string): void
  err(line: string): void
}

/** A command that can't go on: its message, and the exit code (1). */
export class CliError extends Error {}

interface LibraryView {
  id: string
  slug: string
  name: string
  description: string | null
  draftDefinition: ComponentLibraryDefinition
  draftRevision: number
}

interface BuildProblem {
  file: string | null
  line: number | null
  column: number | null
  message: string
}
type BuildOutcome =
  | { ok: true; bundleHash: string; sizeBytes: number; cached: boolean }
  | { ok: false; stage: string; problems: BuildProblem[]; log?: string }

// ── Signing in ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where `login` keeps the instance and the token: `$OW_CONFIG_DIR` or `~/.config/ow-components`. */
function configPath(): string {
  return join(process.env.OW_CONFIG_DIR ?? join(homedir(), '.config', 'ow-components'), 'config.json')
}

/** The instance and token: `OW_URL` and `OW_TOKEN` (CI), else what `login` kept. */
export async function signedIn(): Promise<Api> {
  if (process.env.OW_URL && process.env.OW_TOKEN) return new Api(process.env.OW_URL, process.env.OW_TOKEN)
  try {
    const { url, token } = JSON.parse(await readFile(configPath(), 'utf8')) as { url: string; token: string }
    return new Api(url, token)
  } catch {
    throw new CliError('Not signed in: run `ow-components login <url>` (or set OW_URL and OW_TOKEN)')
  }
}

/** Checks the token against the instance and keeps both (the file readable by its owner only). */
export async function login(url: string, token: string, io: Output): Promise<void> {
  if (!/^https?:\/\//.test(url)) throw new CliError(`${url} isn't a URL (https://…)`)
  if (!token.startsWith('owpat_')) throw new CliError("That isn't an access token (they start with owpat_)")
  const api = new Api(url, token)
  const me = await api.query<{ email: string } | null>('me')
  if (!me) throw new CliError('The instance refused the token (unknown, revoked or expired)')
  const path = configPath()
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify({ url: api.url, token }, null, 2)}\n`, { mode: 0o600 })
  io.out(`Signed in to ${api.url} as ${me.email}`)
}

// ── Libraries and folders ──────────────────────────────────────────────────────────────────────────────────────────

async function library(api: Api, ref: { slug: string } | { id: string }): Promise<LibraryView> {
  return api.query<LibraryView>('componentLibraries.get', ref)
}

/** Writes the library's draft into the folder and records it as synced. */
async function sync(
  dir: string,
  api: Api,
  lib: LibraryView,
  previous: FolderState | null,
): Promise<FolderState> {
  const files = libraryFiles(lib, lib.draftDefinition)
  await writeFolder(dir, files, previous?.paths ?? [])
  const state: FolderState = {
    url: api.url,
    slug: lib.slug,
    id: lib.id,
    revision: lib.draftRevision,
    hash: filesHash(files),
    paths: Object.keys(files),
  }
  await writeState(dir, state)
  return state
}

/** Creates a library on the instance (with its starter component) and its folder. */
export async function init(slug: string, opts: { name?: string; dir?: string }, io: Output): Promise<void> {
  const api = await signedIn()
  const dir = resolve(opts.dir ?? slug)
  if ((await exists(dir)) && Object.keys(await readFolder(dir)).length) {
    throw new CliError(`${dir} isn't empty: init makes a new folder`)
  }
  const created = await api.mutate<{ id: string }>('componentLibraries.create', {
    slug,
    name: opts.name ?? slug,
    folderId: null,
  })
  await sync(dir, api, await library(api, { id: created.id }), null)
  io.out(`Created ${slug} on ${api.url}, in ${dir}`)
}

/** The library's draft into a folder; local changes since the last sync are kept unless `force`. */
export async function pull(
  slug: string | undefined,
  opts: { dir?: string; force?: boolean },
  io: Output,
): Promise<void> {
  const api = await signedIn()
  const dir = resolve(opts.dir ?? slug ?? '.')
  const state = await readState(dir)
  const which = slug ?? state?.slug
  if (!which) throw new CliError('Which library? `ow-components pull <slug>`')
  if (!opts.force && (await exists(dir))) {
    const local = await readFolder(dir)
    const changed = state ? filesHash(local) !== state.hash : Object.keys(local).length > 0
    if (changed) {
      throw new CliError(
        state
          ? `${dir} has changes since the last pull or push: push them, or pull --force to drop them`
          : `${dir} isn't empty: pull into a new folder, or --force`,
      )
    }
  }
  const lib = await library(api, { slug: which })
  await sync(dir, api, lib, state)
  io.out(`Pulled ${lib.slug} (draft revision ${lib.draftRevision}) into ${dir}`)
}

export interface PushOptions {
  /** Push (and build) only when the folder changed since it last synced (`dev`). */
  onlyIfChanged?: boolean
  dir?: string
  force?: boolean
  build?: boolean
  publish?: string
  notes?: string
}

/**
 * The folder into the library's draft. Refused when the draft changed since this folder last synced (someone edited
 * it in the browser) unless `force`. Then, if asked, a build (problems as `file:line:column`) and a release.
 * Returns whether everything asked for worked.
 */
export async function push(opts: PushOptions, io: Output): Promise<boolean> {
  const api = await signedIn()
  const dir = resolve(opts.dir ?? '.')
  const state = await readState(dir)
  if (!state)
    throw new CliError(`${dir} isn't a library's folder (no .ow-components.json): init or pull first`)
  const files = await readFolder(dir)
  const local = folderLibrary(files)
  if (!local.ok) throw new CliError(`The folder's library isn't valid:\n  ${local.problems.join('\n  ')}`)
  const lib = await library(api, { id: state.id })
  const unchanged = filesHash(files) === state.hash && lib.draftRevision === state.revision
  if (unchanged && opts.onlyIfChanged) return true
  if (unchanged && !opts.force && !opts.build && !opts.publish) {
    io.out(`Nothing to push: ${lib.slug}'s draft is the folder already`)
    return true
  }
  if (lib.draftRevision !== state.revision && !opts.force) {
    throw new CliError(
      `The draft changed on ${api.url} since this folder last synced (revision ${state.revision}, now ${lib.draftRevision}): ` +
        'pull (after keeping your changes elsewhere) or push --force to replace it',
    )
  }
  if (unchanged && !opts.force) {
    // The draft is the folder already: only what was asked besides.
    if (opts.build || opts.publish) {
      if (!(await build(api, lib.id, io))) return false
    }
    if (opts.publish) await publish(api, lib, lib.draftRevision, opts, io)
    return true
  }
  if (local.name !== lib.name || (local.description ?? null) !== (lib.description ?? null)) {
    await api.mutate('componentLibraries.update', {
      id: lib.id,
      name: local.name,
      description: local.description,
    })
  }
  const saved = await api.mutate<{ revision: number; diagnostics: { severity: string; message: string }[] }>(
    'componentLibraries.saveDraft',
    { id: lib.id, revision: lib.draftRevision, definition: local.definition },
  )
  await writeState(dir, {
    ...state,
    revision: saved.revision,
    hash: filesHash(files),
    paths: Object.keys(files),
  })
  io.out(`Pushed ${Object.keys(files).length} files to ${lib.slug} (draft revision ${saved.revision})`)
  const errors = saved.diagnostics.filter((d) => d.severity === 'error')
  for (const d of saved.diagnostics) io.err(`${d.severity}: ${d.message}`)
  if (errors.length) return false
  if (opts.build || opts.publish) {
    if (!(await build(api, lib.id, io))) return false
  }
  if (opts.publish) await publish(api, lib, saved.revision, opts, io)
  return true
}

async function publish(api: Api, lib: LibraryView, revision: number, opts: PushOptions, io: Output) {
  const release = await api.mutate<{ version: string }>('componentLibraries.publish', {
    componentLibraryId: lib.id,
    draftRevision: revision,
    version: opts.publish,
    notes: opts.notes ?? null,
  })
  io.out(`Published ${lib.slug} ${release.version}`)
}

/** Builds the draft, printing problems as `file:line:column: message`. */
async function build(api: Api, id: string, io: Output): Promise<boolean> {
  const outcome = await api.mutate<BuildOutcome>('componentLibraries.build', { componentLibraryId: id })
  if (outcome.ok) {
    io.out(
      `Built (${Math.max(1, Math.round(outcome.sizeBytes / 1024))} kB${outcome.cached ? ', as before' : ''})`,
    )
    return true
  }
  io.err(`The build failed (${outcome.stage}):`)
  for (const p of outcome.problems) {
    const where = p.file ? `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ''}` : ''}: ` : ''
    io.err(`  ${where}${p.message}`)
  }
  return false
}

/**
 * A release from a bundle built elsewhere (M25's upload API): `manifest.json` (`{components, allowedOrigins?}`),
 * `bundle.js` and `bundle.css` in `dir`, for the library this folder (or `--slug`) names.
 */
export async function pushPrebuilt(
  dir: string,
  opts: { slug?: string; version?: string; notes?: string },
  io: Output,
): Promise<void> {
  const api = await signedIn()
  const state = await readState(resolve('.'))
  const slug = opts.slug ?? state?.slug
  if (!slug) throw new CliError('Which library? --slug <slug> (or run it in the library’s folder)')
  const read = (name: string, optional = false) =>
    readFile(join(dir, name), 'utf8').catch((err) => {
      if (optional) return ''
      throw new CliError(`${join(dir, name)}: ${(err as Error).message}`)
    })
  let manifest: { components: unknown[]; allowedOrigins?: string[] }
  try {
    manifest = JSON.parse(await read('manifest.json'))
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(`${join(dir, 'manifest.json')} isn't JSON`)
  }
  const lib = await library(api, { slug })
  const release = await api.mutate<{ version: string }>('componentLibraries.uploadBuild', {
    componentLibraryId: lib.id,
    js: await read('bundle.js'),
    css: await read('bundle.css', true),
    components: manifest.components,
    ...(manifest.allowedOrigins && { allowedOrigins: manifest.allowedOrigins }),
    ...(opts.version ? { version: opts.version } : { bump: 'minor' }),
    notes: opts.notes ?? null,
  })
  io.out(`Uploaded ${slug} ${release.version}`)
}

export { ApiError }
