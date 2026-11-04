import { join } from 'node:path'
import type { AppDefinition } from '@ow/app-definition'
import { apps, gitDeploys, gitObjects, gitSettings, resources } from '@ow/db'
import { encodeObjectDir, type Files, manifestFile, type RepoObject } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asksForGitRetry, runGitDeploy } from '../src/services/git/deploy'
import { GitDeployer } from '../src/services/git/deployer'
import { GitRepo } from '../src/services/git/repo'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const author = { name: 'Reviewer', email: 'reviewer@optiply.nl' }

let env: TestEnv
let dir: string
let cleanup: () => Promise<void>
let admin: ReturnType<typeof trpc>
let seeder: GitRepo

beforeAll(async () => {
  ;({ dir, cleanup } = await scratch())
  env = await startTestApp({ GIT_ALLOW_INSECURE_URLS: 'true', GIT_CACHE_DIR: join(dir, 'cache') })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  const remote = bareRepo(join(dir, 'flows.git'))
  await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}` })
  seeder = await GitRepo.open(
    join(dir, 'seeder'),
    { url: `file://${remote}`, token: null },
    { allowInsecure: true },
  )
})
afterAll(async () => {
  await env?.stop()
  await cleanup?.()
})

const deploy = (opts: { retry?: boolean } = {}) =>
  runGitDeploy(env.db, env.config, { trigger: 'poll', ...opts })

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

/** An app whose query needs a resource. */
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

const statusOf = async (slug: string) =>
  (await env.db.select().from(gitObjects).where(eq(gitObjects.slug, slug)))[0]?.status
const deployCount = async () => (await env.db.select().from(gitDeploys)).length
const mark = async () => (await env.db.select().from(gitSettings))[0]!.retryRequestedAt

describe('deploy retries (M22)', () => {
  it('marks a re-check for changes problem objects may wait for, not for running queries', () => {
    for (const action of [
      'resource.created',
      'resource.config_saved',
      'resource.overrides_saved',
      'config_var.value_set',
      'library_query.release_published',
      'module.release_live',
    ]) {
      expect(asksForGitRetry(action), action).toBe(true)
    }
    for (const action of [
      'resource.query_run',
      'library_query.query_run',
      'workflow.updated',
      'app.created',
    ]) {
      expect(asksForGitRetry(action), action).toBe(false)
    }
  })

  it('records nothing when a retry finds the same problems', async () => {
    await pushMain('Add the admin app', [app('warehouse-admin', 'warehouse')], {
      'workflows/broken': { 'workflow.json': '{ not json' },
    })
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: false })
    expect(await statusOf('warehouse-admin')).toBe('problem')
    const deploys = await deployCount()
    expect(await deploy()).toMatchObject({ status: 'up_to_date' })
    expect(await deploy({ retry: true })).toMatchObject({ status: 'up_to_date' })
    expect(await deployCount()).toBe(deploys)
  })

  it('deploys a problem object on the next poll once what it needed is created', async () => {
    const created = await admin.mutate('resources.create', {
      type: 'postgres',
      name: 'Warehouse',
      slug: 'warehouse',
    })
    expect(created.body.error).toBeUndefined()
    expect(await mark()).not.toBeNull()

    const result = await deploy()
    expect(result).toMatchObject({ status: 'deployed', ok: false })
    if (result.status !== 'deployed') throw new Error()
    // The fixed one deploys; the one only a commit can fix is still a problem; deployed ones aren't touched.
    expect(result.objects.map((o) => [o.slug, o.outcome]).sort()).toEqual([
      ['broken', 'problem'],
      ['warehouse-admin', 'released'],
    ])
    expect(await statusOf('warehouse-admin')).toBe('deployed')
    const [app] = await env.db.select().from(apps).where(eq(apps.slug, 'warehouse-admin'))
    expect(app!.liveReleaseId).not.toBeNull()
    expect((await env.db.select().from(gitDeploys)).map((d) => d.trigger)).toContain('retry')
    expect(await mark()).toBeNull()
    expect(await deploy()).toMatchObject({ status: 'up_to_date' })
  })

  it('re-checks on a timer in workers, without any change marked', async () => {
    await pushMain('Add another', [app('depot-admin', 'depot')])
    expect(await deploy()).toMatchObject({ status: 'deployed', ok: false })
    // Made without the API: no mark.
    await env.db.insert(resources).values({ slug: 'depot', name: 'Depot', type: 'postgres' })
    expect(await mark()).toBeNull()
    const deployer = new GitDeployer({ db: env.db, config: env.config, pollMs: 0, retryMs: 100 })
    deployer.start()
    try {
      await vi.waitFor(async () => expect(await statusOf('depot-admin')).toBe('deployed'), {
        timeout: 10_000,
      })
      // Polling is off: a new commit waits for a webhook or Deploy now, however often the timer re-checks (M22
      // review).
      const [before] = await env.db.select().from(gitSettings)
      await pushMain('Not for the timer', [app('later-admin', 'depot')])
      await new Promise((resolve) => setTimeout(resolve, 600))
      const [after] = await env.db.select().from(gitSettings)
      expect(after!.deployedCommit).toBe(before!.deployedCommit)
      expect(await statusOf('later-admin')).toBeUndefined()
    } finally {
      await deployer.stop()
    }
  })
})
