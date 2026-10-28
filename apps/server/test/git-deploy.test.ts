import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import type { AppDefinition } from '@ow/app-definition'
import {
  appReleases,
  apps,
  auditEvents,
  gitDeploys,
  gitObjects,
  gitSettings,
  resources,
  workflowReleases,
  workflows,
  workflowTriggers,
} from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { encodeObject, type Files, manifestFile, type RepoObject } from '@ow/git-format'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handBackLease, requestGitDeploy, runGitDeploy } from '../src/services/git/deploy'
import { GitRepo } from '../src/services/git/repo'
import { bareRepo, scratch } from './git-helpers'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const HOOK_SECRET = 'whsec_deploy_tests'
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
  await admin.mutate('git.saveSettings', { repoUrl: `file://${remote}`, webhookSecret: HOOK_SECRET })
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

const deploy = (force = false) => runGitDeploy(env.db, env.config, { trigger: 'poll', force })

function workflow(slug: string, def: Partial<WorkflowDefinition>, name = slug): RepoObject {
  return {
    kind: 'workflow',
    slug,
    value: {
      name,
      description: null,
      definition: {
        schemaVersion: 1,
        blocks: [{ name: 'startTrigger', type: 'startTrigger' }],
        edges: [],
        ...def,
      } as WorkflowDefinition,
    },
  }
}

function app(slug: string, def: Partial<AppDefinition> = {}): RepoObject {
  return {
    kind: 'app',
    slug,
    value: {
      name: slug,
      description: 'An app',
      definition: { schemaVersion: 1, components: [], queries: [], ...def },
    },
  }
}

const renamed = (object: RepoObject, name: string) =>
  ({ ...object, value: { ...object.value, name } }) as RepoObject

const codeFlow = (code: string, extra: Partial<WorkflowDefinition> = {}) =>
  workflow('sync-orders', {
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      { name: 'step', type: 'code', config: { code } },
    ],
    edges: [{ from: 'startTrigger', port: 'out', to: 'step' }],
    triggers: { webhook: { enabled: true } },
    ...extra,
  })

/** Commits to main as a reviewer merging a PR would: objects written whole, directories removed, single files. */
async function pushMain(
  message: string,
  change: { objects?: RepoObject[]; remove?: string[]; files?: Files; raw?: Record<string, Files> },
): Promise<string> {
  const parent = await seeder.fetchBranch('main')
  const directories: Record<string, Files | null> = { ...change.raw }
  for (const object of change.objects ?? []) {
    const prefix = `${object.kind === 'workflow' ? 'workflows' : 'apps'}/${object.slug}/`
    directories[prefix.slice(0, -1)] = Object.fromEntries(
      Object.entries(encodeObject(object).files).map(([path, content]) => [
        path.slice(prefix.length),
        content,
      ]),
    )
  }
  for (const path of change.remove ?? []) directories[path] = null
  const commit = await seeder.commit({ parent, directories, files: change.files, message, author })
  expect(await seeder.push(commit!, 'main')).toBe('ok')
  return commit!
}

const byKey = (objects: { kind: string; slug: string; outcome: string }[]) =>
  Object.fromEntries(objects.map((o) => [`${o.kind}:${o.slug}`, o.outcome]))

