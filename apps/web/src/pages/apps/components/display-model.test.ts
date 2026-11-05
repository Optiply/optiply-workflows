import { describe, expect, it } from 'vitest'
import { formatStatistic, imageSourceProblem } from './display-model'

describe('the statistic', () => {
  it('formats numbers, currencies and percentages, and shows anything else as text', () => {
    const nf = (n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat(undefined, o).format(n)
    expect(formatStatistic(1234.5, 'number')).toBe(nf(1234.5))
    expect(formatStatistic('1234.5', 'number', { decimals: 0 })).toBe(
      nf(1234.5, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
    )
    expect(formatStatistic(9.5, 'currency', { currency: 'USD' })).toBe(
      nf(9.5, { style: 'currency', currency: 'USD' }),
    )
    expect(formatStatistic(0.25, 'percent')).toBe(nf(0.25, { style: 'percent' }))
    // An unknown currency code falls back to a number.
    expect(formatStatistic(3, 'currency', { currency: 'NOPE!' })).toBe(nf(3))
    expect(formatStatistic('n/a', 'number')).toBe('n/a')
    expect(formatStatistic(null, 'number')).toBe('—')
    expect(formatStatistic(42, 'plain')).toBe('42')
  })
})

describe('the image', () => {
  const origin = 'https://ow.example'
  it('shows a typed address anywhere, a computed one only as data:image or on this site', () => {
    expect(imageSourceProblem('https://cdn.example/logo.png', false, origin)).toBeNull()
    expect(imageSourceProblem('https://leak.example/p.gif?d=secret', true, origin)).toMatch(/computed source/)
    expect(imageSourceProblem('/api/files/logo.png', true, origin)).toBeNull()
    expect(imageSourceProblem('data:image/png;base64,AAAA', true, origin)).toBeNull()
    expect(imageSourceProblem('javascript:alert(1)', false, origin)).toMatch(/Only http/)
    expect(imageSourceProblem('', false, origin)).toBe('No image source')
  })
})
