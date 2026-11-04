import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitError } from '../src/services/git/cli'
import { commitToBranch, GitConflictError } from '../src/services/git/commit'
import { branchNameSchema, checkRepoUrl, GitRepo } from '../src/services/git/repo'
import { bareRepo, gitHttpServer, protectBranch, scratch } from './git-helpers'

const author = { name: 'Fabio', email: 'fabio@optiply.nl' }
const insecure = { allowInsecure: true }

let root: string
let cleanup: () => Promise<void>
let n = 0

beforeAll(async () => {
  ;({ dir: root, cleanup } = await scratch())
})
afterAll(() => cleanup?.())

/** A fresh remote, and a repo for it through its own cache (one per "process"). */
async function setup() {
  const remote = bareRepo(join(root, `remote-${++n}.git`))
  const url = `file://${remote}`
  const open = (cache: string) =>
    GitRepo.open(join(root, `cache-${n}-${cache}`), { url, token: null }, insecure)
  return { remote, url, open, repo: await open('a') }
}

/** Puts a first commit on main. */
async function seed(repo: GitRepo) {
  const commit = await repo.commit({
    parent: null,
    files: { 'ow.json': '{\n  "format": 1\n}\n', 'README.md': '# Flows\n' },
    directories: { 'workflows/sync': { 'workflow.json': '{}\n', 'blocks/a.js': 'return 1\n' } },
    message: 'First',
    author,
  })
  expect(await repo.push(commit!, 'main')).toBe('ok')
  return commit!
}

describe('GitRepo on a local remote', () => {
  it('starts on an empty repo, commits, pushes and reads back', async () => {
    const { repo, open } = await setup()
    expect(await repo.listBranches()).toEqual(new Map())
    expect(await repo.fetchBranch('main')).toBeNull()
    const first = await seed(repo)

    const other = await open('b')
    expect(await other.fetchBranch('main')).toBe(first)
    expect(await other.listBranches()).toEqual(new Map([['main', first]]))
    expect(await other.readFiles(first)).toEqual({
      'README.md': '# Flows\n',
      'ow.json': '{\n  "format": 1\n}\n',
      'workflows/sync/blocks/a.js': 'return 1\n',
      'workflows/sync/workflow.json': '{}\n',
    })
    expect(await other.readFiles(first, ['workflows/'])).toEqual({
      'workflows/sync/blocks/a.js': 'return 1\n',
      'workflows/sync/workflow.json': '{}\n',
    })
    const trees = await other.subtrees(first, ['workflows', 'apps'])
    expect([...trees.keys()]).toEqual(['workflows/sync'])
    expect(trees.get('workflows/sync')).toBe(await other.entryAt(first, 'workflows/sync'))
  })

  it('replaces a directory whole, and makes no commit when nothing changes', async () => {
    const { repo } = await setup()
    const first = await seed(repo)
    const second = await repo.commit({
      parent: first,
      directories: {
        'workflows/sync': { 'workflow.json': '{"x":1}\n' },
        'apps/admin': { 'app.json': '{}\n' },
      },
      message: 'Change',
      author,
    })
    expect(await repo.readFiles(second!, ['workflows/', 'apps/'])).toEqual({
      'apps/admin/app.json': '{}\n',
      'workflows/sync/workflow.json': '{"x":1}\n',
    })
    expect(
      await repo.commit({
        parent: second,
        directories: { 'apps/admin': { 'app.json': '{}\n' } },
        message: 'Same',
        author,
      }),
    ).toBeNull()
    const removed = await repo.commit({
      parent: second,
      directories: { 'apps/admin': null },
      message: 'Remove',
      author,
    })
    expect(Object.keys(await repo.readFiles(removed!))).not.toContain('apps/admin/app.json')
  })

  it('keeps text byte for byte: unicode, CRLF, no trailing newline', async () => {
    const { repo } = await setup()
    const content = "select 'é漢🙂'\r\n-- end"
    const commit = await repo.commit({
      parent: null,
      files: { 'x.sql': content, 'y.txt': '' },
      message: 'm',
      author,
    })
    expect(await repo.readFiles(commit!)).toEqual({ 'x.sql': content, 'y.txt': '' })
  })

  it('records the author and message', async () => {
    const { repo } = await setup()
    const commit = await repo.commit({
      parent: null,
      files: { a: 'a' },
      message: 'Update sync-orders\n\nFrom Optiply Workflows',
      author,
      date: new Date('2026-10-16T12:00:00Z'),
    })
    // The same inputs give the same commit: nothing else (no local config, no clock) goes into it.
    const again = await repo.commit({
      parent: null,
      files: { a: 'a' },
      message: 'Update sync-orders\n\nFrom Optiply Workflows',
      author,
      date: new Date('2026-10-16T12:00:00Z'),
    })
    expect(again).toBe(commit)
  })

  it('refuses paths outside the repo', async () => {
    const { repo } = await setup()
    for (const path of ['../x', '/etc/x', 'a/./b', 'a//b', '.git/config', 'a\nb']) {
      await expect(
        repo.commit({ parent: null, files: { [path]: 'x' }, message: 'm', author }),
      ).rejects.toThrow(GitError)
    }
  })

  it('reports a push behind the remote as rejected', async () => {
    const { repo, open } = await setup()
    const first = await seed(repo)
    const other = await open('b')
    await other.fetchBranch('main')
    const theirs = await other.commit({ parent: first, files: { 'b.txt': 'b' }, message: 'b', author })
    expect(await other.push(theirs!, 'main')).toBe('ok')
    const ours = await repo.commit({ parent: first, files: { 'c.txt': 'c' }, message: 'c', author })
    expect(await repo.push(ours!, 'main')).toBe('rejected')
  })
})

