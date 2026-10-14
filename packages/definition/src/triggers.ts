import { DEFAULT_TIMEZONE, nextCronFire, nextIntervalFire, parseCron } from './cron'
import type { ScheduleTrigger } from './schema'

/** One segment of a webhook alias: fixed text, or a `:name` that captures that part of the URL. */
export type AliasSegment = { text: string; param?: undefined } | { param: string; text?: undefined }

export type AliasParseResult =
  | {
      ok: true
      segments: AliasSegment[]
      /** Segments with every param as `:`, e.g. `orders/:`. Two live aliases with the same shape conflict. */
      shape: string
    }
  | { ok: false; error: string; hint?: string }

const MAX_ALIAS_SEGMENTS = 10
const TEXT_SEGMENT = /^[a-z0-9][a-z0-9_.-]{0,62}$/
const PARAM_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]{0,31})$/

/**
 * Parses a webhook alias such as `orders/:orderId/refunds`. Segments are lowercase text or `:params`; the first one
 * must be text, so every alias has a fixed prefix.
 */
export function parseWebhookAlias(alias: string): AliasParseResult {
  if (alias.startsWith('/') || alias.endsWith('/')) {
    return {
      ok: false,
      error: "An alias can't start or end with /",
      hint: 'Write orders/:id, not /orders/:id/',
    }
  }
  const parts = alias.split('/')
  if (parts.length > MAX_ALIAS_SEGMENTS) {
    return { ok: false, error: `An alias can have at most ${MAX_ALIAS_SEGMENTS} segments` }
  }
  const segments: AliasSegment[] = []
  const params = new Set<string>()
  for (const [i, part] of parts.entries()) {
    const param = PARAM_SEGMENT.exec(part)?.[1]
    if (param) {
      if (i === 0) return { ok: false, error: 'An alias must start with fixed text, not a :param' }
      if (params.has(param)) return { ok: false, error: `The parameter ":${param}" appears twice` }
      params.add(param)
      segments.push({ param })
    } else if (TEXT_SEGMENT.test(part)) {
      segments.push({ text: part })
    } else {
      return {
        ok: false,
        error: part ? `Invalid alias segment "${part}"` : 'An alias has an empty segment (//)',
        hint: 'Use lowercase letters, digits, -, _ or ., or :name for a parameter',
      }
    }
  }
  return { ok: true, segments, shape: segments.map((s) => s.text ?? ':').join('/') }
}

/**
 * Matches URL path segments (already split and decoded) against an alias. Returns the captured params, or null.
 * Callers prefer the alias with the most fixed segments when several match.
 */
export function matchWebhookAlias(
  segments: readonly AliasSegment[],
  path: readonly string[],
): Record<string, string> | null {
  if (segments.length !== path.length) return null
  const params: Record<string, string> = {}
  for (const [i, segment] of segments.entries()) {
    if (segment.param) {
      if (!path[i]) return null
      params[segment.param] = path[i]!
    } else if (segment.text !== path[i]) {
      return null
    }
  }
  return params
}

/**
 * When a schedule fires next, strictly after `after`. Interval schedules keep to the grid of their previous fire
 * (the first fire is one interval after `after`). Null when the schedule is invalid or never fires.
 */
export function nextScheduleFire(
  schedule: Pick<ScheduleTrigger, 'cron' | 'intervalMs' | 'timezone'>,
  after: Date,
  previous?: Date | null,
): Date | null {
  if (schedule.intervalMs !== undefined && schedule.cron === undefined) {
    if (schedule.intervalMs <= 0) return null
    return previous
      ? nextIntervalFire(previous, schedule.intervalMs, after)
      : new Date(after.getTime() + schedule.intervalMs)
  }
  if (schedule.cron === undefined || schedule.intervalMs !== undefined) return null
  const parsed = parseCron(schedule.cron)
  if (!parsed.ok) return null
  try {
    return nextCronFire(parsed.cron, after, schedule.timezone ?? DEFAULT_TIMEZONE)
  } catch {
    return null // Unknown time zone.
  }
}
