import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// A fake of Confluent's Schema Registry for tests (M30): subjects with versions, schemas by id, basic auth.

export interface FakeRegistry {
  url: string
  username: string
  password: string
  /** Registers a schema under a subject: its id. */
  register(subject: string, schema: object, type?: 'AVRO' | 'JSON'): number
  stop(): Promise<void>
}

export async function startFakeRegistry(): Promise<FakeRegistry> {
  const username = 'registry-user'
  const password = 'registry-pass'
  const schemas = new Map<number, { schema: string; schemaType: string }>()
  const subjects = new Map<string, number[]>()
  let next = 1
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/vnd.schemaregistry.v1+json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)
      return reply(401, { error_code: 401, message: 'Unauthorized' })
    const url = new URL(req.url ?? '/', 'http://x')
    let m = /^\/schemas\/ids\/(\d+)$/.exec(url.pathname)
    if (m) {
      const s = schemas.get(Number(m[1]))
      return s
        ? reply(200, s.schemaType === 'AVRO' ? { schema: s.schema } : s)
        : reply(404, { error_code: 40403, message: 'Schema not found' })
    }
    m = /^\/subjects\/([^/]+)\/versions\/latest$/.exec(url.pathname)
    if (m) {
      const subject = decodeURIComponent(m[1]!)
      const ids = subjects.get(subject)
      if (!ids?.length) return reply(404, { error_code: 40401, message: `Subject '${subject}' not found.` })
      const id = ids.at(-1)!
      return reply(200, { subject, version: ids.length, id, ...schemas.get(id) })
    }
    reply(404, { error_code: 404, message: 'HTTP 404 Not Found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    username,
    password,
    register(subject, schema, type = 'AVRO') {
      const id = next++
      schemas.set(id, { schema: JSON.stringify(schema), schemaType: type })
      subjects.set(subject, [...(subjects.get(subject) ?? []), id])
      return id
    },
    stop: () => new Promise((r) => server.close(() => r())),
  }
}
