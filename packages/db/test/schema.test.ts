import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configVars,
  configVarValues,
  createDb,
  type Db,
  environments,
  folders,
  groups,
  permissions,
  resourceConfigs,
  resources,
} from '../src'
import { startTestDatabase } from '../src/testing'

let db: Db
let stop: () => Promise<void>
let prodId: string
let stagingId: string
let groupId: string

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = createDb(pg.url, { max: 2 })
  db = conn.db
  stop = async () => {
    await conn.close()
    await pg.stop()
  }
  const envs = await db.select().from(environments)
  prodId = envs.find((e) => e.slug === 'production')!.id
  stagingId = envs.find((e) => e.slug === 'staging')!.id
  groupId = (await db.insert(groups).values({ name: 'Data' }).returning())[0]!.id
})
afterAll(() => stop?.())

/** The Postgres error behind a failed drizzle query (drizzle wraps it as `cause`). */
async function pgError(query: Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await query
  } catch (err) {
    return ((err as { cause?: unknown }).cause ?? err) as { code?: string; constraint_name?: string }
  }
  throw new Error('expected the query to fail')
}

describe('resources', () => {
  it('allows one config per environment and cascades on delete', async () => {
    const [r] = await db
      .insert(resources)
      .values({ slug: 'orders_db', name: 'Orders', type: 'postgres' })
      .returning()
    await db.insert(resourceConfigs).values([
      { resourceId: r!.id, environmentId: prodId, config: { host: 'prod' } },
      { resourceId: r!.id, environmentId: stagingId, config: { host: 'staging' } },
    ])
    expect(
      await pgError(db.insert(resourceConfigs).values({ resourceId: r!.id, environmentId: prodId })),
    ).toMatchObject({ code: '23505', constraint_name: 'resource_configs_env_uq' })

    await db.delete(resources).where(eq(resources.id, r!.id))
    expect(await db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, r!.id))).toEqual([])
  })

  it('keeps slugs unique', async () => {
    await db.insert(resources).values({ slug: 'billing_api', name: 'Billing', type: 'rest' })
    expect(
      await pgError(db.insert(resources).values({ slug: 'billing_api', name: 'Other', type: 'rest' })),
    ).toMatchObject({ code: '23505', constraint_name: 'resources_slug_uq' })
  })
})

describe('config vars', () => {
  it('requires exactly one of value / valueEncrypted', async () => {
    const [v] = await db.insert(configVars).values({ name: 'API_BASE' }).returning()
    for (const values of [{}, { value: 'a', valueEncrypted: 'v1.x.y.z' }]) {
      expect(
        await pgError(
          db.insert(configVarValues).values({ configVarId: v!.id, environmentId: prodId, ...values }),
        ),
      ).toMatchObject({ code: '23514', constraint_name: 'config_var_values_one_value_ck' })
    }
    await db.insert(configVarValues).values({ configVarId: v!.id, environmentId: prodId, value: 'https://x' })
    await db
      .insert(configVarValues)
      .values({ configVarId: v!.id, environmentId: stagingId, valueEncrypted: 'v1.x.y.z' })
  })
})

describe('permissions', () => {
  it('treats null object / environment as a value in the uniqueness check', async () => {
    const grant = { groupId, objectType: 'resource' as const, level: 'use' as const }
    await db.insert(permissions).values(grant)
    expect(await pgError(db.insert(permissions).values({ ...grant, level: 'edit' }))).toMatchObject({
      code: '23505',
      constraint_name: 'permissions_grant_uq',
    })
    // Same group and type but scoped to one environment is a different grant.
    await db.insert(permissions).values({ ...grant, environmentId: prodId })
  })

  it('rejects unknown levels and object types', async () => {
    // `as never` deliberately bypasses the TS enums so the DB checks are what reject the row.
    const bad = (values: Record<string, string>) =>
      pgError(
        db.insert(permissions).values({ groupId, objectType: 'workflow', level: 'use', ...values } as never),
      )
    expect(await bad({ level: 'admin' })).toMatchObject({
      code: '23514',
      constraint_name: 'permissions_level_ck',
    })
    expect(await bad({ objectType: 'dashboard' })).toMatchObject({
      code: '23514',
      constraint_name: 'permissions_object_type_ck',
    })
  })

  it('cascades when the group is deleted', async () => {
    const [g] = await db.insert(groups).values({ name: 'Temp' }).returning()
    await db.insert(permissions).values({ groupId: g!.id, objectType: 'workflow', level: 'own' })
    await db.delete(groups).where(eq(groups.id, g!.id))
    expect(await db.select().from(permissions).where(eq(permissions.groupId, g!.id))).toEqual([])
  })
})

describe('folders', () => {
  it('keeps names unique per parent (top level included) and refuses to delete non-empty parents', async () => {
    const [top] = await db.insert(folders).values({ objectType: 'resource', name: 'Finance' }).returning()
    expect(
      await pgError(db.insert(folders).values({ objectType: 'resource', name: 'Finance' })),
    ).toMatchObject({
      code: '23505',
      constraint_name: 'folders_name_uq',
    })
    // Same name is fine for another object type or another parent.
    await db.insert(folders).values({ objectType: 'workflow', name: 'Finance' })
    await db.insert(folders).values({ objectType: 'resource', name: 'Finance', parentId: top!.id })

    // ON DELETE RESTRICT raises restrict_violation (23001), not foreign_key_violation (23503).
    expect(await pgError(db.delete(folders).where(eq(folders.id, top!.id)))).toMatchObject({
      code: '23001',
      constraint_name: 'folders_parent_id_folders_id_fk',
    })
  })
})
