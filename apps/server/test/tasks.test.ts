import { auditEvents, createDb } from '@ow/db'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// User Tasks through the API: who sees and completes them, checking answers, and the run resuming on a worker.
let env: TestEnv
let admin: ReturnType<typeof trpc>
let ana: ReturnType<typeof trpc>
let bob: ReturnType<typeof trpc>
let adminCookie: string
let stopWorker: () => Promise<void>

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

async function rest(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: adminCookie },
    ...(payload !== undefined && { payload: payload as object }),
  })
  return { status: res.statusCode, body: res.json() }
}

async function runStatus(id: string): Promise<string> {
  return (await rest('GET', `/runs/${id}`)).body.run.status
}

async function until<T>(check: () => Promise<T | false | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function workflowWith(slug: string, task: object) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          task,
          { name: 'reply', type: 'response', config: { status: '200', body: '{{ approval.data }}' } },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'approval' },
          { from: 'approval', port: 'out', to: 'reply' },
        ],
      },
    }),
  )
}

const approval = (assignees: object) => ({
  name: 'approval',
  type: 'userTask',
  config: {
    title: 'Approve order {{ startTrigger.data.order }}',
    description: 'Check the stock first.',
    assignees,
    fields: [
      { name: 'note', label: 'Note', type: 'text', required: true },
      { name: 'qty', label: 'Quantity', type: 'number', default: '{{ startTrigger.data.qty }}' },
    ],
    outcomes: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
  },
})

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const anaUser = await createLocalUser(env.db, 'ana@optiply.nl')
  await createLocalUser(env.db, 'bob@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, adminCookie)
  ana = trpc(env.app, await login(env.app, 'ana@optiply.nl'))
  bob = trpc(env.app, await login(env.app, 'bob@optiply.nl'))
  const finance = data(await admin.mutate('groups.create', { name: 'Finance' }))
  await admin.mutate('groups.addMember', { groupId: finance.id, userId: anaUser.id })

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
})