describe('deploying from Git', () => {
  let first: string

  it('does nothing before the branch exists', async () => {
    expect(await deploy()).toEqual({ status: 'empty' })
  })

  it('creates protected workflows and apps from the first commit, with releases made by Git sync', async () => {
    first = await pushMain('Add the first flows\n\nReviewed in PR #1', {
      files: { 'ow.json': manifestFile() },
      objects: [
        codeFlow('return 1'),
        // parent calls child; both are new in this commit, and parent sorts first.
        workflow('a-parent', {
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            { name: 'call', type: 'workflow', config: { workflow: 'z-child' } },
          ],
          edges: [{ from: 'startTrigger', port: 'out', to: 'call' }],
        }),
        workflow('z-child', {}),
        app('order-admin', { queries: [{ name: 'q', kind: 'js', code: 'return 1' }] }),
      ],
    })
    const result = await deploy()
    expect(result).toMatchObject({ status: 'deployed', commit: first, ok: true, problems: [] })
    if (result.status !== 'deployed') throw new Error()
    expect(byKey(result.objects)).toEqual({
      'app:order-admin': 'created',
      'workflow:a-parent': 'created',
      'workflow:sync-orders': 'created',
      'workflow:z-child': 'created',
    })

    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    expect(flow).toMatchObject({ name: 'sync-orders', gitProtected: true, createdBy: null })
    const [release] = await env.db
      .select()
      .from(workflowReleases)
      .where(eq(workflowReleases.workflowId, flow!.id))
    expect(release).toMatchObject({
      version: '1.0.0',
      gitCommit: first,
      createdBy: null,
      notes: 'Add the first flows',
    })
    expect(flow!.liveReleaseId).toBe(release!.id)
    expect(flow!.draftDefinition.blocks.find((b) => b.name === 'step')).toMatchObject({
      config: { code: 'return 1' },
    })
    // Going live projected the webhook trigger, as publishing does.
    const triggers = await env.db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.workflowId, flow!.id))
    expect(triggers.map((t) => t.kind)).toEqual(['webhook'])

    const [adminApp] = await env.db.select().from(apps).where(eq(apps.slug, 'order-admin'))
    expect(adminApp).toMatchObject({ gitProtected: true, description: 'An app' })
    const [appRelease] = await env.db.select().from(appReleases).where(eq(appReleases.appId, adminApp!.id))
    expect(appRelease).toMatchObject({ version: '1.0.0', gitCommit: first })
    expect(adminApp!.liveReleaseId).toBe(appRelease!.id)

    const audits = await env.db.select().from(auditEvents)
    expect(audits.filter((a) => a.action === 'workflow.release_published')).toHaveLength(3)
    expect(audits.find((a) => a.action === 'git.deployed')).toMatchObject({
      actorUserId: null,
      metadata: { commit: first, created: 4, released: 0, problems: 0, missing: 0, trigger: 'poll' },
    })
    const [settings] = await env.db.select().from(gitSettings)
    expect(settings).toMatchObject({ deployedCommit: first, lastError: null, deployLeaseUntil: null })
  })

  it('does nothing when the branch has not moved', async () => {
    expect(await deploy()).toEqual({ status: 'up_to_date', commit: first })
    expect(await env.db.select().from(gitDeploys)).toHaveLength(1)
  })

  it('releases only what changed', async () => {
    const second = await pushMain('Change sync-orders', { objects: [codeFlow('return 2')] })
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error(JSON.stringify(result))
    expect(byKey(result.objects)).toEqual({
      'app:order-admin': 'unchanged',
      'workflow:a-parent': 'unchanged',
      'workflow:sync-orders': 'released',
      'workflow:z-child': 'unchanged',
    })
    expect(result.objects.find((o) => o.slug === 'sync-orders')?.version).toBe('1.0.1')
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    const releases = await env.db
      .select()
      .from(workflowReleases)
      .where(eq(workflowReleases.workflowId, flow!.id))
      .orderBy(workflowReleases.createdAt) // without it Postgres may answer through the newest-first index
    expect(releases.map((r) => [r.version, r.gitCommit])).toEqual([
      ['1.0.0', first],
      ['1.0.1', second],
    ])
  })

  it('moves the canvas without a release, and renames', async () => {
    const [before] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    await pushMain('Tidy the canvas', {
      objects: [
        renamed(codeFlow('return 2', { layout: { blocks: { step: { x: 10, y: 20 } } } }), 'Sync orders'),
      ],
    })
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error()
    expect(result.objects.find((o) => o.slug === 'sync-orders')?.outcome).toBe('unchanged')
    const [after] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    expect(after!.name).toBe('Sync orders')
    expect(after!.draftRevision).toBe(before!.draftRevision + 1)
    expect(after!.draftDefinition.layout).toEqual({ blocks: { step: { x: 10, y: 20 } } })
    expect(after!.liveReleaseId).toBe(before!.liveReleaseId)
  })

  it('keeps the live release when a directory has problems, and deploys the rest', async () => {
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    const broken = await pushMain('Break things', {
      raw: { 'workflows/sync-orders': { 'workflow.json': '{ not json' } },
      objects: [
        app('order-admin', {
          queries: [
            { name: 'list', kind: 'resource', resource: 'shop', query: { sql: 'select 1' }, run: 'auto' },
          ],
        }),
        workflow('z-child', { settings: { timeoutMs: 5000 } }),
      ],
    })
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error()
    expect(result.ok).toBe(false)
    expect(byKey(result.objects)).toMatchObject({
      'workflow:sync-orders': 'problem',
      'app:order-admin': 'problem',
      'workflow:z-child': 'released',
    })
    const objects = await env.db.select().from(gitObjects)
    const syncRow = objects.find((o) => o.slug === 'sync-orders')!
    expect(syncRow).toMatchObject({ status: 'problem', commit: broken })
    expect(syncRow.problems).toEqual([
      expect.objectContaining({ path: 'workflows/sync-orders/workflow.json', code: 'invalid_json' }),
    ])
    expect(objects.find((o) => o.slug === 'order-admin')!.problems).toEqual([
      expect.objectContaining({
        path: 'apps/order-admin',
        code: 'invalid_definition',
        message: expect.stringMatching(/shop/),
      }),
    ])
    // Still live: the last good release.
    const [still] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    expect(still!.liveReleaseId).toBe(flow!.liveReleaseId)
    const [deployRow] = await env.db.select().from(gitDeploys).where(eq(gitDeploys.commit, broken))
    expect(deployRow).toMatchObject({ status: 'problems', previousCommit: expect.any(String) })
  })

  it('deploys a problem away with Deploy now, once the instance has what was missing', async () => {
    await env.db.insert(resources).values({ slug: 'shop', name: 'Shop', type: 'postgres' })
    const now = await admin.mutate('git.deployNow')
    expect(now.body.result?.data).toMatchObject({ status: 'deployed', ok: false })
    expect(byKey(now.body.result?.data.objects)).toMatchObject({
      'app:order-admin': 'released',
      'workflow:sync-orders': 'problem',
    })
    const status = (await admin.query('git.status')).body.result?.data
    expect(status.objects.find((o: { slug: string }) => o.slug === 'order-admin')).toMatchObject({
      status: 'deployed',
      version: '1.0.1',
      problems: [],
    })
    expect(status.deploys[0]).toMatchObject({ trigger: 'manual' })
  })

  it("doesn't touch an unprotected object with the same slug", async () => {
    const created = await admin.mutate('workflows.create', { slug: 'made-here', name: 'Made here' })
    expect(created.body.error).toBeUndefined()
    await pushMain('Add made-here', { objects: [workflow('made-here', {}), codeFlow('return 3')] })
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error()
    expect(result.objects.find((o) => o.slug === 'made-here')).toMatchObject({
      outcome: 'problem',
      problems: [expect.objectContaining({ code: 'not_protected' })],
    })
    expect(result.objects.find((o) => o.slug === 'sync-orders')?.outcome).toBe('released')
    const [madeHere] = await env.db.select().from(workflows).where(eq(workflows.slug, 'made-here'))
    expect(madeHere).toMatchObject({ gitProtected: false, liveReleaseId: null })
  })

  it('flags a directory that left the branch, and keeps the object', async () => {
    await pushMain('Remove the app', { remove: ['apps/order-admin', 'workflows/made-here'] })
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error()
    expect(byKey(result.objects)).toMatchObject({
      'app:order-admin': 'missing',
      'workflow:made-here': 'missing',
    })
    const [kept] = await env.db.select().from(apps).where(eq(apps.slug, 'order-admin'))
    expect(kept!.liveReleaseId).not.toBeNull()
    const rows = await env.db.select().from(gitObjects).where(eq(gitObjects.slug, 'order-admin'))
    expect(rows[0]).toMatchObject({ status: 'missing', treeSha: null })
    // Still missing next time; not reported again.
    await pushMain('Unrelated', { files: { 'README.md': 'hi\n' } })
    const again = await deploy()
    if (again.status !== 'deployed') throw new Error()
    expect(again.objects.filter((o) => o.outcome === 'missing')).toEqual([])
  })

  it('deploys nothing from a repo without ow.json', async () => {
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    await pushMain('Drop the manifest', { remove: ['ow.json'], objects: [codeFlow('return 4')] })
    const result = await deploy()
    expect(result).toMatchObject({ status: 'deployed', ok: false, objects: [] })
    if (result.status !== 'deployed') throw new Error()
    expect(result.problems[0]).toMatchObject({ path: 'ow.json', code: 'unsupported_format' })
    const [same] = await env.db.select().from(workflows).where(eq(workflows.slug, 'sync-orders'))
    expect(same!.liveReleaseId).toBe(flow!.liveReleaseId)
    await pushMain('Restore the manifest', { files: { 'ow.json': manifestFile() } })
    const restored = await deploy()
    if (restored.status !== 'deployed') throw new Error()
    expect(restored.objects.find((o) => o.slug === 'sync-orders')?.outcome).toBe('released')
  })

  it('runs one deploy at a time; a request while busy makes it go again', async () => {
    await pushMain('Another change', { objects: [codeFlow('return 5')] })
    const [a, b] = await Promise.all([deploy(), runGitDeploy(env.db, env.config, { trigger: 'webhook' })])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual(['busy', 'deployed'])

    // Another process holds the lease: this one is busy, and its request waits for the holder.
    await env.db.update(gitSettings).set({ deployLeaseUntil: new Date(Date.now() + 60_000) })
    expect(await requestGitDeploy(env.db, env.config, { trigger: 'manual' })).toEqual({ status: 'busy' })
    // The holder ends its round: it keeps the lease and goes again, as the one who asked would have.
    expect(await handBackLease(env.db)).toEqual({ again: true, by: 'manual' })
    const [kept] = await env.db.select().from(gitSettings)
    expect(kept!.deployLeaseUntil!.getTime()).toBeGreaterThan(Date.now())
    expect(kept).toMatchObject({ deployRequestedAt: null, deployRequestedBy: null })
    expect(await handBackLease(env.db)).toEqual({ again: false, by: null })
    const [released] = await env.db.select().from(gitSettings)
    expect(released!.deployLeaseUntil).toBeNull()
  })

  it('brings back an object deleted on the instance', async () => {
    const [child] = await env.db.select().from(workflows).where(eq(workflows.slug, 'z-child'))
    await env.db.delete(workflows).where(eq(workflows.id, child!.id))
    await pushMain('Unrelated again', { files: { 'README.md': 'hello\n' } })
    const result = await deploy()
    if (result.status !== 'deployed') throw new Error()
    expect(result.objects.find((o) => o.slug === 'z-child')?.outcome).toBe('created')
    const [back] = await env.db.select().from(workflows).where(eq(workflows.slug, 'z-child'))
    expect(back).toMatchObject({ gitProtected: true })
    expect(back!.id).not.toBe(child!.id)
  })

  it('reports a branch it cannot read, and recovers', async () => {
    const [settings] = await env.db.select().from(gitSettings)
    await env.db.update(gitSettings).set({ repoUrl: `file://${join(dir, 'gone.git')}` })
    const result = await deploy()
    expect(result.status).toBe('failed')
    const [failed] = await env.db.select().from(gitSettings)
    expect(failed!.lastError).toMatch(/git fetch failed/)
    await env.db.update(gitSettings).set({ repoUrl: settings!.repoUrl })
    expect((await deploy()).status).toBe('up_to_date')
    const [ok] = await env.db.select().from(gitSettings)
    expect(ok!.lastError).toBeNull()
  })
})

