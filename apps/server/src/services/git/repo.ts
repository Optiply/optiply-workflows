import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Files } from '@ow/git-format'
import { z } from 'zod'
import { askpassScript, GitError, type GitRunOptions, runGit } from './cli'

/** Where the repo is and how to sign in. The token is a GitHub token with Contents (and Pull requests) access. */
export interface GitRemote {
  url: string
  token: string | null
}

export interface GitAuthor {
  name: string
  email: string
}

const EMPTY_SHA = '0000000000000000000000000000000000000000'
const SHA = /^[0-9a-f]{40}$/

/**
 * A branch name git and GitHub both take: letters, digits, `.`, `_`, `-` and `/` between parts, none of git's
 * forbidden sequences.
 */
export const branchNameSchema = z
  .string()
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'Use letters, digits, ., _, - and /, starting with a letter or digit',
  )
  .refine(
    (b) => !/\.\.|\/\/|\/$|\.$|\.lock(\/|$)|\/\.|@\{/.test(b),
    "Branch names can't contain .., //, /. or @{, or end with /, . or .lock",
  )

/**
 * The repo URL as stored: `https://host/path` without credentials, a query or a fragment. `file://` and `http://`
 * only when insecure URLs are allowed (development, tests).
 */
export function checkRepoUrl(raw: string, opts: { allowInsecure: boolean }): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new GitError('failed', 'Use a URL like https://github.com/optiply/workflows.git')
  }
  const allowed = opts.allowInsecure ? ['https:', 'http:', 'file:'] : ['https:']
  if (!allowed.includes(url.protocol)) {
    throw new GitError('failed', `Use an ${opts.allowInsecure ? 'https, http or file' : 'https'} URL`)
  }
  if (url.username || url.password) {
    throw new GitError('failed', 'Leave credentials out of the URL: the token is set separately')
  }
  if (url.search || url.hash) throw new GitError('failed', "The URL can't have a query or fragment")
  if (url.protocol !== 'file:' && url.pathname.split('/').filter(Boolean).length < 1) {
    throw new GitError('failed', 'Use the URL of a repository, like https://github.com/optiply/workflows.git')
  }
  return url.toString()
}

/** One process's lock per cache directory: git commands on one bare repo run one at a time. */
const locks = new Map<string, Promise<unknown>>()

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  const settled = next.catch(() => {})
  locks.set(key, settled)
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}

/** A file in a tree: its blob's sha and its path from the root. */
interface TreeEntry {
  mode: string
  type: string
  sha: string
  path: string
}

/** What `GitRepo.commit` writes. */
export interface CommitOptions {
  /** The first parent (null: a first commit). */
  parent: string | null
  /** More parents: a merge commit (made even when its tree is its first parent's). */
  mergeParents?: string[]
  /** The tree to start from instead of the first parent's (a merged tree). */
  tree?: string
  /** Each directory replaced by its files (null removes it). */
  directories?: Record<string, Files | null>
  /** Single files written. */
  files?: Files
  message: string
  author: GitAuthor
  date?: Date
}

/**
 * A remote repo through a bare cache on disk, with plumbing only: no working tree, no checkout, no merge. Each
 * process keeps its own cache (one directory per repo URL) and runs one command on it at a time.
 */
export class GitRepo {
  private constructor(
    readonly dir: string,
    private readonly remote: GitRemote,
    private readonly allowInsecure: boolean,
  ) {}

  static async open(
    cacheRoot: string,
    remote: GitRemote,
    opts: { allowInsecure: boolean },
  ): Promise<GitRepo> {
    const url = checkRepoUrl(remote.url, opts)
    const key = createHash('sha256').update(url).digest('hex').slice(0, 16)
    const repo = new GitRepo(join(cacheRoot, `${key}.git`), { ...remote, url }, opts.allowInsecure)
    await withLock(repo.dir, () => repo.init())
    return repo
  }

  private async init(): Promise<void> {
    const exists = await stat(join(this.dir, 'HEAD')).then(
      () => true,
      () => false,
    )
    if (!exists) {
      await mkdir(this.dir, { recursive: true })
      await this.git(['init', '--bare', '--quiet'])
    }
    await writeFile(this.askpass, askpassScript, { mode: 0o700 })
    await chmod(this.askpass, 0o700)
  }

