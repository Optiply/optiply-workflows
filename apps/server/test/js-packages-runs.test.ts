/**
 * A workflow's JavaScript packages through the server: draft runs bundle and import them, a release keeps its lock
 * and bundle (rebuilt from the lock when the bundle is gone), publishing refuses packages that can't be installed,
 * a rollback brings its own bundle back. With a local npm registry and a real worker.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditEvents, createDb, jsBundles, workflowReleases, workflows } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'
import { startTestRegistry, type TestRegistry } from './npm-registry'

describe("a workflow's JavaScript packages on the server", { timeout: 120_000 }, () => {
  let registry: TestRegistry
  let work: string
  let env: TestEnv
  let admin: ReturnType<typeof trpc>
  let cookie: string
  let stopWorker: () => Promise<void>

  const data = (res: {
    status: number
    body: { result?: { data: unknown }; error?: { message: string } }
  }) => {
    if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
    // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
    return res.body.result.data as any
  }
  const rest = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await env.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie },
      ...(payload !== undefined && { payload: payload as object }),
    })
    return { status: res.statusCode, body: res.json() }
  }
  const waitForRun = async (id: string) => {
    const deadline = Date.now() + 60_000
    for (;;) {
      const { body } = await rest('GET', `/runs/${id}`)
      if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
      if (Date.now() > deadline) throw new Error(`run ${id} still ${body.run.status}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const definition = (packages: string[], code: string) => ({
    schemaVersion: 1,
    settings: { javascript: { packages } },
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      { name: 'use', type: 'code', config: { code }, settings: { timeoutMs: 60_000 } },
      { name: 'reply', type: 'response', config: { body: '{{ use.data }}' } },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'use' },
      { from: 'use', port: 'out', to: 'reply' },
    ],
  })
  const workflowWith = async (
    slug: string,
    packages: string[],
    code = "import pad from 'pad'\nreturn pad('x')",
  ) => {
    const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
    data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: definition(packages, code),
      }),
    )
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, slug))
    return flow!
  }
  const run = async (slug: string, version?: 'live') => {
    const started = await rest('POST', `/workflows/${slug}/runs`, { input: {}, ...(version && { version }) })
    expect(started.status).toBe(202)
    return waitForRun(started.body.run.id)
  }
  const publish = async (flow: { id: string; draftRevision: number }) =>
    admin.mutate('releases.publish', { workflowId: flow.id, draftRevision: flow.draftRevision })

  beforeAll(async () => {
    registry = await startTestRegistry([
      { name: 'pad', version: '1.0.0', files: { 'index.js': 'module.exports = (s) => `[${s}]`' } },
      { name: 'pad', version: '1.1.0', files: { 'index.js': 'module.exports = (s) => `<${s}>`' } },
    ])
    work = await mkdtemp(join(tmpdir(), 'ow-js-runs-test-'))
    env = await startTestApp({ NPM_REGISTRY_URL: registry.url, COMPONENT_BUILD_DIR: work })
    await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
    cookie = await login(env.app, 'admin@optiply.nl')
    admin = trpc(env.app, cookie)
    const workerDb = createDb(env.databaseUrl, { max: 5 })
    const worker = await startWorker({
      db: workerDb.db,
      sql: workerDb.sql,
      config: env.config,
      log: pino({ level: 'silent' }),
    })
    stopWorker = async () => {
      await worker.stop()
      await workerDb.close()
    }
  }, 60_000)
  afterAll(async () => {
    await stopWorker?.()
    await env?.stop()
    await registry?.stop()
    await rm(work, { recursive: true, force: true })
  })

  it('bundles the packages for a draft run, whose code imports them', async () => {
    await workflowWith('js-run', ['pad@^1'])
    expect(await run('js-run')).toMatchObject({ status: 'succeeded', response: { body: '<x>' } })
    // The next run finds the bundle.
    expect(await run('js-run')).toMatchObject({ status: 'succeeded', response: { body: '<x>' } })
    expect(await env.db.select().from(jsBundles)).toHaveLength(1)
  })

  it('keeps the lock and bundle on the release; a live run rebuilds from the lock when the bundle is gone', async () => {
    const flow = await workflowWith('js-live', ['pad@^1'])
    const release = data(await publish(flow))
    const [stored] = await env.db.select().from(workflowReleases).where(eq(workflowReleases.id, release.id))
    const [bundle] = await env.db
      .select()
      .from(jsBundles)
      .where(eq(jsBundles.bundleHash, stored!.jsBundleHash!))
    expect(bundle).toMatchObject({ state: 'ready', versions: { pad: '1.1.0' } })
    expect(stored!.jsLock).toBe(bundle!.lock)
    expect(stored!.jsLock).toContain('"node_modules/pad"')
    // The lock stays on the server (review fix): a release's details leave it out.
    const shown = data(await admin.query('releases.get', { workflowId: flow.id, id: release.id }))
    expect(shown).not.toHaveProperty('jsLock')
    expect(shown.jsBundleHash).toBe(stored!.jsBundleHash)

    expect(await run('js-live', 'live')).toMatchObject({ status: 'succeeded', response: { body: '<x>' } })
    await env.db.delete(jsBundles)
    expect(await run('js-live', 'live')).toMatchObject({ status: 'succeeded', response: { body: '<x>' } })
    const audits = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'js.bundle_built'), eq(auditEvents.objectId, flow.id)))
    // The draft's bundle was built (and audited) by the first test's workflow, the same packages: here only the
    // rebuild from the release's lock.
    expect(audits.map((a) => (a.metadata as { fromLock?: boolean }).fromLock ?? false)).toEqual([true])
  })

  it("refuses to publish packages that can't be installed, saying why; a draft run's block says so too", async () => {
    const flow = await workflowWith(
      'js-bad',
      ['no-such-package'],
      "import x from 'no-such-package'\nreturn 1",
    )
    const res = await publish(flow)
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain("The JavaScript packages couldn't be installed")
    const failed = await run('js-bad', undefined)
    expect(failed).toMatchObject({
      status: 'failed',
      error: { block: 'use', code: 'js_packages', message: expect.stringContaining("couldn't be installed") },
    })
  })

  it('brings back the bundle of a release it rolls back to', async () => {
    const flow = await workflowWith('js-rollback', ['pad@1.0.0'])
    const first = data(await publish(flow))
    const saved = data(
      await admin.mutate('workflows.saveDraft', {
        id: flow.id,
        revision: flow.draftRevision,
        definition: definition(['pad@1.1.0'], "import pad from 'pad'\nreturn pad('x')"),
      }),
    )
    data(await admin.mutate('releases.publish', { workflowId: flow.id, draftRevision: saved.revision }))
    expect(await run('js-rollback', 'live')).toMatchObject({ response: { body: '<x>' } })
    await env.db.delete(jsBundles)
    data(await admin.mutate('releases.setLive', { workflowId: flow.id, releaseId: first.id }))
    expect(await run('js-rollback', 'live')).toMatchObject({ status: 'succeeded', response: { body: '[x]' } })
    const [row] = await env.db.select().from(workflowReleases).where(eq(workflowReleases.id, first.id))
    expect(
      await env.db.select().from(jsBundles).where(eq(jsBundles.bundleHash, row!.jsBundleHash!)),
    ).toHaveLength(1)
  })

  it('needs no bundle for a workflow without packages', async () => {
    await workflowWith('js-none', [], 'return 1 + 1')
    const before = (await env.db.select().from(jsBundles)).length
    expect(await run('js-none')).toMatchObject({ status: 'succeeded', response: { body: 2 } })
    expect(await env.db.select().from(jsBundles)).toHaveLength(before)
    // Packages listed, but no code imports them: nothing is built (review fix).
    await workflowWith('js-unused', ['pad@1.0.0-nothing-has-this'], 'return 3')
    expect(await run('js-unused')).toMatchObject({ status: 'succeeded', response: { body: 3 } })
    expect(await env.db.select().from(jsBundles)).toHaveLength(before)
  })
})
