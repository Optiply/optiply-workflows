import { describe, expect, it } from 'vitest'
import {
  type ChartPalette,
  compactNumber,
  formatTime,
  chartModel as model,
  SERIES_SLOTS,
  sliceColors,
  timeTicks,
  toNumber,
  toTime,
  withAlpha,
} from './chart-model'

/** Distinct colors per slot, so tests see which slot each series got. */
const PALETTE: ChartPalette = {
  series: Array.from({ length: SERIES_SLOTS }, (_, i) => `#00000${i}`),
  other: '#999999',
  ink: { surface: '#fff', text: '#000', secondary: '#333', muted: '#666', grid: '#eee', axis: '#ccc' },
}
const SERIES_COLORS = PALETTE.series
const chartModel = (input: Omit<Parameters<typeof model>[0], 'palette'>) =>
  model({ ...input, palette: PALETTE })

const sales = [
  { month: 'Jan', revenue: '1200.50', orders: 30, region: 'NL' },
  { month: 'Feb', revenue: '980', orders: 25, region: 'BE' },
  { month: 'Mar', revenue: null, orders: 41, region: 'NL' },
]

describe('chart model', () => {
  it('picks the first non-numeric key as x and every numeric one as a series, numeric strings included', () => {
    const m = chartModel({ kind: 'bar', data: sales, xKey: '', series: [] })
    expect(m.xKey).toBe('month')
    expect(m.labels).toEqual(['Jan', 'Feb', 'Mar'])
    expect(m.series.map((s) => [s.key, s.color, s.values])).toEqual([
      ['revenue', SERIES_COLORS[0], [1200.5, 980, null]],
      ['orders', SERIES_COLORS[1], [30, 25, 41]],
    ])
  })

  it('keeps colors with series positions, and leaves out what the palette can’t color', () => {
    const wide = [{ x: 'a', ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, i])) }]
    const m = chartModel({ kind: 'line', data: wide, xKey: 'x', series: [] })
    expect(m.series).toHaveLength(8)
    expect(m.series[7]!.color).toBe(SERIES_COLORS[7])
    expect(m.omitted).toEqual(['s8', 's9'])
    const chosen = chartModel({ kind: 'line', data: sales, xKey: 'month', series: ['orders'] })
    expect(chosen.series.map((s) => [s.key, s.color])).toEqual([['orders', SERIES_COLORS[0]]])
  })

  it('colors series from the palette it is given', () => {
    const dark: ChartPalette = { ...PALETTE, series: PALETTE.series.map((c) => `${c}aa`) }
    const m = model({ kind: 'bar', data: sales, xKey: '', series: [], palette: dark })
    expect(m.palette).toBe(dark)
    expect(m.series.map((s) => s.color)).toEqual([dark.series[0], dark.series[1]])
  })

  it('makes a pie of one series, folding slices past the seventh into Other', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, n: i + 1 }))
    const m = chartModel({ kind: 'pie', data: rows, xKey: 'name', series: ['n', 'other'] })
    expect(m.omitted).toEqual(['other'])
    expect(m.labels).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'Other'])
    expect(m.series[0]!.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8 + 9 + 10])
    expect(m.folded).toBe(3)
    expect(sliceColors(8, 3, PALETTE).at(-1)).toBe(PALETTE.other)
  })

  it('copes with no data, and with values that aren’t numbers', () => {
    expect(chartModel({ kind: 'nope', data: 'x', xKey: null, series: null })).toEqual({
      kind: 'bar',
      xKey: null,
      labels: [],
      time: null,
      series: [],
      omitted: [],
      folded: 0,
      palette: PALETTE,
    })
    expect([toNumber('12'), toNumber('a'), toNumber(''), toNumber(Number.NaN), toNumber(true)]).toEqual([
      12,
      null,
      null,
      null,
      null,
    ])
    expect(compactNumber(2500)).toBe('2.5K')
    expect(withAlpha('#2a78d6', 0.1)).toBe('rgba(42, 120, 214, 0.1)')
  })
})

describe('the time axis (M24)', () => {
  const day = (d: number) => `2026-01-${String(d).padStart(2, '0')}`
  const rows = [5, 1, 2, 4, 9].map((d) => ({ day: day(d), orders: d * 10 }))

  it('reads ISO dates and datetimes, nothing else', () => {
    expect(toTime('2026-01-05')).toBe(Date.UTC(2026, 0, 5))
    expect(toTime('2026-01-05T10:30:00Z')).toBe(Date.UTC(2026, 0, 5, 10, 30))
    expect(toTime('2026-01-05 10:30:00+01:00')).toBe(Date.UTC(2026, 0, 5, 9, 30))
    for (const no of ['Jan 5', '5', 5, null, '2026-13-45x']) expect(toTime(no)).toBeNull()
  })

  it('places a line chart’s points by their dates, sorted, gaps kept as space', () => {
    const model = chartModel({ kind: 'line', data: rows, xKey: 'day', series: ['orders'] })
    expect(model.time?.values).toEqual([1, 2, 4, 5, 9].map((d) => Date.UTC(2026, 0, d)))
    expect(model.series[0]!.values).toEqual([10, 20, 40, 50, 90])
    expect(model.time?.utc).toBe(true)
    expect(model.time?.unit).toBe('day')
    expect(model.time?.ticks).toHaveLength(9)
    expect(model.labels[0]).toMatch(/Jan.*1.*2026|1.*Jan.*2026/)
  })

  it('stays a category axis for bars, for category, and when an x isn’t a date', () => {
    expect(chartModel({ kind: 'bar', data: rows, xKey: 'day', series: ['orders'] }).time).toBeNull()
    expect(
      chartModel({ kind: 'line', data: rows, xKey: 'day', series: ['orders'], xAxis: 'category' }).time,
    ).toBeNull()
    const mixed = [...rows, { day: 'later', orders: 1 }]
    expect(chartModel({ kind: 'line', data: mixed, xKey: 'day', series: ['orders'] }).time).toBeNull()
    // Forced, the rows without a date are left out.
    expect(
      chartModel({ kind: 'area', data: mixed, xKey: 'day', series: ['orders'], xAxis: 'time' }).time?.values,
    ).toHaveLength(5)
  })

  it('ticks on days, Mondays, firsts of the month or of the year, by the span', () => {
    const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d)
    expect(timeTicks(utc(2026, 0, 1), utc(2026, 0, 10), true)).toMatchObject({ unit: 'day' })
    const weeks = timeTicks(utc(2026, 0, 1), utc(2026, 2, 1), true)
    expect(weeks.unit).toBe('week')
    expect(weeks.ticks.every((t) => new Date(t).getUTCDay() === 1)).toBe(true)
    const months = timeTicks(utc(2025, 10, 15), utc(2026, 9, 1), true)
    expect(months.unit).toBe('month')
    expect(months.ticks.slice(0, 2)).toEqual([utc(2025, 11, 1), utc(2026, 0, 1)])
    expect(timeTicks(utc(2020, 5, 1), utc(2026, 0, 1), true).ticks[0]).toBe(utc(2021, 0, 1))
    expect(formatTime(utc(2026, 0, 1), 'year', true)).toBe('2026')
  })
})
