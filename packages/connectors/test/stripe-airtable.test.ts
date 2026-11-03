import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  airtableConnector,
  ConnectorError,
  configureServiceUrls,
  PoolManager,
  runQuery,
  stripeConnector,
  stripeForm,
  testResource,
} from '../src'
import { flatRecord, recordsOf } from '../src/services/airtable'
import { parseStripeForm } from '../src/services/fake-stripe'
import { idempotencyKeyFor } from '../src/services/stripe'
import { type FakeServices, startFakeServices } from '../src/testing'
import { resource, scopeEvaluator } from './helpers'

// Stripe and Airtable (M29 step 2) against their fakes.
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

describe('stripe', () => {
  const key = (config: object = {}, token = fake.stripe.key) =>
    resource(config, { token }, `${JSON.stringify(config)}:${token}`)
  const run = (
    query: object,
    scope: Record<string, unknown> = {},
    r = key(),
    labels?: Record<string, string>,
  ) =>
    runQuery(pool, stripeConnector, r, query, { evaluate: scopeEvaluator(scope), ...(labels && { labels }) })

  it('form-encodes nested objects and arrays the way Stripe reads them', () => {
    const params = {
      email: 'a+b@x.nl',
      metadata: { shop: 'nl', n: 2 },
      items: [{ price: 'price_1', quantity: 2 }],
      tax: null,
      flag: true,
      tags: [],
    }
    const form = stripeForm(params)
    expect(form).toBe(
      'email=a%2Bb%40x.nl&metadata[shop]=nl&metadata[n]=2&items[0][price]=price_1&items[0][quantity]=2&tax=&flag=true&tags=',
    )
    expect(parseStripeForm(form)).toEqual({
      email: 'a+b@x.nl',
      metadata: { shop: 'nl', n: '2' },
      items: [{ price: 'price_1', quantity: '2' }],
      tax: '',
      flag: 'true',
      tags: '',
    })
  })

  it('makes idempotency keys from the run and the request, or at random outside a run', () => {
    const a = idempotencyKeyFor(undefined, { ow_run: 'run-1' }, 'POST /v1/customers\nemail=x')
    expect(a).toBe(idempotencyKeyFor(undefined, { ow_run: 'run-1' }, 'POST /v1/customers\nemail=x'))
    expect(a).not.toBe(idempotencyKeyFor(undefined, { ow_run: 'run-1' }, 'POST /v1/customers\nemail=y'))
    expect(a).not.toBe(idempotencyKeyFor(undefined, { ow_run: 'run-2' }, 'POST /v1/customers\nemail=x'))
    expect(idempotencyKeyFor(undefined, undefined, 'x')).not.toBe(
      idempotencyKeyFor(undefined, undefined, 'x'),
    )
    expect(idempotencyKeyFor('mine', { ow_run: 'run-1' }, 'x')).toBe('mine')
  })

  it('tests the key, and refuses a wrong one', async () => {
    expect(await testResource(stripeConnector, key({ account: 'acct_123' }))).toMatchObject({
      ok: true,
      message: 'Stripe in test mode as acct_123',
    })
    expect(fake.stripe.requests.at(-1)).toMatchObject({ account: 'acct_123' })
    const wrong = await testResource(stripeConnector, key({}, 'sk_test_wrong'))
    expect(wrong).toMatchObject({ ok: false })
  })

  it('creates, retrieves, updates, lists, searches and deletes customers', async () => {
    const r = key({ apiVersion: '2025-01-27.acacia' })
    const ada = await run(
      { action: 'create', kind: 'customers', params: '{"email": {{ email }}, "metadata": {"shop": "nl"}}' },
      { email: 'ada@example.com' },
      r,
    )
    const adaId = (ada.data as { id: string }).id
    expect(adaId).toMatch(/^cus_/)
    expect(fake.stripe.requests.at(-1)).toMatchObject({
      version: '2025-01-27.acacia',
      idempotencyKey: expect.stringMatching(/^ow-/),
    })
    for (let i = 0; i < 4; i++)
      await run({ action: 'create', kind: 'customers', params: `{"email": "c${i}@example.com"}` }, {}, r)

    expect(
      (await run({ action: 'retrieve', kind: 'customers', id: adaId, expand: 'default_source' }, {}, r)).data,
    ).toMatchObject({
      email: 'ada@example.com',
    })
    expect(fake.stripe.requests.at(-1)!.path).toBe(`/v1/customers/${adaId}`)
    const updated = await run(
      {
        action: 'update',
        kind: 'customers',
        id: adaId,
        params: '{"name": "Ada", "metadata": {"tier": "gold"}}',
      },
      {},
      r,
    )
    expect(updated.data).toMatchObject({ name: 'Ada', metadata: { shop: 'nl', tier: 'gold' } })

    // Auto-paging: 5 customers, pages of 2 (the limit follows `max`).
    const listed = await run({ action: 'list', kind: 'customers', max: '5' }, {}, r)
    expect((listed.data as unknown[]).length).toBe(5)
    const two = await run({ action: 'list', kind: 'customers', max: '2' }, {}, r)
    expect(two.metadata).toMatchObject({ count: 2, hasMore: true })

    const found = await run({ action: 'search', kind: 'customers', query: 'metadata["shop"]:"nl"' }, {}, r)
    expect((found.data as { id: string }[]).map((c) => c.id)).toEqual([adaId])
    expect((await run({ action: 'delete', kind: 'customers', id: adaId }, {}, r)).data).toMatchObject({
      deleted: true,
    })
    const missing = await failure(run({ action: 'retrieve', kind: 'customers', id: adaId }, {}, r))
    expect(missing.message).toMatch(/No such customer/)
    expect(missing.details).toMatchObject({ status: 404, code: 'resource_missing' })
  })

  it('replays a retried create in a run instead of charging twice', async () => {
    const labels = { ow_run: 'run-retry' }
    const q = { action: 'create', kind: 'payment_intents', params: '{"amount": 1999, "currency": "eur"}' }
    const first = await run(q, {}, key(), labels)
    const again = await run(q, {}, key(), labels)
    expect((again.data as { id: string }).id).toBe((first.data as { id: string }).id)
    expect(fake.stripe.objects.get('payment_intents')?.size).toBe(1)
    const other = await run(q, {}, key(), { ow_run: 'run-other' })
    expect((other.data as { id: string }).id).not.toBe((first.data as { id: string }).id)
  })

  it('reports a declined card with Stripe’s codes', async () => {
    const err = await failure(
      run({
        action: 'create',
        kind: 'payment_intents',
        params:
          '{"amount": 500, "currency": "eur", "payment_method": "pm_card_chargeDeclined", "confirm": true}',
      }),
    )
    expect(err.message).toBe('Stripe: Your card was declined.')
    expect(err.details).toMatchObject({
      status: 402,
      type: 'card_error',
      code: 'card_declined',
      declineCode: 'generic_decline',
      param: 'payment_method',
    })
  })

  it('calls any endpoint, form-encoding a JSON body, and stays under /v1', async () => {
    expect((await run({ action: 'api', method: 'GET', path: '/v1/balance' })).data).toMatchObject({
      object: 'balance',
    })
    const made = await run({
      action: 'api',
      method: 'POST',
      path: '/v1/products',
      body: '{"name": "Pallet", "metadata": {"sku": "P-1"}}',
    })
    expect(made.data).toMatchObject({ name: 'Pallet', metadata: { sku: 'P-1' } })
    expect((await failure(run({ action: 'api', method: 'GET', path: '/v2/x' }))).message).toMatch(
      /starts with \/v1\//,
    )
    expect((await failure(run({ action: 'list', kind: 'secrets' }))).code).toBe('invalid_query')
  })
})

