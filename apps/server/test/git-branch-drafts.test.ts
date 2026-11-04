import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  auditEvents,
  gitBranchDrafts,
  users,
  workflowDraftSnapshots,
  workflowReleases,
  workflowRuns,
  workflows,
} from '@ow/db'
import { deleteOldRuns } from '@ow/engine'
import { encodeObjectDir } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  commitBranchDraft,
  loadBranchDraft,
  updateBranchDraftFromBranch,
} from '../src/services/git/branch-drafts'
import { runGitDeploy } from '../src/services/git/deploy'
import { repoObject } from '../src/services/git/protection'
import { GitRepo } from '../src/services/git/repo'
import { fakeGitHub } from './fake-github'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const TOKEN = 'ghp_branch_draft_tests'

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let github: Awaited<ReturnType<typeof fakeGitHub>>
let admin: ReturnType<typeof trpc>
let adminCookie: string
let member: ReturnType<typeof trpc>
let remote: string
let other: GitRepo
let flowId: string

// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
const data = (res: { body: { result?: { data: unknown }; error?: unknown } }): any => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data
}
const failure = (res: { body: { error?: { message: string; data?: { code: string } } } }) => ({
  code: res.body.error?.data?.code,
  message: res.body.error?.message,
})

const flowDefinition = (code: string, block = 'step') => ({
  schemaVersion: 1,
  blocks: [
    { name: 'startTrigger', type: 'startTrigger' },
    { name: block, type: 'code', config: { code } },
  ],
  edges: [{ from: 'startTrigger', port: 'out', to: block }],
})

const deploy = () => runGitDeploy(env.db, env.config, { trigger: 'poll' })
const author = { name: 'Someone else', email: 'else@optiply.nl' }
const adminUser = async () =>
  (await env.db.select().from(users).where(eq(users.email, 'admin@optiply.nl')))[0]!
const stepCode = (draft: { definition: { blocks: { name: string; config?: { code?: string } }[] } }) =>
  draft.definition.blocks.find((b) => b.name === 'step')!.config!.code

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  mkdirSync(join(dir, 'optiply'))
  remote = bareRepo(join(dir, 'optiply', 'flows.git'))
  github = await fakeGitHub({ repoPath: remote, owner: 'optiply', repo: 'flows', token: TOKEN })
  env = await startTestApp({
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(dir, 'cache'),
    GITHUB_API_URL: github.url,
  })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: TOKEN }))
  other = await GitRepo.open(
    join(dir, 'other'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )

  // A published workflow, protected and merged: main has it, and it's live.
  flowId = data(await admin.mutate('workflows.create', { slug: 'sync-orders', name: 'Sync orders' })).id
  data(
    await admin.mutate('workflows.saveDraft', {
      id: flowId,
      revision: 1,
      definition: flowDefinition('return 1'),
    }),
  )
  data(await admin.mutate('releases.publish', { workflowId: flowId, draftRevision: 2 }))
  data(await admin.mutate('git.protect', { kind: 'workflow', id: flowId }))
  github.merge(1)
  expect(await deploy()).toMatchObject({ status: 'deployed', ok: true })
})
afterAll(async () => {
  await env?.stop()
  await github?.close()
  await cleanup?.()
})

describe('a branch draft, from opening to deploying', () => {
  let draftId: string

  it('opens on a new branch from main, once', async () => {
    const main = await other.fetchBranch('main')
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: flowId,
        branch: 'fabio/faster',
        create: true,
      }),
    )
    expect(draft).toMatchObject({
      kind: 'workflow',
      objectId: flowId,
      branch: 'fabio/faster',
      name: 'Sync orders',
      revision: 1,
      baseCommit: main,
      branchExists: false,
      committedCommit: null,
      diagnostics: [],
    })
    expect(draft.definition.blocks.find((b: { name: string }) => b.name === 'step').config.code).toBe(
      'return 1',
    )
    draftId = draft.id
    const again = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: flowId,
        branch: 'fabio/faster',
        create: true,
      }),
    )
    expect(again.id).toBe(draftId)
    expect(data(await admin.query('branchDrafts.list', { kind: 'workflow', id: flowId }))).toEqual([
      expect.objectContaining({ id: draftId, branch: 'fabio/faster', branchExists: false }),
    ])
  })

  it('refuses a missing branch without create, unprotected objects, and people without Edit', async () => {
    expect(
      failure(await admin.mutate('branchDrafts.open', { kind: 'workflow', id: flowId, branch: 'nope' })),
    ).toMatchObject({ code: 'NOT_FOUND', message: 'The repo has no branch nope' })
    // The deploy branch takes changes through pull requests only.
    expect(
      failure(
        await admin.mutate('branchDrafts.open', {
          kind: 'workflow',
          id: flowId,
          branch: 'main',
          create: true,
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('through pull requests') })
    const plain = data(await admin.mutate('workflows.create', { slug: 'plain', name: 'Plain' })).id
    expect(
      failure(
        await admin.mutate('branchDrafts.open', { kind: 'workflow', id: plain, branch: 'x', create: true }),
      ),
    ).toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(failure(await member.query('branchDrafts.get', { id: draftId })).code).toBe('NOT_FOUND')
    expect(
      failure(
        await member.mutate('branchDrafts.open', { kind: 'workflow', id: flowId, branch: 'x', create: true }),
      ).code,
    ).toBe('NOT_FOUND')
  })

  it('saves with optimistic concurrency, and shows what a commit would change', async () => {
    const saved = data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: 1,
        definition: flowDefinition('return 2'),
        name: 'Sync orders, faster',
      }),
    )
    expect(saved).toMatchObject({ revision: 2, diagnostics: [] })
    expect(
      failure(
        await admin.mutate('branchDrafts.save', {
          id: draftId,
          revision: 1,
          definition: flowDefinition('x'),
        }),
      ).code,
    ).toBe('CONFLICT')
    expect(
      failure(
        await admin.mutate('branchDrafts.save', { id: draftId, revision: 2, definition: { blocks: 1 } }),
      ).code,
    ).toBe('BAD_REQUEST')

    const changes = data(await admin.query('branchDrafts.changes', { id: draftId }))
    expect(changes).toMatchObject({ tip: null, behind: false, conflict: false })
    expect(changes.files).toEqual([
      {
        path: 'workflows/sync-orders/blocks/step.js',
        status: 'modified',
        before: 'return 1\n',
        after: 'return 2\n',
      },
      expect.objectContaining({ path: 'workflows/sync-orders/workflow.json', status: 'modified' }),
    ])
    expect(changes.files[1].after).toContain('"name": "Sync orders, faster"')
  })

  it('runs the branch draft from its own snapshot, apart from the main draft', async () => {
    const run = await env.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/sync-orders/runs',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { draftId },
    })
    expect(run.statusCode).toBe(202)
    const [row] = await env.db.select().from(workflowRuns).where(eq(workflowRuns.id, run.json().run.id))
    const [snapshot] = await env.db
      .select()
      .from(workflowDraftSnapshots)
      .where(eq(workflowDraftSnapshots.id, row!.draftSnapshotId!))
    expect(snapshot).toMatchObject({ branchDraftId: draftId, revision: 2 })
    expect(snapshot!.definition.blocks.find((b) => b.name === 'step')).toMatchObject({
      config: { code: 'return 2' },
    })

    // The main draft has revision 2 too: its own snapshot, not the branch's.
    const mainRun = await env.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/sync-orders/runs',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: {},
    })
    const [mainRow] = await env.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, mainRun.json().run.id))
    expect(mainRow!.draftSnapshotId).not.toBe(row!.draftSnapshotId)
    const block = await env.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/sync-orders/blocks/step/runs',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { draftId, input: {} },
    })
    expect(block.statusCode).toBe(202)
  })

  it('commits onto a new branch as the person, once per change', async () => {
    expect(
      failure(await admin.mutate('branchDrafts.commit', { id: draftId, revision: 1, message: 'm' })).code,
    ).toBe('CONFLICT')
    const result = data(
      await admin.mutate('branchDrafts.commit', {
        id: draftId,
        revision: 2,
        message: 'Make sync-orders faster',
      }),
    )
    expect(result).toMatchObject({ changed: true, draft: { branchExists: true, baseCommit: result.commit } })
    expect(result.draft.committedCommit).toBe(result.commit)
    const tip = await other.fetchBranch('fabio/faster')
    expect(tip).toBe(result.commit)
    expect((await other.readFiles(tip!, ['workflows/']))['workflows/sync-orders/blocks/step.js']).toBe(
      'return 2\n',
    )
    expect(await other.commitInfo(tip!)).toMatchObject({
      subject: 'Make sync-orders faster',
      authorEmail: 'admin@optiply.nl',
    })
    const again = data(
      await admin.mutate('branchDrafts.commit', { id: draftId, revision: 2, message: 'Again' }),
    )
    expect(again).toMatchObject({ changed: false, commit: result.commit })
    const [audit] = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'git.committed'))
    expect(audit!.metadata).toMatchObject({ branch: 'fabio/faster', commit: result.commit })
    expect(data(await admin.query('branchDrafts.changes', { id: draftId })).files).toEqual([])
  })

  it('goes live when its pull request merges', async () => {
    const pr = data(
      await admin.mutate('git.openPullRequest', { branch: 'fabio/faster', title: 'Faster sync' }),
    )
    github.merge(pr.pullRequest.number)
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error(JSON.stringify(result))
    expect(result.objects).toEqual([
      expect.objectContaining({ slug: 'sync-orders', outcome: 'released', version: '1.0.1' }),
    ])
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.id, flowId))
    expect(flow!.name).toBe('Sync orders, faster')
    const [live] = await env.db
      .select()
      .from(workflowReleases)
      .where(eq(workflowReleases.id, flow!.liveReleaseId!))
    expect(live!.definition.blocks.find((b) => b.name === 'step')).toMatchObject({
      config: { code: 'return 2' },
    })
  })
})

