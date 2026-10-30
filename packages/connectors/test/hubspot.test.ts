import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorError,
  configureServiceUrls,
  type HttpClient,
  hubspotConnector,
  hubspotProperties,
  PoolManager,
  runOperation,
  runQuery,
  testResource,
} from '../src'
import { type FakeServices, startFakeServices } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

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

const app = (token = fake.hubspot.token) => resource({ auth: { type: 'token' } }, { token }, token)

const run = (query: unknown, scope: Record<string, unknown> = {}, r = app()) =>
  runQuery(pool, hubspotConnector, r, query, { evaluate: scopeEvaluator(scope) })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the query to fail')
}

describe('HubSpot resources', () => {
  it('test the connection with the account’s details, and say why a token is refused', async () => {
    expect(await testResource(hubspotConnector, app())).toMatchObject({
      ok: true,
      message: 'HubSpot account 4242 (app-eu1.hubspot.com)',
    })
    const wrong = await testResource(hubspotConnector, app('pat-wrong'))
    expect(wrong).toMatchObject({
      ok: false,
      error: {
        code: 'http',
        message: 'HubSpot: Authentication credentials not found.',
        details: { status: 401 },
      },
    })
  })

  it('create, get by a unique property, update and archive records', async () => {
    const created = await run(
      { action: 'create', objectType: 'contacts', properties: '{"email": {{ email }}, "firstname": "Ada"}' },
      { email: 'ada@example.com' },
    )
    const id = (created.data as { id: string }).id
    expect(created.metadata).toMatchObject({ status: 201 })

    const got = await run({
      action: 'get',
      objectType: 'contacts',
      id: 'ada@example.com',
      idProperty: 'email',
      properties: 'email, firstname',
    })
    expect(got.data).toMatchObject({ id, properties: { email: 'ada@example.com', firstname: 'Ada' } })

    await run({ action: 'update', objectType: 'contacts', id, properties: '{"lastname": "Lovelace"}' })
    expect(fake.hubspot.records.get('contacts')?.get(id)?.properties.lastname).toBe('Lovelace')

    const invalid = await failure(
      run({ action: 'update', objectType: 'contacts', id, properties: '{"shoe": 9}' }),
    )
    expect(invalid.message).toBe('HubSpot: Property values were not valid: shoe')
    expect(invalid.details).toMatchObject({
      status: 400,
      category: 'VALIDATION_ERROR',
      correlationId: 'corr-400',
    })

    await run({ action: 'archive', objectType: 'contacts', id })
    const gone = await failure(run({ action: 'get', objectType: 'contacts', id }))
    expect(gone.details).toMatchObject({ status: 404, category: 'OBJECT_NOT_FOUND' })

    const odd = await failure(run({ action: 'get', objectType: '../owners', id: '1' }))
    expect(odd.code).toBe('invalid_query')
  })

  it('upsert many in batches of 100, then search them by simple filters across pages', async () => {
    const records = Array.from({ length: 230 }, (_, i) => ({
      email: `p${i}@shop.example`,
      lifecyclestage: i % 2 ? 'customer' : 'lead',
    }))
    const upserted = await run(
      { action: 'batchUpsert', objectType: 'contacts', idProperty: 'email', records: '{{ records }}' },
      { records },
    )
    expect((upserted.data as unknown[]).length).toBe(230)
    expect(fake.calls.filter((c) => c.path.endsWith('/batch/upsert')).length).toBe(3)

    const customers = await run({
      action: 'search',
      objectType: 'contacts',
      filters: '[{"propertyName": "lifecyclestage", "operator": "EQ", "value": "customer"}]',
      properties: 'email',
    })
    expect((customers.data as unknown[]).length).toBe(115)
    expect(customers.metadata).toMatchObject({ total: 115, truncated: false })

    const capped = await run({ action: 'search', objectType: 'contacts', filters: '[]', max: '210' })
    expect((capped.data as unknown[]).length).toBe(210)
    expect(capped.metadata).toMatchObject({ total: 230, truncated: true })

    const groups = await run({
      action: 'search',
      objectType: 'contacts',
      filters:
        '[{"filters": [{"propertyName": "email", "operator": "EQ", "value": "p1@shop.example"}]}, {"filters": [{"propertyName": "email", "operator": "EQ", "value": "p2@shop.example"}]}]',
    })
    expect((groups.data as unknown[]).length).toBe(2)

    const missing = await failure(
      run(
        { action: 'batchUpsert', objectType: 'contacts', idProperty: 'email', records: '{{ bad }}' },
        { bad: [{ firstname: 'x' }] },
      ),
    )
    expect(missing.message).toBe('Record 1 has no email')
  })

  it('associate records, and read the association back', async () => {
    const deal = await run({
      action: 'create',
      objectType: 'deals',
      properties: '{"dealname": "Big one", "amount": 900}',
    })
    const company = await run({ action: 'create', objectType: 'companies', properties: '{"name": "Acme"}' })
    const dealId = (deal.data as { id: string }).id
    const companyId = (company.data as { id: string }).id
    await run({
      action: 'associate',
      fromType: 'deals',
      fromId: dealId,
      toType: 'companies',
      toId: companyId,
    })
    const got = await run({ action: 'get', objectType: 'deals', id: dealId, associations: 'companies' })
    expect(got.data).toMatchObject({ associations: { companies: { results: [{ id: companyId }] } } })
  })

  it('call any endpoint under the API, and only there', async () => {
    const any = await run({ action: 'api', method: 'GET', path: '/account-info/v3/details' })
    expect(any.data).toMatchObject({ portalId: 4242 })
    const away = await failure(run({ action: 'api', method: 'GET', path: 'https://evil.example/x' }))
    expect(away.code).toBe('invalid_query')
    const up = await failure(run({ action: 'api', method: 'GET', path: '/crm/../../x' }))
    expect(up.code).toBe('invalid_query')
  })

  it('list an object type’s properties for the forms, leaving hidden ones out', async () => {
    const props = await runOperation(pool, hubspotConnector, app(), (client, ctx) =>
      hubspotProperties(client as HttpClient, 'contacts', ctx),
    )
    expect(props.map((p) => p.name)).toEqual(['email', 'firstname', 'lastname', 'lifecyclestage'])
    expect(props[3]).toMatchObject({
      fieldType: 'select',
      options: [{ value: 'lead' }, { value: 'customer' }],
    })
  })
})
