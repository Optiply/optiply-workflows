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
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commitBranchDraft,
  loadBranchDraft,
  updateBranchDraftFromBranch,
} from '../src/services/git/branch-drafts'
import { runGitDeploy } from '../src/services/git/deploy'
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

const flowDefinition = (code: string) => ({
  schemaVersion: 1,
  blocks: [
    { name: 'startTrigger', type: 'startTrigger' },
    { name: 'step', type: 'code', config: { code } },
  ],
  edges: [{ from: 'startTrigger', port: 'out', to: 'step' }],
})

const deploy = () => runGitDeploy(env.db, env.config, { trigger: 'poll' })
const author = { name: 'Someone else', email: 'else@optiply.nl' }
const adminUser = async () =>
  (await env.db.select().from(users).where(eq(users.email, 'admin@optiply.nl')))[0]!

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
  const stepCode = (draft: { definition: { blocks: { name: string; config?: { code?: string } }[] } }) =>
    draft.definition.blocks.find((b) => b.name === 'step')!.config!.code

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

describe('objects new to the repo, and apps', () => {
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
