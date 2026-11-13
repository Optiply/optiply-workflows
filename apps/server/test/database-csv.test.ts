/**
 * CSV in and out of the managed database through the real routes: the preview's guesses, streamed imports (all or
 * nothing, with the line and column of every problem), and streamed exports that honour the grid's selection.
 */
import { auditEvents, environments } from '@ow/db'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IMPORT_CONTENT_TYPE } from '../src/api/database'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let superSql: postgres.Sql
let adminCookie: string
let outsiderCookie: string
let admin: ReturnType<typeof trpc>
let production: string

beforeAll(async () => {
  env = await startTestApp()
  superSql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'outsider@optiply.nl')
  adminCookie = await login(env.app, 'admin@optiply.nl')
  outsiderCookie = await login(env.app, 'outsider@optiply.nl')
  admin = trpc(env.app, adminCookie)
  const [prod] = await env.db.select().from(environments).where(eq(environments.slug, 'production'))
  production = prod!.id
}, 60_000)
afterAll(async () => {
  await superSql?.end()
  await env?.stop()
})

type Spec = Record<string, unknown>

function importCsv(spec: Spec, csv: string | Buffer, cookie = adminCookie) {
  const body = Buffer.concat([
    Buffer.from(`${JSON.stringify({ environmentId: production, delimiter: ',', ...spec })}\n`),
    Buffer.isBuffer(csv) ? csv : Buffer.from(csv),
  ])
  return env.app.inject({
    method: 'POST',
    url: '/api/v1/database/import',
    headers: { cookie, 'content-type': IMPORT_CONTENT_TYPE },
    payload: body,
  })
}

function exportCsv(table: string, selection?: object, cookie = adminCookie) {
  const qs = new URLSearchParams({ environmentId: production, table })
  if (selection) qs.set('selection', JSON.stringify(selection))
  return env.app.inject({ method: 'GET', url: `/api/v1/database/export.csv?${qs}`, headers: { cookie } })
}

async function rows(table: string, order = 'id') {
  return superSql.unsafe(`select * from owdb_production.${table} order by ${order}`)
}

async function tableExists(name: string): Promise<boolean> {
  const [row] = await superSql`select to_regclass(${`owdb_production.${name}`}) is not null as yes`
  return row!.yes
}

describe('previewing', () => {
  it('guesses the delimiter, names, types, date order and decimal commas from the start of a file', async () => {
    const res = await admin.mutate('database.previewCsv', {
      sample:
        'Naam;Prijs;Besteld op;Actief\nKoffie;1.234,50;31-01-2026;ja\nThee;2,5;01-02-2026;nee\nHalf;"cut',
    })
    expect(res.body.result?.data).toMatchObject({
      delimiter: ';',
      decimalComma: true,
      dateOrder: 'DMY',
      names: ['naam', 'prijs', 'besteld_op', 'actief'],
      // ja/nee aren't booleans Postgres reads: text.
      types: ['text', 'decimal', 'date', 'text'],
      rows: [
        ['Koffie', '1.234,50', '31-01-2026', 'ja'],
        ['Thee', '2,5', '01-02-2026', 'nee'],
      ],
    })
  })

  it('reads with the delimiter it is told to use', async () => {
    const res = await admin.mutate('database.previewCsv', {
      sample: 'a;b,c\n1;2,3\n',
      delimiter: ',',
      complete: true,
    })
    expect(res.body.result?.data).toMatchObject({
      delimiter: ',',
      header: ['a;b', 'c'],
      rows: [['1;2', '3']],
    })
  })
})

