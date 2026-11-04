import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import {
  type ComponentLibraryDefinition,
  componentPathReason,
  PROVIDED_PACKAGES,
  validateComponentLibrary,
} from '@ow/app-definition'
import type { Keyring } from '@ow/crypto'
import { componentBundles, type Db } from '@ow/db'
import { canonicalJson } from '@ow/definition'
import { eq, sql } from 'drizzle-orm'
import { build, type Message, type Plugin } from 'esbuild'
import { DEFAULT_INSTALL_LIMITS, type InstallLimits, installDependencies } from './install'
import { type NpmRegistryAccess, npmRegistryAccess } from './registries'

/**
 * Builds a component library (M25, architecture §2.28): its npm dependencies installed (`install.ts`), then every
 * component's entry bundled by esbuild into **one ESM file exporting each component by name** plus one CSS file.
 * React, ReactDOM and `@ow/component-sdk` are the frame's (one React per frame), read from
 * `globalThis.__owFrame.modules`. Bundling reads only files inside the build directory: a library can't pull in
 * the server's own files. Builds are kept by what went in (`component_bundles.input_hash`), so building the same
 * draft twice is free, and served by what came out (`hash`).
 */

/** The bundle's JS and CSS together, at most. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024

export interface ComponentBuildConfig {
  /** The npm registry, e.g. `https://registry.npmjs.org/`. */
  registry: string
  /** For the admins' npm registries' tokens (M33). */
  keyring?: Keyring
  /** The registries, as `buildComponentLibrary` read them for this build. */
  registries?: NpmRegistryAccess[]
  /** Where builds and npm's download cache go. */
  workDir: string
  limits?: InstallLimits
}

/** A problem with a build, at a library file when it's about one (line and column from 1). */
export interface BuildProblem {
  file: string | null
  line: number | null
  column: number | null
  message: string
}

export type BuildOutcome =
  | { ok: true; bundleHash: string; lock: string | null; sizeBytes: number; cached: boolean }
  | { ok: false; stage: 'validate' | 'install' | 'bundle'; problems: BuildProblem[]; log?: string }

/** The modules the frame provides, by the specifier a component imports. */
export const FRAME_MODULES = [
  ...PROVIDED_PACKAGES,
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom/client',
] as const