describe('commitToBranch', () => {
  const change = (content: string) => ({ 'workflows/sync': { 'workflow.json': content } })

  it('makes a new branch from main', async () => {
    const { repo } = await setup()
    const main = await seed(repo)
    const result = await commitToBranch(repo, {
      branch: 'feature/x',
      base: main,
      createFrom: main,
      directories: change('{"v":1}\n'),
      message: 'v1',
      author,
    })
    expect(result.changed).toBe(true)
    expect(await repo.fetchBranch('feature/x')).toBe(result.commit)
    expect(await repo.fetchBranch('main')).toBe(main)
  })

  it('goes on top when the branch moved elsewhere, and refuses when the same files changed', async () => {
    const { repo, open } = await setup()
    const main = await seed(repo)
    const other = await open('b')
    await other.fetchBranch('main')
    // Someone else changes another directory on main.
    const theirs = await commitToBranch(other, {
      branch: 'main',
      base: main,
      directories: { 'apps/admin': { 'app.json': '{}\n' } },
      message: 'admin',
      author,
    })
    // Our change started from the old main: it lands on top of theirs.
    const ours = await commitToBranch(repo, {
      branch: 'main',
      base: main,
      directories: change('{"v":2}\n'),
      message: 'v2',
      author,
    })
    const files = await repo.readFiles(ours.commit)
    expect(files['apps/admin/app.json']).toBe('{}\n')
    expect(files['workflows/sync/workflow.json']).toBe('{"v":2}\n')
    expect(theirs.commit).not.toBe(ours.commit)

    // They change our directory, from what they had; we commit again from our old base: a conflict.
    await other.fetchBranch('main')
    await commitToBranch(other, {
      branch: 'main',
      base: ours.commit,
      directories: change('{"v":"theirs"}\n'),
      message: 'theirs',
      author,
    })
    const conflict = commitToBranch(repo, {
      branch: 'main',
      base: ours.commit,
      directories: change('{"v":3}\n'),
      message: 'v3',
      author,
    })
    await expect(conflict).rejects.toThrow(GitConflictError)
    await expect(conflict).rejects.toMatchObject({ paths: ['workflows/sync'] })
  })

  it('creates the branch even when there is nothing to change', async () => {
    const { repo } = await setup()
    const main = await seed(repo)
    const result = await commitToBranch(repo, {
      branch: 'empty',
      base: main,
      createFrom: main,
      message: 'm',
      author,
    })
    expect(result).toEqual({ commit: main, changed: false })
    expect(await repo.fetchBranch('empty')).toBe(main)
  })

  it('refuses a missing branch without a place to start it', async () => {
    const { repo } = await setup()
    await expect(
      commitToBranch(repo, { branch: 'nope', base: null, message: 'm', author }),
    ).rejects.toMatchObject({
      kind: 'not_found',
    })
  })
})

