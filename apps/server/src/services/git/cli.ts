import { spawn } from 'node:child_process'

/** How long one git command may take before it's killed. */
const GIT_TIMEOUT_MS = 60_000
/** Output beyond this is an error: the repo holds definitions, not media. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export type GitErrorKind =
  /** The token was refused, or none was given for a private repo. */
  | 'auth'
  /** No such repo (GitHub also says this when the token can't see it). */
  | 'not_found'
  /** DNS, TLS, connection or timeout. */
  | 'unreachable'
  /** The server refused a push (branch protection, a hook): not something a retry fixes. */
  | 'refused'
  | 'failed'

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitRunOptions {
  /** The bare repo (`--git-dir`). */
  gitDir: string
  /** Sent on stdin. */
  input?: string
  /** Extra environment: `GIT_INDEX_FILE`, author and committer, the token (`OW_GIT_TOKEN`). */
  env?: Record<string, string>
  /** Strings to blank out of error messages (the token). */
  secrets?: readonly string[]
  /** Exit codes that aren't errors (e.g. 1 from `push` when a ref was rejected, read from the porcelain output). */
  okCodes?: readonly number[]
}

export interface GitResult {
  stdout: string
  /** The same output as bytes (`cat-file --batch` sizes are in bytes). */
  stdoutBytes: Buffer
  stderr: string
  code: number
}

/**
 * Runs git with a clean environment: no system or global config, no credential helpers, no terminal prompts, and
 * only the protocols the caller allows. The token never appears in the arguments: it reaches git through
 * `GIT_ASKPASS` (see `askpassScript`) and the environment of this one process.
 */
export function runGit(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: opts.gitDir,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...opts.env,
  }
  const command = subcommand(args)
  const fullArgs = [
    '--git-dir',
    opts.gitDir,
    '-c',
    'credential.helper=',
    '-c',
    'core.hooksPath=/dev/null',
    ...args,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn('git', fullArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let failure: GitError | null = null
    const timer = setTimeout(() => {
      failure = new GitError('unreachable', `git ${command} took longer than ${GIT_TIMEOUT_MS / 1000} s`)
      child.kill('SIGKILL')
    }, GIT_TIMEOUT_MS)
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES && !failure) {
        failure = new GitError(
          'failed',
          `git ${command} returned more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`,
        )
        child.kill('SIGKILL')
        return
      }
      into.push(chunk)
    }
    child.stdout.on('data', collect(out))
    child.stderr.on('data', collect(err))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new GitError('failed', `Couldn't run git: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      const stdoutBytes = Buffer.concat(out)
      const stdout = stdoutBytes.toString('utf8')
      const stderr = scrub(Buffer.concat(err).toString('utf8'), opts.secrets ?? [])
      const exit = code ?? -1
      if (exit !== 0 && !(opts.okCodes ?? []).includes(exit)) return reject(classify(command, stderr))
      resolve({ stdout, stdoutBytes, stderr, code: exit })
    })
    child.stdin.on('error', () => {
      // git may exit before reading all of stdin; its exit code says what went wrong.
    })
    child.stdin.end(opts.input ?? '')
  })
}

/** A script git runs for the username and password; it reads the token from this process's environment. */
export const askpassScript = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "\${OW_GIT_USERNAME:-x-access-token}" ;;
  *) printf '%s\\n' "$OW_GIT_TOKEN" ;;
esac
`

/** The git command in `args`, past any `-c name=value` options. */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++
    else return args[i]!
  }
  return 'git'
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) if (secret) out = out.replaceAll(secret, '***')
  return out
}

/** Turns git's stderr into a kind and a message people can act on (git's own last lines, hints dropped). */
function classify(command: string, stderr: string): GitError {
  const text = stderr
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('hint:'))
    .join('\n')
    .trim()
  const message = `git ${command} failed: ${text || 'no output'}`
  if (
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|HTTP 40[13]|returned error: 40[13]|Invalid username or token|Permission to .* denied/i.test(
      text,
    )
  ) {
    return new GitError('auth', message)
  }
  if (
    /Repository not found|repository '.*' not found|does not appear to be a git repository|returned error: 404/i.test(
      text,
    )
  ) {
    return new GitError('not_found', message)
  }
  if (
    /Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|SSL|TLS|Operation timed out|unable to access/i.test(
      text,
    )
  ) {
    return new GitError('unreachable', message)
  }
  return new GitError('failed', message)
}
