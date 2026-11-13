/**
 * The managed database's schema API: tables and columns as the editor sees them, and the changes it can make,
 * all as the environment's role, for people with Use on the built-in resource there.
 */
import { auditEvents, environments, groupMembers, groups, permissions, resources } from '@ow/db'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseDefault } from '../src/services/managed-db'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let superSql: postgres.Sql
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let production: string
let staging: string

beforeAll(async () => {
  env = await startTestApp()
  superSql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  for (const e of await env.db.select().from(environments)) {
    if (e.slug === 'production') production = e.id
    if (e.slug === 'staging') staging = e.id
  }
  // The member gets Use on the database in production only, through a group.
  const [team] = await env.db.insert(groups).values({ name: 'Data team' }).returning()
  await env.db.insert(groupMembers).values({ groupId: team!.id, userId: memberUser.id })
  const [db] = await env.db.select().from(resources).where(eq(resources.systemKind, 'database'))
  await env.db.insert(permissions).values({
    groupId: team!.id,
    objectType: 'resource',
    objectId: db!.id,
    environmentId: production,
    level: 'use',
  })
}, 60_000)
afterAll(async () => {
  await superSql?.end()
  await env?.stop()
})

const data = (res: { body: { result?: { data: unknown } } }) =>
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  res.body.result?.data as any
const error = (res: { body: { error?: { message: string; data?: { code: string } } } }) => res.body.error

describe('access', () => {
  it('lists every environment, ready, and where the caller may use the database', async () => {
    const mine = data(await member.query('database.environments'))
    expect(mine.resourceSlug).toBe('optiply_db')
    expect(
      Object.fromEntries(
        mine.environments.map((e: { slug: string; ready: boolean; canUse: boolean }) => [
          e.slug,
          [e.ready, e.canUse],
        ]),
      ),
    ).toEqual({ production: [true, true], staging: [true, false] })
    const theirs = data(await admin.query('database.environments'))
    expect(theirs.environments.every((e: { canUse: boolean }) => e.canUse)).toBe(true)
  })

  it('needs Use on the built-in resource in that environment', async () => {
    expect(data(await member.query('database.tables', { environmentId: production }))).toEqual([])
    const refused = await member.query('database.tables', { environmentId: staging })
    expect(error(refused)).toMatchObject({ data: { code: 'FORBIDDEN' } })
    const create = await member.mutate('database.createTable', { environmentId: staging, name: 'sneaky' })
    expect(error(create)).toMatchObject({ data: { code: 'FORBIDDEN' } })
  })
})

