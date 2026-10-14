/**
 * Cron expressions and schedule fire times, evaluated on a time zone's wall clock. Shared by the editor (validation,
 * upcoming fire times) and the scheduler (`next_fire_at`).
 *
 * Expressions have the five classic fields: minute, hour, day of month, month, day of week. Fields take `*`, numbers,
 * ranges (`1-5`), lists (`1,15`), steps (`*\/15`, `0-30/10`, `5/15` = from 5 to the end every 15), and names for
 * months (`jan`) and weekdays (`mon`, Sunday is 0 or 7). `@yearly`, `@monthly`, `@weekly`, `@daily` and `@hourly`
 * are shorthands. As in Vixie cron, when both day fields are restricted (neither starts with `*`) a day matches if
 * either does.
 *
 * Daylight saving time (what the Europe/Amsterdam tests pin down):
 * - A wall-clock time that doesn't exist (clocks jump forward) fires once, at the first instant after the gap:
 *   `30 2 * * *` fires at 03:00 on the day the clocks go from 02:00 to 03:00, and an every-15-minutes schedule
 *   fires once at 03:00 for the whole skipped hour.
 * - A wall-clock time that happens twice (clocks go back) fires once, the first time.
 * So a daily job runs exactly once every day, and a job never fires twice for the same wall-clock time.
 */

export const DEFAULT_TIMEZONE = 'Europe/Amsterdam'

/** How far ahead the next fire time is searched for; an expression that never matches within it never fires. */
const SEARCH_YEARS = 8

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export interface CronExpression {
  readonly source: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  /** 0 = Sunday … 6 = Saturday. */
  readonly daysOfWeek: ReadonlySet<number>
  readonly daysOfMonthRestricted: boolean
  readonly daysOfWeekRestricted: boolean
}

export type CronParseResult = { ok: true; cron: CronExpression } | { ok: false; error: string }

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
  label: string
  min: number
  max: number
  names?: string[]
  /** Value of the first name (months are 1-based). */
  namesFrom?: number
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, namesFrom: 1 },
  // 7 is accepted as Sunday and folded into 0 after parsing.
  { label: 'day of week', min: 0, max: 7, names: DAY_NAMES, namesFrom: 0 },
]

export function parseCron(expression: string): CronParseResult {
  const source = expression.trim()
  const expanded = MACROS[source.toLowerCase()] ?? source
  if (expanded.startsWith('@')) return { ok: false, error: `Unknown shorthand "${source}"` }
  const parts = expanded.split(/\s+/).filter(Boolean)
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    }
  }
  const sets: Set<number>[] = []
  for (const [i, part] of parts.entries()) {
    const parsed = parseField(part, FIELDS[i]!)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    sets.push(parsed)
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ]
  if (daysOfWeek.delete(7)) daysOfWeek.add(0)
  return {
    ok: true,
    cron: {
      source,
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      daysOfMonthRestricted: !parts[2]!.startsWith('*'),
      daysOfWeekRestricted: !parts[4]!.startsWith('*'),
    },
  }
}

