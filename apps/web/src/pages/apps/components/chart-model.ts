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

export interface ChartModel {
  kind: ChartKind
  xKey: string | null
  labels: string[]
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

export function chartModel(input: {
  kind: unknown
  data: unknown
  xKey: unknown
  series: unknown
  palette: ChartPalette
}): ChartModel {
  const { palette } = input
  const kind: ChartKind =
    input.kind === 'line' || input.kind === 'area' || input.kind === 'pie' ? input.kind : 'bar'
  const rows = (Array.isArray(input.data) ? input.data : []).filter(
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
  const limit = kind === 'pie' ? 1 : SERIES_SLOTS
  const drawn = seriesKeys.slice(0, limit)
  const omitted = seriesKeys.slice(limit)
  let labels = rows.map((r) => (xKey === null ? '' : String(r[xKey] ?? '')))
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
  return { kind, xKey, labels, series, omitted, folded, palette }
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