describe('the push webhook', () => {
  const sign = (body: string, secret = HOOK_SECRET) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const post = (body: string, headers: Record<string, string>) =>
    env.app.inject({
      method: 'POST',
      url: '/api/git/webhook',
      payload: body,
      headers: { 'content-type': 'application/json', ...headers },
    })

  it('needs a valid signature', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' })
    expect((await post(body, { 'x-github-event': 'push' })).statusCode).toBe(401)
    expect(
      (await post(body, { 'x-github-event': 'push', 'x-hub-signature-256': sign(body, 'wrong') })).statusCode,
    ).toBe(401)
    expect(
      (await post(`${body} `, { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) })).statusCode,
    ).toBe(401)
  })

  it('answers pings, and ignores other events and branches', async () => {
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' })
    expect(
      (await post(ping, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(ping) })).json(),
    ).toEqual({
      ok: true,
    })
    const other = JSON.stringify({ ref: 'refs/heads/feature' })
    const res = await post(other, { 'x-github-event': 'push', 'x-hub-signature-256': sign(other) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ignored: 'Only pushes to main deploy' })
    const issue = JSON.stringify({ action: 'opened' })
    expect(
      (await post(issue, { 'x-github-event': 'issues', 'x-hub-signature-256': sign(issue) })).statusCode,
    ).toBe(200)
  })

  it('deploys on a push to the branch, JSON or form-encoded', async () => {
    const commit = await pushMain('Pushed with a webhook', { objects: [codeFlow('return 7')] })
    const json = JSON.stringify({ ref: 'refs/heads/main', after: commit })
    const res = await post(json, { 'x-github-event': 'push', 'x-hub-signature-256': sign(json) })
    expect(res.statusCode).toBe(202)
    await expect
      .poll(async () => (await env.db.select().from(gitSettings))[0]!.deployedCommit, { timeout: 10_000 })
      .toBe(commit)
    const [deployRow] = await env.db.select().from(gitDeploys).where(eq(gitDeploys.commit, commit))
    expect(deployRow!.trigger).toBe('webhook')

    const next = await pushMain('Pushed as a form', { objects: [codeFlow('return 8')] })
    const form = `payload=${encodeURIComponent(JSON.stringify({ ref: 'refs/heads/main' }))}`
    const formRes = await env.app.inject({
      method: 'POST',
      url: '/api/git/webhook',
      payload: form,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-github-event': 'push',
        'x-hub-signature-256': sign(form),
      },
    })
    expect(formRes.statusCode).toBe(202)
    await expect
      .poll(async () => (await env.db.select().from(gitSettings))[0]!.deployedCommit, { timeout: 10_000 })
      .toBe(next)
  })

  it('is not there without a webhook secret', async () => {
    const [settings] = await env.db.select().from(gitSettings)
    await admin.mutate('git.saveSettings', { repoUrl: settings!.repoUrl, webhookSecret: null })
    const body = JSON.stringify({ ref: 'refs/heads/main' })
    expect(
      (await post(body, { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) })).statusCode,
    ).toBe(404)
  })
})
