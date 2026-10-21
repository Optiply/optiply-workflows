import type { Db } from '@ow/db'
import { sql } from 'drizzle-orm'
import { RunRequestError } from './workflow-runs'

/**
 * A call a live webhook refused, with the reason recorded for the editor and counted in
 * `ow_webhook_rejected_total` (M15). The caller only sees the status and the message.
 */
export class WebhookRejection extends RunRequestError {
  constructor(
    status: RunRequestError['status'],
    code: string,
    message: string,
    /** A finer code than `code`, e.g. `signature_mismatch` for a 401 `unauthorized`. */
    readonly reason: string,
  ) {
    super(status, code, message)
  }
}

/**
 * Counts a call against a webhook's limit, in fixed windows on the database clock (aligned to the epoch), so every
 * API process shares the count. One upsert per call. Refused calls count too, so a flood stays refused until the
 * window ends. A fixed window lets up to twice the limit through around a window's boundary.
 */
export async function countWebhookCall(
  db: Db,
  triggerId: string,
  limit: { requests: number; windowSeconds: number },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const [row] = await db.execute<{ count: number; left: number }>(sql`
    with w as (select to_timestamp(floor(extract(epoch from now()) / ${limit.windowSeconds}) * ${limit.windowSeconds}) as start)
    insert into webhook_rate_windows (trigger_id, window_start, expires_at, count)
    select ${triggerId}, w.start, w.start + make_interval(secs => ${limit.windowSeconds}), 1 from w
    on conflict (trigger_id, window_start) do update set count = webhook_rate_windows.count + 1
    returning count, extract(epoch from expires_at - now())::float8 as left`)
  return {
    allowed: row!.count <= limit.requests,
    retryAfterSeconds: Math.max(1, Math.ceil(row!.left)),
  }
}

/** Refuses the call with 429 and Retry-After when the webhook is over its limit. */
export async function requireUnderLimit(
  db: Db,
  triggerId: string,
  limit: { requests: number; windowSeconds: number } | null,
  setRetryAfter: (seconds: number) => void,
) {
  if (!limit) return
  const { allowed, retryAfterSeconds } = await countWebhookCall(db, triggerId, limit)
  if (allowed) return
  setRetryAfter(retryAfterSeconds)
  throw new WebhookRejection(
    429,
    'rate_limited',
    `This webhook accepts ${limit.requests} calls per ${limit.windowSeconds} s; try again in ${retryAfterSeconds} s`,
    'rate_limited',
  )
}
