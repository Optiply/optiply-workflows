import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { Keyring } from '@ow/crypto'
import { type Db, jsBundles, npmRegistries } from '@ow/db'
import { canonicalJson, jsDependencies, jsPackageProblems } from '@ow/definition'
import { eq, sql } from 'drizzle-orm'
import { build, type Message, type Plugin } from 'esbuild'
import { confineTo, Gate } from './components/build'
import { DEFAULT_INSTALL_LIMITS, type InstallLimits, installDependencies } from './components/install'
import { type NpmRegistryAccess, npmRegistryAccess } from './components/registries'

/**
 * A workflow's or app's JavaScript packages, bundled for the sandboxes (docs/architecture.md, JS packages): npm
 * installs them (`components/install.ts`: no install scripts, the admins' registries, limits), esbuild bundles them
 * into **one script** that sets `globalThis.__owModules`, an object with a getter per package that loads it on first
 * use (so one package failing to load doesn't take the others with it). Code reaches them through `import` lines,
 * rewritten to read that object.
 *
 * Bundled for the browser: workflows' isolates and apps' Workers have no Node. A Node built-in a package reaches
 * for (and has no npm package of the same name installed) becomes a stub that throws, naming it, when used; the
 * build lists them as warnings. Kept in `js_bundles` by what went in, so the same packages build once.
 */

export interface JsBundleConfig {
  /** The npm registry, e.g. `https://registry.npmjs.org/` (NPM_REGISTRY_URL). */
  registry: string
  /** For the admins' npm registries' tokens (M33). */
  keyring?: Keyring
  /** Where builds go; npm's download cache is shared with component builds. */
  workDir: string
  maxBytes: number
  limits?: InstallLimits
}

export function jsBundleConfig(config: {
  NPM_REGISTRY_URL: string
  COMPONENT_BUILD_DIR?: string
  JS_BUNDLE_MAX_MB: number
  keyring?: Keyring
}): JsBundleConfig {
  return {
    registry: config.NPM_REGISTRY_URL,
    keyring: config.keyring,
    workDir: config.COMPONENT_BUILD_DIR ?? join(tmpdir(), 'ow-component-builds'),
    maxBytes: config.JS_BUNDLE_MAX_MB * 1024 * 1024,
  }
}

export interface JsBundleReady {
  ok: true
  bundleHash: string
  js: string
  lock: string | null
  /** The installed version of each package. */
  versions: Record<string, string>
  sizeBytes: number
  warnings: string[]
  /** Found in `js_bundles` rather than built now. */
  cached: boolean
}

export type JsBundleErrorKind = 'invalid' | 'registries' | 'install' | 'timeout' | 'too_large' | 'bundle'

export type JsBundleOutcome =
  | JsBundleReady
  | { ok: false; kind: JsBundleErrorKind; message: string; log?: string }

/** What a bundle depends on: the dependencies, where they resolve from (not the tokens) and the lock it starts from. */
export function jsInputHash(
  dependencies: Record<string, string>,
  registries: readonly Pick<NpmRegistryAccess, 'scope' | 'url'>[],
  defaultRegistry: string,
  lock: string | null,
): string {
  const input = {
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1))),
    registries: [
      { scope: null, url: defaultRegistry },
      ...registries.map(({ scope, url }) => ({ scope, url })),
    ].sort((a, b) => ((a.scope ?? '') < (b.scope ?? '') ? -1 : 1)),
    lock,
  }
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

/** The bundle's entry: a getter per package, loading it once on first use. */
export function bundleEntry(names: readonly string[]): string {
  const lines = [
    'const modules = Object.create(null)',
    'const once = (load) => { let done = false, value; return () => { if (!done) { value = load(); done = true } return value } }',
    ...names.map(
      (name) =>
        `Object.defineProperty(modules, ${JSON.stringify(name)}, { enumerable: true, get: once(() => require(${JSON.stringify(name)})) })`,
    ),
    'globalThis.__owModules = modules',
  ]
  return `${lines.join('\n')}\n`
}

const gate = new Gate(2)
/** Builds of the same inputs in this process share one. */
const running = new Map<string, Promise<JsBundleOutcome>>()

/**
 * The bundle for `packages` (as written in the definition), built now or found again. `lock` is the lock to start
 * from (a release's); without it npm resolves the ranges afresh. Each build is recorded, a failure too.
 */