describe('when others commit to the same branch', () => {
  let draftId: string

  it('commits on top of changes to other objects', async () => {
    draftId = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: flowId,
        branch: 'shared',
        create: true,
      }),
    ).id
    // Someone adds a README on the branch first.
    const main = await other.fetchBranch('main')
    const readme = await other.commit({
      parent: main,
      files: { 'README.md': 'hi\n' },
      message: 'Readme',
      author,
    })
    await other.push(readme!, 'shared')
    data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: 1,
        definition: flowDefinition('return 3'),
      }),
    )
    const changes = data(await admin.query('branchDrafts.changes', { id: draftId }))
    expect(changes).toMatchObject({ tip: readme, behind: true, conflict: false })
    const result = data(
      await admin.mutate('branchDrafts.commit', { id: draftId, revision: 2, message: 'Three' }),
    )
    expect(await other.fetchBranch('shared')).toBe(result.commit)
    const files = await other.readFiles(result.commit)
    expect(files['README.md']).toBe('hi\n')
    expect(files['workflows/sync-orders/blocks/step.js']).toBe('return 3\n')
  })

  it('refuses a commit when they changed the same files, until updated from the branch', async () => {
    const tip = await other.fetchBranch('shared')
    const theirs = await other.commit({
      parent: tip,
      directories: {},
      files: { 'workflows/sync-orders/blocks/step.js': 'return "theirs"\n' },
      message: 'Theirs',
      author,
    })
    await other.push(theirs!, 'shared')
    data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: 2,
        definition: flowDefinition('return 4'),
      }),
    )
    expect(data(await admin.query('branchDrafts.changes', { id: draftId }))).toMatchObject({
      behind: true,
      conflict: true,
      merge: { conflicts: 1 },
    })
    const refused = failure(
      await admin.mutate('branchDrafts.commit', { id: draftId, revision: 3, message: 'Four' }),
    )
    expect(refused).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('workflows/sync-orders'),
    })

    // Both changed the same line: updating merges, and asks which one stays (nothing saved meanwhile).
    const merging = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draftId }))
    expect(merging).toMatchObject({
      status: 'conflicts',
      tip: theirs,
      conflicts: [
        {
          kind: 'text',
          at: ['definition', 'blocks', 'step', 'config', 'code'],
          ours: 'return 4',
          theirs: 'return "theirs"',
        },
      ],
    })
    expect(data(await admin.query('branchDrafts.get', { id: draftId })).revision).toBe(3)
    const { draft: updated } = data(
      await admin.mutate('branchDrafts.updateFromBranch', {
        id: draftId,
        resolutions: { [merging.conflicts[0].id]: 'theirs' },
      }),
    )
    expect(updated).toMatchObject({ baseCommit: theirs, revision: 4 })
    expect(updated.definition.blocks.find((b: { name: string }) => b.name === 'step').config.code).toBe(
      'return "theirs"',
    )
    data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: 4,
        definition: flowDefinition('return 5'),
      }),
    )
    expect(
      data(await admin.mutate('branchDrafts.commit', { id: draftId, revision: 5, message: 'Five' })),
    ).toMatchObject({
      changed: true,
    })
  })

  it('updates a draft without changes from the branch without asking', async () => {
    const tip = await other.fetchBranch('shared')
    const theirs = await other.commit({
      parent: tip,
      files: { 'workflows/sync-orders/blocks/step.js': 'return 6\n' },
      message: 'Six',
      author,
    })
    await other.push(theirs!, 'shared')
    const { status, draft: updated } = data(
      await admin.mutate('branchDrafts.updateFromBranch', { id: draftId }),
    )
    expect(status).toBe('updated')
    expect(updated.definition.blocks.find((b: { name: string }) => b.name === 'step').config.code).toBe(
      'return 6',
    )
  })

  it('discards the draft, leaving the branch', async () => {
    data(await admin.mutate('branchDrafts.discard', { id: draftId }))
    expect(failure(await admin.query('branchDrafts.get', { id: draftId })).code).toBe('NOT_FOUND')
    expect(await other.fetchBranch('shared')).not.toBeNull()
  })

  it("won't open a branch whose files are broken", async () => {
    const main = await other.fetchBranch('main')
    const broken = await other.commit({
      parent: main,
      files: { 'workflows/sync-orders/workflow.json': '{ nope' },
      message: 'Broken',
      author,
    })
    await other.push(broken!, 'broken')
    expect(
      failure(await admin.mutate('branchDrafts.open', { kind: 'workflow', id: flowId, branch: 'broken' })),
    ).toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining("isn't valid JSON") })
  })
})

