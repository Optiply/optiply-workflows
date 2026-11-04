import type { Db } from '@ow/db'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
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
    opts: { details?: Record<string, unknown>; record?: boolean } = {},
  ) {
    super(status, code, message, opts.details)
    this.record = opts.record ?? true
  }
  /** Whether it goes in `webhook_rejections` (only a window's first 429 does). */
  readonly record: boolean
}

/** At most this many rejections are recorded per webhook per minute, so a flood can't fill the table. */
export const MAX_REJECTIONS_PER_MINUTE = 60

/** Records a refused call for the editor's webhook panel (never its body or signature). */
export async function recordRejection(
  db: Db,
  rejection: {
    triggerId: string
    environmentId: string | null
    status: number
    reason: string
    message: string
    ip: string | null
    userAgent: string | null
  },
) {
  await db.execute(sql`
    insert into webhook_rejections (id, trigger_id, environment_id, status, reason, message, ip, user_agent)
    select ${uuidv7()}, ${rejection.triggerId}, ${rejection.environmentId}, ${rejection.status}, ${rejection.reason},
           ${rejection.message.slice(0, 500)}, ${rejection.ip}, ${rejection.userAgent?.slice(0, 300) ?? null}
    where (select count(*) from webhook_rejections
           where trigger_id = ${rejection.triggerId} and created_at > now() - interval '1 minute')
          < ${MAX_REJECTIONS_PER_MINUTE}`)
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
): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number }> {
  const [row] = await db.execute<{ count: number; left: number }>(sql`
    with w as (select to_timestamp(floor(extract(epoch from now()) / ${limit.windowSeconds}) * ${limit.windowSeconds}) as start)
    insert into webhook_rate_windows (trigger_id, window_start, expires_at, count)
    select ${triggerId}, w.start, w.start + make_interval(secs => ${limit.windowSeconds}), 1 from w
    on conflict (trigger_id, window_start) do update set count = webhook_rate_windows.count + 1
    returning count, extract(epoch from expires_at - now())::float8 as left`)
  return {
    allowed: row!.count <= limit.requests,
    count: row!.count,
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
  const { allowed, count, retryAfterSeconds } = await countWebhookCall(db, triggerId, limit)
  if (allowed) return
  setRetryAfter(retryAfterSeconds)
  throw new WebhookRejection(
    429,
    'rate_limited',
    `This webhook accepts ${limit.requests} calls per ${limit.windowSeconds} s; try again in ${retryAfterSeconds} s`,
    'rate_limited',
    { record: count === limit.requests + 1 },
  )
}
