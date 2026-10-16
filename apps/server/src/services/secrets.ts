import {
  DecryptionError,
  decrypt,
  decryptJson,
  encryptJson,
  type Keyring,
  rekey,
  secretAad,
} from '@ow/crypto'
import type { Db } from '@ow/db'
import { sql } from 'drizzle-orm'

/**
 * Every encrypted column. A value's AAD is `<table>:<row id>:<environment id>`, so writers and `rekeyAll` must
 * build it the same way: always go through `encryptForRow` / `decryptForRow`.
 */
export const ENCRYPTED_COLUMNS = [
  { table: 'resource_configs', column: 'secrets' },
  { table: 'config_var_values', column: 'value_encrypted' },
  { table: 'oauth_tokens', column: 'tokens' },
] as const

export type EncryptedTable = (typeof ENCRYPTED_COLUMNS)[number]['table']

interface RowRef {
  id: string
  environmentId: string
}

export function encryptForRow(keyring: Keyring, table: EncryptedTable, row: RowRef, value: unknown): string {
  return encryptJson(keyring, value, secretAad(table, row.id, row.environmentId))
}

export function decryptForRow<T = unknown>(
  keyring: Keyring,
  table: EncryptedTable,
  row: RowRef,
  token: string,
): T {
  return decryptJson<T>(keyring, token, secretAad(table, row.id, row.environmentId))
}

export interface RekeyReport {
  table: EncryptedTable
  /** Rows re-encrypted under the current key (or that would be, in a dry run). */
  rekeyed: number
  /** Rows whose ciphertext failed to decrypt; left untouched. */
  failed: string[]
}

/**
 * Re-encrypts every value not under the current key, in batches, one transaction per batch (rows locked while
 * rewritten). Rows that fail to decrypt are reported and skipped. A dry run decrypts but writes nothing.
 */
export async function rekeyAll(
  db: Db,
  keyring: Keyring,
  opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<RekeyReport[]> {
  const batchSize = opts.batchSize ?? 500
  const reports: RekeyReport[] = []
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const report: RekeyReport = { table, rekeyed: 0, failed: [] }
    const t = sql.identifier(table)
    const c = sql.identifier(column)
    // Keyset pagination, so rows that fail (and so keep their old key) aren't selected again.
    let after = '00000000-0000-0000-0000-000000000000'
    let fetched: number
    do {
      fetched = await db.transaction(async (tx) => {
        const rows = await tx.execute<{ id: string; environment_id: string; token: string }>(sql`
          select id, environment_id, ${c} as token from ${t}
          where id > ${after} and ${c} is not null and split_part(${c}, '.', 1) <> ${keyring.current}
          order by id limit ${batchSize} for update`)
        for (const row of rows) {
          after = row.id
          let fresh: string | null
          try {
            fresh = rekey(keyring, row.token, secretAad(table, row.id, row.environment_id))
          } catch (err) {
            if (!(err instanceof DecryptionError)) throw err
            report.failed.push(row.id)
            continue
          }
          if (!fresh) continue
          report.rekeyed++
          if (!opts.dryRun) await tx.execute(sql`update ${t} set ${c} = ${fresh} where id = ${row.id}`)
        }
        return rows.length
      })
    } while (fetched === batchSize)
    reports.push(report)
  }
  return reports
}

export interface VerifyReport {
  table: EncryptedTable
  /** Rows whose value decrypted. */
  ok: number
  /** Rows whose value didn't (wrong or missing key, or tampered): ids. */
  failed: string[]
  /** How many values use each key version, e.g. `{ v1: 12, v2: 3 }`. */
  keys: Record<string, number>
}

/**
 * Decrypts every stored secret with the configured keys, changing nothing: after restoring a backup (or before
 * removing an old key), this shows whether the keys and the database belong together.
 */
export async function verifySecrets(db: Db, keyring: Keyring, batchSize = 500): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = []
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const report: VerifyReport = { table, ok: 0, failed: [], keys: {} }
    const t = sql.identifier(table)
    const c = sql.identifier(column)
    let after = '00000000-0000-0000-0000-000000000000'
    for (;;) {
      const rows = await db.execute<{ id: string; environment_id: string; token: string }>(sql`
        select id, environment_id, ${c} as token from ${t}
        where id > ${after} and ${c} is not null order by id limit ${batchSize}`)
      for (const row of rows) {
        after = row.id
        const version = row.token.split('.')[0] ?? '?'
        report.keys[version] = (report.keys[version] ?? 0) + 1
        try {
          decrypt(keyring, row.token, secretAad(table, row.id, row.environment_id))
          report.ok++
        } catch (err) {
          if (!(err instanceof DecryptionError)) throw err
          report.failed.push(row.id)
        }
      }
      if (rows.length < batchSize) break
    }
    reports.push(report)
  }
  return reports
}