/** What a build depends on: the files, the dependencies, each component's export and entry, and the lock. */
export function buildInputHash(def: ComponentLibraryDefinition, lock: string | null): string {
  const input = {
    files: [...def.files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    dependencies: def.dependencies,
    entries: def.components.map((c) => [c.name, c.entry]).sort(),
    lock: Object.keys(def.dependencies).length ? lock : null,
  }
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

export const bundleHashOf = (js: string, css: string) =>
  createHash('sha256').update(js).update('\0').update(css).digest('hex')

/** A few builds at a time per process: each installs packages and bundles. */
class Gate {
  private running = 0
  private waiting: (() => void)[] = []
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}
const gate = new Gate(2)

/**
 * Builds `def` (with `lock` as the starting lock), or finds the build it already had. A successful build is stored
 * in `component_bundles`.
 */
export async function buildComponentLibrary(
  db: Db,
  config: ComponentBuildConfig,
  def: ComponentLibraryDefinition,
  lock: string | null,
): Promise<BuildOutcome> {
  const errors = validateComponentLibrary(def).diagnostics.filter((d) => d.severity === 'error')
  if (errors.length) {
    return {
      ok: false,
      stage: 'validate',
      problems: errors.map((d) => ({ file: null, line: null, column: null, message: d.message })),
    }
  }
  if (!def.components.length) {
    return {
      ok: false,
      stage: 'validate',
      problems: [{ file: null, line: null, column: null, message: 'Add a component to build' }],
    }
  }
  // Found again, its age starts over: retention removes bundles unused for a while, not one about to be released.
  const [cached] = await db
    .update(componentBundles)
    .set({ createdAt: sql`now()` })
    .where(eq(componentBundles.inputHash, buildInputHash(def, lock)))
    .returning({
      hash: componentBundles.hash,
      lock: componentBundles.lock,
      sizeBytes: componentBundles.sizeBytes,
    })
  if (cached)
    return { ok: true, bundleHash: cached.hash, lock: cached.lock, sizeBytes: cached.sizeBytes, cached: true }

  // The admins' npm registries (M33), only for a build that installs something.
  let registries: NpmRegistryAccess[] = []
  if (Object.keys(def.dependencies).length) {
    const access = await npmRegistryAccess(db, config.keyring)
    if (!access.ok) {
      return {
        ok: false,
        stage: 'install',
        problems: [{ file: 'package.json', line: null, column: null, message: access.message }],
      }
    }
    registries = access.registries
  }
  return gate.run(async () => {
    await mkdir(config.workDir, { recursive: true })
    const dir = await realpath(await mkdtemp(join(config.workDir, 'build-')))
    try {
      const outcome = await buildIn(dir, { ...config, registries }, def, lock)
      if (!outcome.ok) return outcome
      const bundleHash = bundleHashOf(outcome.js, outcome.css)
      // Kept under the lock the build ended with: the draft's next build starts from that lock (the one it started
      // from was older, or none). A bundle built before under other inputs now answers to these.
      const inputHash = buildInputHash(def, outcome.lock)
      await db
        .insert(componentBundles)
        .values({
          hash: bundleHash,
          inputHash,
          js: outcome.js,
          css: outcome.css,
          lock: outcome.lock,
          sizeBytes: outcome.sizeBytes,
        })
        .onConflictDoUpdate({ target: componentBundles.hash, set: { inputHash, createdAt: sql`now()` } })
        .catch((err: unknown) => {
          // Another process stored these inputs at the same moment: theirs serves.
          if ((err as { code?: string }).code !== '23505') throw err
        })
      return { ok: true, bundleHash, lock: outcome.lock, sizeBytes: outcome.sizeBytes, cached: false }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function buildIn(
  dir: string,
  config: ComponentBuildConfig,
  def: ComponentLibraryDefinition,
  lock: string | null,
): Promise<
  | { ok: true; js: string; css: string; lock: string | null; sizeBytes: number }
  | Extract<BuildOutcome, { ok: false }>
> {
  for (const file of def.files) {
    // Checked by the validator; again here, as these become paths on disk.
    if (componentPathReason(file.path)) throw new Error(`Refusing the path ${file.path}`)
    const path = join(dir, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.content)
  }
  const installed = await installDependencies(dir, {
    dependencies: def.dependencies,
    lock,
    registry: config.registry,
    registries: config.registries,
    cacheDir: join(config.workDir, 'npm-cache'),
    limits: config.limits ?? DEFAULT_INSTALL_LIMITS,
  })
  if (!installed.ok) {
    return {
      ok: false,
      stage: 'install',
      problems: [{ file: 'package.json', line: null, column: null, message: installed.message }],
      log: installed.log,
    }
  }

  const entry = def.components
    .map((c) => `export { default as ${c.name} } from ${JSON.stringify(`./${c.entry}`)}`)
    .join('\n')
  try {
    const result = await build({
      stdin: { contents: entry, resolveDir: dir, sourcefile: '<components>', loader: 'js' },
      absWorkingDir: dir,
      bundle: true,
      write: false,
      outdir: join(dir, 'out'),
      entryNames: 'bundle',
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: {
        '.svg': 'dataurl',
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.gif': 'dataurl',
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.json': 'json',
      },
      logLevel: 'silent',
      plugins: [frameModules(), confineTo(dir)],
    })
    const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? ''
    const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? ''
    const sizeBytes = Buffer.byteLength(js) + Buffer.byteLength(css)
    if (sizeBytes > MAX_BUNDLE_BYTES) {
      return {
        ok: false,
        stage: 'bundle',
        problems: [
          {
            file: null,
            line: null,
            column: null,
            message: `The bundle is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; ${MAX_BUNDLE_BYTES / 1024 / 1024} MB at most`,
          },
        ],
      }
    }
    return { ok: true, js, css, lock: installed.lock, sizeBytes }
  } catch (err) {
    const messages = (err as { errors?: Message[] }).errors
    if (!messages) throw err
    return { ok: false, stage: 'bundle', problems: messages.slice(0, 20).map((m) => problemOf(dir, m)) }
  }
}

/** An esbuild message at a library file (relative path), or at none. */
function problemOf(dir: string, m: Message): BuildProblem {
  const file = m.location?.file
  const inside = file && !file.startsWith('<') ? relative(dir, join(dir, file)) : null
  return {
    file: inside && !inside.startsWith('..') ? inside.split(sep).join('/') : null,
    line: m.location?.line ?? null,
    column: m.location ? m.location.column + 1 : null,
    message: m.text,
  }
}

/** React, ReactDOM and the SDK come from the frame: `module.exports` of what it put on `globalThis.__owFrame`. */
function frameModules(): Plugin {
  const names = new Set<string>(FRAME_MODULES)
  return {
    name: 'ow-frame-modules',
    setup(b) {
      b.onResolve({ filter: /^(react|react-dom|@ow\/component-sdk)(\/.*)?$/ }, (args) => {
        if (!names.has(args.path)) {
          return {
            errors: [
              { text: `"${args.path}" isn’t available in a component (use ${FRAME_MODULES.join(', ')})` },
            ],
          }
        }
        return { path: args.path, namespace: 'ow-frame' }
      })
      b.onLoad({ filter: /.*/, namespace: 'ow-frame' }, (args) => ({
        contents: `module.exports = globalThis.__owFrame.modules[${JSON.stringify(args.path)}]`,
        loader: 'js',
      }))
    },
  }
}

/** Refuses loading any file outside the build directory (the server's own files, through `../` or an absolute path). */
function confineTo(dir: string): Plugin {
  const root = dir.endsWith(sep) ? dir : dir + sep
  return {
    name: 'ow-confine',
    setup(b) {
      b.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        const real = await realpath(args.path).catch(() => args.path)
        if (!real.startsWith(root)) {
          return {
            errors: [{ text: `Only the library’s files and its packages can be imported, not ${args.path}` }],
          }
        }
        return undefined
      })
    },
  }
}

/** npm's public registry (`NPM_REGISTRY_URL`'s default). */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** The build settings from the server's config. */
export function componentBuildConfig(config: {
  NPM_REGISTRY_URL: string
  COMPONENT_BUILD_DIR?: string
  keyring?: Keyring
}): ComponentBuildConfig {
  return {
    registry: config.NPM_REGISTRY_URL,
    keyring: config.keyring,
    workDir: config.COMPONENT_BUILD_DIR ?? join(tmpdir(), 'ow-component-builds'),
  }
}
