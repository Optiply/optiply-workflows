/**
 * The Chart component's data, apart from Chart.js: which key is the x axis, which are the series, their values as
 * numbers, and their colors. Colors are Optiply's (the base of each of its scales, light and dark, see styles.css):
 * assigned in a fixed order by series position, never cycled; past eight series the rest aren't drawn (and the
 * chart says so).
 */

export type ChartKind = 'bar' | 'line' | 'area' | 'pie'
export type ChartTheme = 'light' | 'dark'

/** Categorical slots, in order: Optiply's blue, orange, green, purple, logo blue, red, yellow and navy. */
export const SERIES_COLORS = [
  '#1860c4',
  '#e05f06',
  '#067d5e',
  '#5652cb',
  '#009ee3',
  '#c62525',
  '#ab8327',
  '#0c3369',
]
/** The same slots in dark mode (Optiply's lighter dark-mode bases). */
export const SERIES_COLORS_DARK = [
  '#75b0ff',
  '#fe9853',
  '#30cd84',
  '#a7a5ef',
  '#49b9ee',
  '#fe7777',
  '#ffd26b',
  '#bdd3f4',
]
/** Pie slices past the seventh fold into this. */
export const OTHER_COLOR = '#98a6b7'
const OTHER_COLOR_DARK = '#717e8e'

/** Text, grid and axis colors: Optiply's ink and shades. */
export const CHART_INK = {
  surface: '#ffffff',
  text: '#222b36',
  secondary: '#50657f',
  muted: '#50657f',
  grid: '#e6ecf4',
  axis: '#ccd8eb',
}
const CHART_INK_DARK: typeof CHART_INK = {
  surface: '#212736',
  text: '#ebebeb',
  secondary: '#9fb0c3',
  muted: '#9fb0c3',
  grid: '#2b323f',
  axis: '#303546',
}

/** A theme's series colors, "Other" color and ink. */
export function chartPalette(theme: ChartTheme = 'light') {
  return theme === 'dark'
    ? { series: SERIES_COLORS_DARK, other: OTHER_COLOR_DARK, ink: CHART_INK_DARK }
    : { series: SERIES_COLORS, other: OTHER_COLOR, ink: CHART_INK }
}

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
  /** The theme the colors are for. */
  theme: ChartTheme
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
  theme?: ChartTheme
}): ChartModel {
  const theme = input.theme ?? 'light'
  const palette = chartPalette(theme).series
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
  const limit = kind === 'pie' ? 1 : SERIES_COLORS.length
  const drawn = seriesKeys.slice(0, limit)
  const omitted = seriesKeys.slice(limit)
  let labels = rows.map((r) => (xKey === null ? '' : String(r[xKey] ?? '')))
  let series: ChartSeries[] = drawn.map((key, i) => ({
    key,
    label: key,
    color: palette[i]!,
    values: rows.map((r) => toNumber(r[key])),
  }))

  let folded = 0
  if (kind === 'pie' && series[0]) {
    // A slice per row: seven keep their own color, the rest become one "Other".
    const values = series[0].values
    if (values.length > SERIES_COLORS.length) {
      folded = values.length - (SERIES_COLORS.length - 1)
      const other = values.slice(SERIES_COLORS.length - 1).reduce<number>((sum, v) => sum + (v ?? 0), 0)
      labels = [...labels.slice(0, SERIES_COLORS.length - 1), 'Other']
      series = [{ ...series[0], values: [...values.slice(0, SERIES_COLORS.length - 1), other] }]
    }
  }
  return { kind, xKey, labels, series, omitted, folded, theme }
}

/** The color of each pie slice. */
export function sliceColors(count: number, folded: number, theme: ChartTheme = 'light'): string[] {
  const palette = chartPalette(theme)
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
