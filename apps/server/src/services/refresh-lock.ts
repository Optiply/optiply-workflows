import { setTimeout as sleep } from 'node:timers/promises'
import type { Db } from '@ow/db'
import { sql } from 'drizzle-orm'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const NOT_LOCKED = Symbol('not locked')

/**
 * Runs `fn` in a transaction holding the transaction-scoped advisory lock named `key` (refreshing a connection's
 * tokens, signing a custom flow in). Waiting happens outside any transaction: whoever finds the lock taken sleeps
 * and tries again, so processes queueing behind a slow provider don't each hold a pooled database connection.
 * Only the one holding the lock does, for as long as `fn` runs.
 */
export async function withRefreshLock<T>(
  db: Db,
  key: string,
  signal: AbortSignal,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let delay = 25; ; delay = Math.min(delay * 2, 400)) {
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as locked`,
      )
      if (!row?.locked) return NOT_LOCKED
      return { value: await fn(tx) }
    })
    if (outcome !== NOT_LOCKED) return outcome.value
    await sleep(delay, undefined, { signal })
  }
}