describe('a new process, saves during a commit, and a rewritten branch', () => {
  let draftId: string
  const forgetCache = () => rmSync(join(dir, 'cache'), { recursive: true, force: true })

  it('shows changes and commits with an empty cache (a restart, another replica)', async () => {
    draftId = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: flowId,
        branch: 'fresh',
        create: true,
      }),
    ).id
    data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: 1,
        definition: flowDefinition('return 7'),
      }),
    )
    // The branch isn't made yet: its changes are against the base commit, which a new cache doesn't have.
    forgetCache()
    expect(data(await admin.query('branchDrafts.changes', { id: draftId })).files).toHaveLength(1)
    data(await admin.mutate('branchDrafts.commit', { id: draftId, revision: 2, message: 'Seven' }))
    // Now the base is a commit only on this branch.
    data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: 2,
        definition: flowDefinition('return 8'),
      }),
    )
    forgetCache()
    const second = data(
      await admin.mutate('branchDrafts.commit', { id: draftId, revision: 3, message: 'Eight' }),
    )
    expect(second).toMatchObject({ changed: true })
    expect(await other.fetchBranch('fresh')).toBe(second.commit)
  })

  it('moves the base to its commit even when someone saved during it', async () => {
    const { draft: before, target } = await loadBranchDraft(env.db, draftId)
    data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: before.revision,
        definition: flowDefinition('return 9'),
      }),
    )
    // The commit started from what the person saw (before the save), and pushes that.
    const committed = await commitBranchDraft(env.db, env.config, await adminUser(), {
      target,
      draft: { ...before, definition: flowDefinition('return "seen"') as never },
      revision: before.revision,
      message: 'What I saw',
    })
    expect(committed.draft).toMatchObject({ baseCommit: committed.commit, revision: before.revision + 1 })
    // The save made meanwhile is an uncommitted change on top of it, not a conflict with our own commit.
    const changes = data(await admin.query('branchDrafts.changes', { id: draftId }))
    expect(changes).toMatchObject({ behind: false, conflict: false })
    expect(changes.files[0]).toMatchObject({ before: 'return "seen"\n', after: 'return 9\n' })
  })

  it('refuses updating from the branch over a save it did not see', async () => {
    const { draft: before, target } = await loadBranchDraft(env.db, draftId)
    data(
      await admin.mutate('branchDrafts.save', {
        id: draftId,
        revision: before.revision,
        definition: flowDefinition('return 10'),
      }),
    )
    await expect(
      updateBranchDraftFromBranch(env.db, env.config, await adminUser(), {
        target,
        draft: before,
        discardChanges: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(stepCode(data(await admin.query('branchDrafts.get', { id: draftId })))).toBe('return 10')
  })

  it("asks before replacing a draft whose base commit is gone, and won't commit it", async () => {
    await env.db
      .update(gitBranchDrafts)
      .set({ baseCommit: 'f'.repeat(40) })
      .where(eq(gitBranchDrafts.id, draftId))
    forgetCache()
    expect(data(await admin.query('branchDrafts.changes', { id: draftId }))).toMatchObject({
      behind: true,
      conflict: true,
      merge: null,
    })
    expect(failure(await admin.mutate('branchDrafts.updateFromBranch', { id: draftId }))).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('no longer in the repo'),
    })
    const { draft } = await loadBranchDraft(env.db, draftId)
    expect(
      failure(
        await admin.mutate('branchDrafts.commit', { id: draftId, revision: draft.revision, message: 'x' }),
      ).code,
    ).toBe('CONFLICT')
    const { draft: updated } = data(
      await admin.mutate('branchDrafts.updateFromBranch', { id: draftId, discardChanges: true }),
    )
    expect(updated.baseCommit).toBe(await other.fetchBranch('fresh'))
    expect(stepCode(updated)).toBe('return "seen"')
  })
})