describe('tables', () => {
  it('creates a table with an id key and every column type, defaults included', async () => {
    const created = await member.mutate('database.createTable', {
      environmentId: production,
      name: 'orders',
      columns: [
        { name: 'reference', type: 'text', nullable: false, unique: true },
        { name: 'quantity', type: 'integer', default: { kind: 'value', value: '1' } },
        { name: 'total', type: 'decimal' },
        { name: 'paid', type: 'boolean', default: { kind: 'value', value: 'false' } },
        { name: 'ordered_on', type: 'date', default: { kind: 'expression', expression: 'current_date' } },
        { name: 'created_at', type: 'datetime', default: { kind: 'expression', expression: 'now()' } },
        { name: 'details', type: 'json' },
        { name: 'token', type: 'uuid', default: { kind: 'expression', expression: 'gen_random_uuid()' } },
        { name: 'status', type: 'text', default: { kind: 'value', value: "it's new" } },
        { name: 'big', type: 'bigint' },
      ],
    })
    const table = data(created)
    expect(table.primaryKey).toEqual(['id'])
    const columns = Object.fromEntries(table.columns.map((c: { name: string }) => [c.name, c])) as Record<
      string,
      Record<string, unknown>
    >
    expect(columns.id).toMatchObject({ type: 'bigint', identity: true, primaryKey: true, nullable: false })
    expect(columns.reference).toMatchObject({ type: 'text', nullable: false, unique: true })
    expect(columns.quantity).toMatchObject({ type: 'integer', default: { kind: 'value', value: '1' } })
    expect(columns.total).toMatchObject({ type: 'decimal', nullable: true, default: { kind: 'none' } })
    expect(columns.paid).toMatchObject({ type: 'boolean', default: { kind: 'value', value: 'false' } })
    expect(columns.ordered_on).toMatchObject({
      type: 'date',
      default: { kind: 'expression', expression: 'current_date' },
    })
    expect(columns.created_at).toMatchObject({
      type: 'datetime',
      default: { kind: 'expression', expression: 'now()' },
    })
    expect(columns.details).toMatchObject({ type: 'json' })
    expect(columns.token).toMatchObject({
      type: 'uuid',
      default: { kind: 'expression', expression: 'gen_random_uuid()' },
    })
    expect(columns.status).toMatchObject({ default: { kind: 'value', value: "it's new" } })
    expect(columns.big).toMatchObject({ type: 'bigint' })

    // The defaults work: a row with only the required column gets the rest filled in.
    const [row] = await superSql`insert into owdb_production.orders (reference) values ('A-1') returning *`
    expect(row).toMatchObject({ id: '1', quantity: 1, paid: false, status: "it's new" })
    expect(row!.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(await audits('database.table_created')).toEqual([
      expect.objectContaining({
        objectType: 'database_table',
        objectId: 'orders',
        environmentId: production,
      }),
    ])
  })

  it('keeps environments apart', async () => {
    const tables = data(await admin.query('database.tables', { environmentId: staging }))
    expect(tables).toEqual([])
  })

  it('refuses bad names, duplicates, and a second id column', async () => {
    for (const name of ['Bad Name', 'pg_secret', '1st']) {
      const res = await member.mutate('database.createTable', { environmentId: production, name })
      expect(error(res)?.data?.code).toBe('BAD_REQUEST')
    }
    const dup = await member.mutate('database.createTable', { environmentId: production, name: 'orders' })
    expect(error(dup)).toMatchObject({
      data: { code: 'BAD_REQUEST' },
      message: expect.stringMatching(/already exists/),
    })
    const id = await member.mutate('database.createTable', {
      environmentId: production,
      name: 'other',
      columns: [{ name: 'id', type: 'text' }],
    })
    expect(error(id)?.message).toMatch(/already has an id column/)
    const twice = await member.mutate('database.createTable', {
      environmentId: production,
      name: 'other',
      columns: [
        { name: 'a', type: 'text' },
        { name: 'a', type: 'integer' },
      ],
    })
    expect(error(twice)?.message).toMatch(/Two columns are named a/)
  })

  it('renames and drops tables, including ones made in SQL with odd names', async () => {
    // Made in SQL through the resource, so owned by the environment's role.
    const role = (
      await superSql<{ role: string }[]>`
        select role_name as role from managed_databases where environment_id = ${production}`
    )[0]!.role
    await superSql.begin(async (tx) => {
      await tx.unsafe(`set local role "${role}"`)
      await tx`create table owdb_production."We ""Odd"" One" (id int primary key, note varchar(20))`
    })
    const odd = data(await member.query('database.tables', { environmentId: production })).find(
      (t: { name: string }) => t.name === 'We "Odd" One',
    )
    expect(odd.columns[1]).toMatchObject({ name: 'note', type: 'other', sqlType: 'character varying(20)' })
    const renamed = await member.mutate('database.renameTable', {
      environmentId: production,
      table: 'We "Odd" One',
      to: 'odd_one',
    })
    expect(data(renamed).name).toBe('odd_one')
    expect(
      error(await member.mutate('database.dropTable', { environmentId: production, table: 'odd_one' })),
    ).toBe(undefined)
    const missing = await member.mutate('database.dropTable', { environmentId: production, table: 'odd_one' })
    expect(error(missing)?.data?.code).toBe('NOT_FOUND')
  })
})

describe('columns', () => {
  const orders = () => ({ environmentId: production, table: 'orders' })
  const column = async (name: string) =>
    data(await member.query('database.tables', { environmentId: production }))
      .find((t: { name: string }) => t.name === 'orders')
      .columns.find((c: { name: string }) => c.name === name)

  it('adds, renames and drops columns, but never the id', async () => {
    const added = await member.mutate('database.addColumn', {
      ...orders(),
      column: { name: 'notes', type: 'text', default: { kind: 'value', value: '' } },
    })
    expect(data(added).columns.at(-1)).toMatchObject({ name: 'notes', default: { kind: 'value', value: '' } })
    await member.mutate('database.renameColumn', { ...orders(), column: 'notes', to: 'remarks' })
    expect(await column('remarks')).toBeTruthy()
    await member.mutate('database.dropColumn', { ...orders(), column: 'remarks' })
    expect(await column('remarks')).toBeUndefined()

    for (const [path, input] of [
      ['database.renameColumn', { ...orders(), column: 'id', to: 'key' }],
      ['database.dropColumn', { ...orders(), column: 'id' }],
      ['database.alterColumn', { ...orders(), column: 'id', change: { type: 'text' } }],
      ['database.renameColumn', { ...orders(), column: 'total', to: 'id' }],
    ] as const) {
      expect(error(await member.mutate(path, input))?.data?.code).toBe('BAD_REQUEST')
    }
  })

  it('changes a type by casting the values, and refuses (changing nothing) when one does not convert', async () => {
    await member.mutate('database.addColumn', { ...orders(), column: { name: 'code', type: 'text' } })
    await superSql`update owdb_production.orders set code = '42'`
    const ok = await member.mutate('database.alterColumn', {
      ...orders(),
      column: 'code',
      change: { type: 'integer' },
    })
    expect(error(ok)).toBeUndefined()
    expect((await superSql`select code from owdb_production.orders`)[0]).toEqual({ code: 42 })

    await member.mutate('database.alterColumn', { ...orders(), column: 'code', change: { type: 'text' } })
    await superSql`update owdb_production.orders set code = 'forty-two'`
    const bad = await member.mutate('database.alterColumn', {
      ...orders(),
      column: 'code',
      change: { type: 'integer' },
    })
    expect(error(bad)).toMatchObject({
      data: { code: 'BAD_REQUEST' },
      message: expect.stringMatching(/integer/),
    })
    expect(await column('code')).toMatchObject({ type: 'text' })
  })

  it('keeps a default it understands across a type change', async () => {
    await member.mutate('database.alterColumn', {
      ...orders(),
      column: 'quantity',
      change: { type: 'bigint' },
    })
    expect(await column('quantity')).toMatchObject({ type: 'bigint', default: { kind: 'value', value: '1' } })
  })

  it('turns text into JSON and JSON back into numbers', async () => {
    await superSql`update owdb_production.orders set code = '{"n": 7}'`
    await member.mutate('database.alterColumn', { ...orders(), column: 'code', change: { type: 'json' } })
    expect((await superSql`select code from owdb_production.orders`)[0]).toEqual({ code: { n: 7 } })
    await superSql`update owdb_production.orders set code = '7'::jsonb`
    await member.mutate('database.alterColumn', { ...orders(), column: 'code', change: { type: 'integer' } })
    expect((await superSql`select code from owdb_production.orders`)[0]).toEqual({ code: 7 })
  })

  it('sets and clears not-null, unique and defaults', async () => {
    await superSql`update owdb_production.orders set total = null`
    const notNull = await member.mutate('database.alterColumn', {
      ...orders(),
      column: 'total',
      change: { nullable: false },
    })
    expect(error(notNull)?.message).toMatch(/null values/)
    await superSql`update owdb_production.orders set total = 9.5`
    await member.mutate('database.alterColumn', { ...orders(), column: 'total', change: { nullable: false } })
    expect(await column('total')).toMatchObject({ nullable: false })

    await member.mutate('database.alterColumn', { ...orders(), column: 'total', change: { unique: true } })
    expect(await column('total')).toMatchObject({ unique: true })
    await member.mutate('database.alterColumn', { ...orders(), column: 'total', change: { unique: false } })
    expect(await column('total')).toMatchObject({ unique: false })

    await member.mutate('database.alterColumn', {
      ...orders(),
      column: 'total',
      change: { default: { kind: 'value', value: '0' } },
    })
    expect(await column('total')).toMatchObject({ default: { kind: 'value', value: '0' } })
    await member.mutate('database.alterColumn', {
      ...orders(),
      column: 'total',
      change: { default: { kind: 'none' } },
    })
    expect(await column('total')).toMatchObject({ default: { kind: 'none' } })
    expect((await audits('database.column_changed')).length).toBeGreaterThanOrEqual(5)
  })

  it('gives up on a busy table after 5 seconds instead of queueing behind it', async () => {
    const holder = postgres(env.databaseUrl, { max: 1, onnotice: () => {} })
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const locked = new Promise<void>((ready) => {
      void holder.begin(async (tx) => {
        await tx`lock table owdb_production.orders in access exclusive mode`
        ready()
        await held
      })
    })
    await locked
    const started = Date.now()
    const res = await member.mutate('database.addColumn', {
      ...orders(),
      column: { name: 'late', type: 'text' },
    })
    release()
    await holder.end()
    expect(error(res)).toMatchObject({ data: { code: 'CONFLICT' } })
    expect(Date.now() - started).toBeLessThan(8000)
  }, 20_000)
})

describe("Retool's presets", () => {
  const inProd = { environmentId: production }
  const table = async (name: string) =>
    data(await member.query('database.tables', { environmentId: production })).find(
      (t: { name: string }) => t.name === name,
    )
  const col = async (t: string, name: string) =>
    (await table(t)).columns.find((c: { name: string }) => c.name === name)

  it('makes auto-incrementing IDs, enums, foreign keys and custom types, and reads them back', async () => {
    const vendors = await member.mutate('database.createTable', {
      ...inProd,
      environmentId: production,
      name: 'vendors',
      columns: [{ name: 'code', type: 'text', unique: true, nullable: false }],
    })
    expect(error(vendors)).toBeUndefined()
    const made = await member.mutate('database.createTable', {
      environmentId: production,
      name: 'purchases',
      columns: [
        { name: 'number', type: 'integer', identity: true },
        { name: 'ref', type: 'uuid', default: { kind: 'expression', expression: 'gen_random_uuid()' } },
        { name: 'created', type: 'datetime', default: { kind: 'expression', expression: 'now()' } },
        {
          name: 'status',
          type: 'text',
          enumValues: ['open', "it's late", 'a, b'],
          default: { kind: 'value', value: 'open' },
        },
        {
          name: 'vendor_id',
          type: 'foreignKey',
          references: { table: 'vendors', column: 'id', onDelete: 'cascade' },
        },
        { name: 'vendor_code', type: 'foreignKey', references: { table: 'vendors', column: 'code' } },
        { name: 'sku', type: 'custom', sqlType: 'varchar(20)' },
        { name: 'tags', type: 'custom', sqlType: 'text[]' },
      ],
    })
    expect(error(made)).toBeUndefined()
    const byName = Object.fromEntries(data(made).columns.map((c: { name: string }) => [c.name, c]))
    expect(byName.number).toMatchObject({ type: 'integer', identity: true })
    expect(byName.ref).toMatchObject({
      type: 'uuid',
      default: { kind: 'expression', expression: 'gen_random_uuid()' },
    })
    expect(byName.created).toMatchObject({
      type: 'datetime',
      default: { kind: 'expression', expression: 'now()' },
    })
    expect(byName.status).toMatchObject({
      type: 'text',
      enumValues: ['open', "it's late", 'a, b'],
      references: null,
    })
    expect(byName.vendor_id).toMatchObject({
      type: 'bigint',
      references: { table: 'vendors', column: 'id', onDelete: 'cascade' },
      enumValues: null,
    })
    expect(byName.vendor_code).toMatchObject({
      type: 'text',
      references: { table: 'vendors', column: 'code', onDelete: 'no action' },
    })
    expect(byName.sku).toMatchObject({ type: 'other', sqlType: 'character varying(20)' })
    expect(byName.tags).toMatchObject({ type: 'other', sqlType: 'text[]' })

    // Postgres holds them to it.
    await superSql`insert into owdb_production.vendors (code) values ('ACME')`
    const [row] = await superSql`
      insert into owdb_production.purchases (vendor_id, vendor_code) values (1, 'ACME') returning number, status, ref`
    expect(row).toMatchObject({ number: 1, status: 'open', ref: expect.any(String) })
    await expect(superSql`insert into owdb_production.purchases (status) values ('closed')`).rejects.toThrow(
      /check/,
    )
    await expect(superSql`insert into owdb_production.purchases (vendor_id) values (99)`).rejects.toThrow(
      /foreign key/,
    )
  })

  it('refuses types Postgres lacks or that try to end the statement, and extras on the wrong type', async () => {
    for (const column of [
      { name: 'x', type: 'custom', sqlType: 'not_a_type' },
      { name: 'x', type: 'custom', sqlType: 'text); drop table vendors; --' },
      { name: 'x', type: 'custom' },
      { name: 'x', type: 'integer', enumValues: ['a'] },
      { name: 'x', type: 'text', identity: true },
      { name: 'x', type: 'text', enumValues: ['a', 'a'] },
      { name: 'x', type: 'foreignKey' },
      { name: 'x', type: 'foreignKey', references: { table: 'vendors', column: 'nope' } },
      { name: 'x', type: 'foreignKey', references: { table: 'purchases', column: 'status' } },
    ]) {
      const res = await member.mutate('database.addColumn', {
        ...inProd,
        environmentId: production,
        table: 'purchases',
        column,
      })
      expect(error(res)?.data?.code, JSON.stringify(column)).toBe('BAD_REQUEST')
    }
    expect(await table('vendors')).toBeTruthy()
  })

  it('changes enums, foreign keys and custom types on existing columns', async () => {
    const on = { environmentId: production, table: 'purchases' }
    const alter = (column: string, change: object) =>
      member.mutate('database.alterColumn', { ...on, column, change })

    // A value outside the new list stops the change.
    await superSql`update owdb_production.purchases set status = 'a, b'`
    expect(error(await alter('status', { enumValues: ['open', 'done'] }))?.data?.code).toBe('BAD_REQUEST')
    expect(await col('purchases', 'status')).toMatchObject({ enumValues: ['open', "it's late", 'a, b'] })
    expect(error(await alter('status', { enumValues: ['open', 'a, b', 'done'] }))).toBeUndefined()
    expect(await col('purchases', 'status')).toMatchObject({ enumValues: ['open', 'a, b', 'done'] })
    // Plain text again, then an enum from text.
    expect(error(await alter('status', { enumValues: null }))).toBeUndefined()
    expect(await col('purchases', 'status')).toMatchObject({ type: 'text', enumValues: null })
    expect(error(await alter('status', { type: 'text', enumValues: ['a, b'] }))).toBeUndefined()
    expect(await col('purchases', 'status')).toMatchObject({ enumValues: ['a, b'] })
    // Leaving text drops the enum.
    await superSql`update owdb_production.purchases set status = null`
    expect(error(await alter('status', { type: 'json', default: { kind: 'none' } }))).toBeUndefined()
    expect(await col('purchases', 'status')).toMatchObject({ type: 'json', enumValues: null })

    // A foreign key made from a plain column (converted to the referenced type), and back.
    expect(
      error(await alter('sku', { type: 'foreignKey', references: { table: 'vendors', column: 'code' } })),
    ).toBeUndefined()
    expect(await col('purchases', 'sku')).toMatchObject({
      type: 'text',
      references: { table: 'vendors', column: 'code' },
    })
    expect(error(await alter('sku', { type: 'text' }))).toBeUndefined()
    expect(await col('purchases', 'sku')).toMatchObject({ type: 'text', references: null })
    // The on-delete rule changes on its own.
    expect(
      error(
        await alter('vendor_id', { references: { table: 'vendors', column: 'id', onDelete: 'set null' } }),
      ),
    ).toBeUndefined()
    expect(await col('purchases', 'vendor_id')).toMatchObject({ references: { onDelete: 'set null' } })
    // A custom type, values converted; an auto-incrementing column stays an integer (Postgres says so).
    expect(
      error(await alter('ref', { type: 'custom', sqlType: 'varchar(40)', default: { kind: 'none' } })),
    ).toBeUndefined()
    expect(await col('purchases', 'ref')).toMatchObject({ type: 'other', sqlType: 'character varying(40)' })
    expect(error(await alter('number', { type: 'custom', sqlType: 'numeric(12,2)' }))?.message).toMatch(
      /identity column/,
    )
  })
})

describe('a shared connection', () => {
  it("isn't thrown off by settings a playground query left behind", async () => {
    const [db] = await env.db.select().from(resources).where(eq(resources.systemKind, 'database'))
    // Plain SETs outlast their transaction: on every pooled connection (5), leave a wrong schema, a
    // day-first date style and read-only transactions behind.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        admin.mutate('resources.run', {
          resourceId: db!.id,
          environmentId: production,
          query: {
            sql: "select set_config('search_path', 'public', false), set_config('DateStyle', 'SQL, DMY', false), set_config('default_transaction_read_only', 'on', false)",
          },
        }),
      ),
    )
    for (let i = 0; i < 5; i++) {
      const name = `after_set_${i}`
      const created = await admin.mutate('database.createTable', {
        environmentId: production,
        name,
        columns: [{ name: 'day', type: 'date' }],
      })
      expect(error(created)).toBeUndefined()
      const row = await admin.mutate('database.insertRow', {
        environmentId: production,
        table: name,
        values: { day: '2026-01-31' },
      })
      expect(row.body.result?.data).toMatchObject({ day: '2026-01-31' })
    }
    const counted = await superSql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'owdb_production' and tablename like 'after_set_%'`
    expect(counted[0]!.n).toBe(5)
  })
})

describe('parseDefault', () => {
  it('reads defaults as Postgres prints them', () => {
    expect(parseDefault(null)).toEqual({ kind: 'none' })
    expect(parseDefault("'a''b'::text")).toEqual({ kind: 'value', value: "a'b" })
    expect(parseDefault("'2026-01-01'::date")).toEqual({ kind: 'value', value: '2026-01-01' })
    expect(parseDefault('(-5)')).toEqual({ kind: 'value', value: '-5' })
    expect(parseDefault('1.5')).toEqual({ kind: 'value', value: '1.5' })
    expect(parseDefault('true')).toEqual({ kind: 'value', value: 'true' })
    expect(parseDefault('now()')).toEqual({ kind: 'expression', expression: 'now()' })
    expect(parseDefault('CURRENT_DATE')).toEqual({ kind: 'expression', expression: 'current_date' })
    expect(parseDefault("nextval('x_seq'::regclass)")).toEqual({
      kind: 'other',
      expression: "nextval('x_seq'::regclass)",
    })
  })
})

async function audits(action: string) {
  return env.db.select().from(auditEvents).where(eq(auditEvents.action, action))
}