export async function buildJsBundle(
  db: Db,
  config: JsBundleConfig,
  packages: readonly string[],
  opts: { lock?: string | null } = {},
): Promise<JsBundleOutcome> {
  const problems = jsPackageProblems(packages)
  if (problems.length) {
    return {
      ok: false,
      kind: 'invalid',
      message: problems.map((p) => `Line ${p.index + 1}: ${p.message}`).join('\n'),
    }
  }
  const dependencies = jsDependencies(packages)
  if (!Object.keys(dependencies).length)
    return { ok: false, kind: 'invalid', message: 'No packages to install' }
  const access = await npmRegistryAccess(db, config.keyring)
  if (!access.ok) return { ok: false, kind: 'registries', message: access.message }
  const lock = opts.lock ?? null
  const inputHash = jsInputHash(dependencies, access.registries, config.registry, lock)

  const [row] = await db
    .update(jsBundles)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(jsBundles.inputHash, inputHash))
    .returning()
  if (row?.state === 'ready' && row.js && row.bundleHash) {
    return {
      ok: true,
      bundleHash: row.bundleHash,
      js: row.js,
      lock: row.lock,
      versions: row.versions ?? {},
      sizeBytes: row.sizeBytes ?? row.js.length,
      warnings: row.warnings ?? [],
      cached: true,
    }
  }

  const existing = running.get(inputHash)
  if (existing) return existing
  const promise = gate
    .run(() => buildAndRecord(db, { ...config }, access.registries, dependencies, lock, inputHash))
    .finally(() => running.delete(inputHash))
  running.set(inputHash, promise)
  return promise
}

/** A ready bundle's script, by its hash (what a release names), or null when it's not kept any more. */
export async function jsBundleByHash(db: Db, bundleHash: string): Promise<{ js: string } | null> {
  const [row] = await db
    .update(jsBundles)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(jsBundles.bundleHash, bundleHash))
    .returning({ js: jsBundles.js, state: jsBundles.state })
  return row?.state === 'ready' && row.js ? { js: row.js } : null
}

