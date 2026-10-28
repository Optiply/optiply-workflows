import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { auditEvents, folders, workflows } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runGitDeploy } from '../src/services/git/deploy'
import { githubTarget } from '../src/services/git/github'
import { GitRepo } from '../src/services/git/repo'
import { fakeGitHub } from './fake-github'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const TOKEN = 'ghp_protect_tests'

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let github: Awaited<ReturnType<typeof fakeGitHub>>
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberGroupId: string
let remote: string
let reader: GitRepo

const data = (res: { body: { result?: { data: unknown }; error?: unknown } }) => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data as never
}
const code = (res: { body: { error?: { data?: { code: string } } } }) => res.body.error?.data?.code

const flowDefinition = (code: string) => ({
  schemaVersion: 1,
  blocks: [
    { name: 'startTrigger', type: 'startTrigger' },
    { name: 'step', type: 'code', config: { code } },
  ],
  edges: [{ from: 'startTrigger', port: 'out', to: 'step' }],
})

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
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' }))['id' as never]
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
  reader = await GitRepo.open(
    join(dir, 'reader'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
})
afterAll(async () => {
  await env?.stop()
  await github?.close()
  await cleanup?.()
})

/** A published workflow, as made on the instance before Git sync. */
async function publishedWorkflow(slug: string, code = 'return 1') {
  const created: { id: string } = data(await admin.mutate('workflows.create', { slug, name: `Flow ${slug}` }))
  data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: flowDefinition(code),
    }),
  )
  data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: 2 }))
  return created.id
}

