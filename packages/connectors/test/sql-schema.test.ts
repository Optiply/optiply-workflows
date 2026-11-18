import { startTestDatabase } from '@ow/db/testing'
import mysql from 'mysql2/promise'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AnyConnector,
  createBigQueryConnector,
  describeSqlSchema,
  groupSchema,
  jdbcConnector,
  mssqlConnector,
  mysqlConnector,
  PoolManager,
  postgresConnector,
  SQL_SCHEMA_COLUMNS,
} from '../src'
import { mysqlAvailable, startTestMysql, type TestMysql } from '../src/testing'
import { FakeBigQuery } from './bigquery-fake'
import { resource } from './helpers'

// SQL schema loading (session 57): each SQL connector's catalog query, run through the connector, grouped into tables.

let pool: PoolManager

beforeAll(() => {
  pool = new PoolManager({ sweepIntervalMs: 0 })
})
afterAll(async () => {
  await pool?.closeAll()
})

describe('grouping a catalog’s rows', () => {
  it('makes tables in order, reads any case and every way of saying nullable, and says when it was cut short', () => {
    const rows = [
      { S: 'public', T: 'orders', C: 'id', D: 'integer', N: 'NO' },
      { s: 'public', t: 'orders', c: 'note', d: 'text', n: 'YES' },
      { s: 'shop', t: 'orders', c: 'sku', d: 'VARCHAR2', n: 'Y' },
      { s: 'shop', t: 'lines', c: 'qty', d: 'Nullable(Int32)', n: 1 },
      { s: 'shop', t: 'lines', c: 'extra', d: 'x', n: 'N' },
    ]
    expect(groupSchema(rows, 10)).toEqual({
      truncated: false,
      tables: [
        {
          schema: 'public',
          name: 'orders',
          columns: [
            { name: 'id', type: 'integer', nullable: false },
            { name: 'note', type: 'text', nullable: true },
          ],
        },
        { schema: 'shop', name: 'orders', columns: [{ name: 'sku', type: 'VARCHAR2', nullable: true }] },
        {
          schema: 'shop',
          name: 'lines',
          columns: [
            { name: 'qty', type: 'Nullable(Int32)', nullable: true },
            { name: 'extra', type: 'x', nullable: false },
          ],
        },
      ],
    })
    const cut = groupSchema(rows, 2)
    expect(cut.truncated).toBe(true)
    expect(cut.tables.flatMap((t) => t.columns)).toHaveLength(2)
  })
})

describe('Postgres', () => {
  let admin: postgres.Sql
  let stopDb: () => Promise<void>
  let base: Record<string, unknown>
  let password: string

  beforeAll(async () => {
    const pg = await startTestDatabase()
    stopDb = pg.stop
    const url = new URL(pg.url)
    password = decodeURIComponent(url.password)
    base = {
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      ssl: 'disable',
    }
    admin = postgres(pg.url, { onnotice: () => {} })
    await admin.unsafe(`
      create schema shop;
      create table shop.orders (id int primary key, customer text not null, tags int[], doc jsonb);
      create view shop.big_orders as select id, customer from shop.orders;
    `)
  })
  afterAll(async () => {
    await admin?.end()
    await stopDb?.()
  })

  it('lists its schemas’ tables and views with their columns, not the system’s', async () => {
    const schema = await describeSqlSchema(pool, postgresConnector, resource(base, { password }, 'a'))
    expect(schema!.truncated).toBe(false)
    const orders = schema!.tables.find((t) => t.schema === 'shop' && t.name === 'orders')
    expect(orders?.columns).toEqual([
      { name: 'id', type: 'integer', nullable: false },
      { name: 'customer', type: 'text', nullable: false },
      { name: 'tags', type: '_int4', nullable: true },
      { name: 'doc', type: 'jsonb', nullable: true },
    ])
    expect(schema!.tables.find((t) => t.name === 'big_orders')?.columns.map((c) => c.name)).toEqual([
      'id',
      'customer',
    ])
    expect(schema!.tables.some((t) => t.schema === 'pg_catalog' || t.schema === 'information_schema')).toBe(
      false,
    )
  })

  it('stays under the resource’s own row limit, and says the schema was cut short', async () => {
    const schema = await describeSqlSchema(
      pool,
      postgresConnector,
      resource({ ...base, maxRows: 4 }, { password }, 'b'),
    )
    expect(schema!.truncated).toBe(true)
    expect(schema!.tables.flatMap((t) => t.columns)).toHaveLength(3)
  })
})

