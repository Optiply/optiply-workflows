import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M15 step 4a: multipart uploads into webhooks.

let env: TestEnv
let admin: ReturnType<typeof trpc>

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
}

async function send(url: string, body: Buffer, contentType: string, headers: Record<string, string> = {}) {
  const res = await env.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': contentType, ...headers },
    payload: body,
  })
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return { status: res.statusCode, json: res.json() as any }
}

/** Every byte value, so a file that isn't text survives the trip. */
const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

/** A multipart body written out by hand, as curl sends it. */
function handWritten(boundary: string) {
  const crlf = '\r\n'
  return Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="kind"',
        '',
        'invoice',
        `--${boundary}`,
        'Content-Disposition: form-data; name="tag"',
        '',
        'a',
        `--${boundary}`,
        'Content-Disposition: form-data; name="tag"',
        '',
        'b',
        `--${boundary}`,
        'Content-Disposition: form-data; name="scan"; filename="scan.bin"',
        'Content-Type: application/octet-stream',
        '',
        '',
      ].join(crlf),
    ),
    binary,
    Buffer.from(
      [
        '',
        `--${boundary}`,
        'Content-Disposition: form-data; name="note"; filename="note.txt"',
        '',
        'héllo',
        `--${boundary}--`,
        '',
      ].join(crlf),
    ),
  ])
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  await published('upload', { auth: { type: 'public' } })
})
afterAll(() => env?.stop())

describe('multipart webhooks', () => {
  it('deliver fields as strings and files as base64, byte for byte', async () => {
    const boundary = '----ow-test-7MA4YWxkTrZu0gW'
    const res = await send(
      '/api/v1/workflows/upload/webhook',
      handWritten(boundary),
      `multipart/form-data; boundary=${boundary}`,
    )
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      kind: 'invoice',
      tag: ['a', 'b'],
      scan: {
        filename: 'scan.bin',
        contentType: 'application/octet-stream',
        size: 256,
        base64: binary.toString('base64'),
      },
      // No Content-Type on the part: text/plain (RFC 7578 §4.4).
      note: {
        filename: 'note.txt',
        contentType: 'text/plain',
        size: Buffer.byteLength('héllo'),
        base64: Buffer.from('héllo').toString('base64'),
      },
    })
    expect(Buffer.from(res.json.scan.base64, 'base64').equals(binary)).toBe(true)
  })

  it('accept a boundary whose text appears inside a part, and UTF-8 filenames', async () => {
    // Valid by RFC 2046 (only CRLF--boundary ends a part); undici's own parser refuses it.
    const crlf = '\r\n'
    const body = Buffer.from(
      [
        '--boundary',
        'Content-Disposition: form-data; name="text"',
        '',
        'the word boundary, and --boundary without a line break',
        '--boundary',
        'Content-Disposition: form-data; name="doc"; filename="factuur-€.txt"',
        'Content-Type: text/plain',
        '',
        'x',
        '--boundary--',
        '',
      ].join(crlf),
    )
    const res = await send('/api/v1/workflows/upload/webhook', body, 'multipart/form-data; boundary=boundary')
    expect(res).toMatchObject({
      status: 200,
      json: {
        text: 'the word boundary, and --boundary without a line break',
        doc: { filename: 'factuur-€.txt', contentType: 'text/plain', size: 1 },
      },
    })
  })

  it('check the signature over the raw multipart bytes', async () => {
    const vars = data(await admin.mutate('configVars.create', { name: 'UPLOAD_SECRET', isSecret: true }))
    const envs = data(await admin.query('environments.list')) as { id: string; isDefault: boolean }[]
    data(
      await admin.mutate('configVars.setValue', {
        configVarId: vars.id,
        environmentId: envs.find((e) => e.isDefault)!.id,
        value: 'shh',
      }),
    )
    await published('signed-upload', {
      auth: { type: 'signature', preset: 'github', secret: 'UPLOAD_SECRET' },
    })
    const boundary = 'b0undary'
    const body = handWritten(boundary)
    const sign = (bytes: Buffer) => `sha256=${createHmac('sha256', 'shh').update(bytes).digest('hex')}`
    const type = `multipart/form-data; boundary=${boundary}`
    const url = '/api/v1/workflows/signed-upload/webhook'
    expect((await send(url, body, type, { 'x-hub-signature-256': sign(body) })).status).toBe(200)
    const tampered = Buffer.from(body)
    const at = tampered.indexOf(binary) + 10
    tampered.writeUInt8(tampered[at]! ^ 0xff, at)
    expect((await send(url, tampered, type, { 'x-hub-signature-256': sign(body) })).status).toBe(401)
  })

  it('are checked against the body schema like any body', async () => {
    await published('typed-upload', {
      auth: { type: 'public' },
      bodySchema: {
        type: 'object',
        properties: { kind: { enum: ['receipt'] }, scan: { type: 'object', required: ['base64'] } },
        required: ['kind', 'scan'],
      },
    })
    const boundary = 'x'
    const res = await send(
      '/api/v1/workflows/typed-upload/webhook',
      handWritten(boundary),
      `multipart/form-data; boundary=${boundary}`,
    )
    expect(res).toMatchObject({
      status: 400,
      json: {
        error: {
          code: 'invalid_body',
          details: { errors: [{ path: '/kind', message: 'must be equal to one of the allowed values' }] },
        },
      },
    })
  })

  it('refuse a malformed body, too many parts, and more than 10 MB', async () => {
    const malformed = await send(
      '/api/v1/workflows/upload/webhook',
      Buffer.from('not multipart at all'),
      'multipart/form-data; boundary=zzz',
    )
    expect(malformed).toMatchObject({
      status: 400,
      json: { error: { message: 'The multipart body is malformed' } },
    })

    const form = new FormData()
    for (let i = 0; i < 1001; i++) form.append(`f${i}`, 'x')
    const encoded = new Response(form)
    const many = await send(
      '/api/v1/workflows/upload/webhook',
      Buffer.from(await encoded.arrayBuffer()),
      encoded.headers.get('content-type')!,
    )
    expect(many).toMatchObject({ status: 413, json: { error: { code: 'too_many_parts' } } })

    const big = new FormData()
    big.append('file', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]), 'big.bin')
    const bigEncoded = new Response(big)
    const tooBig = await send(
      '/api/v1/workflows/upload/webhook',
      Buffer.from(await bigEncoded.arrayBuffer()),
      bigEncoded.headers.get('content-type')!,
    )
    expect(tooBig.status).toBe(413)
  })

  it('take a 6 MB file', async () => {
    const file = Buffer.alloc(6 * 1024 * 1024, 7)
    const form = new FormData()
    form.append('file', new Blob([file], { type: 'application/pdf' }), 'report.pdf')
    const encoded = new Response(form)
    const res = await send(
      '/api/v1/workflows/upload/webhook',
      Buffer.from(await encoded.arrayBuffer()),
      encoded.headers.get('content-type')!,
    )
    expect(res.status).toBe(200)
    expect(res.json.file).toMatchObject({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      size: file.length,
    })
    expect(Buffer.from(res.json.file.base64, 'base64').equals(file)).toBe(true)
  })
})