describe('importing', () => {
  it('creates a table from a file, reading Dutch dates and decimal commas', async () => {
    const res = await importCsv(
      {
        mode: 'create',
        table: 'prices',
        delimiter: ';',
        dateOrder: 'DMY',
        decimalComma: true,
        columns: [
          { source: 0, name: 'naam', type: 'text' },
          { source: 1, name: 'prijs', type: 'decimal' },
          { source: 2, name: 'besteld_op', type: 'date' },
          { source: 3, name: 'actief', type: 'boolean' },
        ],
      },
      '﻿Naam;Prijs;Besteld op;Actief\r\nKoffie;1.234,50;31-01-2026;yes\r\n"Thee; groen";2,5;01-02-2026;no\r\nLeeg;;;\r\n',
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ rows: 3, table: { name: 'prices', primaryKey: ['id'] } })
    expect(
      (await rows('prices')).map((r) => [
        r.naam,
        r.prijs,
        r.besteld_op?.toISOString().slice(0, 10),
        r.actief,
      ]),
    ).toEqual([
      ['Koffie', '1234.50', '2026-01-31', true],
      ['Thee; groen', '2.5', '2026-02-01', false],
      ['Leeg', null, undefined, null],
    ])
    const [event] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'database.csv_imported'))
    expect(event).toMatchObject({ objectId: 'prices', metadata: { mode: 'create', rows: 3 } })
  })

  it('keeps ids from the file, and new rows continue after the highest', async () => {
    const res = await importCsv(
      {
        mode: 'create',
        table: 'people',
        columns: [
          { source: 0, name: 'id', type: 'bigint' },
          { source: 1, name: 'name', type: 'text' },
        ],
      },
      'id,name\n7,Ada\n42,Bob\n',
    )
    expect(res.statusCode, res.body).toBe(200)
    const added = await admin.mutate('database.insertRow', {
      environmentId: production,
      table: 'people',
      values: { name: 'Cy' },
    })
    expect(added.body.result?.data).toMatchObject({ id: '43', name: 'Cy' })
  })

  it('appends to an existing table, mapping and skipping columns', async () => {
    const res = await importCsv(
      {
        mode: 'append',
        table: 'people',
        columns: [{ source: 2, name: 'name' }],
      },
      'ignored,also ignored,who\nx,y,Dee\nx,y,Eve\n',
    )
    expect(res.statusCode, res.body).toBe(200)
    expect((await rows('people')).map((r) => [r.id, r.name])).toEqual([
      ['7', 'Ada'],
      ['42', 'Bob'],
      ['43', 'Cy'],
      ['44', 'Dee'],
      ['45', 'Eve'],
    ])
  })

  it('reports every bad value by line and column, and writes nothing, not even the table', async () => {
    const lines = ['name,qty,day']
    for (let i = 1; i <= 2500; i++) lines.push(`item ${i},${i},2026-01-01`)
    lines[1200] = 'item x,lots,2026-01-01'
    lines[1201] = 'item y,3,2026-02-30'
    const res = await importCsv(
      {
        mode: 'create',
        table: 'stock',
        columns: [
          { source: 0, name: 'name', type: 'text' },
          { source: 1, name: 'qty', type: 'integer' },
          { source: 2, name: 'day', type: 'date' },
        ],
      },
      `${lines.join('\n')}\n`,
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().error.problems).toEqual([
      {
        line: 1201,
        column: 'qty',
        message: expect.stringMatching(/invalid input syntax for type integer: "lots"/),
      },
      { line: 1202, column: 'day', message: expect.stringMatching(/out of range/) },
    ])
    expect(res.json().error.message).toMatch(/^Line 1201, qty: /)
    expect(await tableExists('stock')).toBe(false)
  })

  it('names required and unique columns when the file breaks them, including two equal rows in one file', async () => {
    await admin.mutate('database.createTable', {
      environmentId: production,
      name: 'codes',
      columns: [{ name: 'code', type: 'text', nullable: false, unique: true }],
    })
    const missing = await importCsv(
      { mode: 'append', table: 'codes', columns: [{ source: 0, name: 'code' }] },
      'code\nA\n\nB\n""\n',
    )
    expect(missing.json().error.problems).toEqual([{ line: 5, column: 'code', message: 'is required' }])
    const twice = await importCsv(
      { mode: 'append', table: 'codes', columns: [{ source: 0, name: 'code' }] },
      'code\nA\nB\nA\n',
    )
    expect(twice.statusCode).toBe(400)
    expect(twice.json().error.message).toMatch(/code: must be unique/)
    expect(await rows('codes')).toEqual([])
  })

  it('refuses rows with the wrong number of values, and files that are not UTF-8', async () => {
    const short = await importCsv(
      { mode: 'append', table: 'people', columns: [{ source: 1, name: 'name' }] },
      'id,name\n1,Ann\n2\n',
    )
    expect(short.json().error).toMatchObject({
      problems: [{ line: 3, message: '1 values, but the header has 2' }],
    })
    const latin1 = await importCsv(
      { mode: 'append', table: 'people', columns: [{ source: 0, name: 'name' }] },
      Buffer.from('name\nJos\xe9\n', 'latin1'),
    )
    expect(latin1.statusCode).toBe(400)
    expect(latin1.json().error.message).toMatch(/isn't UTF-8.*CSV UTF-8/)
  })

  it('imports a JSON document of more than a million characters, and names a broken quote once', async () => {
    const doc = {
      blocks: Array.from({ length: 6000 }, (_, i) => ({ name: `code${i}`, code: 'x'.repeat(150) })),
    }
    const json = JSON.stringify(doc, null, 2)
    expect(json.length).toBeGreaterThan(1_100_000)
    const res = await importCsv(
      {
        mode: 'create',
        table: 'workflows_big',
        columns: [
          { source: 0, name: 'name', type: 'text' },
          { source: 1, name: 'definition', type: 'json' },
        ],
      },
      `name,definition\nbig,"${json.replaceAll('"', '""')}"\nsmall,"{}"\n`,
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().rows).toBe(2)
    const [big] = await superSql`select definition from owdb_production.workflows_big where name = 'big'`
    expect(big!.definition).toEqual(doc)

    // The dialog shows "Line n: <message>", so a problem's message doesn't start with the line again.
    const open = await importCsv(
      { mode: 'append', table: 'people', columns: [{ source: 1, name: 'name' }] },
      'id,name\n1,Ann\n2,"Bob\n',
    )
    expect(open.statusCode).toBe(400)
    expect(open.json().error).toMatchObject({
      message: 'Line 3: a quoted field is never closed',
      problems: [{ line: 3, message: 'a quoted field is never closed' }],
    })
  })

  it('refuses a column the file does not have, instead of importing it as empty', async () => {
    const res = await importCsv(
      { mode: 'append', table: 'people', columns: [{ source: 4, name: 'name' }] },
      'a,b\nx,y\n',
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().error.problems).toEqual([
      { line: 1, column: 'name', message: "takes the file's column 5, but the file has 2" },
    ])
  })

  it('checks the spec, the content type, sign-in and access', async () => {
    const badSpec = await importCsv(
      { mode: 'create', table: 'Bad Name', columns: [{ source: 0, name: 'a' }] },
      'a\n',
    )
    expect(badSpec.statusCode).toBe(400)
    expect(badSpec.json().error.message).toMatch(/table: Use lowercase.*columns\.0\.type: Choose a type/)
    const wrongType = await env.app.inject({
      method: 'POST',
      url: '/api/v1/database/import',
      headers: { cookie: adminCookie, 'content-type': 'text/csv' },
      payload: 'a\n1\n',
    })
    expect(wrongType.statusCode).toBe(415)
    const anonymous = await env.app.inject({
      method: 'POST',
      url: '/api/v1/database/import',
      headers: { 'content-type': IMPORT_CONTENT_TYPE },
      payload: '{}\n',
    })
    expect(anonymous.statusCode).toBe(401)
    const outsider = await importCsv(
      { mode: 'append', table: 'people', columns: [{ source: 0, name: 'name' }] },
      'name\nMallory\n',
      outsiderCookie,
    )
    expect(outsider.statusCode).toBe(403)
  })

  it('streams a larger file in batches', async () => {
    const lines = ['n,label']
    for (let i = 1; i <= 50_000; i++) lines.push(`${i},row ${i}`)
    const started = Date.now()
    const res = await importCsv(
      {
        mode: 'create',
        table: 'big',
        columns: [
          { source: 0, name: 'n', type: 'integer' },
          { source: 1, name: 'label', type: 'text' },
        ],
      },
      `${lines.join('\n')}\n`,
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().rows).toBe(50_000)
    const [sums] = await superSql`select count(*)::int as n, sum(n)::bigint as total from owdb_production.big`
    expect([sums!.n, sums!.total]).toEqual([50_000, String((50_000 * 50_001) / 2)])
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)
})