describe('merging the branch into a draft (M20)', () => {
  let draftId: string
  const code = (...lines: string[]) => lines.join('\n')
  const original = code('const a = 1', 'const b = 2', 'const c = 3', 'return a + b + c')
  const withBlocks = (step: string, extra: { name: string; code: string }[] = []) => ({
    ...flowDefinition(step),
    blocks: [
      ...flowDefinition(step).blocks,
      ...extra.map((b) => ({ name: b.name, type: 'code', config: { code: b.code } })),
    ],
  })
  // biome-ignore lint/suspicious/noExplicitAny: untyped JSON
  const block = (draft: any, name: string) =>
    draft.definition.blocks.find((b: { name: string }) => b.name === name)
  /** Someone else commits `step`'s code (and whatever else) onto the branch. */
  const theirCommit = async (step: string, files: Record<string, string> = {}) => {
    const tip = await other.fetchBranch('merging')
    const commit = await other.commit({
      parent: tip,
      files: { 'workflows/sync-orders/blocks/step.js': `${step}\n`, ...files },
      message: 'Theirs',
      author,
    })
    await other.push(commit!, 'merging')
    return commit!
  }
  const save = async (definition: unknown) => {
    const { revision } = data(await admin.query('branchDrafts.get', { id: draftId }))
    return data(await admin.mutate('branchDrafts.save', { id: draftId, revision, definition }))
  }

  it('keeps the draft’s changes and the branch’s, line by line and block by block', async () => {
    draftId = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: flowId,
        branch: 'merging',
        create: true,
      }),
    ).id
    await save(withBlocks(original))
    const { revision } = data(await admin.query('branchDrafts.get', { id: draftId }))
    data(await admin.mutate('branchDrafts.commit', { id: draftId, revision, message: 'Start' }))

    // Ours: the first line, and a new block. Theirs: the third line, and a README.
    await save(
      withBlocks(original.replace('const a = 1', 'const a = 10'), [{ name: 'ours', code: 'return "o"' }]),
    )
    const tip = await theirCommit(original.replace('const c = 3', 'const c = 30'), { 'README.md': 'hi\n' })
    const before = data(await admin.query('branchDrafts.get', { id: draftId }))
    expect(data(await admin.query('branchDrafts.changes', { id: draftId }))).toMatchObject({
      conflict: true,
      merge: { conflicts: 0 },
    })
    expect(
      failure(
        await admin.mutate('branchDrafts.commit', { id: draftId, revision: before.revision, message: 'x' }),
      ),
    ).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('merges their changes with yours') })

    const result = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draftId }))
    expect(result.status).toBe('updated')
    expect(result.draft).toMatchObject({ baseCommit: tip, revision: before.revision + 1 })
    expect(block(result.draft, 'step').config.code).toBe(
      code('const a = 10', 'const b = 2', 'const c = 30', 'return a + b + c'),
    )
    expect(block(result.draft, 'ours').config.code).toBe('return "o"')
    // Committing it writes both onto the branch.
    const committed = data(
      await admin.mutate('branchDrafts.commit', {
        id: draftId,
        revision: result.draft.revision,
        message: 'Both',
      }),
    )
    expect(committed.changed).toBe(true)
    expect(await other.fetchBranch('merging')).toBe(committed.commit)
    const files = await other.readFiles(committed.commit)
    expect(files['workflows/sync-orders/blocks/step.js']).toContain('const c = 30')
    expect(files['workflows/sync-orders/blocks/ours.js']).toBe('return "o"\n')
    expect(files['README.md']).toBe('hi\n')
  })

  it('applies resolutions on top of a save made while they were chosen', async () => {
    const current = block(data(await admin.query('branchDrafts.get', { id: draftId })), 'step').config
      .code as string
    await save(
      withBlocks(current.replace('const b = 2', 'const b = 20'), [{ name: 'ours', code: 'return "o"' }]),
    )
    const tip = await theirCommit(current.replace('const b = 2', 'const b = 200'))
    const first = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draftId }))
    expect(first.status).toBe('conflicts')
    expect(first.conflicts).toHaveLength(1)

    // Someone adds a block meanwhile, away from the conflict.
    await save(
      withBlocks(current.replace('const b = 2', 'const b = 20'), [
        { name: 'ours', code: 'return "o"' },
        { name: 'later', code: 'return "l"' },
      ]),
    )
    const second = data(
      await admin.mutate('branchDrafts.updateFromBranch', {
        id: draftId,
        resolutions: { [first.conflicts[0].id]: { chunks: ['both'] } },
      }),
    )
    expect(second.status).toBe('updated')
    expect(second.draft.baseCommit).toBe(tip)
    expect(block(second.draft, 'step').config.code).toContain('const b = 20\nconst b = 200')
    expect(block(second.draft, 'later').config.code).toBe('return "l"')
  })

  it('asks again when the conflicting lines changed after they were resolved', async () => {
    const current = block(data(await admin.query('branchDrafts.get', { id: draftId })), 'step').config
      .code as string
    const extra = [{ name: 'ours', code: 'return "o"' }]
    await save(withBlocks(`${current}\n// ours`, extra))
    await theirCommit(`${current}\n// theirs`)
    const first = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draftId }))
    await save(withBlocks(`${current}\n// ours, again`, extra))
    const second = data(
      await admin.mutate('branchDrafts.updateFromBranch', {
        id: draftId,
        resolutions: { [first.conflicts[0].id]: 'theirs' },
      }),
    )
    expect(second.status).toBe('conflicts')
    expect(second.conflicts[0].id).not.toBe(first.conflicts[0].id)
    expect(second.conflicts[0].ours).toContain('// ours, again')
    const third = data(
      await admin.mutate('branchDrafts.updateFromBranch', {
        id: draftId,
        resolutions: { [second.conflicts[0].id]: { text: `${current}\n// both` } },
      }),
    )
    expect(block(third.draft, 'step').config.code).toBe(`${current}\n// both`)
  })

  it('merges again from a save that raced it, instead of failing', async () => {
    const { draft: stale, target } = await loadBranchDraft(env.db, draftId)
    const current = block(stale, 'step').config.code as string
    await save(withBlocks(current, [{ name: 'ours', code: 'return "raced"' }]))
    await theirCommit(`// top\n${current}`)
    const result = await updateBranchDraftFromBranch(env.db, env.config, await adminUser(), {
      target,
      draft: stale,
      discardChanges: false,
    })
    expect(result.status).toBe('updated')
    if (result.status !== 'updated') return
    expect(block(result.draft, 'ours').config.code).toBe('return "raced"')
    expect(block(result.draft, 'step').config.code).toBe(`// top\n${current}`)
  })

  it('makes a block deleted on one side and changed on the other one conflict', async () => {
    const current = block(data(await admin.query('branchDrafts.get', { id: draftId })), 'step').config
      .code as string
    // Ours deletes the `ours` block; theirs changes it.
    await save(withBlocks(current))
    await theirCommit(current, { 'workflows/sync-orders/blocks/ours.js': 'return "changed"\n' })
    const result = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draftId }))
    expect(result).toMatchObject({
      status: 'conflicts',
      // Deleted: `undefined`, which superjson's raw JSON (read here) shows as null.
      conflicts: [{ kind: 'item', at: ['definition', 'blocks', 'ours'], ours: null }],
    })
    data(await admin.mutate('branchDrafts.discard', { id: draftId }))
  })
})

