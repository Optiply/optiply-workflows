import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// SQL schema loading (session 57): a database resource's tables and columns through resources.sqlSchema, for the
// editor. A Postgres resource on the test database as a reader with grants on some tables, and the built-in Database.

const SECRET = 'Schema-R3ader-Secret-2290'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let superSql: postgres.Sql
let prodId: string
let pgId: string

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}
const tableNames = (schema: { tables: { schema: string; name: string }[] }) =>
  schema.tables.map((t) => `${t.schema}.${t.name}`)

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@example.com')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@example.com'))
  const envs = data(await admin.query('environments.list'))
  prodId = envs.find((e: { slug: string }) => e.slug === 'production').id

  superSql = postgres(env.databaseUrl, { onnotice: () => {} })
  await superSql.unsafe(`
    create schema warehouse;
    create table warehouse.orders (id int primary key, customer text not null, total numeric(10, 2));
    create table warehouse.secrets (id int primary key, token text);
    create role schema_reader login password '${SECRET}';
    grant usage on schema warehouse to schema_reader;
    grant select on warehouse.orders to schema_reader;
  `)
  const url = new URL(env.databaseUrl)
  pgId = data(
    await admin.mutate('resources.create', { type: 'postgres', name: 'Warehouse', slug: 'warehouse' }),
  ).id
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: pgId,
      environmentId: prodId,
      config: {
        host: url.hostname,
        port: Number(url.port),
        database: url.pathname.slice(1),
        user: 'schema_reader',
        ssl: 'disable',
      },
      secrets: { password: SECRET },
    }),
  )
})

afterAll(async () => {
  await superSql?.end()
  await env?.stop()
})

describe('SQL schema loading', () => {
  it('lists what the resource’s user may read, kept a while, read again on refresh', async () => {
    const first = data(await admin.query('resources.sqlSchema', { resourceId: pgId, environmentId: prodId }))
    expect(first).toMatchObject({ ok: true, supported: true })
    const orders = first.schema.tables.find((t: { name: string }) => t.name === 'orders')
    expect(orders).toEqual({
      schema: 'warehouse',
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'customer', type: 'text', nullable: false },
        { name: 'total', type: 'numeric', nullable: true },
      ],
    })
    // The reader has no grant on it: information_schema leaves it out.
    expect(tableNames(first.schema)).not.toContain('warehouse.secrets')

    await superSql.unsafe(
      'create table warehouse.lines (order_id int, sku text); grant select on warehouse.lines to schema_reader',
    )
    const kept = data(await admin.query('resources.sqlSchema', { resourceId: pgId, environmentId: prodId }))
    expect(tableNames(kept.schema)).not.toContain('warehouse.lines')
    const fresh = data(
      await admin.query('resources.sqlSchema', { resourceId: pgId, environmentId: prodId, refresh: true }),
    )
    expect(tableNames(fresh.schema)).toContain('warehouse.lines')
  })

  it('lists the built-in Database’s tables in the environment', async () => {
    await admin.mutate('database.createTable', {
      environmentId: prodId,
      name: 'stock',
      columns: [
        { name: 'name', type: 'text', nullable: false },
        { name: 'qty', type: 'integer' },
      ],
    })
    const list = data(await admin.query('resources.list')).resources
    const builtIn = list.find((r: { slug: string }) => r.slug === 'optiply_db')
    const schema = data(
      await admin.query('resources.sqlSchema', { resourceId: builtIn.id, environmentId: prodId }),
    ).schema
    expect(schema.tables).toEqual([
      expect.objectContaining({
        schema: 'owdb_production',
        name: 'stock',
        columns: expect.arrayContaining([
          { name: 'name', type: 'text', nullable: false },
          { name: 'qty', type: 'integer', nullable: true },
        ]),
      }),
    ])
  })

  it('needs Use, a database resource, and says why it failed', async () => {
    expect(
      (await member.query('resources.sqlSchema', { resourceId: pgId, environmentId: prodId })).status,
    ).toBe(404)
    const rest = data(await admin.query('resources.list')).resources.find(
      (r: { slug: string }) => r.slug === 'rest_api',
    )
    const notSql = await admin.query('resources.sqlSchema', { resourceId: rest.id, environmentId: prodId })
    expect(notSql.body.error?.message).toContain('Only database resources')

    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: pgId,
        environmentId: prodId,
        config: {
          ...data(await admin.query('resources.get', { id: pgId })).environments.find(
            (e: { environmentId: string }) => e.environmentId === prodId,
          ).config,
        },
        secrets: { password: 'wrong-password' },
      }),
    )
    const failed = data(await admin.query('resources.sqlSchema', { resourceId: pgId, environmentId: prodId }))
    expect(failed).toMatchObject({ ok: false, error: { message: expect.stringContaining('password') } })
  })
})
