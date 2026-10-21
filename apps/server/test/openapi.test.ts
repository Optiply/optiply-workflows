import { Validator } from '@seriousme/openapi-schema-validator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M15 step 5: the OpenAPI document of the webhooks the caller may call.

let env: TestEnv
let admin: ReturnType<typeof trpc>
let adminCookie: string
let memberCookie: string
const ids: Record<string, string> = {}

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

const start = { name: 'startTrigger', type: 'startTrigger' }

async function workflow(
  slug: string,
  webhook: object,
  opts: { publish?: boolean; description?: string } = {},
) {
  const created = data(
    await admin.mutate('workflows.create', { slug, name: `The ${slug}`, description: opts.description }),
  )
  ids[slug] = created.id
  const saved = data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: { schemaVersion: 1, blocks: [start], edges: [], triggers: { webhook } },
    }),
  )
  if (opts.publish !== false) {
    data(await admin.mutate('releases.publish', { workflowId: created.id, draftRevision: saved.revision }))
  }
}

async function openapi(headers: Record<string, string>) {
  const res = await env.app.inject({ method: 'GET', url: '/api/v1/openapi.json', headers })
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return { status: res.statusCode, json: res.json() as any }
}

beforeAll(async () => {
  env = await startTestApp({ PUBLIC_URL: 'https://workflows.example.com' })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie)

  const vars = data(await admin.mutate('configVars.create', { name: 'GH_SECRET', isSecret: true }))
  const envs = data(await admin.query('environments.list')) as { id: string; isDefault: boolean }[]
  data(
    await admin.mutate('configVars.setValue', {
      configVarId: vars.id,
      environmentId: envs.find((e) => e.isDefault)!.id,
      value: 's',
    }),
  )

  await workflow(
    'orders-hook',
    {
      enabled: true,
      alias: 'orders/:orderId/events',
      methods: ['POST', 'PUT'],
      auth: { type: 'public' },
      bodySchema: {
        type: 'object',
        properties: { lines: { type: 'array', items: { $ref: '#/$defs/line' } } },
        required: ['lines'],
        $defs: {
          line: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } } },
        },
      },
    },
    { description: 'Order events from the shop' },
  )
  await workflow('keyed-hook', { enabled: true, methods: ['GET', 'POST'] })
  await workflow('github-hook', {
    enabled: true,
    auth: { type: 'signature', preset: 'github', secret: 'GH_SECRET' },
    syncTimeoutMs: 0,
  })
  await workflow('draft-only', { enabled: true }, { publish: false })
  await workflow('disabled-hook', { enabled: false })
})
afterAll(() => env?.stop())

describe('GET /api/v1/openapi.json', () => {
  it('needs a session or an API key', async () => {
    expect((await openapi({})).status).toBe(401)
    expect((await openapi({ 'x-api-key': 'ow_unknown' })).status).toBe(401)
  })

  it('is a valid OpenAPI 3.1 document of the live, enabled webhooks', async () => {
    const { status, json: doc } = await openapi({ cookie: adminCookie })
    expect(status).toBe(200)
    // The validator refuses a broken document (so its "valid" means something).
    expect((await new Validator().validate({ openapi: '3.1.0', info: {} })).valid).toBe(false)
    const result = await new Validator().validate(doc)
    expect(result.errors).toBeUndefined()
    expect(result.valid).toBe(true)

    expect(doc.servers).toEqual([{ url: 'https://workflows.example.com/api/v1' }])
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/hooks/orders/{orderId}/events',
      '/runs/{id}',
      '/workflows/github-hook/webhook',
      '/workflows/keyed-hook/webhook',
      '/workflows/orders-hook/webhook',
    ])
  })

  it('describes each webhook: methods, parameters, auth, body schema and answers', async () => {
    const { json: doc } = await openapi({ cookie: adminCookie })
    const orders = doc.paths['/hooks/orders/{orderId}/events']
    expect(Object.keys(orders)).toEqual(['post', 'put'])
    expect(orders.post).toMatchObject({
      operationId: 'orders-hook.alias.post',
      summary: 'The orders-hook',
      security: [],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/orders-hook.body' } } },
      },
    })
    expect(orders.post.description).toContain('Order events from the shop')
    expect(orders.post.description).toContain('Public: no authentication.')
    expect(orders.post.description).toContain('At most 60 calls per 60 s.')
    expect(orders.post.parameters).toContainEqual({
      name: 'orderId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })
    expect(orders.post.parameters.find((p: { name: string }) => p.name === 'environment').schema).toEqual({
      type: 'string',
      enum: ['production'],
    })
    expect(Object.keys(orders.post.responses)).toEqual(['200', '202', '400', '403', '405', '413', '429'])
    // The body schema keeps its own $defs: its $id makes `#/$defs/line` resolve inside it.
    expect(doc.components.schemas['orders-hook.body']).toMatchObject({
      $id: 'urn:optiply-workflows:webhook-body:orders-hook',
      $defs: { line: { type: 'object' } },
    })

    const keyed = doc.paths['/workflows/keyed-hook/webhook']
    expect(keyed.get.security).toEqual([{ apiKey: [] }, { bearer: [] }])
    expect(keyed.get.requestBody).toBeUndefined()
    expect(keyed.post.requestBody.required).toBe(false)
    expect(keyed.post.responses['429']).toBeUndefined()
    expect(keyed.post.parameters.find((p: { name: string }) => p.name === 'environment').schema.enum).toEqual(
      ['production', 'staging'],
    )

    const github = doc.paths['/workflows/github-hook/webhook'].post
    expect(github.parameters).toContainEqual({
      name: 'x-hub-signature-256',
      in: 'header',
      required: true,
      schema: { type: 'string' },
    })
    expect(github.description).toContain('Signed: the request must carry a GitHub signature of its body.')
    expect(github.description).toContain('Answers 202 at once')
  })

  it("lists only what the caller may call: an API key's workflows, a member's visible ones", async () => {
    const limited = data(
      await admin.mutate('apiKeys.create', { name: 'limited', workflowIds: [ids['keyed-hook']] }),
    )
    const byKey = await openapi({ 'x-api-key': limited.key })
    expect(Object.keys(byKey.json.paths).sort()).toEqual(['/runs/{id}', '/workflows/keyed-hook/webhook'])

    const everything = data(await admin.mutate('apiKeys.create', { name: 'all' }))
    expect(
      Object.keys((await openapi({ authorization: `Bearer ${everything.key}` })).json.paths),
    ).toHaveLength(5)

    const member = await openapi({ cookie: memberCookie })
    expect(Object.keys(member.json.paths)).toEqual(['/runs/{id}'])
    expect(member.json.components.schemas['orders-hook.body']).toBeUndefined()
  })
})
