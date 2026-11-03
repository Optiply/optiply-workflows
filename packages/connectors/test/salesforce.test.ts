import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureServiceUrls,
  httpConfigFor,
  PoolManager,
  runQuery,
  salesforceConnector,
  testResource,
} from '../src'
import { dropAttributes, renderSoql, soqlLiteral } from '../src/services/salesforce'
import { type FakeServices, startFakeServices } from '../src/testing'
import { codeEvaluator, resource, scopeEvaluator } from './helpers'

// Salesforce (M29 step 4) against its fake: client credentials, SOQL with bound literals, pages, sObjects.
let fake: FakeServices
let pool: PoolManager

beforeAll(async () => {
  fake = await startFakeServices()
  configureServiceUrls(fake.urls)
  pool = new PoolManager()
})
afterAll(async () => {
  await pool.closeAll()
  await fake.stop()
  configureServiceUrls({})
})

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected a failure')
}

const sf = (secret = fake.salesforce.clientSecret) =>
  resource(
    {
      domain: 'https://optiply.my.salesforce.com',
      auth: { type: 'clientCredentials', clientId: fake.salesforce.clientId },
    },
    { clientSecret: secret },
    `sf:${secret}`,
  )
const run = (query: object, scope: Record<string, unknown> = {}, r = sf()) =>
  runQuery(pool, salesforceConnector, r, query, { evaluate: scopeEvaluator(scope) })

describe('soql', () => {
  it('writes values as escaped literals', () => {
    expect(soqlLiteral('O\'Brien \\ "x"\nnext')).toBe("'O\\'Brien \\\\ \\\"x\\\"\\nnext'")
    expect(soqlLiteral(12.5)).toBe('12.5')
    expect(soqlLiteral(true)).toBe('true')
    expect(soqlLiteral(null)).toBe('null')
    expect(soqlLiteral(new Date('2026-11-03T10:00:00.123Z'))).toBe('2026-11-03T10:00:00Z')
    // Dates as ISO strings (how expressions give them) go unquoted, as SOQL wants; anything else stays quoted.
    expect(soqlLiteral('2026-11-03')).toBe('2026-11-03')
    expect(soqlLiteral('2026-11-03T10:00:00.250Z')).toBe('2026-11-03T10:00:00Z')
    expect(soqlLiteral('2026-11-03T10:00:00+01:00')).toBe('2026-11-03T10:00:00+01:00')
    expect(soqlLiteral("2026-11-03' OR Id != '")).toBe("'2026-11-03\\' OR Id != \\''")
    expect(soqlLiteral('2026-11-03 10:00')).toBe("'2026-11-03 10:00'")
    expect(soqlLiteral(['a', 1])).toBe("('a', 1)")
    expect(() => soqlLiteral([])).toThrow(/empty list/)
    expect(() => soqlLiteral({ a: 1 })).toThrow(/object/)
    expect(() => soqlLiteral(Number.NaN)).toThrow()
  })

  it('binds every {{ }}, so a hostile value stays a value, and refuses one inside quotes', async () => {
    const evil = "x' OR Name != '"
    expect(
      await renderSoql(
        'SELECT Id FROM Account WHERE Name = {{ name }} AND Id IN {{ ids }}',
        codeEvaluator({ name: evil, ids: ['1', '2'] }),
      ),
    ).toBe("SELECT Id FROM Account WHERE Name = 'x\\' OR Name != \\'' AND Id IN ('1', '2')")
    await expect(
      renderSoql("SELECT Id FROM Account WHERE Name = '{{ name }}'", codeEvaluator({ name: 'a' })),
    ).rejects.toThrow(/outside quotes/)
    // An escaped quote inside a literal doesn't end it.
    await expect(
      renderSoql("SELECT Id FROM A WHERE N = 'it\\'s {{ x }}'", codeEvaluator({ x: 1 })),
    ).rejects.toThrow(/outside quotes/)
    expect(
      await renderSoql("SELECT Id FROM A WHERE N = 'it\\'s' AND M = {{ x }}", codeEvaluator({ x: 1 })),
    ).toBe("SELECT Id FROM A WHERE N = 'it\\'s' AND M = 1")
  })

  it('drops attributes, and flattens sub-query results', () => {
    expect(
      dropAttributes([
        {
          attributes: { type: 'Account' },
          Id: '1',
          Contacts: { totalSize: 1, done: true, records: [{ attributes: {}, Email: 'a@x' }] },
        },
      ]),
    ).toEqual([{ Id: '1', Contacts: [{ Email: 'a@x' }] }])
  })
})