describe('protecting', () => {
  let flowId: string

  it('needs Git sync set up', async () => {
    flowId = await publishedWorkflow('sync-orders')
    const res = await admin.mutate('git.protect', { kind: 'workflow', id: flowId })
    expect(code(res)).toBe('PRECONDITION_FAILED')
    expect(
      code(await admin.mutate('workflows.create', { slug: 'in-git', name: 'In Git', protected: true })),
    ).toBe('PRECONDITION_FAILED')
    data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: TOKEN }))
  })

  it('needs Own', async () => {
    expect(code(await member.mutate('git.protect', { kind: 'workflow', id: flowId }))).toBe('NOT_FOUND')
    await admin.mutate('permissions.set', {
      objectType: 'workflow',
      objectId: flowId,
      groupId: memberGroupId,
      environmentId: null,
      level: 'edit',
    })
    expect(code(await member.mutate('git.protect', { kind: 'workflow', id: flowId }))).toBe('FORBIDDEN')
  })

  it('puts the live release on a branch, opens a pull request, and starts the empty repo', async () => {
    // The draft moves on after publishing: protecting takes what's live.
    data(
      await admin.mutate('workflows.saveDraft', {
        id: flowId,
        revision: 2,
        definition: flowDefinition('return 2'),
      }),
    )
    const result = data(await admin.mutate('git.protect', { kind: 'workflow', id: flowId })) as {
      branch: string
      commit: string
      pullRequest: { number: number; url: string; state: string; head: string; base: string }
      pullRequestError: string | null
    }
    expect(result).toMatchObject({
      branch: 'protect/workflow-sync-orders',
      pullRequest: {
        number: 1,
        url: 'https://github.com/optiply/flows/pull/1',
        state: 'open',
        head: 'protect/workflow-sync-orders',
        base: 'main',
      },
      pullRequestError: null,
    })
    expect(github.pulls[0]).toMatchObject({ title: 'Protect workflow "Flow sync-orders"' })

    const main = await reader.fetchBranch('main')
    expect(await reader.readFiles(main!)).toEqual({ 'ow.json': '{\n  "format": 1\n}\n' })
    const branch = await reader.fetchBranch('protect/workflow-sync-orders')
    expect(branch).toBe(result.commit)
    const files = await reader.readFiles(branch!, ['workflows/'])
    expect(Object.keys(files).sort()).toEqual([
      'workflows/sync-orders/blocks/step.js',
      'workflows/sync-orders/workflow.json',
    ])
    expect(files['workflows/sync-orders/blocks/step.js']).toBe('return 1\n')
    expect((await reader.commitInfo(branch!)).authorEmail).toBe('admin@optiply.nl')

    const [flow] = await env.db.select().from(workflows).where(eq(workflows.id, flowId))
    expect(flow!.gitProtected).toBe(true)
    const audits = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'workflow.protected'))
    expect(audits[0]!.metadata).toMatchObject({ branch: 'protect/workflow-sync-orders', pullRequest: 1 })
    expect(code(await admin.mutate('git.protect', { kind: 'workflow', id: flowId }))).toBe('CONFLICT')
  })

  it('makes main read-only, except an emergency rollback by an admin', async () => {
    const get = data(await admin.query('workflows.get', { id: flowId })) as {
      gitProtected: boolean
      draftRevision: number
    }
    expect(get.gitProtected).toBe(true)
    const save = await admin.mutate('workflows.saveDraft', {
      id: flowId,
      revision: get.draftRevision,
      definition: flowDefinition('return 3'),
    })
    expect(code(save)).toBe('PRECONDITION_FAILED')
    expect(save.body.error?.message).toMatch(/protected: edit it on a Git branch/)
    expect(code(await admin.mutate('workflows.update', { id: flowId, name: 'Renamed' }))).toBe(
      'PRECONDITION_FAILED',
    )
    expect(code(await admin.mutate('workflows.update', { id: flowId, maxConcurrentRuns: 2 }))).toBeUndefined()
    expect(
      code(await admin.mutate('releases.publish', { workflowId: flowId, draftRevision: get.draftRevision })),
    ).toBe('PRECONDITION_FAILED')

    const releases = data(await admin.query('releases.list', { workflowId: flowId })) as { id: string }[]
    await admin.mutate('permissions.set', {
      objectType: 'workflow',
      objectId: flowId,
      groupId: memberGroupId,
      environmentId: null,
      level: 'own',
    })
    expect(
      code(await member.mutate('releases.setLive', { workflowId: flowId, releaseId: releases[0]!.id })),
    ).toBe('FORBIDDEN')
    expect(
      code(await admin.mutate('releases.setLive', { workflowId: flowId, releaseId: releases[0]!.id })),
    ).toBeUndefined()
    const [rollback] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'workflow.release_live'))
    expect(rollback!.metadata).toMatchObject({ emergency: true })
  })

  it('deploys nothing new when the protect pull request merges (it is what is live)', async () => {
    github.merge(1)
    const result = await runGitDeploy(env.db, env.config, { trigger: 'poll' })
    expect(result).toMatchObject({ status: 'deployed', ok: true })
    if (result.status !== 'deployed') throw new Error()
    expect(result.objects).toEqual([expect.objectContaining({ slug: 'sync-orders', outcome: 'unchanged' })])
    const pr = data(await admin.query('git.pullRequest', { branch: 'protect/workflow-sync-orders' })) as {
      pullRequest: { merged: boolean; state: string }
    }
    expect(pr.pullRequest).toMatchObject({ merged: true, state: 'closed' })
  })

  it('protects an app without a live release from its draft, on a branch of your choosing', async () => {
    const app: { id: string } = data(
      await admin.mutate('apps.create', { slug: 'order-admin', name: 'Order admin' }),
    )
    data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [{ name: 'q', kind: 'js', code: 'return 42' }],
        },
      }),
    )
    const result = data(
      await admin.mutate('git.protect', { kind: 'app', id: app.id, branch: 'fabio/protect-admin' }),
    ) as { branch: string; pullRequest: { number: number } }
    expect(result).toMatchObject({ branch: 'fabio/protect-admin', pullRequest: { number: 2 } })
    const files = await reader.readFiles((await reader.fetchBranch('fabio/protect-admin'))!, ['apps/'])
    expect(files['apps/order-admin/queries/q.js']).toBe('return 42\n')
    expect(code(await admin.mutate('apps.saveDraft', { id: app.id, revision: 2, definition: {} }))).toBe(
      'PRECONDITION_FAILED',
    )
    expect(code(await admin.mutate('apps.publish', { appId: app.id, draftRevision: 2 }))).toBe(
      'PRECONDITION_FAILED',
    )

    // Merging deploys its first release, made by Git sync.
    github.merge(2)
    const deployed = await runGitDeploy(env.db, env.config, { trigger: 'poll' })
    if (deployed.status !== 'deployed') throw new Error(JSON.stringify(deployed))
    expect(deployed.objects.find((o) => o.slug === 'order-admin')).toMatchObject({
      outcome: 'released',
      version: '1.0.0',
    })
    const releases = data(await admin.query('apps.releases', { appId: app.id })) as {
      gitCommit: string | null
      createdBy: unknown
    }[]
    // The notes are the pull request's title, not GitHub's "Merge pull request #2 from …".
    expect(releases[0]).toMatchObject({
      gitCommit: deployed.commit,
      createdBy: null,
      notes: 'Protect app "Order admin" (#2)',
    })
  })

  it('unprotects', async () => {
    expect(code(await member.mutate('git.unprotect', { kind: 'workflow', id: flowId }))).toBeUndefined()
    const get = data(await admin.query('workflows.get', { id: flowId })) as {
      gitProtected: boolean
      draftRevision: number
    }
    expect(get.gitProtected).toBe(false)
    expect(
      code(
        await admin.mutate('workflows.saveDraft', {
          id: flowId,
          revision: get.draftRevision,
          definition: flowDefinition('return 4'),
        }),
      ),
    ).toBeUndefined()
    expect(code(await admin.mutate('git.unprotect', { kind: 'workflow', id: flowId }))).toBe('CONFLICT')
  })

  it('creates objects protected from the start', async () => {
    const created = data(
      await admin.mutate('workflows.create', { slug: 'in-git', name: 'In Git', protected: true }),
    ) as { gitProtected: boolean }
    expect(created.gitProtected).toBe(true)
    const app = data(
      await admin.mutate('apps.create', { slug: 'git-app', name: 'Git app', protected: true }),
    ) as {
      gitProtected: boolean
    }
    expect(app.gitProtected).toBe(true)
  })
})

