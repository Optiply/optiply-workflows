import { generateKey } from '@ow/crypto'
import { createDb, type Db } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/api/app'
import { hashPassword } from '../src/auth/password'
import { type Config, loadConfig } from '../src/config'
import { provisionUser } from '../src/services/users'

export interface TestEnv {
  app: FastifyInstance
  db: Db
  config: Config
  /** The test database itself, e.g. to point a Postgres resource at it. */
  databaseUrl: string
  stop: () => Promise<void>
}

export async function startTestApp(
  overrides: Record<string, string> = {},
  opts: { adminOnlyStaging?: boolean } = {},
): Promise<TestEnv> {
  const pg = await startTestDatabase(opts)
  const config = loadConfig({
    DATABASE_URL: pg.url,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
    ENCRYPTION_KEYS: `v1:${generateKey()}`,
    LOCAL_LOGIN_ENABLED: 'true',
    NODE_ENV: 'test',
    // Tests check grants on their own: new objects start unshared unless a test turns sharing on.
    SHARE_NEW_WITH_EVERYONE: 'false',
    ...overrides,
  })
  const { db, sql, close } = createDb(pg.url, { max: 5 })
  const app = await buildApp({ db, config, logger: false, listener: sql })
  return {
    app,
    db,
    config,
    databaseUrl: pg.url,
    stop: async () => {
      await app.close()
      await close()
      await pg.stop()
    },
  }
}

export const PASSWORD = 'correct horse battery staple'

export async function createLocalUser(db: Db, email: string, opts: { admin?: boolean } = {}) {
  return provisionUser(
    db,
    { email, name: email.split('@')[0]!, passwordHash: await hashPassword(PASSWORD) },
    { makeAdmin: opts.admin },
  )
}

/** Logs in via the local endpoint and returns a Cookie header value. */
export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/local', payload: { email, password } })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  const cookie = res.cookies.find((c) => c.name === 'ow_session')
  if (!cookie) throw new Error('no session cookie')
  return `ow_session=${cookie.value}`
}

/**
 * Minimal tRPC-over-HTTP client for tests (no batching; speaks the superjson envelope). `record` collects every raw
 * response body, so a test can assert something never appears in any response.
 */
export function trpc(
  app: FastifyInstance,
  cookie?: string,
  opts: {
    record?: string[] /** An access token (M33), sent as `Authorization: Bearer`. */
    bearer?: string
  } = {},
) {
  const headers: Record<string, string> = {
    ...(cookie && { cookie }),
    ...(opts.bearer && { authorization: `Bearer ${opts.bearer}` }),
  }
  return {
    async query(path: string, input?: unknown) {
      const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
      const res = await app.inject({ method: 'GET', url: `/api/trpc/${path}${qs}`, headers })
      opts.record?.push(res.body)
      return { status: res.statusCode, body: unwrap(res.json()) }
    },
    async mutate(path: string, input?: unknown) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/trpc/${path}`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify({ json: input ?? null }),
      })
      opts.record?.push(res.body)
      return { status: res.statusCode, body: unwrap(res.json()) }
    },
  }
}

/** Strips the superjson envelope (`{ json, meta }`) so assertions see plain JSON. */
function unwrap(raw: { result?: { data?: { json?: unknown } }; error?: { json?: unknown } }): TrpcBody {
  return {
    result: raw.result ? { data: raw.result.data?.json } : undefined,
    error: raw.error?.json as TrpcBody['error'],
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
type TrpcBody = { result?: { data: any }; error?: { message: string; data?: { code: string } } }