describe('Update from main (M20)', () => {
  const lines = (...l: string[]) => l.join('\n')
  const STEP = 'workflows/sync-orders/blocks/step.js'
  // biome-ignore lint/suspicious/noExplicitAny: untyped JSON
  const step = (draft: any) =>
    draft.definition.blocks.find((b: { name: string }) => b.name === 'step').config.code
  /** Someone commits straight onto main (as a merged pull request would). */
  const onMain = async (files: Record<string, string>) => {
    const tip = await other.fetchBranch('main')
    const commit = await other.commit({ parent: tip, files, message: 'On main', author })
    expect(await other.push(commit!, 'main')).toBe('ok')
    return commit!
  }
  const openDraft = async (branch: string) =>
    data(await admin.mutate('branchDrafts.open', { kind: 'workflow', id: flowId, branch, create: true }))
      .id as string
  const saveAndCommit = async (id: string, code: string, message: string, block?: string) => {
    const { revision } = data(await admin.query('branchDrafts.get', { id }))
    data(await admin.mutate('branchDrafts.save', { id, revision, definition: flowDefinition(code, block) }))
    return data(await admin.mutate('branchDrafts.commit', { id, revision: revision + 1, message }))
      .commit as string
  }
  const parents = (commit: string) =>
    execFileSync('git', ['-C', remote, 'rev-list', '--parents', '-n', '1', commit], { encoding: 'utf8' })
      .trim()
      .split(' ')
      .slice(1)
  const start = lines('const a = 1', 'const b = 2', 'const c = 3', 'return a + b + c')

  it('merges main into the branch as a two-parent commit, keeping the draft’s uncommitted changes', async () => {
    await onMain({ [STEP]: `${start}\n` })
    const id = await openDraft('from-main')
    const tip = await saveAndCommit(id, start.replace('const a = 1', 'const a = 10'), 'Ten')
    // Uncommitted: a comment at the end.
    const { revision } = data(await admin.query('branchDrafts.get', { id }))
    data(
      await admin.mutate('branchDrafts.save', {
        id,
        revision,
        definition: flowDefinition(`${start.replace('const a = 1', 'const a = 10')}\n// mine`),
      }),
    )
    const main = await onMain({
      [STEP]: `${start.replace('const c = 3', 'const c = 30')}\n`,
      'docs.md': 'hi\n',
    })
    expect(data(await admin.query('branchDrafts.changes', { id }))).toMatchObject({ mainAhead: true })

    const result = data(await admin.mutate('branchDrafts.updateFromMain', { id }))
    expect(result).toMatchObject({
      status: 'merged',
      objects: ['workflows/sync-orders'],
      draft: { status: 'updated' },
    })
    expect(await other.fetchBranch('from-main')).toBe(result.commit)
    expect(parents(result.commit)).toEqual([tip, main])
    const files = await other.readFiles(result.commit)
    expect(files[STEP]).toBe(`${lines('const a = 10', 'const b = 2', 'const c = 30', 'return a + b + c')}\n`)
    expect(files['docs.md']).toBe('hi\n')
    // The pull request merges cleanly now.
    expect((await other.mergeTree(main, result.commit)).conflicts).toEqual([])
    // The draft: main's change, its own commit and its uncommitted line.
    expect(result.draft.draft.baseCommit).toBe(result.commit)
    expect(step(result.draft.draft)).toBe(
      `${lines('const a = 10', 'const b = 2', 'const c = 30', 'return a + b + c')}\n// mine`,
    )
    expect(data(await admin.query('branchDrafts.changes', { id }))).toMatchObject({ mainAhead: false })
    expect(data(await admin.mutate('branchDrafts.updateFromMain', { id }))).toEqual({ status: 'up_to_date' })
    const [audit] = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'git.merged_main'))
    expect(audit?.metadata).toMatchObject({ branch: 'from-main', commit: result.commit })
    data(await admin.mutate('branchDrafts.discard', { id }))
  })

  it('returns conflicts by object without writing, then merges with the resolutions', async () => {
    await onMain({ [STEP]: `${start}\n` })
    const id = await openDraft('clash')
    const tip = await saveAndCommit(id, start.replace('const b = 2', 'const b = "branch"'), 'Branch')
    await onMain({ [STEP]: `${start.replace('const b = 2', 'const b = "main"')}\n` })
    const first = data(await admin.mutate('branchDrafts.updateFromMain', { id }))
    expect(first).toMatchObject({
      status: 'conflicts',
      objects: [
        {
          dir: 'workflows/sync-orders',
          kind: 'workflow',
          slug: 'sync-orders',
          conflicts: [{ kind: 'text', at: ['definition', 'blocks', 'step', 'config', 'code'] }],
        },
      ],
    })
    expect(await other.fetchBranch('clash')).toBe(tip)
    const [object] = first.objects
    const second = data(
      await admin.mutate('branchDrafts.updateFromMain', {
        id,
        resolutions: { [object.dir]: { [object.conflicts[0].id]: { chunks: ['theirs'] } } },
      }),
    )
    expect(second.status).toBe('merged')
    expect(step(second.draft.draft)).toBe(start.replace('const b = 2', 'const b = "main"'))
    data(await admin.mutate('branchDrafts.discard', { id }))
  })

  /** Main's sync-orders directory replaced whole (a rename moves a block's .js file); nothing when it's the same. */
  const flowDirOnMain = async (files: Record<string, string>) => {
    const tip = await other.fetchBranch('main')
    const commit = await other.commit({
      parent: tip,
      directories: { 'workflows/sync-orders': files },
      message: 'On main',
      author,
    })
    if (commit) expect(await other.push(commit, 'main')).toBe('ok')
  }
  /** Main's sync-orders with one code block named `block`. */
  const flowOnMain = (code: string, block: string) =>
    flowDirOnMain(
      encodeObjectDir(
        repoObject('workflow', 'sync-orders', {
          name: 'Sync orders',
          description: null,
          definition: flowDefinition(code, block),
        }),
      ).files,
    )
  /** Main's sync-orders files as they are, to put back after a test that renames on main. */
  const mainFlowDir = async () => {
    const files = await other.readFiles((await other.fetchBranch('main'))!, ['workflows/sync-orders/'])
    return Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path.slice('workflows/sync-orders/'.length), text]),
    )
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped JSON
  const blockNames = (draft: any) => draft.definition.blocks.map((b: { name: string }) => b.name).sort()

  it('follows a block renamed on the branch and changed on main (M22)', async () => {
    const before = await mainFlowDir()
    await flowOnMain(start, 'step')
    const id = await openDraft('renamed')
    await saveAndCommit(id, start, 'Rename step to stage', 'stage')
    await flowOnMain(start.replace('const c = 3', 'const c = 30'), 'step')

    const result = data(await admin.mutate('branchDrafts.updateFromMain', { id }))
    expect(result).toMatchObject({ status: 'merged', objects: ['workflows/sync-orders'] })
    const merged = result.draft.draft
    expect(blockNames(merged)).toEqual(['stage', 'startTrigger'])
    expect(merged.definition.blocks.find((b: { name: string }) => b.name === 'stage').config.code).toBe(
      start.replace('const c = 3', 'const c = 30'),
    )
    expect(merged.definition.edges).toEqual([{ from: 'startTrigger', port: 'out', to: 'stage' }])
    expect(await other.fetchBranch('renamed')).toBe(result.commit)
    const files = await other.readFiles(result.commit, ['workflows/sync-orders/'])
    expect(Object.keys(files).filter((path) => path.includes('/blocks/'))).toEqual([
      'workflows/sync-orders/blocks/stage.js',
    ])
    data(await admin.mutate('branchDrafts.discard', { id }))
    await flowDirOnMain(before)
  })

  it('makes two different renames of a block one conflict over its name, resolved by a side (M22)', async () => {
    const before = await mainFlowDir()
    await flowOnMain(start, 'step')
    const id = await openDraft('renamed-twice')
    await saveAndCommit(id, start, 'Rename step to stage', 'stage')
    // A rename only: a block renamed and changed on one side reads as deleted and added.
    await flowOnMain(start, 'phase')

    const first = data(await admin.mutate('branchDrafts.updateFromMain', { id }))
    expect(first).toMatchObject({
      status: 'conflicts',
      objects: [
        {
          dir: 'workflows/sync-orders',
          conflicts: [
            {
              kind: 'value',
              at: ['definition', 'blocks', 'step', 'name'],
              base: 'step',
              ours: 'stage',
              theirs: 'phase',
            },
          ],
        },
      ],
    })
    const [object] = first.objects
    const second = data(
      await admin.mutate('branchDrafts.updateFromMain', {
        id,
        resolutions: { [object.dir]: { [object.conflicts[0].id]: 'theirs' } },
      }),
    )
    expect(second.status).toBe('merged')
    expect(blockNames(second.draft.draft)).toEqual(['phase', 'startTrigger'])
    expect(second.draft.draft.definition.edges).toEqual([{ from: 'startTrigger', port: 'out', to: 'phase' }])
    data(await admin.mutate('branchDrafts.discard', { id }))
    await flowDirOnMain(before)
  })

  it('refuses a conflict outside objects, naming it', async () => {
    const id = await openDraft('readme')
    await saveAndCommit(id, 'return "readme"', 'Readme branch')
    const tip = await other.fetchBranch('readme')
    const c = await other.commit({ parent: tip, files: { 'README.md': 'branch\n' }, message: 'r', author })
    await other.push(c!, 'readme')
    await onMain({ 'README.md': 'main\n' })
    expect(failure(await admin.mutate('branchDrafts.updateFromMain', { id }))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('README.md'),
    })
    expect(await other.fetchBranch('readme')).toBe(c)
    data(await admin.mutate('branchDrafts.discard', { id }))
  })

  it('merges another object both sides changed where git’s line merge would conflict', async () => {
    const extra = (blocks: string[]) =>
      encodeObjectDir(
        repoObject('workflow', 'extra', {
          name: 'Extra',
          description: null,
          definition: {
            schemaVersion: 1,
            blocks: [
              { name: 'startTrigger', type: 'startTrigger' },
              ...blocks.map((name) => ({ name, type: 'code', config: { code: `return "${name}"` } })),
            ],
            edges: [],
          },
        }),
      ).files
    const prefixed = (files: Record<string, string>) =>
      Object.fromEntries(Object.entries(files).map(([path, text]) => [`workflows/extra/${path}`, text]))
    await onMain(prefixed(extra(['code1'])))
    const id = await openDraft('two-objects')
    await saveAndCommit(id, 'return "two"', 'Two')
    const tip = await other.fetchBranch('two-objects')
    const branchSide = await other.commit({
      parent: tip,
      directories: { 'workflows/extra': extra(['code1', 'fromBranch']) },
      message: 'Branch adds a block',
      author,
    })
    await other.push(branchSide!, 'two-objects')
    const main = await other.fetchBranch('main')
    const mainSide = await other.commit({
      parent: main,
      directories: { 'workflows/extra': extra(['code1', 'fromMain']) },
      message: 'Main adds a block',
      author,
    })
    await other.push(mainSide!, 'main')
    // Git alone can't merge workflow.json: both sides added at the same place.
    expect((await other.mergeTree(branchSide!, mainSide!)).conflicts).toContain(
      'workflows/extra/workflow.json',
    )

    const result = data(await admin.mutate('branchDrafts.updateFromMain', { id }))
    expect(result).toMatchObject({ status: 'merged', objects: ['workflows/extra'] })
    expect(await other.fetchBranch('two-objects')).toBe(result.commit)
    const files = await other.readFiles(result.commit, ['workflows/extra/'])
    const json = JSON.parse(files['workflows/extra/workflow.json']!)
    // Canonical files order blocks by name.
    expect(json.blocks.map((b: { name: string }) => b.name)).toEqual([
      'code1',
      'fromBranch',
      'fromMain',
      'startTrigger',
    ])
    expect(files['workflows/extra/blocks/fromMain.js']).toBe('return "fromMain"\n')
    expect((await other.mergeTree(mainSide!, result.commit)).conflicts).toEqual([])
    data(await admin.mutate('branchDrafts.discard', { id }))
  })

  it('refuses conflicts in an object the person can’t edit', async () => {
    const [memberUser] = await env.db.select().from(users).where(eq(users.email, 'member@optiply.nl'))
    const groupId = data(await admin.mutate('groups.create', { name: 'Sync editors' })).id
    data(await admin.mutate('groups.addMember', { groupId, userId: memberUser!.id }))
    data(
      await admin.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: flowId,
        groupId,
        environmentId: null,
        level: 'edit',
      }),
    )
    const id = data(
      await member.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: flowId,
        branch: 'member',
        create: true,
      }),
    ).id
    const { revision } = data(await member.query('branchDrafts.get', { id }))
    data(await member.mutate('branchDrafts.save', { id, revision, definition: flowDefinition('return "m"') }))
    data(await member.mutate('branchDrafts.commit', { id, revision: revision + 1, message: 'Member' }))
    // `workflows/elsewhere` (not on the instance: admins only) gets the same line changed on both sides.
    const elsewhere = (code: string) =>
      encodeObjectDir(
        repoObject('workflow', 'elsewhere', {
          name: 'Elsewhere',
          description: null,
          definition: {
            schemaVersion: 1,
            blocks: [{ name: 'a', type: 'code', config: { code } }],
            edges: [],
          },
        }),
      ).files
    const main0 = await other.fetchBranch('main')
    const first = await other.commit({
      parent: main0,
      directories: { 'workflows/elsewhere': elsewhere('return 0') },
      message: 'Elsewhere',
      author,
    })
    await other.push(first!, 'main')
    const tip = await other.fetchBranch('member')
    const mainTip = await other.fetchBranch('main')
    // The branch takes main in first, so `elsewhere` is in their merge base.
    const { tree } = await other.mergeTree(tip!, mainTip!)
    const base = await other.commit({ parent: tip, mergeParents: [mainTip!], tree, message: 'Sync', author })
    await other.push(base!, 'member')
    const branchSide = await other.commit({
      parent: base,
      directories: { 'workflows/elsewhere': elsewhere('return "branch"') },
      message: 'b',
      author,
    })
    await other.push(branchSide!, 'member')
    const main1 = await other.fetchBranch('main')
    const mainSide = await other.commit({
      parent: main1,
      directories: { 'workflows/elsewhere': elsewhere('return "main"') },
      message: 'm',
      author,
    })
    await other.push(mainSide!, 'main')
    expect(failure(await member.mutate('branchDrafts.updateFromMain', { id }))).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('workflows/elsewhere'),
    })
    data(await member.mutate('branchDrafts.discard', { id }))
  })

  it('reports a draft update that fails after the merge commit is pushed, and still audits it', async () => {
    await onMain({ [STEP]: `${start}\n` })
    const id = await openDraft('post-push')
    await saveAndCommit(id, start.replace('const a = 1', 'const a = 5'), 'Five')
    await onMain({ [STEP]: `${start.replace('const c = 3', 'const c = 5')}\n` })
    // The draft's base is gone (a rewritten branch): its own update can only fail.
    await env.db
      .update(gitBranchDrafts)
      .set({ baseCommit: 'e'.repeat(40) })
      .where(eq(gitBranchDrafts.id, id))
    const result = data(await admin.mutate('branchDrafts.updateFromMain', { id }))
    expect(result).toMatchObject({
      status: 'merged',
      draft: null,
      draftError: expect.stringContaining('no longer in the repo'),
    })
    expect(await other.fetchBranch('post-push')).toBe(result.commit)
    expect(parents(result.commit)).toHaveLength(2)
    const audits = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'git.merged_main'))
    expect(audits.some((a) => (a.metadata as { commit?: string }).commit === result.commit)).toBe(true)
    data(await admin.mutate('branchDrafts.discard', { id }))
  })

  it('moves a draft whose branch isn’t made yet onto main’s tip', async () => {
    await onMain({ [STEP]: `${start}\n` })
    const id = await openDraft('not-yet')
    const { revision } = data(await admin.query('branchDrafts.get', { id }))
    data(
      await admin.mutate('branchDrafts.save', {
        id,
        revision,
        definition: flowDefinition(start.replace('const a = 1', 'const a = 100')),
      }),
    )
    const main = await onMain({ [STEP]: `${start.replace('const c = 3', 'const c = 300')}\n` })
    expect(data(await admin.query('branchDrafts.changes', { id }))).toMatchObject({ mainAhead: true })
    const result = data(await admin.mutate('branchDrafts.updateFromMain', { id }))
    expect(result).toMatchObject({ status: 'merged', commit: null, draft: { status: 'updated' } })
    expect(result.draft.draft).toMatchObject({ baseCommit: main, branchExists: false })
    expect(step(result.draft.draft)).toBe(
      lines('const a = 100', 'const b = 2', 'const c = 300', 'return a + b + c'),
    )
    expect(await other.fetchBranch('not-yet')).toBeNull()
    data(await admin.mutate('branchDrafts.discard', { id }))
  })
})

