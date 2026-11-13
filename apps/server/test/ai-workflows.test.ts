import { type FakeAi, startFakeAi } from '@ow/connectors/testing'
import { createDb } from '@ow/db'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// AI queries in workflow runs (M35, docs/architecture.md §2.38): the answer as the block's data, a run log line per
// call (tokens, cost), prompts kept in the metadata unless the resource hides them, the run's token budget stopping a
// later call, and the metrics.

let env: TestEnv
let fake: FakeAi
let admin: ReturnType<typeof trpc>
let adminCookie: string
let prodId: string
let stopWorker: (() => Promise<void>) | undefined

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { status: number; body: { result?: { data: any }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
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

async function claude(slug: string, extra: Record<string, unknown> = {}) {
  const created = data(await admin.mutate('resources.create', { type: 'anthropic', name: slug, slug }))
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: created.id,
      environmentId: prodId,
      config: { baseUrl: fake.anthropicUrl, allowPrivateNetwork: true, ...extra },
      secrets: { apiKey: fake.anthropicKey },
    }),
  )
}

const ORDER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { customer: { type: 'string' }, quantity: { type: 'integer' } },
  required: ['customer', 'quantity'],
  additionalProperties: false,
})

/** startTrigger → extract → classify → summarize, each an AI query on `resource`. */
async function triage(slug: string, resource: string) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const query = (name: string, q: Record<string, unknown>) => ({
    name,
    type: 'resourceQuery',
    config: { resource, query: q },
  })
  data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          query('order', { action: 'extract', input: '{{ startTrigger.data.email }}', schema: ORDER_SCHEMA }),
          query('kind', {
            action: 'classify',
            input: '{{ startTrigger.data.email }}',
            labels: 'order, complaint, question',
          }),
          query('gist', { action: 'summarize', input: '{{ startTrigger.data.email }}', length: 'short' }),
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'order' },
          { from: 'order', port: 'out', to: 'kind' },
          { from: 'kind', port: 'out', to: 'gist' },
        ],
      },
    }),
  )
}