function parseField(field: string, spec: FieldSpec): Set<number> | string {
  const values = new Set<number>()
  for (const item of field.split(',')) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(item)
    if (!match) return `Invalid ${spec.label} "${item}"`
    const [, range, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    if (step < 1 || step > spec.max) return `Invalid step "${stepText}" in the ${spec.label} field`
    let from: number
    let to: number
    if (range === '*') {
      from = spec.min
      to = spec.label === 'day of week' ? 6 : spec.max
    } else {
      const bounds = range!.split('-')
      if (bounds.length > 2) return `Invalid ${spec.label} range "${range}"`
      const low = parseValue(bounds[0]!, spec)
      if (typeof low === 'string') return low
      from = low
      if (bounds.length === 2) {
        const high = parseValue(bounds[1]!, spec)
        if (typeof high === 'string') return high
        to = high
      } else {
        // `5/15` runs from 5 to the end of the range.
        to = stepText === undefined ? low : spec.max
      }
      if (from > to) return `The ${spec.label} range "${range}" runs backwards`
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return values
}

function parseValue(text: string, spec: FieldSpec): number | string {
  const name = spec.names?.indexOf(text.toLowerCase()) ?? -1
  if (name >= 0) return name + spec.namesFrom!
  if (!/^\d+$/.test(text)) return `Invalid ${spec.label} "${text}"`
  const value = Number(text)
  if (value < spec.min || value > spec.max) {
    return `The ${spec.label} must be between ${spec.min} and ${spec.max}, got ${value}`
  }
  return value
}

// ── Time zones ──────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** True for IANA zone names the runtime knows, e.g. `Europe/Amsterdam` or `UTC`. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

/**
 * The wall-clock time at an instant, as milliseconds of a UTC date with the same fields ("wall ms"), so calendar
 * arithmetic can use `Date`'s UTC methods.
 */
function toWall(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {}
  for (const p of formatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
}

/** The zone's UTC offset at an instant, in ms (Amsterdam in summer: +2 h). */
function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000
  return toWall(whole, timeZone) - whole
}

/**
 * The instant a wall-clock time happens. A time that happens twice gives the first instant; a time skipped by a
 * forward jump gives the instant the jump happens (the first wall-clock time after the gap).
 */
export function wallToInstant(wall: number, timeZone: string): number {
  const before = offsetAt(wall - DAY, timeZone)
  const after = offsetAt(wall + DAY, timeZone)
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => toWall(instant, timeZone) === wall)
  if (candidates.length) return Math.min(...candidates)
  // In a gap: find the transition, the first instant whose offset is the later one.
  let low = wall - Math.max(before, after)
  let high = wall - Math.min(before, after)
  while (high - low > 1000) {
    const mid = Math.floor((low + high) / 2000) * 1000
    if (offsetAt(mid, timeZone) === after) high = mid
    else low = mid
  }
  return high
}

// ── Fire times ──────────────────────────────────────────────────────────────

function dayMatches(cron: CronExpression, wall: Date): boolean {
  const dom = cron.daysOfMonth.has(wall.getUTCDate())
  const dow = cron.daysOfWeek.has(wall.getUTCDay())
  if (cron.daysOfMonthRestricted && cron.daysOfWeekRestricted) return dom || dow
  return dom && dow
}

/** The first wall-clock minute at or after `wall` that matches, or null if none does within the search window. */
function nextMatchingWall(cron: CronExpression, wall: number): number | null {
  const d = new Date(wall)
  const limit = d.getUTCFullYear() + SEARCH_YEARS
  while (d.getUTCFullYear() <= limit) {
    if (!cron.months.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1)
      d.setUTCHours(0, 0, 0, 0)
    } else if (!dayMatches(cron, d)) {
      d.setUTCDate(d.getUTCDate() + 1)
      d.setUTCHours(0, 0, 0, 0)
    } else if (!cron.hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0)
    } else if (!cron.minutes.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0)
    } else {
      return d.getTime()
    }
  }
  return null
}

/** The first time strictly after `after` that the expression fires in the zone, or null if it never does. */
export function nextCronFire(cron: CronExpression, after: Date, timeZone = DEFAULT_TIMEZONE): Date | null {
  const afterMs = after.getTime()
  // Start at the next whole wall-clock minute.
  let candidate = Math.floor(toWall(afterMs, timeZone) / MINUTE) * MINUTE + MINUTE
  for (;;) {
    const wall = nextMatchingWall(cron, candidate)
    if (wall === null) return null
    const instant = wallToInstant(wall, timeZone)
    // Times inside a forward gap all map to its end; times in a repeated hour map to their first occurrence.
    // Either can land at or before `after`, which means this wall-clock time has fired already.
    if (instant > afterMs) return new Date(instant)
    candidate = wall + MINUTE
  }
}

/** The next fire times after `after`, for previews. */
export function upcomingCronFires(
  cron: CronExpression,
  after: Date,
  count: number,
  timeZone = DEFAULT_TIMEZONE,
): Date[] {
  const fires: Date[] = []
  let from = after
  while (fires.length < count) {
    const next = nextCronFire(cron, from, timeZone)
    if (!next) break
    fires.push(next)
    from = next
  }
  return fires
}

/**
 * The next fire of an interval schedule after `after`, keeping to the grid of `previous + n × interval`. After
 * downtime this skips the missed fires (the scheduler catches up with a single run).
 */
export function nextIntervalFire(previous: Date, intervalMs: number, after: Date): Date {
  const steps = Math.floor((after.getTime() - previous.getTime()) / intervalMs) + 1
  return new Date(previous.getTime() + steps * intervalMs)
}
