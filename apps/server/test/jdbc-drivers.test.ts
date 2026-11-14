import { createHash } from 'node:crypto'
import { jdbcConnector, parseResource } from '@ow/connectors'
import { auditEvents } from '@ow/db'
import { desc } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// M38 step 3b: uploaded JDBC drivers: admins upload and delete them, everyone who edits resources sees the list, a
// resource using one keeps it, and the connector finds its jar.

let env: TestEnv
let adminCookie: string
let memberCookie: string
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>

const data = (res: { status: number; body: { result?: { data: unknown }; error?: { message: string } } }) => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  return res.body.result.data as any
}

// A jar is a zip: a local file header, then anything (the server keeps the bytes as they are).
const JAR = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('a pretend DB2 driver')])
const SHA = createHash('sha256').update(JAR).digest('hex')

function upload(cookie: string, body: Buffer, query: Record<string, string>) {
  return env.app.inject({
    method: 'POST',
    url: `/api/v1/jdbc-drivers?${new URLSearchParams(query)}`,
    headers: { cookie, 'content-type': 'application/java-archive' },
    payload: body,
  })
}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, memberCookie)
}, 120_000)
afterAll(async () => {
  await env?.stop()
})

describe('JDBC drivers', () => {
  let driverId: string

  it('are uploaded by admins only, checked, and listed for everyone without the jar', async () => {
    const query = { name: 'IBM DB2', className: 'com.ibm.db2.jcc.DB2Driver', fileName: 'jcc-12.1.jar' }
    expect((await upload(memberCookie, JAR, query)).statusCode).toBe(403)
    expect((await upload(adminCookie, Buffer.from('not a zip'), query)).json()).toEqual({
      error: { message: "That file isn't a jar" },
    })
    expect((await upload(adminCookie, JAR, { ...query, className: 'not a class' })).statusCode).toBe(400)

    const ok = await upload(adminCookie, JAR, query)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ id: expect.any(String), sha256: SHA, size: JAR.length })
    driverId = ok.json().id
    expect((await upload(adminCookie, JAR, query)).json()).toEqual({
      error: { message: 'A driver named "IBM DB2" exists already' },
    })

    const listed = data(await member.query('jdbcDrivers.list'))
    expect(listed).toEqual([
      {
        id: driverId,
        name: 'IBM DB2',
        className: 'com.ibm.db2.jcc.DB2Driver',
        fileName: 'jcc-12.1.jar',
        sha256: SHA,
        size: JAR.length,
        createdAt: expect.any(String),
        uploadedBy: 'admin@optiply.nl',
      },
    ])
    const [audit] = await env.db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1)
    expect(audit).toMatchObject({ action: 'jdbc_driver.uploaded', objectId: driverId })
  })

  it('are found by the connector, jar and all', async () => {
    const client = await jdbcConnector.createClient(
      parseResource(jdbcConnector, {
        id: 'rc-1',
        resourceId: 'r-1',
        environmentId: 'e-1',
        version: '1',
        config: { driver: 'uploaded', driverId, url: 'jdbc:db2://db2:50000/SHOP', user: 'app' },
        secrets: { password: 'pw' },
      }) as never,
    )
    expect(client.connection).toMatchObject({ driverSha: SHA, driverClass: 'com.ibm.db2.jcc.DB2Driver' })
    expect(Buffer.from(await client.jar!())).toEqual(JAR)
  })

  it('can’t be deleted while a resource uses them; members can’t delete', async () => {
    const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
    const prodId = envs.find((e) => e.slug === 'production')!.id
    const resourceId = data(
      await admin.mutate('resources.create', { type: 'jdbc', name: 'DB2', slug: 'db2' }),
    ).id
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId: prodId,
        config: { driver: 'uploaded', driverId, url: 'jdbc:db2://db2:50000/SHOP', user: 'app' },
        secrets: { password: 'pw' },
      }),
    )
    expect((await member.mutate('jdbcDrivers.delete', { id: driverId })).status).toBe(403)
    const refused = await admin.mutate('jdbcDrivers.delete', { id: driverId })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/In use by DB2/)

    data(await admin.mutate('resources.delete', { id: resourceId }))
    expect(data(await admin.mutate('jdbcDrivers.delete', { id: driverId }))).toEqual({ ok: true })
    expect(data(await admin.query('jdbcDrivers.list'))).toEqual([])
  })
})

describe('Snowflake OAuth (M38 step 3c)', () => {
  it('sends whoever connects to Snowflake’s consent screen, for the resource’s role', async () => {
    const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
    const prodId = envs.find((e) => e.slug === 'production')!.id
    const resourceId = data(
      await admin.mutate('resources.create', { type: 'jdbc', name: 'Warehouse', slug: 'warehouse' }),
    ).id
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId: prodId,
        config: {
          driver: 'snowflake',
          account: 'acme-prod',
          warehouse: 'WH',
          role: 'ANALYST',
          auth: 'oauth',
          oauthClientId: 'snowflake-client',
        },
        secrets: { clientSecret: 'snowflake-secret' },
      }),
    )
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/oauth/start?resourceId=${resourceId}&environmentId=${prodId}&account=mine`,
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(302)
    const location = new URL(String(res.headers.location))
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://acme-prod.snowflakecomputing.com/oauth/authorize',
    )
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: 'snowflake-client',
      response_type: 'code',
      scope: 'refresh_token session:role:ANALYST',
      code_challenge_method: 'S256',
    })
    expect(res.body).not.toContain('snowflake-secret')
  })
})
