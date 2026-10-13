import { generateKey, keyVersionOf, parseKeyring } from '@ow/crypto'
import {
  configVars,
  configVarValues,
  createDb,
  type Db,
  environments,
  resourceConfigs,
  resources,
} from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decryptForRow, encryptForRow, rekeyAll } from '../src/services/secrets'

const k1 = generateKey()
const k2 = generateKey()
const oldRing = parseKeyring(`v1:${k1}`)
const rotated = parseKeyring(`v1:${k1},v2:${k2}`)
const newOnly = parseKeyring(`v2:${k2}`)

let db: Db
let stop: () => Promise<void>
let prodId: string
let stagingId: string

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
})
afterAll(() => stop?.())

async function insertResourceConfigs(n: number, environmentId: string) {
  const [r] = await db
    .insert(resources)
    .values({ slug: `r_${uuidv7().slice(-12)}`, name: 'R', type: 'postgres' })
    .returning()
  const rows = []
  for (let i = 0; i < n; i++) {
    const id = uuidv7()
    const resourceId =
      i === 0
        ? r!.id
        : (
            await db
              .insert(resources)
              .values({ slug: `r_${uuidv7().slice(-12)}`, name: 'R', type: 'postgres' })
              .returning()
          )[0]!.id
    const secrets = encryptForRow(oldRing, 'resource_configs', { id, environmentId }, { password: `pw-${i}` })
    rows.push({ id, resourceId, environmentId, secrets })
  }
  await db.insert(resourceConfigs).values(rows)
  return rows
}

describe('encryptForRow / decryptForRow', () => {
  it('round-trips and is bound to the row', () => {
    const row = { id: uuidv7(), environmentId: prodId }
    const token = encryptForRow(oldRing, 'config_var_values', row, 'secret')
    expect(decryptForRow(oldRing, 'config_var_values', row, token)).toBe('secret')
    expect(() => decryptForRow(oldRing, 'resource_configs', row, token)).toThrow()
    expect(() =>
      decryptForRow(oldRing, 'config_var_values', { ...row, environmentId: stagingId }, token),
    ).toThrow()
  })
})

describe('rekeyAll', () => {
  it('re-encrypts every table in batches, reports rows that fail to decrypt, and is idempotent', async () => {
    const configs = await insertResourceConfigs(7, prodId)

    const [v] = await db.insert(configVars).values({ name: 'TOKEN', isSecret: true }).returning()
    const valueRow = { id: uuidv7(), environmentId: stagingId }
    await db.insert(configVarValues).values({
      ...valueRow,
      configVarId: v!.id,
      valueEncrypted: encryptForRow(oldRing, 'config_var_values', valueRow, 'tok-123'),
    })

    // Simulate a ciphertext swapped from another row: it must fail and be left alone.
    const swapped = configs[1]!
    await db
      .update(resourceConfigs)
      .set({ secrets: configs[0]!.secrets })
      .where(eq(resourceConfigs.id, swapped.id))

    const dry = await rekeyAll(db, rotated, { dryRun: true, batchSize: 3 })
    expect(dry).toEqual([
      { table: 'resource_configs', rekeyed: 6, failed: [swapped.id] },
      { table: 'config_var_values', rekeyed: 1, failed: [] },
    ])
    const afterDry = await db.select().from(resourceConfigs)
    expect(afterDry.every((r) => keyVersionOf(r.secrets!) === 'v1')).toBe(true)

    expect(await rekeyAll(db, rotated, { batchSize: 3 })).toEqual(dry)

    for (const row of await db.select().from(resourceConfigs)) {
      if (row.id === swapped.id) {
        expect(keyVersionOf(row.secrets!)).toBe('v1')
        continue
      }
      const i = configs.findIndex((c) => c.id === row.id)
      expect(decryptForRow(newOnly, 'resource_configs', row, row.secrets!)).toEqual({ password: `pw-${i}` })
    }
    const [value] = await db.select().from(configVarValues)
    expect(decryptForRow(newOnly, 'config_var_values', value!, value!.valueEncrypted!)).toBe('tok-123')

    // Second run: nothing left except the broken row.
    expect(await rekeyAll(db, rotated)).toEqual([
      { table: 'resource_configs', rekeyed: 0, failed: [swapped.id] },
      { table: 'config_var_values', rekeyed: 0, failed: [] },
    ])
  })
})
