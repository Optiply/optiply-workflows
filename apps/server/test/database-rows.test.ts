/**
 * Rows of managed tables, as the grid reads and writes them: pages with sort and filter, values in shapes JSON keeps
 * exactly, and single-row writes whose errors name the field they're about.
 */
import { auditEvents, environments } from '@ow/db'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let superSql: postgres.Sql
let admin: ReturnType<typeof trpc>
let outsider: ReturnType<typeof trpc>
let production: string
let role: string

const data = (res: { body: { result?: { data: unknown } } }) =>
  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  res.body.result?.data as any
const error = (res: { body: { error?: { message: string; data?: { code: string } } } }) => res.body.error
const on = (table: string) => ({ environmentId: production, table })

beforeAll(async () => {
  env = await startTestApp()
  superSql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'outsider@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  outsider = trpc(env.app, await login(env.app, 'outsider@optiply.nl'))
  const [prod] = await env.db.select().from(environments).where(eq(environments.slug, 'production'))
  production = prod!.id
  role = (
    await superSql<{ role: string }[]>`
      select role_name as role from managed_databases where environment_id = ${production}`
  )[0]!.role
  const created = await admin.mutate('database.createTable', {
    environmentId: production,
    name: 'products',
    columns: [
      { name: 'name', type: 'text', nullable: false, unique: true },
      { name: 'price', type: 'decimal' },
      { name: 'stock', type: 'integer' },
      { name: 'active', type: 'boolean', default: { kind: 'value', value: 'true' } },
      { name: 'launched', type: 'date' },
      { name: 'updated_at', type: 'datetime' },
      { name: 'tags', type: 'json' },
      { name: 'sku', type: 'uuid' },
      { name: 'big', type: 'bigint' },
    ],
  })
  expect(error(created)).toBeUndefined()
}, 60_000)
afterAll(async () => {
  await superSql?.end()
  await env?.stop()
})

/** As the environment's role, like a query from a workflow would. */
async function asRole(statement: string) {
  return superSql.begin(async (tx) => {
    await tx.unsafe(`set local role "${role}"`)
    await tx.unsafe('set local search_path = owdb_production')
    return tx.unsafe(statement)
  })
}

