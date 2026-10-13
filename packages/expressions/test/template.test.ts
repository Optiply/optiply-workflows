import { describe, expect, it } from 'vitest'
import { parseTemplate, singleExpression, TemplateError } from '../src'

const exprs = (src: string) => parseTemplate(src).flatMap((p) => (p.type === 'expression' ? [p.code] : []))

describe('parseTemplate', () => {
  it('splits text and expressions with source offsets', () => {
    expect(parseTemplate('Hi {{ user.name }}!')).toEqual([
      { type: 'text', value: 'Hi ', start: 0, end: 3 },
      { type: 'expression', code: ' user.name ', start: 3, end: 18 },
      { type: 'text', value: '!', start: 18, end: 19 },
    ])
    expect(parseTemplate('plain')).toEqual([{ type: 'text', value: 'plain', start: 0, end: 5 }])
    expect(parseTemplate('')).toEqual([])
    expect(exprs('{{a}}{{b}}')).toEqual(['a', 'b'])
  })

  it.each([
    ['{{ {a: {b: 1}} }}', ' {a: {b: 1}} '],
    ['{{ {a: 1}}}', ' {a: 1}'],
    ['{{ "}}" }}', ' "}}" '],
    ["{{ '}}' + `}}` }}", " '}}' + `}}` "],
    ['{{ `${ {x: 1}.x }}}` }}', ' `${ {x: 1}.x }}}` '],
    ['{{ `a ${ `b ${c}` } d` }}', ' `a ${ `b ${c}` } d` '],
    ['{{ a /* }} */ }}', ' a /* }} */ '],
    ['{{ "\\"}}" }}', ' "\\"}}" '],
    ['{{ x.map(i => ({ id: i })) }}', ' x.map(i => ({ id: i })) '],
  ])('finds the right closing braces in %s', (src, code) => {
    expect(exprs(src)).toEqual([code])
  })

  it('reports unterminated and empty expressions with positions', () => {
    expect(() => parseTemplate('a {{ b')).toThrow(TemplateError)
    try {
      parseTemplate('a {{ b')
    } catch (e) {
      expect(e).toMatchObject({ start: 2, end: 6, message: expect.stringMatching(/Unterminated/) })
    }
    expect(() => parseTemplate('{{   }}')).toThrow(/Empty/)
    expect(() => parseTemplate('{{ {a: 1} ')).toThrow(/Unterminated/)
  })
})

describe('singleExpression', () => {
  it('returns the code only for a lone expression', () => {
    expect(singleExpression(parseTemplate('{{ x }}'))).toBe(' x ')
    expect(singleExpression(parseTemplate('  {{ x }}\n'))).toBe(' x ')
    expect(singleExpression(parseTemplate('id: {{ x }}'))).toBeNull()
    expect(singleExpression(parseTemplate('{{ a }}{{ b }}'))).toBeNull()
    expect(singleExpression(parseTemplate('text'))).toBeNull()
  })
})