describe.skipIf(!mysqlAvailable())('MySQL', () => {
  let server: TestMysql
  beforeAll(async () => {
    server = await startTestMysql()
    const root = await mysql.createConnection({
      host: server.host,
      port: server.port,
      user: 'root',
      password: server.rootPassword,
      database: server.database,
    })
    await root.query(
      'CREATE TABLE products (id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, price DECIMAL(10, 2))',
    )
    await root.end()
  }, 180_000)
  afterAll(async () => {
    await server?.stop()
  })

  it('lists the connected database’s tables with their column types', async () => {
    const schema = await describeSqlSchema(
      pool,
      mysqlConnector,
      resource(
        {
          host: server.host,
          port: server.port,
          database: server.database,
          user: server.user,
          ssl: 'disable',
        },
        { password: server.password },
        'm',
      ),
    )
    expect(schema!.tables).toEqual([
      {
        schema: server.database,
        name: 'products',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'name', type: 'varchar(80)', nullable: false },
          { name: 'price', type: 'decimal(10,2)', nullable: true },
        ],
      },
    ])
  })
})

describe('BigQuery', () => {
  const fake = new FakeBigQuery()
  let bigquery: AnyConnector
  beforeAll(async () => {
    await fake.start()
    bigquery = createBigQueryConnector(fake.endpoints)
  })
  afterAll(async () => {
    await fake.stop()
  })

  it('reads the default dataset’s columns, else the region’s', async () => {
    fake.script(/INFORMATION_SCHEMA\.COLUMNS/, {
      schema: {
        fields: ['s', 't', 'c', 'd', 'n'].map((name) => ({ name, type: 'STRING' })),
      },
      rows: [{ f: [{ v: 'shop' }, { v: 'orders' }, { v: 'id' }, { v: 'INT64' }, { v: 'NO' }] }],
    })
    const bq = (config: Record<string, unknown>, version: string) =>
      resource({ location: 'EU', ...config }, { serviceAccountKey: fake.keyJson }, version)
    const sent = () =>
      (
        fake.requests.findLast((r) => r.method === 'POST' && r.path.endsWith('/jobs'))?.body as {
          configuration: { query: { query: string } }
        }
      ).configuration.query.query

    const regional = await describeSqlSchema(pool, bigquery, bq({}, 'r'))
    expect(regional!.tables).toEqual([
      { schema: 'shop', name: 'orders', columns: [{ name: 'id', type: 'INT64', nullable: false }] },
    ])
    expect(sent()).toContain('`region-eu`.INFORMATION_SCHEMA.COLUMNS')
    await describeSqlSchema(pool, bigquery, bq({ defaultDataset: 'other-project.shop' }, 'd'))
    expect(sent()).toContain('`other-project.shop`.INFORMATION_SCHEMA.COLUMNS')
  })
})

describe('the other dialects’ catalog queries', () => {
  it('SQL Server, and JDBC’s Snowflake, Oracle and ClickHouse; none for an uploaded driver', () => {
    const jdbc = (config: Record<string, unknown>) =>
      jdbcConnector.schemaSql!(jdbcConnector.configSchema.parse({ user: 'u', ...config }), 11)
    expect(
      mssqlConnector.schemaSql!(
        mssqlConnector.configSchema.parse({ host: 'h', database: 'd', user: 'u' }),
        11,
      ),
    ).toMatch(/^SELECT TOP 11 .*FROM INFORMATION_SCHEMA\.COLUMNS/s)
    expect(jdbc({ driver: 'snowflake', account: 'acme' })).toMatch(
      /information_schema\.columns[\s\S]*LIMIT 11$/,
    )
    expect(jdbc({ driver: 'oracle', host: 'db', serviceName: 'ORCL' })).toMatch(
      /all_tab_columns[\s\S]*CURRENT_SCHEMA[\s\S]*FETCH FIRST 11 ROWS ONLY$/,
    )
    expect(jdbc({ driver: 'clickhouse', host: 'ch' })).toMatch(
      /system\.columns[\s\S]*currentDatabase\(\)[\s\S]*LIMIT 11$/,
    )
    expect(jdbc({ driver: 'uploaded', driverId: 'x', mode: 'url', url: 'jdbc:x://h' })).toBeNull()
    expect(SQL_SCHEMA_COLUMNS).toBe(20_000)
  })
})
