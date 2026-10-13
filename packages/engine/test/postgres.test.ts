import { PoolManager, postgresConnector } from '@ow/connectors'
import { startTestDatabase } from '@ow/db/testing'
import { IvmRuntime } from '@ow/sandbox'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EngineServices } from '../src'
import { code, response, run, wf } from './helpers'

let services: EngineServices
let admin: postgres.Sql
let stop: () => Promise<void>

beforeAll(async () => {
  const pg = await startTestDatabase()
  const url = new URL(pg.url)
  admin = postgres(pg.url, { max: 1 })
  const sandbox = new IvmRuntime()
  const pool = new PoolManager({ sweepIntervalMs: 0 })
  services = {
    sandbox,
    pool,
    resources: {
      async resolve(slug, environmentId) {
        if (slug !== 'warehouse') throw new Error('unknown')
        return {
          connector: postgresConnector,
          resource: {
            id: 'rc-1',
            resourceId: 'r-1',
            environmentId,
            version: '1',
            config: {
              host: url.hostname,
              port: Number(url.port),
              database: url.pathname.slice(1),
              user: decodeURIComponent(url.username),
              ssl: 'disable',
            },
            secrets: { password: decodeURIComponent(url.password) },
          },
        }
      },
    },
  }
  stop = async () => {
    sandbox.dispose()
    await pool.closeAll()
    await admin.end()
    await pg.stop()
  }
})
afterAll(() => stop?.())

const sql = (name: string, text: string, settings?: object) => ({
  name,
  type: 'resourceQuery',
  config: { resource: 'warehouse', query: { sql: text } },
  ...(settings && { settings }),
})

describe('resource queries against Postgres', () => {
  it('binds {{ }} as parameters and feeds rows downstream', async () => {
    const { outcome, data } = await run(
      services,
      wf(
        [
          sql(
            'orders',
            'select n, n * {{ startTrigger.data.factor }} as scaled from generate_series(1, 3) n',
          ),
          code('total', 'return _.sumBy(orders.data, "scaled")'),
          response('reply', '{"total": {{ total.data }}, "rows": {{ orders.metadata.rowCount }}}'),
        ],
        [
          ['startTrigger', 'orders'],
          ['orders', 'total'],
          ['total', 'reply'],
        ],
      ),
      { input: { data: { factor: 10 } } },
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('orders')).toEqual([
      { n: 1, scaled: 10 },
      { n: 2, scaled: 20 },
      { n: 3, scaled: 30 },
    ])
    expect(outcome.response).toEqual({ status: 200, headers: {}, body: { total: 60, rows: 3 } })
  })

  it('keeps injected SQL inert', async () => {
    const { data } = await run(
      services,
      wf([sql('q', 'select {{ startTrigger.data }}::text as v')], [['startTrigger', 'q']]),
      {
        input: { data: "x'; drop table workflows; --" },
      },
    )
    expect(data('q')).toEqual([{ v: "x'; drop table workflows; --" }])
    expect(await admin`select to_regclass('workflows') as t`).toEqual([{ t: 'workflows' }])
  })

  it('reports SQL errors as query errors', async () => {
    const { outcome } = await run(services, wf([sql('q', 'select * from nope')], [['startTrigger', 'q']]))
    expect(outcome.error).toMatchObject({ code: 'query', block: 'q' })
    expect(outcome.error!.message).toMatch(/nope/)
  })

  it('cancels the statement on the server when the block times out', async () => {
    const { outcome } = await run(
      services,
      wf([sql('slow', 'select pg_sleep(5)', { timeoutMs: 300 })], [['startTrigger', 'slow']]),
    )
    expect(outcome.error).toMatchObject({ code: 'timeout', block: 'slow' })
    // Give the cancel request a moment to land.
    await new Promise((r) => setTimeout(r, 300))
    const active =
      await admin`select count(*)::int as n from pg_stat_activity where query like 'select pg_sleep%' and state = 'active'`
    expect(active).toEqual([{ n: 0 }])
  })
})
