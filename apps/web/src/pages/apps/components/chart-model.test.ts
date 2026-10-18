import { describe, expect, it } from 'vitest'
import {
  chartModel,
  chartPalette,
  compactNumber,
  OTHER_COLOR,
  SERIES_COLORS,
  SERIES_COLORS_DARK,
  sliceColors,
  toNumber,
  withAlpha,
} from './chart-model'

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

  it('colors series with the dark palette in dark mode, the same slots', () => {
    const m = chartModel({ kind: 'bar', data: sales, xKey: '', series: [], theme: 'dark' })
    expect(m.theme).toBe('dark')
    expect(m.series.map((s) => s.color)).toEqual([SERIES_COLORS_DARK[0], SERIES_COLORS_DARK[1]])
    expect(SERIES_COLORS_DARK).toHaveLength(SERIES_COLORS.length)
    expect(sliceColors(8, 3, 'dark').at(-1)).toBe(chartPalette('dark').other)
    expect(chartPalette('dark').ink.surface).not.toBe(chartPalette('light').ink.surface)
  })

  it('makes a pie of one series, folding slices past the seventh into Other', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, n: i + 1 }))
    const m = chartModel({ kind: 'pie', data: rows, xKey: 'name', series: ['n', 'other'] })
    expect(m.omitted).toEqual(['other'])
    expect(m.labels).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'Other'])
    expect(m.series[0]!.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8 + 9 + 10])
    expect(m.folded).toBe(3)
    expect(sliceColors(8, 3).at(-1)).toBe(OTHER_COLOR)
  })

  it('copes with no data, and with values that aren’t numbers', () => {
    expect(chartModel({ kind: 'nope', data: 'x', xKey: null, series: null })).toEqual({
      kind: 'bar',
      xKey: null,
      labels: [],
      series: [],
      omitted: [],
      folded: 0,
      theme: 'light',
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