  private get askpass(): string {
    return join(this.dir, 'ow-askpass.sh')
  }

  private git(args: string[], opts: Omit<GitRunOptions, 'gitDir'> = {}) {
    return runGit(args, { gitDir: this.dir, ...opts })
  }

  /** A command that talks to the remote: the allowed protocols, no redirects, the token through askpass. */
  private network(args: string[], opts: Omit<GitRunOptions, 'gitDir'> = {}) {
    const protocols = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always']
    if (this.allowInsecure)
      protocols.push('-c', 'protocol.http.allow=always', '-c', 'protocol.file.allow=always')
    const token = this.remote.token
    return this.git([...protocols, '-c', 'http.followRedirects=false', ...args], {
      ...opts,
      env: { ...opts.env, ...(token ? { GIT_ASKPASS: this.askpass, OW_GIT_TOKEN: token } : {}) },
      secrets: token ? [token] : [],
    })
  }

  /** The remote's branches and their commits. */
  listBranches(): Promise<Map<string, string>> {
    return withLock(this.dir, async () => {
      const { stdout } = await this.network(['ls-remote', '--heads', this.remote.url])
      const heads = new Map<string, string>()
      for (const line of stdout.split('\n')) {
        const [sha, ref] = line.split('\t')
        if (sha && ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha)
      }
      return heads
    })
  }

  /** Fetches every branch in one go (M22: which branches change an object) and returns each one's commit. */
  fetchAllBranches(): Promise<Map<string, string>> {
    return withLock(this.dir, async () => {
      await this.network([
        'fetch',
        '--no-tags',
        '--quiet',
        '--prune',
        this.remote.url,
        '+refs/heads/*:refs/remotes/origin/*',
      ])
      const { stdout } = await this.git([
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/remotes/origin/',
      ])
      const heads = new Map<string, string>()
      for (const line of stdout.split('\n')) {
        const [sha, ref] = line.split(' ')
        if (sha && ref?.startsWith('refs/remotes/origin/'))
          heads.set(ref.slice('refs/remotes/origin/'.length), sha)
      }
      return heads
    })
  }

  /** Fetches a branch and returns its commit, or null when the remote has no such branch. */
  fetchBranch(branch: string): Promise<string | null> {
    const name = branchNameSchema.parse(branch)
    return withLock(this.dir, async () => {
      try {
        await this.network([
          'fetch',
          '--no-tags',
          '--quiet',
          this.remote.url,
          `+refs/heads/${name}:refs/remotes/origin/${name}`,
        ])
      } catch (err) {
        if (err instanceof GitError && /couldn't find remote ref/i.test(err.message)) {
          await this.git(['update-ref', '-d', `refs/remotes/origin/${name}`]).catch(() => {})
          return null
        }
        throw err
      }
      const { stdout } = await this.git(['rev-parse', '--verify', `refs/remotes/origin/${name}^{commit}`])
      return stdout.trim()
    })
  }