describe('writing rows', () => {
  it('inserts a row and returns it with every type in a JSON-exact shape', async () => {
    const res = await admin.mutate('database.insertRow', {
      ...on('products'),
      values: {
        name: 'Widget',
        price: '9.99',
        stock: 5,
        launched: '2026-01-02',
        updated_at: '2026-01-02T05:04:05+02:00',
        tags: ['new', { featured: true }],
        sku: '0b9c3c1e-4d1f-4c6b-9e7a-3f5d2a1b0c9d',
        big: '9007199254740993',
      },
    })
    expect(error(res)).toBeUndefined()
    expect(data(res)).toEqual({
      id: '1',
      name: 'Widget',
      price: '9.99',
      stock: 5,
      active: true,
      launched: '2026-01-02',
      updated_at: '2026-01-02T03:04:05+00:00',
      tags: ['new', { featured: true }],
      sku: '0b9c3c1e-4d1f-4c6b-9e7a-3f5d2a1b0c9d',
      // Past 2^53: a JS number would have lost the last digit.
      big: '9007199254740993',
    })
  })

  it('fills in defaults for what is left out, and takes datetimes without an offset as UTC', async () => {
    const row = data(
      await admin.mutate('database.insertRow', {
        ...on('products'),
        values: { name: 'Gadget', updated_at: '2026-03-01 12:00' },
      }),
    )
    expect(row).toMatchObject({ id: '2', active: true, price: null, updated_at: '2026-03-01T12:00:00+00:00' })
  })

  it('names the field a refused value belongs to, and writes nothing', async () => {
    const before = await count('products')
    const bad = await admin.mutate('database.insertRow', {
      ...on('products'),
      values: { name: 'Thing', stock: 'lots', price: '1' },
    })
    expect(error(bad)).toMatchObject({
      data: { code: 'BAD_REQUEST' },
      message: expect.stringMatching(/^stock: invalid input syntax for type integer/),
    })
    const missing = await admin.mutate('database.insertRow', { ...on('products'), values: { price: '1' } })
    expect(error(missing)?.message).toBe('name: is required')
    const duplicate = await admin.mutate('database.insertRow', {
      ...on('products'),
      values: { name: 'Widget' },
    })
    expect(error(duplicate)?.message).toBe('name: must be unique: another row has this value')
    const badJson = await admin.mutate('database.insertRow', {
      ...on('products'),
      values: { name: 'X', launched: '2026-13-45' },
    })
    expect(error(badJson)?.message).toMatch(/^launched: /)
    const unknown = await admin.mutate('database.insertRow', {
      ...on('products'),
      values: { name: 'Y', colour: 'red' },
    })
    expect(error(unknown)?.message).toMatch(/has no column named colour/)
    expect(await count('products')).toBe(before)
  })

  it('updates a row by its key, including setting a value to null', async () => {
    const res = await admin.mutate('database.updateRow', {
      ...on('products'),
      key: '1',
      values: { price: '12.50', stock: null },
    })
    expect(data(res)).toMatchObject({ id: '1', price: '12.50', stock: null, name: 'Widget' })
    const missing = await admin.mutate('database.updateRow', {
      ...on('products'),
      key: 999,
      values: { stock: 1 },
    })
    expect(error(missing)).toMatchObject({ data: { code: 'NOT_FOUND' } })
    const clash = await admin.mutate('database.updateRow', {
      ...on('products'),
      key: 2,
      values: { name: 'Widget' },
    })
    expect(error(clash)?.message).toBe('name: must be unique: another row has this value')
    const nothing = await admin.mutate('database.updateRow', { ...on('products'), key: 1, values: {} })
    expect(error(nothing)?.message).toBe('Nothing to change')
  })

  it('logs who changed which rows and columns, never the values', async () => {
    const [update] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'database.row_updated'))
    expect(update).toMatchObject({
      objectType: 'database_table',
      objectId: 'products',
      metadata: { key: '1', columns: ['price', 'stock'] },
    })
    const all = JSON.stringify(await env.db.select({ m: auditEvents.metadata }).from(auditEvents))
    expect(all).not.toContain('12.50')
    expect(all).not.toContain('9007199254740993')
  })

  it('needs a single-column primary key to edit or delete, but can read and add to any table', async () => {
    await asRole('create table loose (label text)')
    expect(
      error(await admin.mutate('database.insertRow', { ...on('loose'), values: { label: 'a' } })),
    ).toBeUndefined()
    const page = data(await admin.query('database.rows', on('loose')))
    expect(page.rows).toEqual([{ label: 'a' }])
    const update = await admin.mutate('database.updateRow', {
      ...on('loose'),
      key: 1,
      values: { label: 'b' },
    })
    expect(error(update)?.message).toMatch(/no primary key/)
    const remove = await admin.mutate('database.deleteRows', { ...on('loose'), keys: [1] })
    expect(error(remove)?.message).toMatch(/no primary key/)
  })
})