describe('merging (M20)', () => {
  /** A commit's parents, read from the remote. */
  const parents = (remote: string, commit: string) =>
    execFileSync('git', ['-C', remote, 'rev-list', '--parents', '-n', '1', commit], { encoding: 'utf8' })
      .trim()
      .split(' ')
      .slice(1)

  /** main and feature, each one commit after `first`, changing what's given. */
  async function diverged(main: Record<string, string>, feature: Record<string, string>) {
    const { repo, remote } = await setup()
    const first = await seed(repo)
    const m = await repo.commit({ parent: first, files: main, message: 'Main', author })
    expect(await repo.push(m!, 'main')).toBe('ok')
    const f = await repo.commit({ parent: first, files: feature, message: 'Feature', author })
    expect(await repo.push(f!, 'feature')).toBe('ok')
    return { repo, remote, first, main: m!, feature: f! }
  }

  it('finds the merge base, and what is an ancestor', async () => {
    const { repo, first, main, feature } = await diverged({ 'README.md': 'main\n' }, { 'a.txt': 'a\n' })
    expect(await repo.mergeBase(feature, main)).toBe(first)
    expect(await repo.isAncestor(first, feature)).toBe(true)
    expect(await repo.isAncestor(feature, main)).toBe(false)
    expect(await repo.isAncestor(main, main)).toBe(true)
  })

  it('merges a clean tree into a commit with two parents, which merges back into main cleanly', async () => {
    const { repo, remote, main, feature } = await diverged(
      { 'README.md': '# Flows, on main\n' },
      { 'workflows/sync/blocks/a.js': 'return 2\n' },
    )
    const merged = await repo.mergeTree(feature, main)
    expect(merged.conflicts).toEqual([])
    const commit = await repo.commit({
      parent: feature,
      mergeParents: [main],
      tree: merged.tree,
      message: 'Update from main',
      author,
    })
    expect(await repo.push(commit!, 'feature')).toBe('ok')
    expect(parents(remote, commit!)).toEqual([feature, main])
    const files = await repo.readFiles(commit!)
    expect(files['README.md']).toBe('# Flows, on main\n')
    expect(files['workflows/sync/blocks/a.js']).toBe('return 2\n')
    // Into main now: main is an ancestor, nothing conflicts.
    expect(await repo.isAncestor(main, commit!)).toBe(true)
    expect((await repo.mergeTree(main, commit!)).conflicts).toEqual([])
  })

  it('lists conflicting paths, and writes directories and files over the merged tree', async () => {
    const { repo, main, feature } = await diverged(
      { 'workflows/sync/blocks/a.js': 'return "main"\n', 'README.md': 'main\n' },
      { 'workflows/sync/blocks/a.js': 'return "feature"\n', 'README.md': 'feature\n' },
    )
    const merged = await repo.mergeTree(feature, main)
    expect(merged.conflicts.sort()).toEqual(['README.md', 'workflows/sync/blocks/a.js'])
    const commit = await repo.commit({
      parent: feature,
      mergeParents: [main],
      tree: merged.tree,
      directories: { 'workflows/sync': { 'workflow.json': '{}\n', 'blocks/a.js': 'return "both"\n' } },
      files: { 'README.md': 'both\n' },
      message: 'Update from main',
      author,
    })
    const files = await repo.readFiles(commit!)
    expect(files['workflows/sync/blocks/a.js']).toBe('return "both"\n')
    expect(files['README.md']).toBe('both\n')
    expect(Object.values(files).some((f) => f.includes('<<<<<<<'))).toBe(false)
    expect((await repo.mergeTree(main, commit!)).conflicts).toEqual([])
  })

  it('makes a merge commit even when its tree is its first parent’s', async () => {
    const { repo, remote, first } = await diverged({ 'README.md': 'main\n' }, { 'a.txt': 'a\n' })
    const main = await repo.fetchBranch('main')
    const same = await repo.commit({ parent: first, mergeParents: [main!], message: 'Merge', author })
    expect(same).not.toBeNull()
    expect(await repo.push(same!, 'other')).toBe('ok')
    expect(parents(remote, same!)).toEqual([first, main])
    // Without another parent, an unchanged tree is still no commit.
    expect(await repo.commit({ parent: first, message: 'Nothing', author })).toBeNull()
  })
})