describe('exporting', () => {
  beforeAll(async () => {
    await admin.mutate('database.createTable', {
      environmentId: production,
      name: 'ledger',
      columns: [
        { name: 'label', type: 'text' },
        { name: 'amount', type: 'decimal' },
        { name: 'at', type: 'datetime' },
        { name: 'meta', type: 'json' },
      ],
    })
    for (const values of [
      { label: '=HYPERLINK("http://evil")', amount: '-5', at: '2026-01-01T10:00:00Z', meta: { a: 1 } },
      { label: 'plain, with comma', amount: '12.50', at: null, meta: null },
      { label: 'line\nbreak', amount: '0', at: '2026-01-02T00:00:00Z', meta: ['x'] },
    ]) {
      await admin.mutate('database.insertRow', { environmentId: production, table: 'ledger', values })
    }
  })

  it('streams the table as CSV, guarding text against formulas but leaving numbers as numbers', async () => {
    const res = await exportCsv('ledger')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="ledger.csv"')
    expect(res.body).toBe(
      [
        'id,label,amount,at,meta',
        `1,"'=HYPERLINK(""http://evil"")",-5,2026-01-01T10:00:00+00:00,"{""a"": 1}"`,
        '2,"plain, with comma",12.50,,',
        '3,"line\nbreak",0,2026-01-02T00:00:00+00:00,"[""x""]"',
        '',
      ].join('\r\n'),
    )
  })

  it('exports what the grid shows: its filters and sort', async () => {
    const res = await exportCsv('ledger', {
      filters: [{ column: 'amount', op: 'gte', value: '0' }],
      sort: [{ column: 'amount', desc: true }],
    })
    expect(res.body.split('\r\n').map((l) => l.split(',')[0])).toEqual(['id', '2', '3', ''])
    const [event] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'database.csv_exported'))
    expect(event).toMatchObject({ objectId: 'ledger', metadata: { rows: 3 } })
  })

  it('reports a missing table or a bad filter as an error, not a broken download', async () => {
    const missing = await exportCsv('nope')
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.message).toMatch(/no table named nope/)
    const bad = await exportCsv('ledger', { filters: [{ column: 'amount', op: 'gt', value: 'lots' }] })
    expect(bad.statusCode).toBe(400)
    expect((await exportCsv('ledger', undefined, outsiderCookie)).statusCode).toBe(403)
  })

  it('round-trips: an export imports back into an equal table', async () => {
    const csv = (await exportCsv('people')).body
    const res = await importCsv(
      {
        mode: 'create',
        table: 'people_copy',
        columns: [
          { source: 0, name: 'id', type: 'bigint' },
          { source: 1, name: 'name', type: 'text' },
        ],
      },
      csv,
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(await rows('people_copy')).toEqual(await rows('people'))
  })
})
