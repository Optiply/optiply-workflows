/**
 * The managed database's provisioning: a schema and a login role per environment, reached through the built-in
 * `optiply_db` resource. The role can work in its own schema and nowhere else.
 */
import { ConnectorError, PoolManager, postgresConnector, runQuery } from '@ow/connectors'
import {
  createDb,
  environments,
  managedDatabases,
  type ResourceConfig,
  resourceConfigs,
  resources,
} from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectionTarget, DatabaseSetupError, provisionDatabases } from '../src/services/database'
import { toResolved } from '../src/services/resources'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let superSql: postgres.Sql
let pool: PoolManager
let resourceId: string
const envIds: Record<string, string> = {}

beforeAll(async () => {
  // Provisioning runs as the app starts.
  env = await startTestApp()
  superSql = postgres(env.databaseUrl, { max: 1, onnotice: () => {} })
  pool = new PoolManager({ sweepIntervalMs: 0 })
  for (const e of await env.db.select().from(environments)) envIds[e.slug] = e.id
  const [resource] = await env.db.select().from(resources).where(eq(resources.slug, 'optiply_db'))
  resourceId = resource!.id
}, 60_000)
afterAll(async () => {
  await pool?.closeAll()
  await superSql?.end()
  await env?.stop()
})

async function configRow(environment: string): Promise<ResourceConfig> {
  const rows = await env.db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, resourceId))
  return rows.find((r) => r.environmentId === envIds[environment])!
}

/** Runs one statement as the environment's role, through the built-in resource (as a workflow would). */
async function query(environment: string, text: string) {
  const resolved = toResolved(env.config.keyring, await configRow(environment))
  return runQuery(pool, postgresConnector, resolved, { sql: text }, { evaluate: async () => [] })
}

async function refused(environment: string, text: string): Promise<string> {
  try {
    await query(environment, text)
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return (err as ConnectorError).message
  }
  throw new Error(`expected "${text}" to be refused`)
}