describe('objects new to the repo, and apps', () => {
  it('merges from what the draft started from when its base has no files, even after the object changed here', async () => {
    const id = data(
      await admin.mutate('workflows.create', { slug: 'drifting', name: 'Drifting', protected: true }),
    ).id
    const draft = data(
      await admin.mutate('branchDrafts.open', { kind: 'workflow', id, branch: 'drift', create: true }),
    )
    expect(draft.definition.blocks.map((b: { name: string }) => b.name)).toEqual(['startTrigger'])
    // The object changes on the instance meanwhile (as a deploy or a rollback would).
    await env.db
      .update(workflows)
      .set({ draftDefinition: flowDefinition('return "drift"') as never })
      .where(eq(workflows.id, id))
    // Someone puts the workflow on the branch, with a step of their own.
    const main = await other.fetchBranch('main')
    const theirs = await other.commit({
      parent: main,
      directories: {
        'workflows/drifting': encodeObjectDir(
          repoObject('workflow', 'drifting', {
            name: 'Drifting',
            description: null,
            definition: flowDefinition('return "theirs"'),
          }),
        ).files,
      },
      message: 'Theirs',
      author,
    })
    await other.push(theirs!, 'drift')
    // From the draft's own start (only startTrigger), theirs added the step: taken, not a conflict with the drift.
    const result = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draft.id }))
    expect(result.status).toBe('updated')
    expect(stepCode(result.draft)).toBe('return "theirs"')
    data(await admin.mutate('branchDrafts.discard', { id: draft.id }))
  })

  it('starts a workflow created protected from the instance, and its first merge deploys it', async () => {
    const id = data(
      await admin.mutate('workflows.create', { slug: 'brand-new', name: 'Brand new', protected: true }),
    ).id
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id,
        branch: 'new/brand-new',
        create: true,
      }),
    )
    expect(draft.definition.blocks).toEqual([{ name: 'startTrigger', type: 'startTrigger' }])
    data(
      await admin.mutate('branchDrafts.save', {
        id: draft.id,
        revision: 1,
        definition: flowDefinition('return "new"'),
      }),
    )
    const changes = data(await admin.query('branchDrafts.changes', { id: draft.id }))
    expect(changes.files.map((f: { status: string }) => f.status)).toEqual(['added', 'added'])
    data(await admin.mutate('branchDrafts.commit', { id: draft.id, revision: 2, message: 'Add brand-new' }))
    const pr = data(
      await admin.mutate('git.openPullRequest', { branch: 'new/brand-new', title: 'Brand new' }),
    )
    github.merge(pr.pullRequest.number)
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error(JSON.stringify(result))
    expect(result.objects.find((o) => o.slug === 'brand-new')).toMatchObject({
      outcome: 'released',
      version: '1.0.0',
    })
  })

  it("runs an app's queries from its branch draft", async () => {
    const appId = data(
      await admin.mutate('apps.create', { slug: 'admin-app', name: 'Admin app', protected: true }),
    ).id
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'app',
        id: appId,
        branch: 'app/queries',
        create: true,
      }),
    )
    data(
      await admin.mutate('branchDrafts.save', {
        id: draft.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [
            { name: 'list', kind: 'resource', resource: 'nowhere', query: { sql: 'select 1' }, run: 'auto' },
          ],
        },
      }),
    )
    const envs = data(await admin.query('environments.list')) as { id: string }[]
    const run = (branchDraftId?: string) =>
      admin.mutate('apps.runQuery', {
        appId,
        releaseId: null,
        branchDraftId,
        query: 'list',
        environmentId: envs[0]!.id,
      })
    // The main draft has no such query; the branch draft does (and names a resource that isn't there).
    expect(failure(await run()).message).toMatch(/no query named "list"/)
    expect(failure(await run(draft.id)).message).toMatch(/No resource has the slug "nowhere"/)
  })

  it('keeps the snapshot of an open branch draft through retention', async () => {
    // brand-new's draft never ran: no run holds on to its snapshots.
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, 'brand-new'))
    const [draft] = await env.db
      .select()
      .from(gitBranchDrafts)
      .where(eq(gitBranchDrafts.workflowId, flow!.id))
    const definition = flowDefinition('return 0') as never
    await env.db.insert(workflowDraftSnapshots).values([
      { workflowId: flow!.id, branchDraftId: draft!.id, revision: draft!.revision, definition },
      { workflowId: flow!.id, branchDraftId: draft!.id, revision: 1, definition },
    ])
    await deleteOldRuns(env.db, { days: 0, now: new Date(Date.now() + 86_400_000), pauseMs: 0 })
    const left = await env.db
      .select({ revision: workflowDraftSnapshots.revision })
      .from(workflowDraftSnapshots)
      .where(eq(workflowDraftSnapshots.branchDraftId, draft!.id))
    expect(left.map((s) => s.revision)).toEqual([draft!.revision])
  })
})