describe('branches and pull requests', () => {
  it('lists branches with the deploy branch first', async () => {
    const branches = data(await member.query('git.branches')) as { name: string; deploy: boolean }[]
    expect(branches.map((b) => b.name)).toEqual([
      'main',
      'fabio/protect-admin',
      'protect/workflow-sync-orders',
    ])
    expect(branches[0]!.deploy).toBe(true)
  })

  it('opens a pull request once, and finds it again', async () => {
    const main = await reader.fetchBranch('main')
    const commit = await reader.commit({
      parent: main,
      files: { 'README.md': '# Flows\n' },
      message: 'Readme',
      author: { name: 'a', email: 'a@optiply.nl' },
    })
    await reader.push(commit!, 'docs/readme')
    const first = data(
      await member.mutate('git.openPullRequest', { branch: 'docs/readme', title: 'Add a readme' }),
    ) as {
      pullRequest: { number: number; created: boolean }
    }
    expect(first.pullRequest).toMatchObject({ number: 3, created: true })
    const again = data(
      await member.mutate('git.openPullRequest', { branch: 'docs/readme', title: 'Again' }),
    ) as {
      pullRequest: { number: number; created: boolean }
    }
    expect(again.pullRequest).toMatchObject({ number: 3, created: false })
    expect(data(await member.query('git.pullRequest', { branch: 'nope' }))).toEqual({
      pullRequest: null,
      error: null,
    })
  })

  it('reports GitHub refusing the token instead of failing', async () => {
    data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: 'ghp_wrong' }))
    const res = data(await member.mutate('git.openPullRequest', { branch: 'docs/readme', title: 'x' })) as {
      pullRequest: null
      pullRequestError: string
    }
    expect(res.pullRequestError).toMatch(/GitHub said 401: Bad credentials/)
    expect(res.pullRequestError).not.toContain('ghp_wrong')
    data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, token: TOKEN }))
  })

  it('works out the GitHub API from the repo URL', () => {
    expect(githubTarget('https://github.com/optiply/flows.git')).toEqual({
      api: 'https://api.github.com',
      owner: 'optiply',
      repo: 'flows',
    })
    expect(githubTarget('https://git.optiply.nl/data/flows')).toEqual({
      api: 'https://git.optiply.nl/api/v3',
      owner: 'data',
      repo: 'flows',
    })
    expect(githubTarget('file:///tmp/x/optiply/flows.git')).toBeNull()
    expect(githubTarget('file:///tmp/x/optiply/flows.git', 'http://127.0.0.1:9')).toMatchObject({
      owner: 'optiply',
      repo: 'flows',
    })
    expect(githubTarget('https://github.com/flows')).toBeNull()
  })
})

