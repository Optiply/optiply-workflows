import { describe, expect, it } from 'vitest'
import { type AppDefinition, setCustomCss, setTheme, validateApp } from '../src'

const base: AppDefinition = { schemaVersion: 1, components: [], queries: [] }

describe('the app theme and custom CSS (session 41)', () => {
  it('are set, and removed when empty', () => {
    const themed = setTheme(base, { primary: '#7c3aed', radius: 4, text: undefined })
    expect(themed.theme).toEqual({ primary: '#7c3aed', radius: 4 })
    expect('theme' in setTheme(themed, {})).toBe(false)
    const styled = setCustomCss(base, '.x { color: red }')
    expect(styled.css).toBe('.x { color: red }')
    expect('css' in setCustomCss(styled, '  ')).toBe(false)
    expect(validateApp({ ...themed, css: '.x {}' }).diagnostics).toEqual([])
  })

  it('takes colours as #rrggbb only, and a radius up to 24 px', () => {
    const codes = (theme: unknown) => validateApp({ ...base, theme }).diagnostics.map((d) => d.code)
    expect(codes({ primary: 'red' })).toEqual(['schema'])
    expect(codes({ primary: '#abc' })).toEqual(['schema'])
    expect(codes({ radius: 40 })).toEqual(['schema'])
    expect(codes({ font: 'comic' })).toEqual(['schema'])
  })
})