async function runDraft(slug: string, input: unknown) {
  const started = await rest('POST', `/workflows/${slug}/runs?environment=production`, { input })
  expect(started.status, JSON.stringify(started.body)).toBe(202)
  const deadline = Date.now() + 20_000
  for (;;) {
    const { body } = await rest('GET', `/runs/${started.body.run.id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
    if (Date.now() > deadline) throw new Error(`run still ${body.run.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function logsOf(
  runId: string,
  count: number,
): Promise<{ blockKey: string; level: string; message: string }[]> {
  let logs: { blockKey: string; level: string; message: string }[] = []
  for (let i = 0; i < 60 && logs.length < count; i++) {
    logs = (await rest('GET', `/runs/${runId}/logs`)).body.logs
    if (logs.length < count) await new Promise((r) => setTimeout(r, 50))
  }
  return logs
}

beforeAll(async () => {
  fake = await startFakeAi()
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@example.com', { admin: true })
  adminCookie = await login(env.app, 'admin@example.com')
  admin = trpc(env.app, adminCookie)
  prodId = data(await admin.query('environments.list')).find(
    (e: { slug: string }) => e.slug === 'production',
  ).id
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
  await fake?.stop()
})

describe('AI queries in workflow runs', () => {
  it('extracts, classifies and summarizes, with a log line per call and the prompts in the metadata', async () => {
    await claude('claude')
    await triage('triage', 'claude')
    const run = await runDraft('triage', { email: 'LABEL=order Hi, Ada here: 3 lamps please' })
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded')

    const block = async (key: string) => (await rest('GET', `/runs/${run.id}/blocks/${key}`)).body.block
    const order = await block('order')
    expect(order.data).toEqual({ customer: 'customer from the text', quantity: expect.any(Number) })
    expect(order.metadata).toMatchObject({
      resource: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
      costUsd: expect.any(Number),
      request: { prompt: expect.stringContaining('3 lamps') },
    })
    expect((await block('kind')).data).toMatchObject({ label: 'order', reason: expect.any(String) })
    expect(typeof (await block('gist')).data).toBe('string')

    const logs = await logsOf(run.id, 3)
    expect(logs.map((l) => [l.blockKey, l.level])).toEqual([
      ['order', 'info'],
      ['kind', 'info'],
      ['gist', 'info'],
    ])
    expect(logs[0]!.message).toMatch(
      /^AI call: anthropic claude-sonnet-5-5, \d+ input \+ \d+ output tokens, \$\d+\.\d+, \d+\.\d s$/,
    )

    // The metrics count the calls, their tokens and cost.
    const metrics = (await env.app.inject({ method: 'GET', url: '/metrics' })).body
    expect(metrics).toMatch(
      /ow_ai_calls_total\{provider="anthropic",model="claude-sonnet-5-5",outcome="ok"\} [3-9]/,
    )
    expect(metrics).toMatch(
      /ow_ai_tokens_total\{provider="anthropic",model="claude-sonnet-5-5",kind="input"\} \d+/,
    )
    expect(metrics).toMatch(/ow_ai_cost_usd_total\{provider="anthropic",model="claude-sonnet-5-5"\} \d/)
  })

  it("stops a later call once the run has spent the resource's budget, and hides prompts when asked", async () => {
    await claude('claude_tight', { budgetTokens: 1, hidePrompts: true })
    await triage('triage-tight', 'claude_tight')
    const run = await runDraft('triage-tight', { email: 'Hi, Ada here: 3 lamps please' })
    expect(run.status).toBe('failed')
    expect(run.error).toMatchObject({
      block: 'kind',
      code: 'ai_budget',
      message: expect.stringContaining("over the resource's budget of 1 per run"),
    })
    const order = (await rest('GET', `/runs/${run.id}/blocks/order`)).body.block
    expect(order.status).toBe('succeeded')
    expect(order.metadata).toMatchObject({ promptsHidden: true })
    expect(order.metadata.request).toBeUndefined()
    const logs = await logsOf(run.id, 1)
    expect(logs[0]!.message).toMatch(/prompts hidden$/)

    const metrics = (await env.app.inject({ method: 'GET', url: '/metrics' })).body
    expect(metrics).toMatch(
      /ow_ai_calls_total\{provider="anthropic",model="claude-sonnet-5-5",outcome="ai_budget"\} 1/,
    )
  })

  it('keeps a failed call’s usage with its error and logs it as a warning', async () => {
    await claude('claude_refusing')
    await triage('triage-refused', 'claude_refusing')
    const run = await runDraft('triage-refused', { email: 'REFUSE_ME' })
    expect(run.status).toBe('failed')
    expect(run.error).toMatchObject({
      block: 'order',
      code: 'ai_refused',
      details: { provider: 'anthropic', usage: { inputTokens: expect.any(Number) } },
    })
    const logs = await logsOf(run.id, 1)
    expect(logs[0]).toMatchObject({
      blockKey: 'order',
      level: 'warn',
      message: expect.stringMatching(/^AI call:/),
    })
  })

  it('runs an agent that calls a published workflow as a tool, the call a child run of this run', async () => {
    await claude('claude_agent')
    // The tool: a published workflow whose Start trigger's body schema is what the model is offered.
    const lookup = data(
      await admin.mutate('workflows.create', {
        slug: 'lookup-customer',
        name: 'Look up customer',
        description: 'Finds a customer by email',
      }),
    )
    data(
      await admin.mutate('workflows.saveDraft', {
        id: lookup.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          triggers: {
            webhook: {
              enabled: true,
              bodySchema: {
                type: 'object',
                properties: { email: { type: 'string' } },
                required: ['email'],
              },
            },
          },
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            {
              name: 'reply',
              type: 'response',
              config: { status: '200', body: '{{ ({ name: "Ada", email: startTrigger.data.email }) }}' },
            },
          ],
          edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
        },
      }),
    )
    data(await admin.mutate('releases.publish', { workflowId: lookup.id, draftRevision: 2 }))

    const agent = data(
      await admin.mutate('workflows.create', { slug: 'support-agent', name: 'support-agent' }),
    )
    data(
      await admin.mutate('workflows.saveDraft', {
        id: agent.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            {
              name: 'agent',
              type: 'resourceQuery',
              config: {
                resource: 'claude_agent',
                query: {
                  action: 'agent',
                  instructions: 'You answer support questions.',
                  prompt: 'Who is {{ startTrigger.data.email }}?',
                  tools: 'lookup-customer',
                },
              },
            },
          ],
          edges: [{ from: 'startTrigger', port: 'out', to: 'agent' }],
        },
      }),
    )
    const before = fake.requests.length
    const run = await runDraft('support-agent', { email: 'ada@example.com' })
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded')
    const block = (await rest('GET', `/runs/${run.id}/blocks/agent`)).body.block
    const children = (await rest('GET', `/runs/${run.id}/children`)).body.runs
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ status: 'succeeded', parentRunId: run.id })
    expect(block.data).toEqual({
      answer: 'Done: {"name":"Ada","email":"email from the text"}',
      steps: [
        {
          workflow: 'lookup-customer',
          input: { email: 'email from the text' },
          runId: children[0].id,
          ok: true,
        },
      ],
    })
    expect(block.metadata).toMatchObject({ provider: 'anthropic', steps: 1 })
    // The model was offered the workflow by its slug, description and body schema.
    expect(fake.requests[before]!.body.tools).toEqual([
      {
        name: 'lookup-customer',
        description: 'Finds a customer by email',
        input_schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      },
    ])
    const logs = await logsOf(run.id, 2)
    expect(logs.map((l) => l.message)).toEqual([
      `Agent: calling workflow "lookup-customer" (run ${children[0].id})`,
      expect.stringMatching(/^AI call: anthropic/),
    ])
  })

  it("refuses to run an agent naming a workflow that isn't published", async () => {
    const created = data(await admin.mutate('workflows.create', { slug: 'agent-bad', name: 'agent-bad' }))
    data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            {
              name: 'agent',
              type: 'resourceQuery',
              config: { resource: 'claude', query: { action: 'agent', prompt: 'x', tools: 'triage' } },
            },
          ],
          edges: [{ from: 'startTrigger', port: 'out', to: 'agent' }],
        },
      }),
    )
    // `triage` exists (a draft, never published): the run is refused, as for a Workflow block.
    const started = await rest('POST', '/workflows/agent-bad/runs?environment=production', { input: {} })
    expect(started.status).toBe(400)
    expect(started.body.error).toMatchObject({
      code: 'invalid_definition',
      details: {
        diagnostics: [{ code: 'unpublished_workflow', path: ['blocks', 1, 'config', 'query', 'tools'] }],
      },
    })
  })
})
