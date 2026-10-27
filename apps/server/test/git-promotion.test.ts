import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { auditEvents } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { encodeObjectDir, manifestFile, type RepoObject } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitRepo } from '../src/services/git/repo'
import { fakeGitHub } from './fake-github'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const TOKEN = 'ghp_promotion_tests'
const author = { name: 'Reviewer', email: 'reviewer@optiply.nl' }

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let github: Awaited<ReturnType<typeof fakeGitHub>>
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let seeder: GitRepo

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { body: { result?: { data: unknown }; error?: unknown } }): any => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data
}
const code = (res: { body: { error?: { data?: { code: string } } } }) => res.body.error?.data?.code

const workflow = (slug: string): RepoObject => ({
  kind: 'workflow',
  slug,
  value: {
    name: slug,
    description: null,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
      edges: [],
    } as WorkflowDefinition,
  },
})

/** Commits workflows onto a branch (from `from`, or the branch's own tip). */
async function commitOn(branch: string, objects: RepoObject[], from?: string | null) {
  const parent = from === undefined ? await seeder.fetchBranch(branch) : from
  const directories = Object.fromEntries(
    objects.map((o) => {
      const { dir: path, files } = encodeObjectDir(o)
      return [path, files]
    }),
  )
  const commit = await seeder.commit({
    parent,
    directories,
    files: parent ? {} : { 'ow.json': manifestFile() },
    message: `On ${branch}`,
    author,
  })
  expect(await seeder.push(commit!, branch)).toBe('ok')
  return commit!
}

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  mkdirSync(join(dir, 'optiply'))
  const remote = bareRepo(join(dir, 'optiply', 'flows.git'))
  github = await fakeGitHub({ repoPath: remote, owner: 'optiply', repo: 'flows', token: TOKEN })
  env = await startTestApp({
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(dir, 'cache'),
    GITHUB_API_URL: github.url,
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  // This instance deploys `staging`; production is another instance's deploy branch.
  data(
    await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, branch: 'staging', token: TOKEN }),
  )
  seeder = await GitRepo.open(
    join(dir, 'seeder'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
  const start = await commitOn('production', [workflow('shared')], null)
  expect(await seeder.push(start, 'staging')).toBe('ok')
})
afterAll(async () => {
  await env?.stop()
  await github?.close()
  await cleanup?.()
})

describe('Promote (M22)', () => {
  it('says so when the target already has everything', async () => {
    expect(data(await admin.mutate('git.openPromotion', { target: 'production' }))).toEqual({
      status: 'up_to_date',
    })
  })

  it('opens a pull request from the deploy branch into the target, listing what it brings', async () => {
    await commitOn('staging', [
      workflow('new-flow'),
      {
        ...workflow('shared'),
        value: { ...workflow('shared').value, name: 'Shared, renamed' },
      } as RepoObject,
    ])
    const result = data(await admin.mutate('git.openPromotion', { target: 'production' }))
    expect(result).toMatchObject({
      status: 'opened',
      directories: ['workflows/new-flow', 'workflows/shared'],
      pullRequestError: null,
      pullRequest: { number: 1, state: 'open', head: 'staging', base: 'production' },
    })
    expect(github.pulls[0]).toMatchObject({ title: 'Promote staging into production' })
    expect(github.pulls[0]!.body).toContain('- `workflows/new-flow`')
    expect(github.pulls[0]!.body).toContain(env.config.PUBLIC_URL)
    const [audit] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'git.promotion_opened'))
    expect(audit?.metadata).toMatchObject({ target: 'production', number: 1 })

    // Again: the one already open.
    const again = data(await admin.mutate('git.openPromotion', { target: 'production', title: 'Other' }))
    expect(again.pullRequest).toMatchObject({ number: 1, created: false })
    expect(github.pulls).toHaveLength(1)

    // Merged: production has it all.
    await github.merge(1)
    expect(data(await admin.mutate('git.openPromotion', { target: 'production' }))).toEqual({
      status: 'up_to_date',
    })
  })

  it('refuses its own deploy branch, a missing branch, and people who are not admins', async () => {
    expect(code(await admin.mutate('git.openPromotion', { target: 'staging' }))).toBe('BAD_REQUEST')
    expect(code(await admin.mutate('git.openPromotion', { target: 'nowhere' }))).toBe('NOT_FOUND')
    expect(code(await member.mutate('git.openPromotion', { target: 'production' }))).toBe('FORBIDDEN')
  })
})
