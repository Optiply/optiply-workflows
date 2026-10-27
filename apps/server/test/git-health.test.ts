import { join } from 'node:path'
import type { AppDefinition } from '@ow/app-definition'
import { auditEvents, workflowRuns } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { encodeObjectDir, type Files, manifestFile, type RepoObject } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runGitDeploy } from '../src/services/git/deploy'
import { GitRepo } from '../src/services/git/repo'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const author = { name: 'Reviewer', email: 'reviewer@optiply.nl' }

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let seeder: GitRepo
let notifyId: string

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { body: { result?: { data: unknown }; error?: unknown } }): any => {
  if (res.body.error) throw new Error(JSON.stringify(res.body.error))
  return res.body.result!.data
}
const code = (res: { body: { error?: { data?: { code: string } } } }) => res.body.error?.data?.code
const startOnly = { schemaVersion: 1, blocks: [{ name: 'startTrigger', type: 'startTrigger' }], edges: [] }

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  env = await startTestApp({ GIT_ALLOW_INSECURE_URLS: 'true', GIT_CACHE_DIR: join(dir, 'cache') })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  const remote = bareRepo(join(dir, 'flows.git'))
  data(await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}` }))
  seeder = await GitRepo.open(
    join(dir, 'seeder'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
  // The notify workflow, made and published on the instance.
  notifyId = data(await admin.mutate('workflows.create', { slug: 'tell-ops', name: 'Tell ops' })).id
  data(await admin.mutate('workflows.saveDraft', { id: notifyId, revision: 1, definition: startOnly }))
  data(await admin.mutate('releases.publish', { workflowId: notifyId, draftRevision: 2 }))
})
afterAll(async () => {
  await env?.stop()
  await cleanup?.()
})

const deploy = () => runGitDeploy(env.db, env.config, { trigger: 'poll' })

async function pushMain(message: string, objects: RepoObject[], raw: Record<string, Files> = {}) {
  const parent = await seeder.fetchBranch('main')
  const directories: Record<string, Files | null> = { ...raw }
  for (const object of objects) {
    const { dir: path, files } = encodeObjectDir(object)
    directories[path] = files
  }
  const commit = await seeder.commit({
    parent,
    directories,
    files: parent ? {} : { 'ow.json': manifestFile() },
    message,
    author,
  })
  expect(await seeder.push(commit!, 'main')).toBe('ok')
  return commit!
}

const app = (slug: string, resource: string): RepoObject => ({
  kind: 'app',
  slug,
  value: {
    name: slug,
    description: null,
    definition: {
      schemaVersion: 1,
      components: [],
      queries: [{ name: 'list', kind: 'resource', resource, query: { sql: 'select 1' }, run: 'auto' }],
    } as AppDefinition,
  },
})
const workflow = (slug: string): RepoObject => ({
  kind: 'workflow',
  slug,
  value: { name: slug, description: null, definition: startOnly as WorkflowDefinition },
})

/** The notify workflow's runs, oldest first. */
async function notifications() {
  const runs = await env.db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, notifyId))
    .orderBy(workflowRuns.createdAt)
  // biome-ignore lint/suspicious/noExplicitAny: untyped run input
  return runs.map((r) => ({ ...r, data: (r.input as any).data }))
}

describe('Git health and the notify workflow (M22)', () => {
  it('picks the notify workflow (admins only, an existing workflow)', async () => {
    expect(code(await member.mutate('git.setNotifyWorkflow', { workflowId: notifyId }))).toBe('FORBIDDEN')
    expect(
      code(
        await admin.mutate('git.setNotifyWorkflow', { workflowId: '01a17de9-0000-7000-8000-000000000000' }),
      ),
    ).toBe('NOT_FOUND')
    const view = data(await admin.mutate('git.setNotifyWorkflow', { workflowId: notifyId }))
    expect(view.notifyWorkflow).toEqual({ id: notifyId, name: 'Tell ops' })
    expect(data(await admin.query('git.settings')).notifyWorkflow).toEqual({ id: notifyId, name: 'Tell ops' })
    expect(code(await member.query('git.health'))).toBe('FORBIDDEN')
    expect(data(await admin.query('git.health'))).toMatchObject({
      configured: true,
      lastDeploy: null,
      problems: [],
      key: '',
    })
  })

  it('runs it once when a deploy ends with new problems, with what they are', async () => {
    const commit = await pushMain('Add things', [app('warehouse-admin', 'warehouse'), workflow('fine')], {
      'workflows/broken': { 'workflow.json': '{ not json' },
    })
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: false })
    const health = data(await admin.query('git.health'))
    expect(health).toMatchObject({ lastDeploy: { commit, status: 'problems' }, lastError: null })
    expect(health.problems).toEqual([
      expect.objectContaining({ kind: 'app', slug: 'warehouse-admin', path: 'apps/warehouse-admin' }),
      expect.objectContaining({ kind: 'workflow', slug: 'broken', path: 'workflows/broken/workflow.json' }),
    ])
    expect(health.key).not.toBe('')

    const runs = await notifications()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ triggerType: 'git', createdBy: null, status: 'queued' })
    expect(runs[0]!.data).toEqual({
      deploy: { id: health.lastDeploy.id, commit, url: `${env.config.PUBLIC_URL}/settings/git` },
      problems: health.problems,
    })
    const [audit] = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'git.notified'))
    expect(audit).toMatchObject({ objectId: notifyId, metadata: { problems: 2 } })
  })

  it('stays quiet while the problems are the same', async () => {
    await pushMain('Another fine one', [workflow('also-fine')])
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: false })
    expect(await notifications()).toHaveLength(1)
  })

  it('runs it again when they change, and once more when they are gone', async () => {
    data(await admin.mutate('resources.create', { type: 'postgres', name: 'Warehouse', slug: 'warehouse' }))
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: false })
    let runs = await notifications()
    expect(runs).toHaveLength(2)
    expect(runs[1]!.data.problems).toEqual([expect.objectContaining({ slug: 'broken' })])

    const fixed = await pushMain('Fix it', [workflow('broken')])
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: true })
    runs = await notifications()
    expect(runs).toHaveLength(3)
    expect(runs[2]!.data).toMatchObject({ deploy: { commit: fixed }, problems: [] })
    expect(data(await admin.query('git.health'))).toMatchObject({ problems: [], key: '' })

    await pushMain('All well', [workflow('still-fine')])
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: true })
    expect(await notifications()).toHaveLength(3)
  })

  it('only logs when the notify workflow has nothing live, and can be turned off', async () => {
    const draftOnly = data(await admin.mutate('workflows.create', { slug: 'not-live', name: 'Not live' })).id
    data(await admin.mutate('git.setNotifyWorkflow', { workflowId: draftOnly }))
    await pushMain('Break again', [], { 'workflows/broken': { 'workflow.json': '{ not json' } })
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: false })
    expect(await env.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, draftOnly))).toEqual([])
    expect(data(await admin.mutate('git.setNotifyWorkflow', { workflowId: null })).notifyWorkflow).toBeNull()
  })
})
