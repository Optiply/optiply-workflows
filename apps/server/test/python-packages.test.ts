/**
 * A workflow's Python packages through the server (M23, docs/architecture.md §2.26): draft runs resolve and install
 * them with the real builder (from a local package index) and import them in the real executor, sharing the envs
 * volume as in Compose.
 */
import { execFileSync } from 'node:child_process'
import {
  executorAvailable,
  startTestBuilder,
  startTestExecutor,
  startTestIndex,
  type TestBuilder,
  type TestExecutor,
  type TestIndex,
  testEnvsVolume,
} from '@ow/code-executor/testing'
import { auditEvents, createDb, pythonEnvs, workflowReleases, workflows } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configurePython, pythonDiagnostics } from '../src/services/python'
import { configurePythonPackages, requirementsHash } from '../src/services/python-envs'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const available = executorAvailable() && !process.env.PYTHON_EXECUTOR_TEST_URL

describe.skipIf(!available)("a workflow's Python packages on the server", () => {
  let index: TestIndex
  let builder: TestBuilder
  let executor: TestExecutor
  let volume: ReturnType<typeof testEnvsVolume>
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
  const workflowWith = async (slug: string, requirements: string[], blocks: object[]) => {
    const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
    data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          settings: { python: { requirements } },
          blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
          edges: blocks.map((b, i) => ({
            from: i === 0 ? 'startTrigger' : (blocks[i - 1] as { name: string }).name,
            port: 'out',
            to: (b as { name: string }).name,
          })),
        },
      }),
    )
    return slug
  }
  const runDraft = async (slug: string) => {
    const started = await rest('POST', `/workflows/${slug}/runs`, { input: {} })
    expect(started.status).toBe(202)
    return waitForRun(started.body.run.id)
  }
  const python = (name: string, code: string) => ({
    name,
    type: 'code',
    config: { code, language: 'python' },
  })
  const reply = { name: 'reply', type: 'response', config: { body: '{{ use.data }}' } }
  const envRow = async (requirements: string[]) =>
    (
      await env.db
        .select()
        .from(pythonEnvs)
        .where(eq(pythonEnvs.requirementsHash, requirementsHash(requirements)))
    )[0]

  beforeAll(async () => {
    index = await startTestIndex([
      {
        name: 'owtest-a',
        version: '1.0.0',
        requires: ['owtest-b'],
        files: { 'owtest_a/__init__.py': 'from owtest_b import VERSION as B\nNAME = "a"\n' },
      },
      { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
    ])
    volume = testEnvsVolume()
    builder = await startTestBuilder({ indexUrl: index.url, envsVolume: volume.name })
    executor = await startTestExecutor({ envsVolume: volume.name, env: { PYTHON_WARM_JAILS: '1' } })
    env = await startTestApp({
      PYTHON_EXECUTOR_URL: executor.url,
      PYTHON_EXECUTOR_TOKEN: executor.token,
      PYTHON_BUILDER_URL: builder.url,
      PYTHON_BUILDER_TOKEN: builder.token,
    })
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
  })
  afterAll(async () => {
    await stopWorker?.()
    await env?.stop()
    await executor?.stop()
    await builder?.stop()
    await index?.stop()
    volume?.remove()
  })

  it('installs the packages for a draft run, which imports them; the next run reuses the lock', async () => {
    const slug = await workflowWith(
      'pkg-run',
      ['owtest-a'],
      [python('use', 'import owtest_a\nreturn {"name": owtest_a.NAME, "b": owtest_a.B}'), reply],
    )
    const run = await runDraft(slug)
    expect(run).toMatchObject({ status: 'succeeded', response: { body: { name: 'a', b: '1.0.0' } } })
    const row = await envRow(['owtest-a'])
    expect(row).toMatchObject({ state: 'ready', envId: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(row!.lock!.packages.map((p) => p.name)).toEqual(['owtest-a', 'owtest-b'])

    expect(await runDraft(slug)).toMatchObject({ status: 'succeeded' })
    const again = await envRow(['owtest-a'])
    expect(again!.builtAt).toEqual(row!.builtAt) // installed from the lock, not resolved again
    expect(again!.lastUsedAt.getTime()).toBeGreaterThan(row!.lastUsedAt.getTime())
  })

  it("fails the Python block with pip's reason when the packages can't be installed, and records it", async () => {
    const slug = await workflowWith('pkg-missing', ['owtest-nope'], [python('use', 'return 1'), reply])
    const run = await runDraft(slug)
    expect(run.status).toBe('failed')
    expect(run.error).toMatchObject({
      block: 'use',
      code: 'python_packages',
      message: expect.stringContaining("The workflow's Python packages couldn't be installed"),
    })
    expect(await envRow(['owtest-nope'])).toMatchObject({ state: 'failed', error: { kind: 'resolve' } })
  })

  it('installs nothing for a workflow without Python', async () => {
    const slug = await workflowWith(
      'pkg-no-python',
      ['owtest-b'],
      [{ name: 'use', type: 'code', config: { code: 'return 1' } }, reply],
    )
    expect(await runDraft(slug)).toMatchObject({ status: 'succeeded' })
    expect(await envRow(['owtest-b'])).toBeUndefined()
  })

  it('publishes with the lock, which live runs install even when the env and the draft record are gone', async () => {
    const slug = await workflowWith(
      'pkg-live',
      ['owtest-a'],
      [python('use', 'import owtest_a\nreturn {"b": owtest_a.B}'), reply],
    )
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, slug))
    const release = data(
      await admin.mutate('releases.publish', { workflowId: flow!.id, draftRevision: flow!.draftRevision }),
    )
    const [stored] = await env.db.select().from(workflowReleases).where(eq(workflowReleases.id, release.id))
    const row = await envRow(['owtest-a'])
    expect(stored!.pythonLock).toEqual(row!.lock)

    // Nothing left but the release's lock: it installs again.
    await env.db.delete(pythonEnvs)
    execFileSync('docker', ['exec', builder.container, 'sh', '-c', `rm -rf /envs/${row!.envId}`])
    const live = await rest('POST', `/workflows/${slug}/runs`, { input: {}, version: 'live' })
    expect(live.status).toBe(202)
    expect(await waitForRun(live.body.run.id)).toMatchObject({
      status: 'succeeded',
      response: { body: { b: '1.0.0' } },
    })
    expect(await envRow(['owtest-a'])).toBeUndefined() // the release's lock, not the draft's requirements
  })

  it("refuses to publish packages that can't be installed, saying why", async () => {
    const slug = await workflowWith('pkg-bad-publish', ['owtest-nope'], [python('use', 'return 1'), reply])
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, slug))
    const res = await admin.mutate('releases.publish', {
      workflowId: flow!.id,
      draftRevision: flow!.draftRevision,
    })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain("The workflow's Python packages couldn't be installed")
  })

  it('installs a release it rolls back to, and audits each new env', async () => {
    const slug = await workflowWith('pkg-rollback', ['owtest-b'], [python('use', 'return 1'), reply])
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.slug, slug))
    const first = data(
      await admin.mutate('releases.publish', { workflowId: flow!.id, draftRevision: flow!.draftRevision }),
    )
    const saved = data(
      await admin.mutate('workflows.saveDraft', {
        id: flow!.id,
        revision: flow!.draftRevision,
        definition: { ...flow!.draftDefinition, settings: { python: { requirements: ['owtest-a'] } } },
      }),
    )
    data(await admin.mutate('releases.publish', { workflowId: flow!.id, draftRevision: saved.revision }))
    const [firstRow] = await env.db.select().from(workflowReleases).where(eq(workflowReleases.id, first.id))
    expect(firstRow!.pythonLock!.packages.map((p) => p.name)).toEqual(['owtest-b'])
    const firstEnv = (await envRow(['owtest-b']))!.envId!
    execFileSync('docker', ['exec', builder.container, 'sh', '-c', 'rm -rf /envs/*'])
    data(await admin.mutate('releases.setLive', { workflowId: flow!.id, releaseId: first.id }))
    const envs = execFileSync('docker', ['exec', builder.container, 'ls', '/envs']).toString().split('\n')
    expect(envs).toContain(firstEnv)

    const audits = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'python.env_built'), eq(auditEvents.objectId, flow!.id)))
    expect(audits.map((a) => a.metadata)).toContainEqual(
      expect.objectContaining({ requirements: ['owtest-b'], packages: ['owtest-b==1.0.0'] }),
    )
  })

  it('refuses packages on an instance without a builder', async () => {
    const definition = {
      schemaVersion: 1,
      settings: { python: { requirements: ['owtest-a'] } },
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, python('use', 'return 1')],
      edges: [],
    } as never
    configurePythonPackages({})
    try {
      expect(await pythonDiagnostics(definition, { syntax: false })).toEqual([
        expect.objectContaining({
          code: 'python_packages_unavailable',
          path: ['settings', 'python', 'requirements'],
        }),
      ])
    } finally {
      configurePythonPackages(env.config)
      configurePython(env.config)
    }
    expect(await pythonDiagnostics(definition, { syntax: false })).toEqual([])
  })
})