describe('folders on branches (M22)', () => {
  const FILE = 'workflows/filed-flow/workflow.json'
  let objectId: string
  let finance: string
  const folderIn = async (branch: string, file = FILE) => {
    const files = await other.readFiles((await other.fetchBranch(branch))!, [file])
    return JSON.parse(files[file]!).folder ?? null
  }
  const save = async (id: string, change: { folder?: string | null; code?: string }) => {
    const { revision } = data(await admin.query('branchDrafts.get', { id }))
    data(
      await admin.mutate('branchDrafts.save', {
        id,
        revision,
        definition: flowDefinition(change.code ?? 'return 1'),
        ...(change.folder !== undefined ? { folder: change.folder } : {}),
      }),
    )
    return revision + 1
  }
  const commit = async (id: string, revision: number) =>
    data(await admin.mutate('branchDrafts.commit', { id, revision, message: 'Folder' }))
  /** Someone else commits the workflow's JSON with a folder of theirs onto a branch. */
  const theirFolder = async (branch: string, folder: string, path = FILE) => {
    const tip = await other.fetchBranch(branch)
    const json = JSON.parse((await other.readFiles(tip!, [path]))[path]!)
    const next = await other.commit({
      parent: tip,
      files: { [path]: `${JSON.stringify({ ...json, folder }, null, 2)}\n` },
      message: 'Their folder',
      author,
    })
    expect(await other.push(next!, branch)).toBe('ok')
  }

  beforeAll(async () => {
    finance = data(await admin.mutate('folders.create', { name: 'Finance', type: 'workflow' })).id
    objectId = data(
      await admin.mutate('workflows.create', {
        slug: 'filed-flow',
        name: 'Filed flow',
        protected: true,
        folderId: finance,
      }),
    ).id
  })

  it('keeps the folder from opening to committing, and commits a new one', async () => {
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: objectId,
        branch: 'filing',
        create: true,
      }),
    )
    // The repo has no files for it yet: the instance's folder.
    expect(draft.folder).toBe('Finance')
    let revision = await save(draft.id, {})
    const changes = data(await admin.query('branchDrafts.changes', { id: draft.id }))
    const json = changes.files.find((f: { path: string }) => f.path === FILE)
    expect(JSON.parse(json.after)).toMatchObject({ folder: 'Finance' })
    await commit(draft.id, revision)
    expect(await folderIn('filing')).toBe('Finance')

    revision = await save(draft.id, { folder: 'Finance/Reports' })
    await commit(draft.id, revision)
    expect(await folderIn('filing')).toBe('Finance/Reports')
    revision = await save(draft.id, { folder: null })
    await commit(draft.id, revision)
    expect(await folderIn('filing')).toBeNull()
    expect(
      failure(
        await admin.mutate('branchDrafts.save', {
          id: draft.id,
          revision: revision,
          definition: flowDefinition('return 1'),
          folder: 'Finance/ Reports',
        }),
      ).code,
    ).toBe('BAD_REQUEST')
    data(await admin.mutate('branchDrafts.discard', { id: draft.id }))
  })

  it('sets the name, description and folder without a new revision, and commits them', async () => {
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: objectId,
        branch: 'detailing',
        create: true,
      }),
    )
    const view = data(
      await admin.mutate('branchDrafts.setDetails', {
        id: draft.id,
        name: 'Filed, renamed',
        description: 'Why it exists',
        folder: 'Ops/Nightly',
      }),
    )
    expect(view).toMatchObject({
      name: 'Filed, renamed',
      description: 'Why it exists',
      folder: 'Ops/Nightly',
    })
    expect(view.revision).toBe(draft.revision)
    await commit(draft.id, draft.revision)
    const files = await other.readFiles((await other.fetchBranch('detailing'))!, [FILE])
    expect(JSON.parse(files[FILE]!)).toMatchObject({
      name: 'Filed, renamed',
      description: 'Why it exists',
      folder: 'Ops/Nightly',
    })
    // Cleared: the top level, no description.
    data(await admin.mutate('branchDrafts.setDetails', { id: draft.id, description: null, folder: '' }))
    expect(
      failure(await admin.mutate('branchDrafts.setDetails', { id: draft.id, folder: 'Ops/ ' })).code,
    ).toBe('BAD_REQUEST')
    expect(failure(await member.mutate('branchDrafts.setDetails', { id: draft.id, name: 'Mine' })).code).toBe(
      'NOT_FOUND',
    )
    const after = data(await admin.query('branchDrafts.get', { id: draft.id }))
    expect(after).toMatchObject({ name: 'Filed, renamed', description: null, folder: null })
    data(await admin.mutate('branchDrafts.discard', { id: draft.id }))
  })

  it('takes the branch’s folder on update, unless the draft changed it too', async () => {
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: objectId,
        branch: 'refiling',
        create: true,
      }),
    )
    await commit(draft.id, await save(draft.id, {}))
    await theirFolder('refiling', 'Ops')
    let result = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draft.id }))
    expect(result).toMatchObject({ status: 'updated', draft: { folder: 'Ops' } })

    await save(draft.id, { folder: 'Mine', code: 'return "mine"' })
    await theirFolder('refiling', 'Theirs')
    result = data(await admin.mutate('branchDrafts.updateFromBranch', { id: draft.id }))
    expect(result).toMatchObject({ status: 'updated', draft: { folder: 'Mine' } })
    expect(stepCode(result.draft)).toBe('return "mine"')
    data(await admin.mutate('branchDrafts.discard', { id: draft.id }))
  })

  it('keeps main’s folder change when Update from main merges the object', async () => {
    const MAIN_FILE = 'workflows/sync-orders/workflow.json'
    const draft = data(
      await admin.mutate('branchDrafts.open', {
        kind: 'workflow',
        id: flowId,
        branch: 'refolded',
        create: true,
      }),
    )
    await commit(draft.id, await save(draft.id, { code: 'return "branch"' }))
    await theirFolder('main', 'Moved on main', MAIN_FILE)
    const result = data(await admin.mutate('branchDrafts.updateFromMain', { id: draft.id }))
    expect(result).toMatchObject({ status: 'merged', objects: ['workflows/sync-orders'] })
    expect(await folderIn('refolded', MAIN_FILE)).toBe('Moved on main')
    expect(result.draft.draft.folder).toBe('Moved on main')
    expect(stepCode(result.draft.draft)).toBe('return "branch"')
    data(await admin.mutate('branchDrafts.discard', { id: draft.id }))
  })
})

