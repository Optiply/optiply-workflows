import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type NpmRegistryAccess, npmAuthKey } from './registries'

/**
 * Installs a component library's npm dependencies (M25, architecture §2.28) into a build directory: `npm install`
 * with **no install scripts**, from one registry, in an environment holding nothing of the server's (no secrets, no
 * `~/.npmrc`), within a time and size limit. It follows the lock it's given while the dependencies allow, and
 * returns the lock it ends with.
 */

export interface InstallLimits {
  timeoutMs: number
  /** Bytes the installed packages may take. */
  maxBytes: number
}

export const DEFAULT_INSTALL_LIMITS: InstallLimits = { timeoutMs: 120_000, maxBytes: 200 * 1024 * 1024 }

export type InstallResult =
  | { ok: true; lock: string | null; log: string }
  | { ok: false; kind: 'install' | 'timeout' | 'too_large'; message: string; log: string }

/** npm's output kept for a failure (its end, where the error is). */
const MAX_LOG = 16 * 1024

export async function installDependencies(
  dir: string,
  opts: {
    dependencies: Record<string, string>
    lock: string | null
    registry: string
    /**
     * The admins' registries (M33): per scope, or one for everything else (instead of `registry`), with their
     * tokens. They go into the build's own `.npmrc` (only npm reads it; no package code runs: no install scripts).
     */
    registries?: NpmRegistryAccess[]
    /** npm's download cache, shared by builds. */
    cacheDir: string
    /** The `name` in the package.json written (default `ow-component-library`). */
    name?: string
    limits?: InstallLimits
  },
): Promise<InstallResult> {
  const limits = opts.limits ?? DEFAULT_INSTALL_LIMITS
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: opts.name ?? 'ow-component-library', private: true, dependencies: opts.dependencies }, null, 2)}\n`,
  )
  if (Object.keys(opts.dependencies).length === 0) return { ok: true, lock: null, log: '' }
  if (opts.lock) await writeFile(join(dir, 'package-lock.json'), opts.lock)
  // npm reads these instead of the server's own files. Outside the build directory (the bundler may read anything
  // inside it, and the library's code chooses what it imports: M33's tokens are in .npmrc), gone once npm is done.
  const home = await mkdtemp(join(dirname(dir), '.npm-home-'))
  try {
    return await install(dir, home, opts, limits)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

async function install(
  dir: string,
  home: string,
  opts: Parameters<typeof installDependencies>[1],
  limits: InstallLimits,
): Promise<InstallResult> {
  const npmrc = join(home, '.npmrc')
  const globalrc = join(home, 'global.npmrc')
  let registry = opts.registry
  const lines: string[] = []
  const tokens: string[] = []
  for (const r of opts.registries ?? []) {
    if (r.scope) lines.push(`${r.scope}:registry=${r.url}`)
    else registry = r.url
    if (r.token) {
      lines.push(`${npmAuthKey(r.url)}:_authToken=${r.token}`)
      tokens.push(r.token)
    }
  }
  await writeFile(npmrc, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
  await writeFile(globalrc, '')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalrc,
    npm_config_registry: registry,
    npm_config_cache: opts.cacheDir,
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
    npm_config_loglevel: 'warn',
  }
  const run = await runNpm(['install'], dir, env, limits.timeoutMs)
  // npm doesn't print tokens; if a URL or error ever carried one, it's not kept.
  for (const token of tokens) run.log = run.log.split(token).join('***')
  if (run.timedOut) {
    return {
      ok: false,
      kind: 'timeout',
      message: `Installing took over ${limits.timeoutMs / 1000} s`,
      log: run.log,
    }
  }
  if (run.code !== 0) {
    return { ok: false, kind: 'install', message: npmError(run.log), log: run.log }
  }
  const size = await sizeOf(join(dir, 'node_modules'), limits.maxBytes)
  if (size > limits.maxBytes) {
    return {
      ok: false,
      kind: 'too_large',
      message: `The packages take over ${Math.round(limits.maxBytes / 1024 / 1024)} MB`,
      log: run.log,
    }
  }
  const lock = await readFile(join(dir, 'package-lock.json'), 'utf8').catch(() => null)
  return { ok: true, lock, log: run.log }
}

function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; log: string; timedOut: boolean }>((resolve) => {
    const child = spawn('npm', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    const append = (chunk: Buffer) => {
      log += chunk.toString('utf8')
      if (log.length > MAX_LOG * 2) log = log.slice(-MAX_LOG)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, log: `${log}\n${err.message}`.slice(-MAX_LOG), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, log: log.slice(-MAX_LOG), timedOut })
    })
  })
}

/** npm's error lines (`npm error …`), or the end of its output. */
function npmError(log: string): string {
  const lines = log
    .split('\n')
    .filter((l) => l.startsWith('npm error') || l.startsWith('npm ERR!'))
    .map((l) => l.replace(/^npm (error|ERR!) ?/, '').trim())
    .filter((l) => l && !l.startsWith('A complete log') && !/^\/.*\.log$/.test(l))
  const text = (lines.length ? lines.slice(0, 6) : log.trim().split('\n').slice(-6)).join('\n')
  return text || 'npm install failed'
}

/** The bytes under `dir`, counting until `stopAt` is passed. Symbolic links count as themselves. */
async function sizeOf(dir: string, stopAt: number): Promise<number> {
  let total = 0
  const stack = [dir]
  while (stack.length && total <= stopAt) {
    const current = stack.pop()!
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const path = join(current, e.name)
      if (e.isDirectory()) stack.push(path)
      else if (e.isFile()) total += (await stat(path)).size
    }
  }
  return total
}