describe('provisioning', () => {
  it('creates the built-in resource, and a schema and role per environment', async () => {
    const [resource] = await env.db.select().from(resources).where(eq(resources.id, resourceId))
    expect(resource).toMatchObject({ slug: 'optiply_db', type: 'postgres', systemKind: 'database' })
    const managed = await env.db.select().from(managedDatabases)
    expect(managed.map((m) => m.schemaName).sort()).toEqual(['owdb_production', 'owdb_staging'])
    for (const m of managed) expect(m.roleName).toMatch(/^owdb_[0-9a-f]{6}_(production|staging)$/)

    const production = await configRow('production')
    const prodRole = managed.find((m) => m.environmentId === envIds.production)!.roleName
    expect(production.config).toMatchObject({ user: prodRole, ...connectionTarget(env.databaseUrl) })
    expect(production.secrets).toBeTruthy()
    // The password itself never appears in config.
    expect(JSON.stringify(production.config)).not.toMatch(/password/i)
  })

  it('lets each role build and query tables in its own schema, unqualified', async () => {
    await query(
      'production',
      'create table customers (id bigint generated always as identity primary key, name text)',
    )
    await query('production', "insert into customers (name) values ('Acme'), ('Globex')")
    expect((await query('production', 'select name from customers order by id')).data).toEqual([
      { name: 'Acme' },
      { name: 'Globex' },
    ])
    expect((await query('production', 'select current_schema() as s')).data).toEqual([
      { s: 'owdb_production' },
    ])
    // Staging has its own, empty schema.
    await query('staging', 'create table customers (id int)')
    expect((await query('staging', 'select count(*)::int as n from customers')).data).toEqual([{ n: 0 }])
  })

  it('keeps the role away from everything else', async () => {
    // The platform's own tables.
    expect(await refused('production', 'select email from public.users')).toMatch(/permission denied/)
    expect(await refused('production', 'select * from public.resource_configs')).toMatch(/permission denied/)
    // Another environment's schema.
    expect(await refused('production', 'select * from owdb_staging.customers')).toMatch(/permission denied/)
    // Switching role, in a statement or by setting it.
    expect(await refused('production', "select set_config('role', 'ow', false)")).toMatch(/permission denied/)
    expect(await refused('production', 'set role ow')).toMatch(/permission denied/)
    expect(await refused('production', 'alter role current_user superuser')).toMatch(
      /permission denied|superuser/,
    )
    // New schemas, or tables outside its schema.
    expect(await refused('production', 'create schema sneaky')).toMatch(/permission denied/)
    expect(await refused('production', 'create table public.sneaky (id int)')).toMatch(/permission denied/)
    expect(await refused('production', 'select * from pg_authid')).toMatch(/permission denied/)
  })

  it('needs the right password to log in', async () => {
    const row = await configRow('production')
    const target = connectionTarget(env.databaseUrl)
    const wrong = postgres({
      host: target.host,
      port: target.port,
      database: row.config.database as string,
      username: row.config.user as string,
      password: 'not-the-password',
      max: 1,
      onnotice: () => {},
    })
    await expect(wrong`select 1`).rejects.toThrow(/password authentication failed/)
    await wrong.end()
  })

  it('runs again without changing anything', async () => {
    const before = await configRow('production')
    const report = await provisionDatabases(env.db, env.config.keyring, env.databaseUrl)
    expect(report.environments.map((e) => e.created)).toEqual([false, false])
    const after = await configRow('production')
    // Same row, same password, same version: pools keep their connections.
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(after.secrets).toBe(before.secrets)
    expect((await query('production', 'select count(*)::int as n from customers')).data).toEqual([{ n: 2 }])
  })

  it('repairs what a restore onto another server leaves behind: a missing role, and tables owned by others', async () => {
    const [managed] = await env.db
      .select()
      .from(managedDatabases)
      .where(eq(managedDatabases.environmentId, envIds.production!))
    const role = managed!.roleName
    await pool.closeAll()
    // A restore without the role: objects belong to whoever restored them, and the role doesn't exist.
    await superSql.unsafe(`reassign owned by "${role}" to current_user`)
    await superSql.unsafe(`drop owned by "${role}"`)
    await superSql.unsafe(`drop role "${role}"`)

    const report = await provisionDatabases(env.db, env.config.keyring, env.databaseUrl)
    expect(report.environments.find((e) => e.slug === 'production')).toMatchObject({ created: true })
    const owners = await superSql`
      select c.relname, pg_get_userbyid(c.relowner) as owner from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'owdb_production' and c.relkind in ('r', 'S')`
    expect(owners.length).toBeGreaterThan(0)
    for (const o of owners) expect(o.owner).toBe(role)
    // The stored password works for the new role, and the data is all there.
    expect(
      (await query('production', "insert into customers (name) values ('Initech') returning id")).data,
    ).toEqual([{ id: '3' }])
  })

  it('takes away anything granted to the role by hand', async () => {
    const [managed] = await env.db
      .select()
      .from(managedDatabases)
      .where(eq(managedDatabases.environmentId, envIds.staging!))
    // The role doesn't inherit, but a granted role can be switched to mid-statement, and dynamic SQL runs as it.
    const roleSwitch =
      "select set_config('role', 'pg_read_all_data', true) as r, " +
      "query_to_xml('select count(*) from public.users', false, false, '')::text as x"
    await superSql.unsafe(`grant pg_read_all_data to "${managed!.roleName}"`)
    expect((await query('staging', roleSwitch)).data).toHaveLength(1)
    await provisionDatabases(env.db, env.config.keyring, env.databaseUrl)
    expect(await refused('staging', roleSwitch)).toMatch(/permission denied/)
  })
})

describe('environment names', () => {
  it('give every environment its own schema and role, even slugs that read the same', async () => {
    await env.db.insert(environments).values([
      { slug: 'eu-west', name: 'EU west (dash)' },
      { slug: 'eu_west', name: 'EU west (underscore)' },
    ])
    await provisionDatabases(env.db, env.config.keyring, env.databaseUrl)
    const managed = await env.db.select().from(managedDatabases)
    const eu = managed.filter((m) => m.schemaName.startsWith('owdb_eu_west'))
    expect(eu).toHaveLength(2)
    expect(new Set(eu.map((m) => m.schemaName)).size).toBe(2)
    expect(new Set(eu.map((m) => m.roleName)).size).toBe(2)
  })
})