describe('reading rows', () => {
  beforeAll(async () => {
    await asRole(`
      insert into products (name, price, stock, active, tags)
      select 'Item ' || lpad(i::text, 2, '0'), (i * 1.5)::numeric, i % 7, i % 2 = 0,
             case when i % 5 = 0 then null else jsonb_build_array('t' || i) end
      from generate_series(1, 30) i`)
  })
  const names = (page: { rows: { name: string }[] }) => page.rows.map((r) => r.name)

  it('pages through the rows in key order, with the count', async () => {
    const first = data(await admin.query('database.rows', { ...on('products'), query: { limit: 10 } }))
    expect(first.total).toBe(32)
    expect(first.more).toBe(false)
    expect(first.rows).toHaveLength(10)
    expect(first.rows[0].id).toBe('1')
    expect(first.table.columns.map((c: { name: string }) => c.name)).toContain('price')
    const third = data(
      await admin.query('database.rows', { ...on('products'), query: { limit: 10, offset: 30 } }),
    )
    expect(names(third)).toEqual(['Item 29', 'Item 30'])
  })

  it('sorts by any column, empty values last, then by the key', async () => {
    const page = data(
      await admin.query('database.rows', {
        ...on('products'),
        query: { sort: [{ column: 'price', desc: true }], limit: 3 },
      }),
    )
    expect(names(page)).toEqual(['Item 30', 'Item 29', 'Item 28'])
    const byStock = data(
      await admin.query('database.rows', {
        ...on('products'),
        query: { sort: [{ column: 'stock' }], limit: 40 },
      }),
    )
    // Gadget and Widget have no stock: last.
    expect(names(byStock).slice(-2)).toEqual(['Widget', 'Gadget'])
  })

  it('filters by comparison, text search and emptiness, all or any', async () => {
    const q = async (query: object) =>
      names(data(await admin.query('database.rows', { ...on('products'), query: { limit: 100, ...query } })))
    expect(await q({ filters: [{ column: 'price', op: 'gte', value: '42' }] })).toEqual([
      'Item 28',
      'Item 29',
      'Item 30',
    ])
    expect(await q({ filters: [{ column: 'name', op: 'contains', value: 'ITEM 1' }] })).toHaveLength(10)
    expect(await q({ filters: [{ column: 'name', op: 'starts_with', value: 'gad' }] })).toEqual(['Gadget'])
    expect(await q({ filters: [{ column: 'tags', op: 'is_empty' }] })).toEqual([
      'Gadget',
      'Item 05',
      'Item 10',
      'Item 15',
      'Item 20',
      'Item 25',
      'Item 30',
    ])
    expect(
      await q({
        filters: [
          { column: 'stock', op: 'eq', value: '6' },
          { column: 'active', op: 'eq', value: 'true' },
        ],
      }),
    ).toEqual(['Item 06', 'Item 20'])
    expect(
      await q({
        match: 'any',
        filters: [
          { column: 'name', op: 'eq', value: 'Widget' },
          { column: 'name', op: 'eq', value: 'Gadget' },
        ],
      }),
    ).toEqual(['Widget', 'Gadget'])
    // neq keeps rows whose value is empty, like a spreadsheet does.
    expect(await q({ filters: [{ column: 'stock', op: 'neq', value: '0' }] })).toHaveLength(28)
    expect(await q({ filters: [{ column: 'name', op: 'not_contains', value: 'item' }] })).toEqual([
      'Widget',
      'Gadget',
    ])
  })

  it('compares JSON columns to the JSON typed into the filter', async () => {
    const page = data(
      await admin.query('database.rows', {
        ...on('products'),
        query: { filters: [{ column: 'tags', op: 'eq', value: '["t7"]' }] },
      }),
    )
    expect(names(page)).toEqual(['Item 07'])
    const not = data(
      await admin.query('database.rows', {
        ...on('products'),
        query: { filters: [{ column: 'tags', op: 'neq', value: '["t7"]' }], limit: 100 },
      }),
    )
    expect(names(not)).toHaveLength(31)
    const bad = await admin.query('database.rows', {
      ...on('products'),
      query: { filters: [{ column: 'tags', op: 'eq', value: '[not json' }] },
    })
    expect(error(bad)).toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })

  it('treats filter values as values, never as SQL', async () => {
    const page = data(
      await admin.query('database.rows', {
        ...on('products'),
        query: { filters: [{ column: 'name', op: 'eq', value: "x'); drop table products; --" }] },
      }),
    )
    expect(page.rows).toEqual([])
    expect(await count('products')).toBe(32)
    const wrongType = await admin.query('database.rows', {
      ...on('products'),
      query: { filters: [{ column: 'stock', op: 'gt', value: 'many' }] },
    })
    expect(error(wrongType)).toMatchObject({ data: { code: 'BAD_REQUEST' } })
    const noColumn = await admin.query('database.rows', {
      ...on('products'),
      query: { sort: [{ column: 'nope' }] },
    })
    expect(error(noColumn)?.message).toMatch(/has no column named nope/)
  })

  it('counts up to 10,000 and says when there are more', async () => {
    await asRole('create table many (id bigint generated always as identity primary key, n int)')
    await asRole('insert into many (n) select i from generate_series(1, 10005) i')
    const page = data(await admin.query('database.rows', { ...on('many'), query: { limit: 5 } }))
    expect(page).toMatchObject({ total: 10_000, more: true })
    expect(page.rows).toHaveLength(5)
  })

  it('is only for people with Use on the database', async () => {
    expect(error(await outsider.query('database.rows', on('products')))).toMatchObject({
      data: { code: 'FORBIDDEN' },
    })
    expect(
      error(await outsider.mutate('database.insertRow', { ...on('products'), values: { name: 'Mine' } })),
    ).toMatchObject({ data: { code: 'FORBIDDEN' } })
  })
})

describe('deleting rows', () => {
  it('deletes rows by key and says how many went', async () => {
    const res = await admin.mutate('database.deleteRows', { ...on('products'), keys: ['1', 2, '999'] })
    expect(data(res)).toEqual({ deleted: 2 })
    expect(await count('products')).toBe(30)
    const [event] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'database.rows_deleted'))
    expect(event?.metadata).toEqual({ keys: ['1', 2, '999'], deleted: 2 })
  })
})

async function count(table: string): Promise<number> {
  const rows = await superSql.unsafe(`select count(*)::int as n from owdb_production.${table}`)
  return rows[0]!.n as number
}