describe('salesforce resource', () => {
  it('builds OAuth settings from the My Domain URL for M9', () => {
    const cfg = httpConfigFor('salesforce', {
      domain: 'https://acme.my.salesforce.com/',
      auth: { type: 'oauth', clientId: 'ck' },
    })
    // Under test the fake replaces the domain; the shape is what matters.
    expect(cfg?.auth).toMatchObject({
      type: 'oauth2AuthorizationCode',
      authorizeUrl: `${fake.urls.salesforce}/services/oauth2/authorize`,
      tokenUrl: `${fake.urls.salesforce}/services/oauth2/token`,
      clientId: 'ck',
      scope: 'api refresh_token',
      pkce: true,
    })
  })

  it('signs in with client credentials, and refuses a wrong secret', async () => {
    expect(await testResource(salesforceConnector, sf())).toMatchObject({
      ok: true,
      message: 'Salesforce at optiply.my.salesforce.com, API v62.0 (14990 of 15000 daily API calls left)',
    })
    expect(await testResource(salesforceConnector, sf('wrong'))).toMatchObject({ ok: false })
  })

  it('creates, queries (bound values, paged), gets, updates, upserts, describes, searches and deletes', async () => {
    const ids: string[] = []
    for (const name of ['Acme', "O'Brien Supplies", 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']) {
      const made = await run(
        { action: 'create', object: 'Account', record: '{"Name": {{ name }}, "Industry": "Retail"}' },
        { name },
      )
      ids.push((made.data as { id: string }).id)
    }
    const one = await run(
      { action: 'query', soql: 'SELECT Id, Name FROM Account WHERE Name = {{ name }}' },
      { name: "O'Brien Supplies" },
    )
    expect(one.data).toEqual([{ Id: ids[1], Name: "O'Brien Supplies" }])
    expect(fake.salesforce.queries.at(-1)).toBe(
      "SELECT Id, Name FROM Account WHERE Name = 'O\\'Brien Supplies'",
    )
    // An injection attempt is just a name that matches nothing.
    const none = await run(
      { action: 'query', soql: 'SELECT Id FROM Account WHERE Name = {{ name }}' },
      { name: "x' OR Name != '" },
    )
    expect(none.data).toEqual([])

    const all = await run({ action: 'query', soql: 'SELECT Id, Name, Industry FROM Account' })
    expect((all.data as unknown[]).length).toBe(7)
    expect(all.metadata).toMatchObject({ totalSize: 7, more: false })
    const capped = await run({ action: 'query', soql: 'SELECT Id FROM Account', max: '4' })
    expect(capped.data).toHaveLength(4)
    expect(capped.metadata).toMatchObject({ more: true })
    const listed = await run(
      { action: 'query', soql: 'SELECT Id, Name FROM Account WHERE Id IN {{ ids }}' },
      { ids: ids.slice(0, 2) },
    )
    expect((listed.data as { Name: string }[]).map((r) => r.Name)).toEqual(['Acme', "O'Brien Supplies"])

    expect((await run({ action: 'get', object: 'Account', id: ids[0]!, fieldList: 'Name' })).data).toEqual({
      Id: ids[0],
      Name: 'Acme',
    })
    await run({ action: 'update', object: 'Account', id: ids[0]!, record: '{"Industry": "Logistics"}' })
    expect(fake.salesforce.records.get('Account')?.get(ids[0]!)).toMatchObject({ Industry: 'Logistics' })
    const created = await run({
      action: 'upsert',
      object: 'Account',
      externalIdField: 'Optiply_Id__c',
      externalId: 'OPT-1',
      record: '{"Name": "Upserted"}',
    })
    expect(created.data).toMatchObject({ created: true })
    const again = await run({
      action: 'upsert',
      object: 'Account',
      externalIdField: 'Optiply_Id__c',
      externalId: 'OPT-1',
      record: '{"Name": "Upserted 2"}',
    })
    expect(again.data).toMatchObject({ created: false })
    const fields = await run({ action: 'describe', object: 'Account' })
    expect(
      (fields.data as { name: string; required: boolean }[]).find((x) => x.name === 'Name'),
    ).toMatchObject({ required: true })
    const found = await run({ action: 'search', term: 'brien', objects: 'Account', fieldList: 'Id, Name' })
    expect(found.data).toEqual([{ type: 'Account', Id: ids[1], Name: "O'Brien Supplies" }])

    await run({ action: 'delete', object: 'Account', id: ids[6]! })
    expect(((await run({ action: 'query', soql: 'SELECT Id FROM Account' })).data as unknown[]).length).toBe(
      7,
    )
    expect(
      ((await run({ action: 'query', soql: 'SELECT Id FROM Account', all: 'true' })).data as unknown[])
        .length,
    ).toBe(8)
  })

  it('explains Salesforce’s errors and keeps the API path', async () => {
    const missing = await failure(run({ action: 'create', object: 'Account', record: '{"Industry": "x"}' }))
    expect(missing.message).toBe('Salesforce: Required fields are missing: [Name] (REQUIRED_FIELD_MISSING)')
    expect(missing.details).toMatchObject({
      status: 400,
      errorCode: 'REQUIRED_FIELD_MISSING',
      fields: ['Name'],
    })
    expect(
      (
        await failure(
          run({ action: 'query', soql: "SELECT Id FROM Account WHERE Name = '{{ n }}'" }, { n: 'a' }),
        )
      ).code,
    ).toBe('invalid_query')
    expect((await run({ action: 'api', path: '/services/data/v62.0/limits' })).data).toMatchObject({
      DailyApiRequests: { Max: 15000 },
    })
    expect((await failure(run({ action: 'api', path: '/services/apexrest/x' }))).code).toBe('invalid_query')
  })
})
