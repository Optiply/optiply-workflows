import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureServiceUrls,
  configureSheets,
  googleSheetsConnector,
  PoolManager,
  runQuery,
  spreadsheetId,
  testResource,
} from '../src'
import { type FakeServices, startFakeServices } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

let fake: FakeServices
let pool: PoolManager

beforeAll(async () => {
  fake = await startFakeServices()
  configureServiceUrls(fake.urls)
  configureSheets({ tokenUrl: fake.urls.googleToken })
  pool = new PoolManager()
})

afterAll(async () => {
  await pool.closeAll()
  await fake.stop()
  configureServiceUrls({})
  configureSheets({})
})

beforeEach(() => {
  fake.sheets.spreadsheets.set('orders-doc', {
    title: 'Orders',
    sharedWith: [fake.sheets.serviceAccountEmail],
    sheets: [
      {
        sheetId: 1,
        title: 'Orders',
        values: [
          ['id', 'customer', 'amount'],
          ['1', 'acme', 1200],
          ['2', 'globex', 500],
          ['', '', ''],
        ],
      },
      {
        sheetId: 2,
        title: 'Notes 2026',
        values: [
          ['a', 'a', '', 'x'],
          [1, 2, 3, 4],
        ],
      },
    ],
  })
  fake.sheets.spreadsheets.set('private-doc', {
    title: 'Private',
    sharedWith: [],
    sheets: [{ sheetId: 3, title: 'S', values: [] }],
  })
})

const key = (extra: Record<string, unknown> = {}) =>
  resource(
    { auth: { type: 'serviceAccount' }, ...extra },
    { serviceAccountKey: fake.sheets.serviceAccountKey },
    JSON.stringify(extra),
  )

const run = (query: unknown, scope: Record<string, unknown> = {}, r = key()) =>
  runQuery(pool, googleSheetsConnector, r, query, { evaluate: scopeEvaluator(scope) })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the query to fail')
}