describe('airtable', () => {
  const BASE = 'appFAKEBASE000001'
  const key = (config: object = { base: BASE }, token = fake.airtable.token) =>
    resource(config, { token }, `${JSON.stringify(config)}:${token}`)
  const run = (query: object, scope: Record<string, unknown> = {}, r = key()) =>
    runQuery(pool, airtableConnector, r, query, { evaluate: scopeEvaluator(scope) })

  beforeAll(() => {
    fake.airtable.bases.set(BASE, [
      {
        id: 'tblOrders0000001',
        name: 'Orders',
        fields: [
          { id: 'fldSku', name: 'SKU', type: 'singleLineText' },
          { id: 'fldQty', name: 'Qty', type: 'number' },
          { id: 'fldStatus', name: 'Status', type: 'singleSelect' },
        ],
        records: new Map(),
      },
    ])
  })

  it('reads records given as fields or {fields}, with ids for updates', () => {
    expect(recordsOf({ SKU: 'A' }, false)).toEqual([{ fields: { SKU: 'A' } }])
    expect(
      recordsOf(
        [
          { id: 'rec1', fields: { SKU: 'A' } },
          { id: 'rec2', Qty: 2 },
        ],
        true,
      ),
    ).toEqual([
      { id: 'rec1', fields: { SKU: 'A' } },
      { id: 'rec2', fields: { Qty: 2 } },
    ])
    expect(() => recordsOf([{ SKU: 'A' }], true)).toThrow(/has no id/)
    expect(flatRecord({ id: 'rec1', createdTime: 't', fields: { SKU: 'A' } })).toEqual({
      id: 'rec1',
      createdTime: 't',
      SKU: 'A',
    })
  })

  it('tests the token', async () => {
    expect(await testResource(airtableConnector, key())).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Airtable as ops@optiply.nl/),
    })
    expect(await testResource(airtableConnector, key({}, 'pat_wrong'))).toMatchObject({ ok: false })
  })

  it('creates 25 records in batches of 10, lists them paged and filtered, updates, upserts and deletes', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      SKU: `S-${String(i).padStart(2, '0')}`,
      Qty: i,
      Status: i % 2 ? 'Open' : 'Done',
    }))
    const created = await run({ action: 'create', table: 'Orders', records: '{{ rows }}' }, { rows })
    expect(created.metadata).toMatchObject({ count: 25 })
    const posts = fake.calls.filter(
      (c) => c.service === 'airtable' && c.method === 'POST' && !c.path.endsWith('listRecords'),
    )
    expect(posts.length).toBe(3)

    const all = await run({ action: 'list', table: 'tblOrders0000001', max: '250' })
    expect((all.data as unknown[]).length).toBe(25)
    const open = await run({
      action: 'list',
      table: 'Orders',
      filterByFormula: "{Status} = 'Open'",
      sort: '[{"field": "SKU", "direction": "desc"}]',
      fields: 'SKU, Status',
    })
    const openRows = open.data as Record<string, unknown>[]
    expect(openRows.length).toBe(12)
    expect(openRows[0]).toEqual({
      id: expect.any(String),
      createdTime: expect.any(String),
      SKU: 'S-23',
      Status: 'Open',
    })

    const first = openRows[0]!
    const updated = await run(
      { action: 'update', table: 'Orders', records: '[{"id": "{{ id }}", "fields": {"Qty": 100}}]' },
      { id: first.id },
    )
    expect((updated.data as Record<string, unknown>[])[0]).toMatchObject({ SKU: 'S-23', Qty: 100 })
    expect((await run({ action: 'get', table: 'Orders', id: String(first.id) })).data).toMatchObject({
      Qty: 100,
    })

    const upserted = await run({
      action: 'upsert',
      table: 'Orders',
      mergeOn: 'SKU',
      records: '[{"SKU": "S-23", "Qty": 7}, {"SKU": "S-99", "Qty": 1}]',
    })
    expect((upserted.metadata.created as string[]).length).toBe(1)
    expect((upserted.metadata.updated as string[]).length).toBe(1)

    const ids = (all.data as { id: string }[]).slice(0, 12).map((r) => r.id)
    const deleted = await run({ action: 'delete', table: 'Orders', ids: '{{ ids }}' }, { ids })
    expect((deleted.data as { deleted: string[] }).deleted).toEqual(ids)
    expect((await run({ action: 'list', table: 'Orders' })).metadata).toMatchObject({ count: 14 })
  })

  it('waits out a 429 once, reads the schema, and explains errors', async () => {
    fake.airtable.rateLimitOnce = true
    expect((await run({ action: 'list', table: 'Orders', max: '1' })).data).toHaveLength(1)
    const schema = await run({ action: 'schema' })
    expect((schema.data as { name: string; fields: { name: string }[] }[])[0]).toMatchObject({
      name: 'Orders',
      fields: expect.arrayContaining([{ id: 'fldSku', name: 'SKU', type: 'singleLineText' }]),
    })
    const unknown = await failure(run({ action: 'create', table: 'Orders', records: '{"Colour": "red"}' }))
    expect(unknown.message).toBe('Airtable: Unknown field name: "Colour" (UNKNOWN_FIELD_NAME)')
    expect(await failure(run({ action: 'list', table: 'Orders' }, {}, key({})))).toMatchObject({
      code: 'invalid_query',
    })
    expect((await failure(run({ action: 'list', table: 'Nope' }))).details).toMatchObject({
      status: 404,
      type: 'TABLE_NOT_FOUND',
    })
  })
})
