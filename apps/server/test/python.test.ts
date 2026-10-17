/**
 * Python code blocks through the server (M12): draft runs on a worker, the syntax check before runs and publishing,
 * `workflows.checkPython` for the editor, and an instance without an executor. Against the real code executor.
 */
import { executorAvailable, startTestExecutor, type TestExecutor } from '@ow/code-executor/testing'
import { createDb } from '@ow/db'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configurePython } from '../src/services/python'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const available = executorAvailable()

describe.skipIf(!available)('Python on the server', () => {
  let executor: TestExecutor
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
    const deadline = Date.now() + 20_000
    for (;;) {
      const { body } = await rest('GET', `/runs/${id}`)
      if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
      if (Date.now() > deadline) throw new Error(`run ${id} still ${body.run.status}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const workflowWith = async (slug: string, blocks: object[], edges: [string, string][]) => {
    const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
    const saved = data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
          edges: edges.map(([from, to]) => ({ from, port: 'out', to })),
        },
      }),
    )
    return { id: created.id as string, slug, revision: saved.revision as number }
  }
  const python = (name: string, code: string) => ({
    name,
    type: 'code',
    config: { code, language: 'python' },
  })

  beforeAll(async () => {
    executor = await startTestExecutor()
    env = await startTestApp({ PYTHON_EXECUTOR_URL: executor.url, PYTHON_EXECUTOR_TOKEN: executor.token })
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
  })

  it('runs a draft with a Python block on a worker, with its logs', async () => {
    const wf = await workflowWith(
      'py-run',
      [
        python(
          'shape',
          'import pandas as pd\nrows = pd.DataFrame(startTrigger.data["rows"])\nprint("rows", len(rows))\nreturn {"total": int(rows.n.sum())}',
        ),
        { name: 'reply', type: 'response', config: { body: '{{ shape.data }}' } },
      ],
      [
        ['startTrigger', 'shape'],
        ['shape', 'reply'],
      ],
    )
    const started = await rest('POST', `/workflows/${wf.slug}/runs`, {
      input: { rows: [{ n: 2 }, { n: 5 }] },
    })
    expect(started.status).toBe(202)
    const run = await waitForRun(started.body.run.id)
    expect(run).toMatchObject({ status: 'succeeded', response: { body: { total: 7 } } })
    let logs = { logs: [] as { message: string }[] }
    for (let i = 0; i < 40 && !logs.logs.length; i++) {
      logs = (await rest('GET', `/runs/${run.id}/logs`)).body
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(logs.logs.map((l) => l.message)).toEqual(['rows 2'])
  })

  it("refuses to run or publish Python that doesn't compile, saying where", async () => {
    const wf = await workflowWith(
      'py-broken',
      [python('typo', 'x = 1\nreturn x +')],
      [['startTrigger', 'typo']],
    )
    const refused = await rest('POST', `/workflows/${wf.slug}/runs`, {})
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatchObject({ code: 'invalid_definition' })
    expect(refused.body.error.details.diagnostics).toEqual([
      expect.objectContaining({
        code: 'syntax',
        block: 'typo',
        path: ['blocks', 1, 'config', 'code'],
        message: 'SyntaxError: invalid syntax (line 2)',
        // Python points past the `+` at the end: the marker goes on the `+`.
        start: 15,
        end: 16,
      }),
    ])
    const publish = await admin.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision })
    expect(publish.body.error?.message).toContain('SyntaxError: invalid syntax (line 2)')
  })

  it('publishes valid Python, and runs the release', async () => {
    const wf = await workflowWith('py-live', [python('calc', 'return 6 * 7')], [['startTrigger', 'calc']])
    data(await admin.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision }))
    const started = await rest('POST', `/workflows/${wf.slug}/runs`, { version: 'live' })
    expect(started.status).toBe(202)
    const run = await waitForRun(started.body.run.id)
    expect(run.status).toBe('succeeded')
    const { body } = await rest('GET', `/runs/${run.id}/blocks/calc`)
    expect(body.block.data).toBe(42)
  })

  it('checks fields for the editor', async () => {
    const result = data(
      await admin.mutate('workflows.checkPython', {
        fields: [
          { id: 'a', code: 'return 1' },
          { id: 'b', code: 'if x\n  pass' },
        ],
      }),
    )
    expect(result).toEqual({
      available: true,
      problems: [{ id: 'b', message: "SyntaxError: expected ':'", line: 1, column: 5 }],
    })
  })

  it('says Python is unavailable without an executor', async () => {
    configurePython({})
    try {
      expect(data(await admin.mutate('workflows.checkPython', { fields: [{ id: 'a', code: 'x' }] }))).toEqual(
        {
          available: false,
          message: "Python isn't set up on this instance",
          problems: [],
        },
      )
      const wf = await workflowWith('py-nowhere', [python('p', 'return 1')], [['startTrigger', 'p']])
      const refused = await rest('POST', `/workflows/${wf.slug}/runs`, {})
      expect(refused.status).toBe(400)
      expect(refused.body.error.details.diagnostics).toEqual([
        expect.objectContaining({
          code: 'python_unavailable',
          block: 'p',
          message: "Python isn't set up on this instance (PYTHON_EXECUTOR_URL)",
        }),
      ])
    } finally {
      configurePython(env.config)
    }
  })
})
