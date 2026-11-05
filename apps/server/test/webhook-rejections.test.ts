import { createHmac } from 'node:crypto'
import { webhookRejections, workflowRuns, workflowTriggers } from '@ow/db'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M15 step 3b: body schemas checked before a run, and refused calls recorded for the webhook panel.

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberGroupId: string

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

const start = { name: 'startTrigger', type: 'startTrigger' }
const echo = { name: 'reply', type: 'response', config: { status: '200', body: '{{ startTrigger.data }}' } }

async function published(slug: string, webhook: object) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const saved = data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [start, echo],
        edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
        triggers: { webhook: { enabled: true, ...webhook } },
      },
    }),
  )
  data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
  return created.id as string
}

async function call(
  url: string,
  opts: { body?: string; headers?: Record<string, string>; method?: string } = {},
) {
  const res = await env.app.inject({
    method: (opts.method ?? 'POST') as 'POST',
    url,
    headers: { 'content-type': 'application/json', 'user-agent': 'test-agent/1.0', ...opts.headers },
    payload: opts.body ?? '{}',
  })
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return { status: res.statusCode, json: res.json() as any }
}

const rejections = async (workflowId: string) =>
  data(await admin.query('workflows.webhookRejections', { id: workflowId })) as {
    status: number
    reason: string
    message: string
    environment: string | null
    ip: string | null
    userAgent: string | null
  }[]

const runCount = async () => (await env.db.select({ id: workflowRuns.id }).from(workflowRuns)).length

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
  data(await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id }))
})
afterAll(() => env?.stop())

describe('body schemas', () => {
  it('refuse a body that breaks the schema with 400 and its errors, before any run', async () => {
    const id = await published('orders-hook', {
      auth: { type: 'public' },
      bodySchema: {
        type: 'object',
        properties: { orderId: { type: 'integer' }, email: { type: 'string', format: 'email' } },
        required: ['orderId'],
      },
    })
    const ok = await call('/api/v1/workflows/orders-hook/webhook', {
      body: '{"orderId":7,"email":"a@optiply.nl"}',
    })
    expect(ok).toMatchObject({ status: 200, json: { orderId: 7 } })

    const before = await runCount()
    const bad = await call('/api/v1/workflows/orders-hook/webhook', { body: '{"email":"nope"}' })
    expect(bad).toEqual({
      status: 400,
      json: {
        error: {
          code: 'invalid_body',
          message: "The body doesn't match the webhook's schema",
          details: {
            errors: [
              { path: '', message: "must have required property 'orderId'" },
              { path: '/email', message: 'must match format "email"' },
            ],
          },
        },
      },
    })
    expect(await runCount()).toBe(before)
    expect(await rejections(id)).toMatchObject([
      {
        status: 400,
        reason: 'invalid_body',
        message: "The body doesn't match the webhook's schema",
        environment: 'Production',
        userAgent: 'test-agent/1.0',
      },
    ])
  })

  it('run patterns in linear time (RE2): a catastrophic one answers at once', async () => {
    await published('codes-hook', {
      auth: { type: 'public' },
      bodySchema: { type: 'object', properties: { code: { type: 'string', pattern: '^(a+)+$' } } },
    })
    // JavaScript's engine backtracks 2^40 ways on this before failing; RE2 doesn't.
    const started = Date.now()
    const bad = await call('/api/v1/workflows/codes-hook/webhook', { body: `{"code":"${'a'.repeat(40)}!"}` })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(bad).toMatchObject({
      status: 400,
      json: { error: { details: { errors: [{ path: '/code', message: 'must match pattern "^(a+)+$"' }] } } },
    })
    expect(await call('/api/v1/workflows/codes-hook/webhook', { body: '{"code":"aaa"}' })).toMatchObject({
      status: 200,
    })
  })
})

describe('rejections', () => {
  it('record the reason, the environment when known, and only the first 429 of a window', async () => {
    const vars = data(await admin.mutate('configVars.create', { name: 'SIGNING', isSecret: true }))
    const envs = data(await admin.query('environments.list')) as { id: string; isDefault: boolean }[]
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: vars.id,
        environmentId: envs.find((e) => e.isDefault)!.id,
        value: 'secret',
      }),
    )
    const id = await published('signed-hook', {
      auth: { type: 'signature', preset: 'github', secret: 'SIGNING' },
      rateLimit: { requests: 3, windowSeconds: 3600 },
    })
    const url = '/api/v1/workflows/signed-hook/webhook'
    const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update('{}').digest('hex')}`
    expect((await call(url, { headers: { 'x-hub-signature-256': sign('wrong') } })).status).toBe(401)
    expect((await call(url, { method: 'PUT' })).status).toBe(405)
    expect((await call(url)).status).toBe(401)
    // Only calls that authenticated count toward a signed webhook's limit: three pass, then 429 (recorded once).
    const signed = []
    for (let i = 0; i < 5; i++)
      signed.push((await call(url, { headers: { 'x-hub-signature-256': sign('secret') } })).status)
    expect(signed).toEqual([200, 200, 200, 429, 429])

    const rows = await rejections(id)
    expect(rows.map((r) => [r.status, r.reason, r.environment])).toEqual([
      [429, 'rate_limited', 'Production'],
      [401, 'missing_signature', 'Production'],
      [405, 'method_not_allowed', null],
      [401, 'signature_mismatch', 'Production'],
    ])
    // The caller never learns the reason; the panel does.
    expect(rows.find((r) => r.reason === 'signature_mismatch')!.message).toBe(
      "The request's signature couldn't be verified",
    )
  })

  it('are capped at 60 a minute per webhook', async () => {
    const id = await published('flooded', {
      auth: { type: 'signature', preset: 'github', secret: 'SIGNING' },
      rateLimit: { requests: 1000, windowSeconds: 60 },
    })
    for (let i = 0; i < 65; i++) await call('/api/v1/workflows/flooded/webhook')
    const [row] = await env.db
      .select({ n: count() })
      .from(webhookRejections)
      .innerJoin(workflowTriggers, eq(workflowTriggers.id, webhookRejections.triggerId))
      .where(eq(workflowTriggers.workflowId, id))
    expect(row!.n).toBe(60)
  })

  it("are listed to editors only (they hold callers' IP addresses)", async () => {
    const id = await published('private-hook', { auth: { type: 'public' } })
    const grant = (level: 'use' | 'edit') =>
      admin.mutate('permissions.set', {
        objectType: 'workflow',
        objectId: id,
        groupId: memberGroupId,
        environmentId: null,
        level,
      })
    expect((await member.query('workflows.webhookRejections', { id })).status).toBe(404)
    data(await grant('use'))
    expect((await member.query('workflows.webhookRejections', { id })).status).toBe(403)
    data(await grant('edit'))
    expect(data(await member.query('workflows.webhookRejections', { id }))).toEqual([])
  })
})
