import { hashApiKey } from '@ow/crypto'
import { type ApiKey, apiKeys, type Db } from '@ow/db'
import { eq, sql } from 'drizzle-orm'

/** Where the caller put the key, so that header can be kept out of the run's input. */
export type ApiKeySource = 'x-api-key' | 'authorization'

/** The API key a request presents: `X-Api-Key: ow_…` or `Authorization: Bearer ow_…`. */
export function presentedApiKey(
  headers: Record<string, unknown>,
): { key: string; source: ApiKeySource } | null {
  const header = headers['x-api-key']
  if (typeof header === 'string' && header) return { key: header.trim(), source: 'x-api-key' }
  const auth = headers.authorization
  if (typeof auth === 'string') {
    const bearer = /^Bearer\s+(ow_\S+)$/i.exec(auth.trim())
    if (bearer) return { key: bearer[1]!, source: 'authorization' }
  }
  return null
}

/**
 * The active key with that value, or null (unknown, revoked or expired). Keys are looked up by their sha256, which
 * the unique index makes a constant-time-enough equality on random 256-bit secrets. Records the use at most once a
 * minute, without waiting for it.
 */
export async function authenticateApiKey(db: Db, key: string): Promise<ApiKey | null> {
  if (!key.startsWith('ow_') || key.length > 200) return null
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.hash, hashApiKey(key)))
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= new Date())) return null
  void db
    .execute(sql`
      update api_keys set last_used_at = now()
      where id = ${row.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`)
    .catch(() => {})
  return row
}

/** Whether a key may start (and read) runs of this workflow in this environment. */
export function apiKeyAllows(key: ApiKey, workflowId: string, environmentId: string): boolean {
  return (
    (key.workflowIds === null || key.workflowIds.includes(workflowId)) &&
    (key.environmentIds === null || key.environmentIds.includes(environmentId))
  )
}
