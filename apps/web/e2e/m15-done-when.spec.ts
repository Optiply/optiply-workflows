import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, type Page, test } from '@playwright/test'
import { openRail, signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M15's done-when (architecture.md §2.7): a Stripe-signed webhook accepts its own events and refuses a forged and an
 * expired one, shown in the webhook panel; GitHub's documented example verifies and its redelivery replays the run;
 * a body that breaks the schema gets 400 and no run; a public webhook over its limit gets 429 with Retry-After; a
 * multipart upload is forwarded by a REST query byte for byte; the OpenAPI document lists the webhook with its schema.
 * (Two API processes sharing one limit: apps/server/test/webhook-limits.test.ts and the Compose check. The document's
 * validity against the OpenAPI 3.1 schema: apps/server/test/openapi.test.ts.)
 */

let server: Server
let origin: string
/** What the fake file service received last. */
let received: { contentType: string; body: Buffer } | undefined

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    received = { contentType: String(req.headers['content-type']), body: Buffer.concat(chunks) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ stored: true, bytes: received.body.length }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(
  () =>
    new Promise((resolve) => {
      // The platform's REST connector keeps its connection to this server alive in a pool: close() alone waits for it.
      server?.closeAllConnections()
      server?.close(resolve)
    }),
)

const start = { name: 'startTrigger', type: 'startTrigger' }
const echo = { name: 'reply', type: 'response', config: { status: '200', body: '{{ startTrigger.data }}' } }

async function publishWorkflow(page: Page, slug: string, definition: object) {
  const wf = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  const saved = await trpcMutate<{ revision: number }>(page, 'workflows.saveDraft', {
    id: wf.id,
    revision: 1,
    definition: { schemaVersion: 1, ...definition },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: wf.id, draftRevision: saved.revision })
  return wf.id
}

async function secretVar(page: Page, name: string, value: string) {
  const envs = await trpcQuery<{ id: string; isDefault: boolean }[]>(page, 'environments.list', undefined)
  const created = await trpcMutate<{ id: string }>(page, 'configVars.create', { name, isSecret: true })
  await trpcMutate(page, 'configVars.setValue', {
    configVarId: created.id,
    environmentId: envs.find((e) => e.isDefault)!.id,
    value,
  })
}

async function runCount(page: Page, slug: string) {
  const res = await page.request.get(`/api/v1/workflows/${slug}/runs?limit=200`)
  return ((await res.json()).runs as unknown[]).length
}

test('M15: signed, limited and multipart webhooks, and the OpenAPI document', async ({ page, request }) => {
  const s = Date.now().toString(36)
  await signIn(page)

  await test.step('Stripe: its own events run; a forged, an expired and an off-schema one are refused', async () => {
    await secretVar(page, `STRIPE_${s.toUpperCase()}`, 'whsec_e2e_secret')
    const workflowId = await publishWorkflow(page, `stripe-${s}`, {
      blocks: [start, echo],
      edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
      triggers: {
        webhook: {
          enabled: true,
          auth: { type: 'signature', preset: 'stripe', secret: `STRIPE_${s.toUpperCase()}` },
          bodySchema: {
            type: 'object',
            properties: { type: { type: 'string' }, data: { type: 'object' } },
            required: ['type', 'data'],
          },
        },
      },
    })
    const url = `/api/v1/workflows/stripe-${s}/webhook`
    const send = (body: string, secret: string, t = Math.floor(Date.now() / 1000)) =>
      request.post(url, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`,
        },
        data: body,
      })

    const event = '{"type":"invoice.paid","data":{"object":{"id":"in_1"}}}'
    const ok = await send(event, 'whsec_e2e_secret')
    expect(ok.status()).toBe(200)
    expect(await ok.json()).toEqual(JSON.parse(event))
    const runs = await runCount(page, `stripe-${s}`)

    expect((await send(event, 'whsec_a_guess')).status()).toBe(401)
    expect((await send(event, 'whsec_e2e_secret', Math.floor(Date.now() / 1000) - 600)).status()).toBe(401)
    const offSchema = await send('{"type":"invoice.paid"}', 'whsec_e2e_secret')
    expect(offSchema.status()).toBe(400)
    expect(await offSchema.json()).toMatchObject({
      error: {
        code: 'invalid_body',
        details: { errors: [{ path: '', message: "must have required property 'data'" }] },
      },
    })
    expect(await runCount(page, `stripe-${s}`)).toBe(runs)

    // The webhook panel lists all three, newest first.
    await page.goto(`/workflows/${workflowId}`)
    await openRail(page, 'triggers')
    const refused = page.getByTestId('webhook-rejections').locator('li')
    await expect(refused).toHaveCount(3)
    await expect(refused.nth(0)).toContainText("The body didn't match the body schema")
    await expect(refused.nth(1)).toContainText("Signing time too far from the server's clock")
    await expect(refused.nth(2)).toContainText("Signature didn't match")
  })

  await test.step('GitHub: its documented example verifies, and a redelivery replays the run', async () => {
    await secretVar(page, `GITHUB_${s.toUpperCase()}`, "It's a Secret to Everybody")
    await publishWorkflow(page, `github-${s}`, {
      blocks: [start, echo],
      edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
      triggers: {
        webhook: {
          enabled: true,
          auth: { type: 'signature', preset: 'github', secret: `GITHUB_${s.toUpperCase()}` },
        },
      },
    })
    const deliver = () =>
      request.post(`/api/v1/workflows/github-${s}/webhook`, {
        headers: {
          'content-type': 'text/plain',
          'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
          'x-github-delivery': `delivery-${s}`,
        },
        data: 'Hello, World!',
      })
    const first = await deliver()
    expect(first.status()).toBe(200)
    expect(await first.text()).toBe('"Hello, World!"')
    const again = await deliver()
    expect(again.headers()['x-run-id']).toBe(first.headers()['x-run-id'])
    expect(again.headers()['idempotent-replayed']).toBe('true')
    expect(await runCount(page, `github-${s}`)).toBe(1)
  })

  await test.step('a public webhook over its limit answers 429 with Retry-After', async () => {
    await publishWorkflow(page, `public-${s}`, {
      blocks: [start, echo],
      edges: [{ from: 'startTrigger', port: 'out', to: 'reply' }],
      triggers: {
        webhook: { enabled: true, auth: { type: 'public' }, rateLimit: { requests: 2, windowSeconds: 3600 } },
      },
    })
    const statuses: number[] = []
    let retryAfter: string | undefined
    for (let i = 0; i < 3; i++) {
      const res = await request.post(`/api/v1/workflows/public-${s}/webhook`, { data: { i } })
      statuses.push(res.status())
      retryAfter ??= res.headers()['retry-after']
    }
    expect(statuses).toEqual([200, 200, 429])
    expect(Number(retryAfter)).toBeGreaterThan(0)
  })

  await test.step('a multipart upload is forwarded by a REST query, byte for byte', async () => {
    const files = await trpcMutate<{ id: string }>(page, 'resources.create', {
      type: 'rest',
      name: 'Files',
      slug: `files_${s}`,
    })
    const envs = await trpcQuery<{ id: string }[]>(page, 'environments.list', undefined)
    for (const env of envs) {
      await trpcMutate(page, 'resources.saveConfig', {
        resourceId: files.id,
        environmentId: env.id,
        config: { baseUrl: `${origin}/api`, allowPrivateNetwork: true },
        secrets: {},
      })
    }
    await publishWorkflow(page, `upload-${s}`, {
      blocks: [
        start,
        {
          name: 'store',
          type: 'resourceQuery',
          config: {
            resource: `files_${s}`,
            query: {
              method: 'POST',
              path: '/upload',
              body: {
                type: 'multipart',
                parts: [
                  { kind: 'text', key: 'note', value: 'from {{ startTrigger.data.who }}' },
                  { kind: 'file', key: 'doc', file: '{{ startTrigger.data.doc }}' },
                ],
              },
            },
          },
        },
        { name: 'reply', type: 'response', config: { status: '200', body: '{{ store.data }}' } },
      ],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'store' },
        { from: 'store', port: 'out', to: 'reply' },
      ],
      triggers: { webhook: { enabled: true, auth: { type: 'public' } } },
    })
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256))
    const res = await request.post(`/api/v1/workflows/upload-${s}/webhook`, {
      multipart: {
        who: 'the scanner',
        doc: { name: 'scan.pdf', mimeType: 'application/pdf', buffer: bytes },
      },
    })
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ stored: true })

    const form = await new Response(new Uint8Array(received!.body), {
      headers: { 'content-type': received!.contentType },
    }).formData()
    expect(form.get('note')).toBe('from the scanner')
    const doc = form.get('doc') as File
    expect([doc.name, doc.type]).toEqual(['scan.pdf', 'application/pdf'])
    expect(Buffer.from(await doc.arrayBuffer()).equals(bytes)).toBe(true)
  })

  await test.step('the OpenAPI document lists the webhook with its schema', async () => {
    const doc = await (await page.request.get('/api/v1/openapi.json')).json()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths[`/workflows/stripe-${s}/webhook`].post).toMatchObject({
      security: [],
      parameters: expect.arrayContaining([
        { name: 'stripe-signature', in: 'header', required: true, schema: { type: 'string' } },
      ]),
      requestBody: {
        content: { 'application/json': { schema: { $ref: `#/components/schemas/stripe-${s}.body` } } },
      },
    })
    expect(doc.components.schemas[`stripe-${s}.body`]).toMatchObject({ required: ['type', 'data'] })
  })
})
