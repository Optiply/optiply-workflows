import { describe, expect, it } from 'vitest'
import { freeIdentifierRefs, freeIdentifiers, stringArgCalls, TemplateError } from '../src'

describe('freeIdentifiers (expressions)', () => {
  it.each([
    ['query1.data[0].name', ['query1']],
    ['a + b * a', ['a', 'b']],
    ['obj[key].prop', ['obj', 'key']],
    ['{ total: sum, [dyn]: 1, shorthand }', ['sum', 'dyn', 'shorthand']],
    ['rows.map(r => r.id + offset)', ['rows', 'offset']],
    ['rows.map(({ id, meta: { tag } }) => id + tag)', ['rows']],
    ['rows.map(function f(x) { return f(x) + arguments.length })', ['rows']],
    ['(x = def) => x', ['def']],
    ['`${greeting}, ${user.name}`', ['greeting', 'user']],
    ['typeof maybe === "undefined"', ['maybe']],
    ['_.sumBy(items, "qty") > dayjs().unix()', ['_', 'items', 'dayjs']],
    ['new Date(ts).toISOString()', ['Date', 'ts']],
    ['this.x', []],
    ['class { m() { return y } }', ['y']],
    ['a?.b ?? c', ['a', 'c']],
  ])('%s', (code, names) => {
    expect(freeIdentifiers(code)).toEqual(names)
  })

  it('marks references that are shorthand properties', () => {
    expect(freeIdentifierRefs('{ a, b: a, c }')).toEqual([
      { name: 'a', start: 2, end: 3, shorthand: true },
      { name: 'a', start: 8, end: 9 },
      { name: 'c', start: 11, end: 12, shorthand: true },
    ])
    expect(freeIdentifierRefs('return { a }', 'function-body')).toEqual([
      { name: 'a', start: 9, end: 10, shorthand: true },
    ])
  })

  it('reports the property read off each reference when asked', () => {
    const refs = freeIdentifierRefs("a.b + a?.c + a['d'] + a[k] + f(a) + a.b.c", 'expression', {
      properties: true,
    })
    expect(refs.map((r) => [r.name, r.property])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['a', 'd'],
      ['a', undefined],
      ['k', undefined],
      ['f', undefined],
      ['a', undefined],
      ['a', 'b'],
    ])
    // Not asked: no properties, so existing callers see the same objects as before.
    expect(freeIdentifierRefs('a.b')).toEqual([{ name: 'a', start: 0, end: 1 }])
  })

  it('parses synchronous function bodies, where await is an error', () => {
    expect(freeIdentifiers('const t = rows.length; return t * k', 'sync-function-body')).toEqual([
      'rows',
      'k',
    ])
    expect(() => freeIdentifiers('return await q()', 'sync-function-body')).toThrow(TemplateError)
    expect(() => freeIdentifiers('}) || (() => {', 'sync-function-body')).toThrow(TemplateError)
  })

  it('reports each reference with offsets into the code', () => {
    const code = ' a + a.b '
    expect(freeIdentifierRefs(code)).toEqual([
      { name: 'a', start: 1, end: 2 },
      { name: 'a', start: 5, end: 6 },
    ])
    expect(code.slice(5, 6)).toBe('a')
  })

  it.each([
    ['a)(b', /single expression/],
    ['a), (b', /single expression/],
    ['a); evil(', /./],
    ['let x = 1', /Syntax error/],
    ['a +', /Syntax error/],
    ['await x', /Syntax error/],
  ])('rejects %j', (code, error) => {
    expect(() => freeIdentifiers(code)).toThrow(TemplateError)
    expect(() => freeIdentifiers(code)).toThrow(error)
  })

  it('keeps syntax error positions relative to the user code', () => {
    try {
      freeIdentifiers('a + ')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError)
      expect((e as TemplateError).message).not.toMatch(/\(\d+:\d+\)/)
      expect((e as TemplateError).start).toBeLessThanOrEqual(4)
    }
  })

  it('allows trailing comments', () => {
    expect(freeIdentifiers('a // note')).toEqual(['a'])
  })
})

describe('freeIdentifiers (function bodies)', () => {
  it('excludes everything the body declares, wherever it is declared', () => {
    const body = `
      const rows = await query1.trigger()
      let total = 0
      for (const r of rows) total += r.qty * rate
      try { risky() } catch (err) { log(err) }
      function helper(n) { return n * hoisted }
      var hoisted = 2
      class Box { constructor(v) { this.v = v } }
      return { total, h: helper(1), box: new Box(other) }
    `
    expect(freeIdentifiers(body, 'function-body')).toEqual(['query1', 'rate', 'risky', 'log', 'other'])
  })

  it('treats a used-before-declared let as declared (TDZ is a runtime error, not a free reference)', () => {
    expect(freeIdentifiers('x; let x = 1; return x', 'function-body')).toEqual([])
  })

  it.each([
    '}) || evil(() => {',
    '}), (async () => {',
    '}); (async () => {',
    '})(); stolen(); (async () => {',
  ])('rejects code that breaks out of the wrapper: %j', (code) => {
    expect(() => freeIdentifiers(code, 'function-body')).toThrow(TemplateError)
  })

  it('reports offsets relative to the body', () => {
    const body = 'return foo'
    const [ref] = freeIdentifierRefs(body, 'function-body')
    expect(body.slice(ref!.start, ref!.end)).toBe('foo')
  })
})

describe('stringArgCalls (M24)', () => {
  it('finds object.method calls with a string literal first, where the literal is', () => {
    const code = `await c1.setView('details'); c1?.setView("list", 1); other.setView('x'); c1.setView(next); c1['setView']('y')`
    const calls = stringArgCalls(code, 'function-body', 'c1', 'setView')
    expect(calls.map((c) => [c.value, code.slice(c.start, c.end)])).toEqual([
      ['details', "'details'"],
      ['list', '"list"'],
    ])
    expect(stringArgCalls("utils.openPage('orders', { id: 1 })", 'expression', 'utils', 'openPage')).toEqual([
      { value: 'orders', start: 15, end: 23 },
    ])
  })

  it('finds nothing in code that doesn’t parse', () => {
    expect(stringArgCalls("c1.setView('a'", 'expression', 'c1', 'setView')).toEqual([])
  })
})