  /** The text files under `paths` (all of them when none) at a fetched commit, by path from the root. */
  readFiles(commit: string, paths: readonly string[] = []): Promise<Files> {
    return withLock(this.dir, async () => {
      const blobs = (await this.entries(commit, paths)).filter(
        (e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755'),
      )
      if (blobs.length === 0) return {}
      const { stdoutBytes } = await this.git(['cat-file', '--batch'], {
        input: `${blobs.map((b) => b.sha).join('\n')}\n`,
      })
      const files: Files = {}
      let offset = 0
      for (const blob of blobs) {
        const headerEnd = stdoutBytes.indexOf(0x0a, offset)
        const [sha, type, size] = stdoutBytes.subarray(offset, headerEnd).toString('utf8').split(' ')
        if (sha !== blob.sha || type !== 'blob')
          throw new GitError('failed', `Unexpected cat-file output for ${blob.path}`)
        const start = headerEnd + 1
        const end = start + Number(size)
        files[blob.path] = stdoutBytes.subarray(start, end).toString('utf8')
        offset = end + 1
      }
      return files
    })
  }

  /** The tree of each directory right under `roots` (`workflows/sync-orders` → its tree's sha), at a commit. */
  subtrees(commit: string, roots: readonly string[]): Promise<Map<string, string>> {
    return withLock(this.dir, async () => {
      const { stdout } = await this.git(['ls-tree', '-z', commit, '--', ...roots.map((r) => `${r}/`)])
      const trees = new Map<string, string>()
      for (const entry of parseEntries(stdout)) if (entry.type === 'tree') trees.set(entry.path, entry.sha)
      return trees
    })
  }

  /**
   * Commits on top of `parent` (null: a first commit): each directory in `directories` replaced by its files (null
   * removes it), and each single file in `files` written. Returns null when the tree comes out the same.
   */
  commit(opts: CommitOptions): Promise<string | null> {
    return withLock(this.dir, () => this.commitLocked(opts))
  }

  private async commitLocked(opts: CommitOptions): Promise<string | null> {
    const index = join(this.dir, `ow-index-${randomUUID()}`)
    const env = { GIT_INDEX_FILE: index }
    const start = opts.tree ?? opts.parent
    const merge = (opts.mergeParents ?? []).length > 0
    try {
      await this.git(start ? ['read-tree', start] : ['read-tree', '--empty'], { env })
      const lines: string[] = []
      for (const [dir, files] of Object.entries(opts.directories ?? {})) {
        checkPath(dir)
        if (start) {
          for (const entry of await this.entries(start, [dir])) {
            lines.push(`0 ${EMPTY_SHA}\t${entry.path}`)
          }
        }
        for (const [path, content] of Object.entries(files ?? {})) {
          lines.push(`100644 ${await this.blob(content)}\t${checkPath(`${dir}/${path}`)}`)
        }
      }
      for (const [path, content] of Object.entries(opts.files ?? {})) {
        lines.push(`100644 ${await this.blob(content)}\t${checkPath(path)}`)
      }
      if (lines.length > 0)
        await this.git(['update-index', '--index-info'], { env, input: `${lines.join('\n')}\n` })
      const tree = (await this.git(['write-tree'], { env })).stdout.trim()
      // A merge commit is made even with its first parent's tree: it records the other parents.
      if (opts.parent && !merge) {
        const parentTree = (await this.git(['rev-parse', `${opts.parent}^{tree}`])).stdout.trim()
        if (parentTree === tree) return null
      }
      const parents = [...(opts.parent ? [opts.parent] : []), ...(opts.mergeParents ?? [])]
      const when = `${Math.floor((opts.date ?? new Date()).getTime() / 1000)} +0000`
      const { stdout } = await this.git(
        ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'],
        {
          input: opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`,
          env: {
            GIT_AUTHOR_NAME: opts.author.name,
            GIT_AUTHOR_EMAIL: opts.author.email,
            GIT_AUTHOR_DATE: when,
            GIT_COMMITTER_NAME: opts.author.name,
            GIT_COMMITTER_EMAIL: opts.author.email,
            GIT_COMMITTER_DATE: when,
          },
        },
      )
      return stdout.trim()
    } finally {
      await rm(index, { force: true })
    }
  }

  /**
   * Pushes a commit to a branch, fast-forward only. `rejected`: the branch moved on the remote since the commit's
   * parent was fetched (fetch and try again); a refusal by the server (branch protection) throws `refused`.
   */
  push(commit: string, branch: string): Promise<'ok' | 'rejected'> {
    const name = branchNameSchema.parse(branch)
    if (!SHA.test(commit)) throw new GitError('failed', 'Expected a commit sha')
    return withLock(this.dir, async () => {
      const result = await this.network(
        ['push', '--porcelain', '--quiet', this.remote.url, `${commit}:refs/heads/${name}`],
        { okCodes: [1] },
      )
      const refLine = result.stdout.split('\n').find((line) => line.includes(`refs/heads/${name}`))
      if (refLine?.startsWith('!')) {
        if (/\[remote rejected\]/.test(refLine)) {
          const reason = /\[remote rejected\]\s*(?:\((.*)\))?/.exec(refLine)?.[1] ?? 'refused by the server'
          throw new GitError('refused', `The push to ${name} was refused: ${reason}`)
        }
        return 'rejected'
      }
      if (result.code !== 0) {
        throw new GitError('failed', `git push failed: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      await this.git(['update-ref', `refs/remotes/origin/${name}`, commit])
      return 'ok'
    })
  }

  /** A fetched commit's subject line, body and author. */
  commitInfo(
    commit: string,
  ): Promise<{ subject: string; body: string; authorName: string; authorEmail: string }> {
    return withLock(this.dir, async () => {
      const { stdout } = await this.git(['show', '-s', '--format=%s%x00%an%x00%ae%x00%b', commit])
      const [subject = '', authorName = '', authorEmail = '', body = ''] = stdout.split('\0')
      return { subject, body: body.trim(), authorName, authorEmail }
    })
  }

  /** The best common ancestor of two fetched commits, or null when they share no history. */
  mergeBase(a: string, b: string): Promise<string | null> {
    if (!SHA.test(a) || !SHA.test(b)) throw new GitError('failed', 'Expected commit shas')
    return withLock(this.dir, async () => {
      const { stdout, code } = await this.git(['merge-base', a, b], { okCodes: [1] })
      return code === 0 ? stdout.trim() : null
    })
  }

  /** Whether `ancestor` is `commit` or in its history (both fetched). */
  isAncestor(ancestor: string, commit: string): Promise<boolean> {
    if (!SHA.test(ancestor) || !SHA.test(commit)) throw new GitError('failed', 'Expected commit shas')
    return withLock(this.dir, async () => {
      const { code } = await this.git(['merge-base', '--is-ancestor', ancestor, commit], { okCodes: [1] })
      return code === 0
    })
  }

  /**
   * Merges two fetched commits as git would, in the bare cache (no working tree): the merged tree, and the paths git
   * couldn't merge (their files in the tree hold conflict markers). Nothing is committed.
   */
  mergeTree(ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
    if (!SHA.test(ours) || !SHA.test(theirs)) throw new GitError('failed', 'Expected commit shas')
    return withLock(this.dir, async () => {
      const { stdout } = await this.git(
        ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, theirs],
        { okCodes: [1] },
      )
      const [tree = '', ...paths] = stdout.split('\0')
      if (!SHA.test(tree)) throw new GitError('failed', 'Unexpected merge-tree output')
      return { tree, conflicts: [...new Set(paths.filter(Boolean))] }
    })
  }

  /** The tree or blob at `path` in a commit, or null when there's nothing there. */
  entryAt(commit: string, path: string): Promise<string | null> {
    return withLock(this.dir, async () => {
      const { stdout } = await this.git(['ls-tree', '-z', commit, '--', checkPath(path)])
      return parseEntries(stdout).find((e) => e.path === path)?.sha ?? null
    })
  }

  /**
   * Makes sure the cache has a commit: fetched with a branch, or else by its sha (GitHub serves commits still on a
   * branch). False when the remote doesn't have it either.
   */
  ensureCommit(commit: string): Promise<boolean> {
    if (!SHA.test(commit)) throw new GitError('failed', 'Expected a commit sha')
    return withLock(this.dir, async () => {
      const has = () =>
        this.git(['cat-file', '-e', `${commit}^{commit}`]).then(
          () => true,
          () => false,
        )
      if (await has()) return true
      await this.network(['fetch', '--no-tags', '--quiet', this.remote.url, commit]).catch(() => {})
      return has()
    })
  }

  private async entries(commit: string, paths: readonly string[]): Promise<TreeEntry[]> {
    const { stdout } = await this.git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths])
    return parseEntries(stdout)
  }

  private async blob(content: string): Promise<string> {
    return (await this.git(['hash-object', '-w', '--stdin'], { input: content })).stdout.trim()
  }
}

function parseEntries(stdout: string): TreeEntry[] {
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t')
      const [mode = '', type = '', sha = ''] = record.slice(0, tab).split(' ')
      return { mode, type, sha, path: record.slice(tab + 1) }
    })
}

/** Paths we write: relative, `/`-separated, no `.`/`..` parts, nothing git's index format can't hold. */
function checkPath(path: string): string {
  const parts = path.split('/')
  if (
    !path ||
    path.startsWith('/') ||
    /[\0\n\t\r\\]/.test(path) ||
    parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')
  ) {
    throw new GitError('failed', `Can't write the path ${JSON.stringify(path)}`)
  }
  return path
}