describe('User Tasks', () => {
  it('shows a run’s task to its assignees, checks the answer and resumes the run', async () => {
    await workflowWith('orders', approval({ groups: ['Finance'] }))
    const started = await rest('POST', '/workflows/orders/runs', { input: { order: 'A-17', qty: 3 } })
    expect(started.status).toBe(202)
    const runId = started.body.run.id as string
    await until(async () => (await runStatus(runId)) === 'waiting')

    // Ana is in Finance: the task is in her inbox, and she can complete it.
    expect(data(await ana.query('tasks.openCount'))).toBe(1)
    const [listed] = data(await ana.query('tasks.list', {}))
    expect(listed).toMatchObject({
      title: 'Approve order A-17',
      status: 'open',
      runId,
      runStatus: 'waiting',
      workflow: { slug: 'orders', name: 'orders' },
      environment: 'production',
      assignees: { users: [], groups: ['Finance'] },
      canComplete: true,
    })
    expect(listed).not.toHaveProperty('fields')
    const task = data(await ana.query('tasks.get', { id: listed.id }))
    expect(task).toMatchObject({
      description: 'Check the stock first.',
      fields: [
        { name: 'note', label: 'Note', type: 'text', required: true },
        { name: 'qty', label: 'Quantity', type: 'number', default: 3 },
      ],
      outcomes: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    })

    // Bob isn't assigned and has no access to the workflow: for him the task doesn't exist.
    expect(data(await bob.query('tasks.list', {}))).toEqual([])
    expect(data(await bob.query('tasks.openCount'))).toBe(0)
    expect((await bob.query('tasks.get', { id: task.id })).status).toBe(404)
    expect((await bob.mutate('tasks.complete', { id: task.id, outcome: 'approve' })).status).toBe(404)

    // The answer is checked against the task's fields.
    const invalid = await ana.mutate('tasks.complete', {
      id: task.id,
      outcome: 'approve',
      values: { qty: 'many' },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error?.message).toBe(
      'Invalid answer: note: Note is required; qty: Quantity must be a number',
    )
    const done = data(
      await ana.mutate('tasks.complete', {
        id: task.id,
        outcome: 'approve',
        values: { note: 'In stock', qty: 3 },
      }),
    )
    expect(done).toMatchObject({
      status: 'completed',
      outcome: 'approve',
      values: { note: 'In stock', qty: 3 },
      completedBy: { email: 'ana@optiply.nl' },
      canComplete: false,
    })

    // The run resumes on the worker and replies with the answer.
    const run = await until(async () => {
      const { body } = await rest('GET', `/runs/${runId}`)
      return body.run.status === 'succeeded' && body.run
    })
    expect(run.response.body).toMatchObject({
      outcome: 'approve',
      values: { note: 'In stock', qty: 3 },
      completedBy: { email: 'ana@optiply.nl', name: expect.any(String) },
    })
    expect(data(await ana.query('tasks.openCount'))).toBe(0)
    expect(data(await ana.query('tasks.list', { status: 'closed' }))).toMatchObject([
      { id: task.id, status: 'completed', completedBy: { email: 'ana@optiply.nl' } },
    ])
    expect(
      (await ana.mutate('tasks.complete', { id: task.id, outcome: 'reject', values: { note: 'x' } })).status,
    ).toBe(409)
    const audit = await env.db.select().from(auditEvents).where(eq(auditEvents.action, 'task.complete'))
    expect(audit).toMatchObject([
      { metadata: { taskId: task.id, runId, block: 'approval', outcome: 'approve' } },
    ])
  })

  it('lets admins see every task, and complete it, while it isn’t theirs', async () => {
    await workflowWith('invoices', approval({ users: ['ana@optiply.nl'] }))
    const { body } = await rest('POST', '/workflows/invoices/runs', { input: { order: 'B-2', qty: 1 } })
    await until(async () => (await runStatus(body.run.id)) === 'waiting')
    // Not in the admin's own inbox, but in "all".
    expect(data(await admin.query('tasks.list', {}))).toEqual([])
    const [task] = data(await admin.query('tasks.list', { scope: 'all' }))
    expect(task).toMatchObject({
      title: 'Approve order B-2',
      assignees: { users: [{ email: 'ana@optiply.nl' }] },
    })
    // Bob asking for "all" still only sees his own (none).
    expect(data(await bob.query('tasks.list', { scope: 'all' }))).toEqual([])
    data(
      await admin.mutate('tasks.complete', { id: task.id, outcome: 'reject', values: { note: 'Duplicate' } }),
    )
    await until(async () => (await runStatus(body.run.id)) === 'succeeded')
  })

  it('closes the task when its run is cancelled', async () => {
    await workflowWith('refunds', approval({ groups: ['Finance'] }))
    const { body } = await rest('POST', '/workflows/refunds/runs', { input: { order: 'C-9' } })
    await until(async () => (await runStatus(body.run.id)) === 'waiting')
    const [task] = data(await ana.query('tasks.list', {}))
    expect((await rest('POST', `/runs/${body.run.id}/cancel`)).status).toBe(200)
    expect(data(await ana.query('tasks.get', { id: task.id }))).toMatchObject({
      status: 'cancelled',
      canComplete: false,
    })
    expect(
      (await ana.mutate('tasks.complete', { id: task.id, outcome: 'approve', values: { note: 'x' } })).status,
    ).toBe(409)
  })

  it('refuses runs whose tasks name people or groups that don’t exist', async () => {
    await workflowWith(
      'ghosts',
      approval({ users: ['nobody@optiply.nl'], groups: ['Ghosts', '{{ "later" }}'] }),
    )
    const refused = await rest('POST', '/workflows/ghosts/runs', {})
    expect(refused.status).toBe(400)
    expect(refused.body.error.details.diagnostics).toMatchObject([
      { code: 'unknown_assignee', message: 'No user has the email nobody@optiply.nl', block: 'approval' },
      { code: 'unknown_assignee', message: 'No group is named "Ghosts"', block: 'approval' },
    ])
  })
})