// Last: it adds branches and pull requests the tests above count.
describe('protecting again', () => {
  it('protects onto a branch other than the deploy branch, under a free name', async () => {
    const id = await publishedWorkflow('twice')
    expect(code(await admin.mutate('git.protect', { kind: 'workflow', id, branch: 'main' }))).toBe(
      'BAD_REQUEST',
    )
    // Protected, then unprotected before its pull request merged: protect/workflow-twice is still there.
    const first = data(await admin.mutate('git.protect', { kind: 'workflow', id })) as { branch: string }
    expect(first.branch).toBe('protect/workflow-twice')
    data(await admin.mutate('git.unprotect', { kind: 'workflow', id }))
    const again = data(await admin.mutate('git.protect', { kind: 'workflow', id })) as { branch: string }
    expect(again.branch).toBe('protect/workflow-twice-2')
    const files = await reader.readFiles((await reader.fetchBranch(again.branch))!, ['workflows/'])
    expect(files['workflows/twice/blocks/step.js']).toBe('return 1\n')
  })

  it('writes the folder it is in, which then stays as Git has it (M22)', async () => {
    const finance = data(await admin.mutate('folders.create', { name: 'Finance', type: 'workflow' })) as {
      id: string
    }
    const reports = data(
      await admin.mutate('folders.create', { name: 'Reports', parentId: finance.id, type: 'workflow' }),
    ) as { id: string }
    const id = await publishedWorkflow('filed')
    data(await admin.mutate('workflows.update', { id, folderId: reports.id }))
    const result = data(await admin.mutate('git.protect', { kind: 'workflow', id })) as { branch: string }
    const files = await reader.readFiles((await reader.fetchBranch(result.branch))!, ['workflows/'])
    expect(JSON.parse(files['workflows/filed/workflow.json']!)).toMatchObject({
      name: 'Flow filed',
      folder: 'Finance/Reports',
    })
    expect(code(await admin.mutate('workflows.update', { id, folderId: finance.id }))).toBe(
      'PRECONDITION_FAILED',
    )
    expect(code(await admin.mutate('workflows.update', { id, folderId: null }))).toBe('PRECONDITION_FAILED')
    // Its own folder again, or no folder given: not a move.
    data(await admin.mutate('workflows.update', { id, folderId: reports.id, maxConcurrentRuns: 2 }))
    data(await admin.mutate('workflows.update', { id, maxConcurrentRuns: 3 }))
    // Its folders, or the one above them, can't be renamed or deleted while it's protected (M22 review).
    expect(code(await admin.mutate('folders.rename', { id: reports.id, name: 'Old reports' }))).toBe(
      'PRECONDITION_FAILED',
    )
    expect(code(await admin.mutate('folders.rename', { id: finance.id, name: 'Money' }))).toBe(
      'PRECONDITION_FAILED',
    )
    expect(code(await admin.mutate('folders.delete', { id: reports.id }))).toBe('PRECONDITION_FAILED')
  })

  it('writes the top level as null, and refuses folder names holding a / (M22 review)', async () => {
    const id = await publishedWorkflow('top')
    const result = data(await admin.mutate('git.protect', { kind: 'workflow', id })) as { branch: string }
    const files = await reader.readFiles((await reader.fetchBranch(result.branch))!, ['workflows/'])
    expect(JSON.parse(files['workflows/top/workflow.json']!).folder).toBeNull()

    expect(code(await admin.mutate('folders.create', { name: 'Sales/EU', type: 'workflow' }))).toBe(
      'BAD_REQUEST',
    )
    // One made before the rule: protecting what's in it is refused, naming it.
    const [slashed] = await env.db
      .insert(folders)
      .values({ objectType: 'workflow', name: 'Sales/EU', parentId: null })
      .returning()
    const filed = await publishedWorkflow('slashed')
    data(await admin.mutate('workflows.update', { id: filed, folderId: slashed!.id }))
    const refused = await admin.mutate('git.protect', { kind: 'workflow', id: filed })
    expect(code(refused)).toBe('PRECONDITION_FAILED')
    expect(JSON.stringify(refused.body)).toContain('Rename the folder \\"Sales/EU\\" first')
    // Folders without protected objects still change as before.
    data(await admin.mutate('folders.rename', { id: slashed!.id, name: 'Sales EU' }))
  })
})
