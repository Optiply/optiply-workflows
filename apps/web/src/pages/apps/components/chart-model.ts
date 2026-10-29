/**
 * The Chart component's data, apart from Chart.js: which key is the x axis, which are the series, their values as
 * numbers, and their colors. Colors come from the palette passed in (Optiply's tokens, see chart.tsx): assigned in a
 * fixed order by series position, never cycled; past eight series the rest aren't drawn (and the chart says so).
 */

export type ChartKind = 'bar' | 'line' | 'area' | 'pie'

/** Colors for a chart: its series slots in order, the pie's "Other", and text, grid and axis colors. */
export interface ChartPalette {
  series: readonly string[]
  other: string
  ink: { surface: string; text: string; secondary: string; muted: string; grid: string; axis: string }
}

/** How many series a chart draws (the palette's categorical slots). */
export const SERIES_SLOTS = 8

export interface ChartSeries {
  key: string
  label: string
  color: string
  values: (number | null)[]
}

/** A time axis (M24): each row's time, where the ticks go and what they say. */
export interface ChartTime {
  /** Each row's time in milliseconds, in the order of `labels` (rows sorted by time). */
  values: number[]
  min: number
  max: number
  ticks: number[]
  unit: TimeUnit
  /** Dates without a time: shown in UTC, so a day stays that day wherever the viewer is. */
  utc: boolean
}

export type TimeUnit = 'day' | 'week' | 'month' | 'year'

export interface ChartModel {
  kind: ChartKind
  xKey: string | null
  labels: string[]
  /** The x axis as time (M24): line and area charts of dates or datetimes. */
  time: ChartTime | null
  series: ChartSeries[]
  /** Series left out past the palette (or, for a pie, every series after the first). */
  omitted: string[]
  /** Pie slices folded into "Other". */
  folded: number
  /** The colors it was made with. */
  palette: ChartPalette
}

type Row = Record<string, unknown>

/** A number, or a numeric string (Postgres sends bigint and numeric as strings); anything else is null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function keysOf(rows: Row[]): string[] {
  return [
    ...new Set(
      rows
        .slice(0, 50)
        .flatMap((r) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : [])),
    ),
  ]
}

function isNumericKey(rows: Row[], key: string): boolean {
  let seen = false
  for (const row of rows.slice(0, 50)) {
    const v = row?.[key]
    if (v === null || v === undefined || v === '') continue
    if (toNumber(v) === null) return false
    seen = true
  }
  return seen
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/** A row's x value as a time: ISO dates and datetimes (and Date objects); null for anything else. */
export function toTime(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (DATE_ONLY.test(text)) return Date.parse(`${text}T00:00:00Z`)
  if (!DATE_TIME.test(text)) return null
  const t = Date.parse(text.replace(' ', 'T'))
  return Number.isNaN(t) ? null : t
}

const DAY = 86_400_000

/** Where a time axis's ticks go: whole days, Mondays, firsts of the month or of the year, by the span (M24). */
export function timeTicks(min: number, max: number, utc: boolean): { unit: TimeUnit; ticks: number[] } {
  const span = max - min
  const unit: TimeUnit =
    span <= 14 * DAY ? 'day' : span <= 120 * DAY ? 'week' : span <= 3 * 365 * DAY ? 'month' : 'year'
  const at = new Date(min)
  const get = (part: 'FullYear' | 'Month' | 'Date' | 'Day') =>
    (at[`get${utc ? 'UTC' : ''}${part}`] as () => number).call(at)
  const set = (y: number, m: number, d: number) => {
    const t = utc ? Date.UTC(y, m, d) : new Date(y, m, d).getTime()
    at.setTime(t)
  }
  // The first boundary at or after the start.
  set(
    get('FullYear'),
    unit === 'year' ? 0 : get('Month'),
    unit === 'year' || unit === 'month' ? 1 : get('Date'),
  )
  if (unit === 'week') set(get('FullYear'), get('Month'), get('Date') + ((8 - get('Day')) % 7))
  while (at.getTime() < min) {
    if (unit === 'year') set(get('FullYear') + 1, 0, 1)
    else if (unit === 'month') set(get('FullYear'), get('Month') + 1, 1)
    else set(get('FullYear'), get('Month'), get('Date') + (unit === 'week' ? 7 : 1))
  }
  const ticks: number[] = []
  while (at.getTime() <= max && ticks.length < 400) {
    ticks.push(at.getTime())
    if (unit === 'year') set(get('FullYear') + 1, 0, 1)
    else if (unit === 'month') set(get('FullYear'), get('Month') + 1, 1)
    else set(get('FullYear'), get('Month'), get('Date') + (unit === 'week' ? 7 : 1))
  }
  return { unit, ticks }
}