describe('branches for one object (M22)', () => {
  const STEP = 'workflows/sync-orders/blocks/step.js'
  const commitOn = async (branch: string, from: string, files: Record<string, string>) => {
    const commit = await other.commit({ parent: from, files, message: `On ${branch}`, author })
    expect(await other.push(commit!, branch)).toBe('ok')
    return commit!
  }

  it('lists the deploy branch first, then the branches that change it or hold its draft', async () => {
    const main = (await other.fetchBranch('main'))!
    await commitOn('touches-it', main, { [STEP]: 'return "touched"\n' })
    await commitOn('elsewhere', main, { 'docs/notes.md': 'hi\n' })
    // Behind main, which then changes the workflow: not a change of the branch's.
    expect(await other.push(main, 'behind')).toBe('ok')
    await commitOn('main', main, { [STEP]: 'return "main moved"\n' })
    data(await admin.mutate('branchDrafts.open', { kind: 'workflow', id: flowId, branch: 'elsewhere' }))

    const branches = data(await admin.query('git.branches', { kind: 'workflow', id: flowId })) as {
      name: string
      deploy: boolean
      changes: boolean
      draft: boolean
    }[]
    expect(branches[0]).toMatchObject({ name: 'main', deploy: true })
    const by = (name: string) => branches.find((b) => b.name === name)!
    expect(by('touches-it')).toMatchObject({ changes: true, draft: false })
    expect(by('elsewhere')).toMatchObject({ changes: false, draft: true })
    expect(by('behind')).toMatchObject({ changes: false, draft: false })
    const firstPlain = branches.findIndex((b) => !b.deploy && !b.changes && !b.draft)
    const lastMarked = branches.findLastIndex((b) => b.changes || b.draft)
    expect(lastMarked).toBeLessThan(firstPlain)

    // Without an object: every branch, unmarked.
    const all = data(await admin.query('git.branches')) as { name: string; changes: boolean }[]
    expect(all.find((b) => b.name === 'touches-it')).toMatchObject({ changes: false })
    const unknown = { kind: 'workflow', id: '01a17de9-0000-7000-8000-000000000000' }
    expect(failure(await admin.query('git.branches', unknown)).code).toBe('NOT_FOUND')
  })

  it('asks the remote and git again only when something may have changed (M22 review)', async () => {
    const fetches = vi.spyOn(GitRepo.prototype, 'fetchAllBranches')
    const mergeBases = vi.spyOn(GitRepo.prototype, 'mergeBase')
    try {
      const list = async () =>
        data(await admin.query('git.branches', { kind: 'workflow', id: flowId })) as { name: string }[]
      const first = await list()
      const [fetched, compared] = [fetches.mock.calls.length, mergeBases.mock.calls.length]
      // Again right away: the branches read a moment ago, each answer kept.
      expect(await list()).toEqual(first)
      expect(fetches.mock.calls.length).toBe(fetched)
      expect(mergeBases.mock.calls.length).toBe(compared)
      // A push from this server: read again, the new branch listed.
      const id = data(
        await admin.mutate('branchDrafts.open', {
          kind: 'workflow',
          id: flowId,
          branch: 'pushed-here',
          create: true,
        }),
      ).id as string
      const { revision } = data(await admin.query('branchDrafts.get', { id }))
      data(
        await admin.mutate('branchDrafts.save', {
          id,
          revision,
          definition: flowDefinition('return "here"'),
        }),
      )
      data(await admin.mutate('branchDrafts.commit', { id, revision: revision + 1, message: 'Here' }))
      expect((await list()).map((b) => b.name)).toContain('pushed-here')
      expect(fetches.mock.calls.length).toBeGreaterThan(fetched)
      data(await admin.mutate('branchDrafts.discard', { id }))
    } finally {
      fetches.mockRestore()
      mergeBases.mockRestore()
    }
  })
})