describe('the platform user', () => {
  it('works without superuser, given CREATEROLE', async () => {
    const pg = await startTestDatabase()
    const admin = postgres(pg.url, { max: 1, onnotice: () => {} })
    const dbName = (await admin<{ db: string }[]>`select current_database() as db`)[0]!.db
    const user = `ow_platform_${dbName.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 60)
    await admin.unsafe(`create role "${user}" login createrole password 'platform-pass'`)
    await admin.unsafe(`grant all on all tables in schema public to "${user}"`)
    await admin.unsafe(`grant create on database "${dbName}" to "${user}"`)
    const url = new URL(pg.url)
    url.username = user
    url.password = 'platform-pass'
    const platform = createDb(url.toString(), { max: 1 })
    try {
      const report = await provisionDatabases(platform.db, env.config.keyring, url.toString())
      expect(report.environments.map((e) => e.created)).toEqual([true, true])
      // Again, as that user, to show the repair path works without superuser too.
      expect(
        (await provisionDatabases(platform.db, env.config.keyring, url.toString())).environments,
      ).toHaveLength(2)
    } finally {
      await platform.close()
      await admin.end()
      await pg.stop()
    }
  }, 60_000)

  it('without CREATEROLE, explains what to grant', async () => {
    const pg = await startTestDatabase()
    const admin = postgres(pg.url, { max: 1, onnotice: () => {} })
    const dbName = (await admin<{ db: string }[]>`select current_database() as db`)[0]!.db
    const user = `ow_plain_${dbName.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 60)
    await admin.unsafe(`create role "${user}" login password 'plain-pass'`)
    const url = new URL(pg.url)
    url.username = user
    url.password = 'plain-pass'
    const plain = createDb(url.toString(), { max: 1 })
    try {
      await expect(provisionDatabases(plain.db, env.config.keyring, url.toString())).rejects.toThrow(
        DatabaseSetupError,
      )
      await expect(provisionDatabases(plain.db, env.config.keyring, url.toString())).rejects.toThrow(
        /CREATEROLE/,
      )
    } finally {
      await plain.close()
      await admin.end()
      await pg.stop()
    }
  }, 60_000)
})

describe('the built-in resource', () => {
  let admin: ReturnType<typeof trpc>
  beforeAll(async () => {
    await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
    admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  })

  it("comes after people's own resources, which new query blocks default to", async () => {
    await admin.mutate('resources.create', { type: 'postgres', name: 'Shop DB', slug: 'shop_db' })
    const list = await admin.query('resources.list')
    expect(list.body.result?.data.resources.map((r: { slug: string }) => r.slug)).toEqual([
      'shop_db',
      'optiply_db',
    ])
  })

  it("can't be renamed, reconfigured, deleted, or tested with other settings, even by admins", async () => {
    const environmentId = envIds.production!
    const attempts = [
      admin.mutate('resources.update', { id: resourceId, name: 'Mine now' }),
      admin.mutate('resources.delete', { id: resourceId }),
      admin.mutate('resources.saveConfig', {
        resourceId,
        environmentId,
        config: { host: 'evil.example.com', database: 'x', user: 'x' },
      }),
      admin.mutate('resources.deleteConfig', { resourceId, environmentId }),
      // The stored password must not go to a host of the caller's choosing.
      admin.mutate('resources.test', {
        resourceId,
        environmentId,
        config: { host: 'evil.example.com', database: 'x', user: 'x' },
      }),
    ]
    for (const res of await Promise.all(attempts)) {
      expect(res.body.error?.data?.code).toBe('FORBIDDEN')
      expect(res.body.error?.message).toMatch(/built-in resource/)
    }
    // As it is, it tests fine.
    const test = await admin.mutate('resources.test', { resourceId, environmentId })
    expect(test.body.result?.data).toMatchObject({ ok: true })
    expect((await configRow('production')).config.host).not.toBe('evil.example.com')
  })
})
