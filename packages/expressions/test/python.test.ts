import { describe, expect, it } from 'vitest'
import { analyzePython } from '../src/python'

/** Lines of Python. */
const py = (...lines: string[]) => lines.join('\n')
/** The names a block's Python reads from outside itself, in order, without repeats. */
const refs = (code: string) => [...new Set(analyzePython(code).refs.map((r) => r.name))]

describe('analyzePython', () => {
  it('finds the blocks and globals code reads', () => {
    expect(
      refs(py('rows = query1.data', 'return [r["id"] for r in rows if r["amount"] > configVars.min]')),
    ).toEqual(['query1', 'configVars'])
  })

  it('gives offsets into the code, and properties when asked', () => {
    const code = 'total = query1.data + q2["data"] + q3[k]'
    const { refs: found } = analyzePython(code, { properties: true })
    expect(found).toEqual([
      { name: 'query1', start: 8, end: 14, property: 'data' },
      { name: 'q2', start: 22, end: 24, property: 'data' },
      { name: 'q3', start: 35, end: 37 },
      { name: 'k', start: 38, end: 39 },
    ])
  })

  it('skips attributes, keyword arguments, strings, comments and keywords', () => {
    expect(
      refs(
        py(
          '# query1 in a comment',
          's = "query1 in a string" + \'query2\' + """query3',
          'still query3"""',
          'df = pd.DataFrame(data=rows.data, columns=cols)',
          'x = obj.query4.query5',
          'if x is None and not y: pass',
        ),
      ),
    ).toEqual(['pd', 'rows', 'cols', 'obj', 'y'])
  })

  it('reads the code inside f-string fields, and only there', () => {
    expect(refs('return f"{query1.data[0]} of {total!r:>{width}} {{literal}} {name=}"')).toEqual([
      'query1',
      'total',
      'width',
      'name',
    ])
    // Python 3.12: the same quotes inside a field, and nested f-strings.
    expect(refs('return f"{d["key"]} {f\'{inner}\'}" + rf"{raw}\\d" + b"{notcode}"')).toEqual([
      'd',
      'inner',
      'raw',
    ])
    const code = 'x = f"a {query1} b"'
    const ref = analyzePython(code).refs[0]!
    expect(code.slice(ref.start, ref.end)).toBe('query1')
  })

  it('treats what the code binds as its own: assignments, loops, with/except/import as, def, class, :=', () => {
    const code = py(
      'import json, os.path',
      'import numpy as np',
      'from datetime import date, timedelta as td',
      'a = 1',
      'b, (c, d) = 2, (3, 4)',
      'e = f = 5',
      'g += 1',
      'h: int = 6',
      'for i, (j, k) in pairs:',
      '    pass',
      'with open(p) as fh:',
      '    pass',
      'try:',
      '    pass',
      'except ValueError as err:',
      '    pass',
      'def helper(m, n=default, *rest, o: int = 1, **kw):',
      '    return m',
      'class Thing(Base):',
      '    pass',
      'if (q := compute()):',
      '    pass',
      'squares = [s * s for s in values]',
      'fn = lambda u, v=fallback: u + v',
      'return [json, os, np, date, td, a, b, c, d, e, f, g, h, i, j, k, fh, err, helper, Thing, q, squares, fn, x.y]',
    )
    const { bound } = analyzePython(code)
    for (const name of 'json os np date td a b c d e f g h i j k fh err helper m n rest o kw Thing q squares s fn u v'.split(
      ' ',
    )) {
      expect(bound, name).toContain(name)
    }
    expect(refs(code)).toEqual(['pairs', 'p', 'default', 'Base', 'compute', 'values', 'fallback', 'x'])
  })

  it("reads a name it deletes an item or attribute of (del a[0] doesn't bind a)", () => {
    expect(
      refs(py('del query1.data[0]', 'del cache.entry', 'del gone', 'return query1.data, cache')),
    ).toEqual(['query1', 'cache'])
  })

  it('says where each bound name is first bound', () => {
    const code = 'value = value * 2\nrows = 1\nrows = 2'
    expect(analyzePython(code).bindings).toEqual([
      { name: 'value', start: 0, end: 5 },
      { name: 'rows', start: 18, end: 22 },
    ])
  })

  it('keeps names declared global or nonlocal as references', () => {
    expect(refs(py('global counter, total', 'counter = counter + 1'))).toEqual(['counter', 'total'])
  })

  it("doesn't take subscript or attribute targets for bindings", () => {
    expect(
      refs(py('rows[0] = 1', 'obj.attr = 2', 'cache["k"], other = 3, 4', 'return rows, obj, cache')),
    ).toEqual(['rows', 'obj', 'cache'])
  })

  it('handles statements after a header on the same line, and lambdas in headers', () => {
    expect(refs(py('if ready: x = query1', 'else: y = query2', 'return x, y'))).toEqual([
      'ready',
      'query1',
      'query2',
    ])
    expect(refs(py('key = lambda r: r.amount', 'return sorted(rows.data, key=key)'))).toEqual(['rows'])
  })

  it('reports builtins apart', () => {
    const { refs: found, builtins } = analyzePython(
      'return len(rows.data) + sum(x for x in nums) + max(1, 2)',
    )
    expect(found.map((r) => r.name)).toEqual(['rows', 'nums'])
    expect(builtins.map((r) => r.name)).toEqual(['len', 'sum', 'max'])
  })

  it('keeps keyword arguments apart in calls spanning lines', () => {
    expect(refs(py('df = pd.read_csv(', '    source,', '    sep=";",', '    names=columns,', ')'))).toEqual([
      'pd',
      'source',
      'columns',
    ])
  })

  it("doesn't read numbers, decorators' attributes or import paths as names", () => {
    expect(
      refs(
        py(
          'from collections.abc import Mapping',
          'x = 1e5 + 0x1F + 1_000 + 3j + .5',
          '@functools.cache',
          'def f(): pass',
          'return x, Mapping',
        ),
      ),
    ).toEqual(['functools'])
  })

  it('never throws on code being typed', () => {
    for (const code of [
      'return f"{',
      'x = (',
      'return """unterminated',
      'def f(',
      ')]}',
      'x = "a',
      'f"{a!',
      'lambda',
    ]) {
      expect(() => analyzePython(code)).not.toThrow()
    }
    expect(refs('x = query1.data[')).toEqual(['query1'])
  })
})