async function buildAndRecord(
  db: Db,
  config: JsBundleConfig,
  registries: NpmRegistryAccess[],
  dependencies: Record<string, string>,
  lock: string | null,
  inputHash: string,
): Promise<JsBundleOutcome> {
  await mkdir(config.workDir, { recursive: true })
  const dir = await realpath(await mkdtemp(join(config.workDir, 'js-bundle-')))
  let outcome: JsBundleOutcome
  try {
    outcome = await buildIn(dir, config, registries, dependencies, lock)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const recorded = outcome.ok
    ? {
        state: 'ready' as const,
        bundleHash: outcome.bundleHash,
        js: outcome.js,
        lock: outcome.lock,
        versions: outcome.versions,
        sizeBytes: outcome.sizeBytes,
        warnings: outcome.warnings,
        error: null,
        log: null,
        builtAt: new Date(),
      }
    : {
        state: 'failed' as const,
        bundleHash: null,
        js: null,
        error: { kind: outcome.kind, message: outcome.message },
        log: outcome.log ?? null,
        builtAt: new Date(),
      }
  await db
    .insert(jsBundles)
    .values({ inputHash, dependencies, ...recorded })
    .onConflictDoUpdate({ target: jsBundles.inputHash, set: { ...recorded, lastUsedAt: sql`now()` } })
  return outcome
}

async function buildIn(
  dir: string,
  config: JsBundleConfig,
  registries: NpmRegistryAccess[],
  dependencies: Record<string, string>,
  lock: string | null,
): Promise<JsBundleOutcome> {
  const installed = await installDependencies(dir, {
    name: 'ow-js-packages',
    dependencies,
    lock,
    registry: config.registry,
    registries,
    cacheDir: join(config.workDir, 'npm-cache'),
    limits: config.limits ?? DEFAULT_INSTALL_LIMITS,
  })
  if (!installed.ok)
    return { ok: false, kind: installed.kind, message: installed.message, log: installed.log }

  const names = Object.keys(dependencies)
  const warnings = new Set<string>()
  let js: string
  try {
    const result = await build({
      stdin: { contents: bundleEntry(names), resolveDir: dir, sourcefile: '<packages>', loader: 'js' },
      absWorkingDir: dir,
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
      loader: { '.json': 'json', '.node': 'empty', '.css': 'empty' },
      logLevel: 'silent',
      plugins: [nodeBuiltins(dir, warnings), confineTo(dir)],
    })
    js = result.outputFiles[0]?.text ?? ''
  } catch (err) {
    const messages = (err as { errors?: Message[] }).errors
    if (!messages) throw err
    return { ok: false, kind: 'bundle', message: messages.slice(0, 10).map(describe).join('\n') }
  }
  const sizeBytes = Buffer.byteLength(js)
  if (sizeBytes > config.maxBytes) {
    return {
      ok: false,
      kind: 'too_large',
      message: `The packages bundle to ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; ${Math.round(config.maxBytes / 1024 / 1024)} MB at most`,
    }
  }
  const versions: Record<string, string> = {}
  for (const name of names) {
    const manifest = await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8').catch(() => null)
    const version = manifest ? (JSON.parse(manifest) as { version?: unknown }).version : undefined
    if (typeof version === 'string') versions[name] = version
  }
  return {
    ok: true,
    bundleHash: createHash('sha256').update(js).digest('hex'),
    js,
    lock: installed.lock,
    versions,
    sizeBytes,
    warnings: [...warnings].sort(),
    cached: false,
  }
}

function describe(m: Message): string {
  const at = m.location ? `${m.location.file.split(`node_modules${sep}`).pop()}:${m.location.line}: ` : ''
  return `${at}${m.text}`
}

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')))

/** The package a file in node_modules belongs to: `zod`, `@acme/utils`; null outside node_modules. */
export function packageOf(path: string): string | null {
  const parts = path.split(/[\\/]/)
  const at = parts.lastIndexOf('node_modules')
  if (at < 0) return null
  const first = parts[at + 1]
  if (!first) return null
  return first.startsWith('@') ? `${first}/${parts[at + 2] ?? ''}` : first
}

/**
 * Node's built-ins: an npm package of the same name when one is installed (`events`, `buffer`: browser versions),
 * else a stub that throws when used, naming the built-in and who asked for it (a warning of the build).
 */
function nodeBuiltins(dir: string, warnings: Set<string>): Plugin {
  return {
    name: 'ow-node-builtins',
    setup(b) {
      b.onResolve({ filter: /^[a-z_:/]+$/ }, async (args) => {
        if (args.pluginData === 'ow-builtin-probe') return undefined
        const bare = args.path.replace(/^node:/, '')
        const root = bare.split('/')[0]!
        if (!BUILTINS.has(bare) && !BUILTINS.has(root)) return undefined
        if (!args.path.startsWith('node:')) {
          const found = await b.resolve(args.path, {
            kind: args.kind,
            resolveDir: args.resolveDir,
            importer: args.importer,
            pluginData: 'ow-builtin-probe',
          })
          if (!found.errors.length && found.path) return undefined
        }
        const who = packageOf(args.importer) ?? 'A package'
        warnings.add(
          `${who} uses Node's ${bare}, which the sandbox doesn't have: it fails if that part is used`,
        )
        return { path: bare, namespace: 'ow-node-builtin', pluginData: who }
      })
      b.onLoad({ filter: /.*/, namespace: 'ow-node-builtin' }, (args) => ({
        contents: builtinStub(args.path, String(args.pluginData)),
        loader: 'js',
        resolveDir: dir,
      }))
    },
  }
}

/** A module that throws when used: any property read (but those bundlers and promises check), call or `new`. */
function builtinStub(name: string, who: string): string {
  const message = JSON.stringify(`${who} needs Node's ${name}, which the sandbox doesn't have`)
  return `const fail = () => { throw new Error(${message}) }
const quiet = new Set(['__esModule', 'then', 'default'])
module.exports = new Proxy(function () {}, {
  get(_, key) { if (typeof key === 'symbol' || quiet.has(key)) return undefined; fail() },
  apply: fail,
  construct: fail,
})
`
}

export type JsBundleState =
  | { state: 'none' }
  | { state: 'invalid'; error: string }
  | { state: 'failed'; kind: string; error: string; log: string; at: Date | null }
  | {
      state: 'ready'
      versions: Record<string, string>
      sizeBytes: number
      warnings: string[]
      at: Date | null
    }

/**
 * What `buildJsBundle` would find for `packages` now, without building: for the editor. The registries count by
 * their scope and URL only, so this reads no tokens.
 */
export async function jsBundleState(
  db: Db,
  config: JsBundleConfig,
  packages: readonly string[],
): Promise<JsBundleState> {
  const problems = jsPackageProblems(packages)
  if (problems.length) {
    return { state: 'invalid', error: problems.map((p) => `Line ${p.index + 1}: ${p.message}`).join('\n') }
  }
  const dependencies = jsDependencies(packages)
  if (!Object.keys(dependencies).length) return { state: 'none' }
  const registries = await db
    .select({ scope: npmRegistries.scope, url: npmRegistries.url })
    .from(npmRegistries)
  const [row] = await db
    .select()
    .from(jsBundles)
    .where(eq(jsBundles.inputHash, jsInputHash(dependencies, registries, config.registry, null)))
  if (!row) return { state: 'none' }
  if (row.state === 'failed') {
    return {
      state: 'failed',
      kind: row.error?.kind ?? 'install',
      error: row.error?.message ?? 'The install failed',
      log: row.log ?? '',
      at: row.builtAt,
    }
  }
  return {
    state: 'ready',
    versions: row.versions ?? {},
    sizeBytes: row.sizeBytes ?? 0,
    warnings: row.warnings ?? [],
    at: row.builtAt,
  }
}

/** A build's outcome as the editor's state: what `jsBundleState` would now say (failures before recording too). */
export function stateOf(outcome: JsBundleOutcome): JsBundleState {
  if (outcome.ok) {
    return {
      state: 'ready',
      versions: outcome.versions,
      sizeBytes: outcome.sizeBytes,
      warnings: outcome.warnings,
      at: new Date(),
    }
  }
  if (outcome.kind === 'invalid') return { state: 'invalid', error: outcome.message }
  return {
    state: 'failed',
    kind: outcome.kind,
    error: outcome.message,
    log: outcome.log ?? '',
    at: new Date(),
  }
}