describe('Google Sheets resources', () => {
  it('take a spreadsheet by id or URL', () => {
    expect(spreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-d_9/edit#gid=0')).toBe('1AbC-d_9')
    expect(spreadsheetId('1AbC-d_9')).toBe('1AbC-d_9')
    expect(() => spreadsheetId('../x')).toThrow(ConnectorError)
  })

  it('read the first sheet as objects by the header row, or as rows, raw or formatted', async () => {
    const objects = await run({
      action: 'read',
      spreadsheet: 'https://docs.google.com/spreadsheets/d/orders-doc/edit',
    })
    expect(objects.data).toEqual([
      { id: '1', customer: 'acme', amount: '1200' },
      { id: '2', customer: 'globex', amount: '500' },
    ])
    expect(objects.metadata).toMatchObject({ range: 'Orders', headers: ['id', 'customer', 'amount'] })

    const raw = await run({
      action: 'read',
      spreadsheet: 'orders-doc',
      range: 'Orders!A2:C2',
      headers: 'false',
      render: 'UNFORMATTED_VALUE',
    })
    expect(raw.data).toEqual([['1', 'acme', 1200]])
    // A name with a space is quoted; blank and repeated headers get names of their own.
    const spaced = await run({ action: 'read', spreadsheet: 'orders-doc', range: "'Notes 2026'" })
    expect(spaced.data).toEqual([{ a: '1', a_2: '2', column_3: '3', x: '4' }])
  })

  it('append objects under their column names, and refuse columns the sheet lacks', async () => {
    const out = await run(
      { action: 'append', spreadsheet: 'orders-doc', range: 'Orders', rows: '{{ rows }}' },
      {
        rows: [
          { id: 3, customer: 'initech', amount: '42' },
          { id: 4, amount: 7, customer: { nested: true } },
        ],
      },
    )
    expect(out.data).toEqual({ updatedRange: 'Orders!A4:C5', updatedRows: 2 })
    const values = fake.sheets.spreadsheets.get('orders-doc')!.sheets[0]!.values
    expect(values[3]).toEqual([3, 'initech', 42])
    expect(values[4]).toEqual([4, '{"nested":true}', 7])

    const bad = await failure(
      run(
        { action: 'append', spreadsheet: 'orders-doc', rows: '{{ rows }}' },
        { rows: [{ id: 5, colour: 'red' }] },
      ),
    )
    expect(bad.message).toBe('Columns not in the sheet’s header row: colour')
  })

  it('update rows by a key column, keeping the columns not given, and say which keys weren’t found', async () => {
    const out = await run(
      { action: 'update', spreadsheet: 'orders-doc', range: 'Orders', keyColumn: 'id', rows: '{{ rows }}' },
      {
        rows: [
          { id: '2', amount: 650 },
          { id: '99', amount: 1 },
        ],
      },
    )
    expect(out.data).toEqual({ updatedRows: 1, notFound: ['99'] })
    // Written as if typed, so the id read back as text is stored as a number again.
    expect(fake.sheets.spreadsheets.get('orders-doc')!.sheets[0]!.values[2]).toEqual([2, 'globex', 650])

    await run(
      {
        action: 'update',
        spreadsheet: 'orders-doc',
        range: 'Orders!B2:C2',
        rows: '{{ rows }}',
        valueInput: 'RAW',
      },
      { rows: [['ACME', '13']] },
    )
    expect(fake.sheets.spreadsheets.get('orders-doc')!.sheets[0]!.values[1]).toEqual(['1', 'ACME', '13'])
    const noKey = await failure(
      run(
        { action: 'update', spreadsheet: 'orders-doc', keyColumn: 'sku', rows: '{{ rows }}' },
        { rows: [{ sku: 1 }] },
      ),
    )
    expect(noKey.message).toBe('No column “sku” in the header row')
  })

  it('clear a range, add and delete sheets, and describe the spreadsheet', async () => {
    await run({ action: 'clear', spreadsheet: 'orders-doc', range: 'Orders!C2:C3' })
    expect(fake.sheets.spreadsheets.get('orders-doc')!.sheets[0]!.values[1]![2]).toBe('')
    const added = await run({ action: 'addSheet', spreadsheet: 'orders-doc', title: 'Archive' })
    expect(added.data).toMatchObject({ title: 'Archive' })
    const dup = await failure(run({ action: 'addSheet', spreadsheet: 'orders-doc', title: 'Archive' }))
    expect(dup).toMatchObject({ code: 'http', details: { status: 400, reason: 'INVALID_ARGUMENT' } })
    await run({ action: 'deleteSheet', spreadsheet: 'orders-doc', title: 'Archive' })
    const info = await run({ action: 'info', spreadsheet: 'orders-doc' })
    expect(info.data).toMatchObject({
      id: 'orders-doc',
      title: 'Orders',
      sheets: [{ title: 'Orders' }, { title: 'Notes 2026' }],
    })
  })

  it('create a spreadsheet and share it through Drive', async () => {
    const out = await run({
      action: 'create',
      title: 'Report',
      sheets: 'Summary, Lines',
      shareWith: 'ada@example.com',
    })
    const created = out.data as { spreadsheetId: string; sharedWith: string[] }
    expect(created.sharedWith).toEqual(['ada@example.com'])
    expect(fake.sheets.spreadsheets.get(created.spreadsheetId)?.sheets.map((s) => s.title)).toEqual([
      'Summary',
      'Lines',
    ])
    expect(fake.sheets.shares.at(-1)).toEqual({
      spreadsheetId: created.spreadsheetId,
      email: 'ada@example.com',
      role: 'writer',
    })
  })

  it('say whom to share a spreadsheet with when the service account can’t open it', async () => {
    const denied = await failure(run({ action: 'info', spreadsheet: 'private-doc' }))
    expect(denied.message).toBe(
      `Google Sheets: The caller does not have permission. Share the spreadsheet with ${fake.sheets.serviceAccountEmail}`,
    )
    expect(denied.details).toMatchObject({ status: 403, reason: 'PERMISSION_DENIED' })
  })

  it('test the connection: the identity, and a spreadsheet’s title if given', async () => {
    expect(await testResource(googleSheetsConnector, key({ testSpreadsheet: 'orders-doc' }))).toMatchObject({
      ok: true,
      message: `Google Sheets as ${fake.sheets.serviceAccountEmail}; spreadsheet “Orders”`,
    })
    const none = await testResource(
      googleSheetsConnector,
      resource({ auth: { type: 'serviceAccount' } }, {}, 'none'),
    )
    expect(none).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
  })

  it('sign in as the server’s own identity only where the instance allows it', async () => {
    const server = resource({ auth: { type: 'server' } }, {}, 'server')
    const off = await testResource(googleSheetsConnector, server)
    expect(off).toMatchObject({ ok: false, error: { code: 'invalid_config' } })

    fake.sheets.acceptTokens.set('server-token', 'any')
    configureSheets({
      tokenUrl: fake.urls.googleToken,
      serverIdentity: { token: async () => 'server-token', describe: async () => 'ow-server@optiply.iam' },
    })
    try {
      const out = await runQuery(
        pool,
        googleSheetsConnector,
        resource({ auth: { type: 'server' } }, {}, 'server-2'),
        {
          action: 'info',
          spreadsheet: 'private-doc',
        },
        { evaluate: scopeEvaluator({}) },
      )
      expect(out.data).toMatchObject({ title: 'Private' })
    } finally {
      configureSheets({ tokenUrl: fake.urls.googleToken })
    }
  })

  it('give OAuth sign-in Google’s preset with the Sheets scope', () => {
    const config = googleSheetsConnector.configSchema.parse({ auth: { type: 'oauth', clientId: 'cid' } })
    expect(googleSheetsConnector.httpConfig!(config).auth).toMatchObject({
      type: 'oauth2AuthorizationCode',
      provider: 'google',
      scope: expect.stringContaining('https://www.googleapis.com/auth/spreadsheets'),
    })
  })
})