/** A tick's or a point's label, in the viewer's language: "Jan 5", "Jan 2026", "2026"; with the time for datetimes. */
export function formatTime(ms: number, unit: TimeUnit | 'point', utc: boolean): string {
  const zone = utc ? { timeZone: 'UTC' } : {}
  const options: Intl.DateTimeFormatOptions =
    unit === 'year'
      ? { year: 'numeric' }
      : unit === 'month'
        ? { month: 'short', year: 'numeric' }
        : unit === 'point' && !utc
          ? { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }
          : unit === 'point'
            ? { month: 'short', day: 'numeric', year: 'numeric' }
            : { month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(undefined, { ...options, ...zone }).format(ms)
}

export function chartModel(input: {
  kind: unknown
  data: unknown
  xKey: unknown
  series: unknown
  palette: ChartPalette
  /** `auto` (time for line and area charts of dates), `category` or `time` (M24). */
  xAxis?: unknown
}): ChartModel {
  const { palette } = input
  const kind: ChartKind =
    input.kind === 'line' || input.kind === 'area' || input.kind === 'pie' ? input.kind : 'bar'
  let rows = (Array.isArray(input.data) ? input.data : []).filter(
    (r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r),
  )
  const keys = keysOf(rows)
  const xKey =
    typeof input.xKey === 'string' && input.xKey
      ? input.xKey
      : (keys.find((k) => !isNumericKey(rows, k)) ?? keys[0] ?? null)
  const wanted = Array.isArray(input.series)
    ? input.series.filter((s): s is string => typeof s === 'string' && s !== '')
    : []
  const seriesKeys = wanted.length ? wanted : keys.filter((k) => k !== xKey && isNumericKey(rows, k))
  // A time axis: every x value a date or datetime, the rows in time order (one without a time can't be placed).
  let time: ChartTime | null = null
  const lineLike = kind === 'line' || kind === 'area'
  if (lineLike && xKey !== null && input.xAxis !== 'category') {
    const raw = rows.map((r) => r[xKey])
    const times = raw.map(toTime)
    const usable = times.filter((t): t is number => t !== null)
    if (usable.length && (input.xAxis === 'time' || usable.length === times.length)) {
      const order = rows
        .map((_, i) => i)
        .filter((i) => times[i] !== null)
        .sort((a, b) => times[a]! - times[b]!)
      rows = order.map((i) => rows[i]!)
      const values = order.map((i) => times[i]!)
      const utc = raw.every((v) => typeof v !== 'string' || DATE_ONLY.test(v.trim()))
      const min = values[0]!
      const max = values.at(-1)!
      time = { values, min, max, utc, ...timeTicks(min, max, utc) }
    }
  }
  const limit = kind === 'pie' ? 1 : SERIES_SLOTS
  const drawn = seriesKeys.slice(0, limit)
  const omitted = seriesKeys.slice(limit)
  let labels = time
    ? time.values.map((t) => formatTime(t, 'point', time!.utc))
    : rows.map((r) => (xKey === null ? '' : String(r[xKey] ?? '')))
  let series: ChartSeries[] = drawn.map((key, i) => ({
    key,
    label: key,
    color: palette.series[i]!,
    values: rows.map((r) => toNumber(r[key])),
  }))

  let folded = 0
  if (kind === 'pie' && series[0]) {
    // A slice per row: seven keep their own color, the rest become one "Other".
    const values = series[0].values
    if (values.length > SERIES_SLOTS) {
      folded = values.length - (SERIES_SLOTS - 1)
      const other = values.slice(SERIES_SLOTS - 1).reduce<number>((sum, v) => sum + (v ?? 0), 0)
      labels = [...labels.slice(0, SERIES_SLOTS - 1), 'Other']
      series = [{ ...series[0], values: [...values.slice(0, SERIES_SLOTS - 1), other] }]
    }
  }
  return { kind, xKey, labels, time, series, omitted, folded, palette }
}

/** The color of each pie slice. */
export function sliceColors(count: number, folded: number, palette: ChartPalette): string[] {
  return Array.from({ length: count }, (_, i) =>
    folded && i === count - 1 ? palette.other : palette.series[i]!,
  )
}

/** Axis ticks: clean and compact from a thousand up (1K, 2.5M). */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/** A hex color at an opacity, for area washes. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
