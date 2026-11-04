/**
 * Package indexes on the server (M32, docs/architecture.md §2.35): an admin defines them with a password in a
 * secret config var; a workflow's `settings.python.index` picks one; draft runs, publishing and live runs resolve
 * and install from it; sdist-only packages come along. Against a real builder, executor and two local indexes.
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
import { auditEvents, createDb, environments, pythonEnvs, workflowReleases, workflows } from '@ow/db'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const available = executorAvailable() && !process.env.PYTHON_EXECUTOR_TEST_URL
const PASSWORD = 'index-password-for-tests'

describe.skipIf(!available)('package indexes on the server', { timeout: 120_000 }, () => {
  let publicIndex: TestIndex
  let privateIndex: TestIndex
  let builder: TestBuilder
  let executor: TestExecutor
  let volume: ReturnType<typeof testEnvsVolume>
  let env: TestEnv
  let admin: ReturnType<typeof trpc>
  let member: ReturnType<typeof trpc>
  let cookie: string
  let stopWorker: () => Promise<void>

  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  const data = (res: { status: number; body: { result?: { data: any }; error?: { message: string } } }) => {
    if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
    return res.body.result.data
  }
  const failure = (res: { status: number; body: { error?: { message: string } } }) => {
    if (!res.body.error) throw new Error(`Expected the call to fail (${res.status})`)
    return { status: res.status, message: res.body.error.message }
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
    const deadline = Date.now() + 120_000
    for (;;) {
      const { body } = await rest('GET', `/runs/${id}`)
      if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
      if (Date.now() > deadline) throw new Error(`run ${id} still ${body.run.status}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const workflowWith = async (
    slug: string,
    python: { requirements: string[]; index?: string },
    code: string,
  ) => {
    const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
    data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          settings: { python },
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            // A minute: the block's timeout counts its wait for the packages (an sdist's build among them).
            {
              name: 'use',
              type: 'code',
              config: { code, language: 'python' },
              settings: { timeoutMs: 60_000 },
            },
            { name: 'reply', type: 'response', config: { body: '{{ use.data }}' } },
          ],
          edges: [
            { from: 'startTrigger', port: 'out', to: 'use' },
            { from: 'use', port: 'out', to: 'reply' },
          ],
        },
      }),
    )
    return created.id as string
  }
  const run = async (slug: string, version?: 'live') => {
    const started = await rest('POST', `/workflows/${slug}/runs`, { input: {}, ...(version && { version }) })
    expect(started.status).toBe(202)
    return waitForRun(started.body.run.id)
  }
  const indexFields = (overrides: object = {}) => ({
    name: 'Private PyPI',
    url: privateIndex.url,
    username: 'ci',
    passwordConfigVar: 'PRIVATE_PYPI_PASSWORD',
    mode: 'extra' as const,
    ...overrides,
  })
  const IMPORTS = 'import owtest_private, owtest_psrc\nreturn [owtest_private.SAUCE, owtest_psrc.P]'

  beforeAll(async () => {
    publicIndex = await startTestIndex([
      { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
    ])
    privateIndex = await startTestIndex(
      [
        {
          name: 'owtest-private',
          version: '1.0.0',
          requires: ['owtest-b'],
          files: { 'owtest_private/__init__.py': 'SAUCE = 42\n' },
        },
        // No wheel: built from its sdist.
        { name: 'owtest-psrc', version: '2.0.0', files: { 'owtest_psrc.py': 'P = 2\n' }, sdist: {} },
      ],
      { auth: { username: 'ci', password: PASSWORD } },
    )
    volume = testEnvsVolume()
    builder = await startTestBuilder({ indexUrl: publicIndex.url, envsVolume: volume.name })
    executor = await startTestExecutor({ envsVolume: volume.name, env: { PYTHON_WARM_JAILS: '0' } })
    env = await startTestApp({
      PYTHON_EXECUTOR_URL: executor.url,
      PYTHON_EXECUTOR_TOKEN: executor.token,
      PYTHON_BUILDER_URL: builder.url,
      PYTHON_BUILDER_TOKEN: builder.token,
    })
    await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
    await createLocalUser(env.db, 'member@optiply.nl')
    cookie = await login(env.app, 'admin@optiply.nl')
    admin = trpc(env.app, cookie)
    member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
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
    // The password as a secret config var, in the default environment.
    const [defaultEnv] = await env.db.select().from(environments).where(eq(environments.isDefault, true))
    const secret = data(
      await admin.mutate('configVars.create', { name: 'PRIVATE_PYPI_PASSWORD', isSecret: true }),
    )
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: secret.id,
        environmentId: defaultEnv!.id,
        value: PASSWORD,
      }),
    )
    data(await admin.mutate('configVars.create', { name: 'NOT_SECRET', isSecret: false }))
  })
  afterAll(async () => {
    await stopWorker?.()
    await env?.stop()
    await executor?.stop()
    await builder?.stop()
    await privateIndex?.stop()
    await publicIndex?.stop()
    volume?.remove()
  })

  it('lets admins define and test an index, its password a secret config var that never comes back', async () => {
    expect(
      failure(await member.mutate('pythonIndexes.create', { slug: 'nope', ...indexFields() })).status,
    ).toBe(403)
    expect(
      failure(
        await admin.mutate('pythonIndexes.create', {
          slug: 'x',
          ...indexFields({ passwordConfigVar: 'NOT_SECRET' }),
        }),
      ).message,
    ).toContain("NOT_SECRET isn't one")
    expect(
      failure(
        await admin.mutate('pythonIndexes.create', {
          slug: 'x',
          ...indexFields({ url: 'https://u:p@x.com/simple' }),
        }),
      ).status,
    ).toBe(400)

    expect(data(await admin.mutate('pythonIndexes.test', indexFields()))).toMatchObject({
      ok: true,
      status: 200,
    })
    expect(
      data(
        await admin.mutate('pythonIndexes.test', indexFields({ username: null, passwordConfigVar: null })),
      ),
    ).toMatchObject({ ok: false, status: 401 })

    const { id } = data(await admin.mutate('pythonIndexes.create', { slug: 'private', ...indexFields() }))
    expect(
      failure(await admin.mutate('pythonIndexes.create', { slug: 'private', ...indexFields() })).message,
    ).toContain('already exists')
    const listed = data(await member.query('pythonIndexes.list'))
    expect(listed).toEqual([
      { id, slug: 'private', name: 'Private PyPI', url: privateIndex.url, mode: 'extra', signedIn: true },
    ])
    expect(JSON.stringify(data(await admin.query('pythonIndexes.list')))).not.toContain(PASSWORD)
    const audited = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'python.index_created'))
    expect(audited).toHaveLength(1)
    expect(JSON.stringify(audited)).not.toContain(PASSWORD)
  })

  it('runs a draft with a private package and an sdist-only one, and only from its index', async () => {
    await workflowWith(
      'idx-draft',
      { requirements: ['owtest-private', 'owtest-psrc'], index: 'private' },
      IMPORTS,
    )
    expect(await run('idx-draft')).toMatchObject({ status: 'succeeded', response: { body: [42, 2] } })
    const [row] = await env.db.select().from(pythonEnvs)
    expect(row!.indexId).not.toBeNull()
    expect(row!.lock!.packages).toEqual([
      expect.objectContaining({ name: 'owtest-b' }),
      expect.objectContaining({ name: 'owtest-private', index: 'private' }),
      expect.objectContaining({ name: 'owtest-psrc', index: 'private', source: 'sdist' }),
    ])
    expect(row!.lock!.packages[0]).not.toHaveProperty('index')
    expect(JSON.stringify(row)).not.toContain(PASSWORD)

    // The same requirements without the index: the default index lacks them.
    await workflowWith('idx-none', { requirements: ['owtest-private'] }, 'import owtest_private\nreturn 1')
    const without = await run('idx-none')
    expect(without).toMatchObject({ status: 'failed', error: { code: 'python_packages' } })

    // The editor's state, with and without the index.
    const flow = (await env.db.select().from(workflows).where(eq(workflows.slug, 'idx-draft')))[0]!
    const state = data(
      await admin.query('workflows.pythonEnv', {
        workflowId: flow.id,
        requirements: ['owtest-private', 'owtest-psrc'],
        index: 'private',
      }),
    )
    expect(state).toMatchObject({
      state: 'ready',
      details: [{}, { index: 'private' }, { index: 'private', source: 'sdist' }],
    })
    expect(
      data(
        await admin.query('workflows.pythonEnv', {
          workflowId: flow.id,
          requirements: ['owtest-private'],
          index: 'missing',
        }),
      ),
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('"missing" doesn\'t exist') })
  })

  it('publishes with a lock naming the index, which live runs install again from it', async () => {
    const id = await workflowWith(
      'idx-live',
      { requirements: ['owtest-private', 'owtest-psrc'], index: 'private' },
      IMPORTS,
    )
    const [flow] = await env.db.select().from(workflows).where(eq(workflows.id, id))
    const release = data(
      await admin.mutate('releases.publish', { workflowId: id, draftRevision: flow!.draftRevision }),
    )
    const [stored] = await env.db.select().from(workflowReleases).where(eq(workflowReleases.id, release.id))
    expect(stored!.pythonLock!.packages.map((p) => p.index ?? null)).toEqual([null, 'private', 'private'])
    // Nothing kept but the release's lock: the env and the built wheel are installed and built again.
    await env.db.delete(pythonEnvs)
    execFileSync('docker', ['exec', builder.container, 'sh', '-c', 'rm -rf /envs/[0-9a-f]* /envs/.wheels'])
    expect(await run('idx-live', 'live')).toMatchObject({ status: 'succeeded', response: { body: [42, 2] } })
  })

  it("fails a run whose index is gone or whose password has no value, and refuses deleting one that's used", async () => {
    const { id } = (data(await admin.query('pythonIndexes.list')) as { id: string; slug: string }[]).find(
      (i) => i.slug === 'private',
    )!
    expect(failure(await admin.mutate('pythonIndexes.delete', { id })).message).toContain('idx-draft')

    await workflowWith('idx-unknown', { requirements: ['owtest-private'], index: 'nowhere' }, 'return 1')
    expect(await run('idx-unknown')).toMatchObject({
      status: 'failed',
      error: { code: 'python_packages', message: expect.stringContaining('"nowhere"') },
    })

    // Its password moved to a var without a value: the run says which.
    data(await admin.mutate('configVars.create', { name: 'EMPTY_SECRET', isSecret: true }))
    data(
      await admin.mutate('pythonIndexes.update', {
        id,
        ...indexFields({ passwordConfigVar: 'EMPTY_SECRET' }),
      }),
    )
    expect(await env.db.select().from(pythonEnvs).where(eq(pythonEnvs.indexId, id))).toEqual([])
    expect(await run('idx-draft')).toMatchObject({
      status: 'failed',
      error: { code: 'python_packages', message: expect.stringContaining('EMPTY_SECRET') },
    })
    data(await admin.mutate('pythonIndexes.update', { id, ...indexFields() }))
    expect(await run('idx-draft')).toMatchObject({ status: 'succeeded' })
  })
})