describe('over HTTP with a token', () => {
  const TOKEN = 'ghp_secretToken123'
  let http: Awaited<ReturnType<typeof gitHttpServer>>
  let remotePath: string

  beforeAll(async () => {
    remotePath = bareRepo(join(root, 'served', 'flows.git'))
    http = await gitHttpServer(join(root, 'served'), TOKEN)
  })
  afterAll(() => http?.close())

  const open = (token: string | null, cache: string) =>
    GitRepo.open(join(root, `http-cache-${cache}`), { url: `${http.url}/flows.git`, token }, insecure)

  it('signs in with the token through askpass, and pushes', async () => {
    const repo = await open(TOKEN, 'ok')
    const commit = await repo.commit({ parent: null, files: { 'ow.json': '{}\n' }, message: 'm', author })
    expect(await repo.push(commit!, 'main')).toBe('ok')
    expect(await repo.listBranches()).toEqual(new Map([['main', commit]]))
    expect(http.requests.authorized).toBeGreaterThan(0)
  })

  it('reports a wrong or missing token as an auth error, without the token', async () => {
    const wrong = await open('ghp_wrongToken456', 'wrong')
    const error = await wrong.listBranches().catch((e) => e)
    expect(error).toBeInstanceOf(GitError)
    expect(error.kind).toBe('auth')
    expect(error.message).not.toContain('ghp_wrongToken456')
    const none = await open(null, 'none')
    await expect(none.listBranches()).rejects.toMatchObject({ kind: 'auth' })
  })

  it('reports a push the server refuses (branch protection)', async () => {
    await protectBranch(remotePath, 'main')
    const repo = await open(TOKEN, 'refused')
    const tip = await repo.fetchBranch('main')
    const commit = await repo.commit({ parent: tip, files: { 'x.txt': 'x' }, message: 'm', author })
    await expect(repo.push(commit!, 'main')).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('main'),
    })
    // Other branches still take pushes.
    expect(await repo.push(commit!, 'feature')).toBe('ok')
  })

  it('signs in with credentials asked per command: the host’s username, a fresh token (M31)', async () => {
    const gitlab = await gitHttpServer(join(root, 'served'), TOKEN, '127.0.0.1', 'oauth2')
    try {
      let asked = 0
      const repo = await GitRepo.open(
        join(root, 'http-cache-credentials'),
        {
          url: `${gitlab.url}/flows.git`,
          token: null,
          credentials: async () => {
            asked++
            return { username: 'oauth2', token: TOKEN }
          },
        },
        insecure,
      )
      await repo.listBranches()
      await repo.listBranches()
      expect(asked).toBe(2)
      expect(gitlab.requests.authorized).toBeGreaterThan(0)
      // GitHub's username isn't taken there.
      const github = await GitRepo.open(
        join(root, 'http-cache-credentials-gh'),
        { url: `${gitlab.url}/flows.git`, token: TOKEN },
        insecure,
      )
      await expect(github.listBranches()).rejects.toMatchObject({ kind: 'auth' })
    } finally {
      await gitlab.close()
    }
  })

  it('reports a repo that is not there', async () => {
    const repo = await GitRepo.open(
      join(root, 'http-cache-404'),
      { url: `${http.url}/nope.git`, token: TOKEN },
      insecure,
    )
    await expect(repo.listBranches()).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('checkRepoUrl and branch names', () => {
  it('takes https URLs of repos, without credentials', () => {
    expect(checkRepoUrl(' https://github.com/optiply/flows.git ', { allowInsecure: false })).toBe(
      'https://github.com/optiply/flows.git',
    )
    for (const bad of [
      'http://github.com/optiply/flows.git',
      'file:///tmp/x.git',
      'ssh://git@github.com/optiply/flows.git',
      'git@github.com:optiply/flows.git',
      'https://user:pw@github.com/optiply/flows.git',
      'https://github.com/optiply/flows.git?x=1',
      'https://github.com/',
      'https://github.com',
      'not a url',
    ]) {
      expect(() => checkRepoUrl(bad, { allowInsecure: false }), bad).toThrow(GitError)
    }
    expect(checkRepoUrl('file:///tmp/x.git', insecure)).toBe('file:///tmp/x.git')
  })

  it('takes branch names git and GitHub take', () => {
    for (const ok of ['main', 'feature/orders', 'fabio/fix-1.2', 'release_2026']) {
      expect(branchNameSchema.safeParse(ok).success, ok).toBe(true)
    }
    for (const bad of [
      '',
      '-x',
      '.x',
      'a..b',
      'a//b',
      'a/',
      'a.lock',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a@{1}',
      '/a',
      'a/.b',
    ]) {
      expect(branchNameSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})
