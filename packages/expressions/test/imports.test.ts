import { describe, expect, it } from 'vitest'
import {
  blankImports,
  freeIdentifierRefs,
  importedPackages,
  packageName,
  parseImports,
  rewriteImports,
  TemplateError,
} from '../src'

/** Import lines at the top of a JS code body (JavaScript packages). */

describe('import lines', () => {
  it('reads every form, with where each is', () => {
    const code = [
      "import _ from 'lodash'",
      'import { format, parseISO as parse } from "date-fns";',
      "import * as z from 'zod'",
      "import d, { a } from '@acme/utils/sub'",
      "import 'side-effect'",
      'return 1',
    ].join('\n')
    const imports = parseImports(code)
    expect(imports.map((i) => [i.source, i.bindings])).toEqual([
      ['lodash', [{ imported: 'default', local: '_' }]],
      [
        'date-fns',
        [
          { imported: 'format', local: 'format' },
          { imported: 'parseISO', local: 'parse' },
        ],
      ],
      ['zod', [{ imported: '*', local: 'z' }]],
      [
        '@acme/utils/sub',
        [
          { imported: 'default', local: 'd' },
          { imported: 'a', local: 'a' },
        ],
      ],
      ['side-effect', []],
    ])
    expect(code.slice(imports[0]!.start, imports[0]!.end)).toBe("import _ from 'lodash'")
    expect(code.slice(imports[1]!.start, imports[1]!.end)).toBe(
      'import { format, parseISO as parse } from "date-fns";',
    )
    expect(code.slice(imports[3]!.sourceStart, imports[3]!.sourceEnd)).toBe('@acme/utils/sub')
    expect(importedPackages(imports).map((p) => p.name)).toEqual([
      'lodash',
      'date-fns',
      'zod',
      '@acme/utils',
      'side-effect',
    ])
  })

  it('reads them after comments and blank lines, across lines, and with attributes', () => {
    const code =
      "// packages\n\n/* a */ import {\n  a,\n  b,\n} from 'x'\nimport data from 'y' with { type: 'json' }\nreturn a"
    const imports = parseImports(code)
    expect(imports.map((i) => i.source)).toEqual(['x', 'y'])
    expect(code.slice(imports[1]!.start, imports[1]!.end)).toBe("import data from 'y' with { type: 'json' }")
  })

  it('reads them after a directive; a with statement after them is not an attribute (review fixes)', () => {
    expect(parseImports("'use strict'\nimport x from 'x'\nreturn x").map((i) => i.source)).toEqual(['x'])
    const code = "import x from 'x'\nwith (obj) { y }"
    const [imp] = parseImports(code)
    expect(code.slice(imp!.start, imp!.end)).toBe("import x from 'x'")
    expect(rewriteImports(code).split('\n')[1]).toBe('with (obj) { y }')
    // The older `assert { … }`: the whole line, or a clear syntax error; never half of it left behind.
    const old = "import data from 'y' assert { type: 'json' }\nreturn data"
    let left: string | null = null
    try {
      left = rewriteImports(old).split('\n')[0]!
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError)
    }
    if (left !== null) expect(left).not.toContain('assert')
  })

  it('stops at the first other statement; import(…), import.meta and names starting with import are not lines', () => {
    expect(parseImports("const a = 1\nimport x from 'x'")).toEqual([])
    expect(parseImports("const m = await import('x')\nreturn m")).toEqual([])
    expect(parseImports('return import.meta')).toEqual([])
    expect(parseImports('importantThing = 1')).toEqual([])
    expect(parseImports('return 1')).toEqual([])
  })

  it('says where an import line is wrong', () => {
    const at = (code: string) => {
      try {
        parseImports(code)
        return null
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateError)
        return { message: (err as TemplateError).message, start: (err as TemplateError).start }
      }
    }
    expect(at("import { a from 'x'\nreturn a")).toMatchObject({ start: expect.any(Number) })
    expect(at('import x from y\nreturn x')?.message).toBeTruthy()
  })

  it('rewrites to consts on the same lines', () => {
    const code =
      "import _ from 'lodash'\nimport {\n  a,\n  b as c,\n} from 'x'\nimport * as ns from 'n'\nimport 'fx'\nreturn [_, a, c, ns]"
    const out = rewriteImports(code)
    expect(out.split('\n')).toEqual([
      'const __owImport0 = __owImport("lodash"), _ = __owImport0.default;',
      'const __owImport1 = __owImport("x"), { "a": a, "b": c } = __owImport1;',
      '',
      '',
      '',
      'const __owImport2 = __owImport("n"), ns = __owImport2;',
      '__owImport("fx");',
      'return [_, a, c, ns]',
    ])
    expect(rewriteImports('return 1')).toBe('return 1')
  })

  it('runs: the rewritten body reads the packages, errors keep their lines', async () => {
    const modules: Record<string, unknown> = { x: { a: 1, b: 2 }, lodash: { __esModule: true, default: 'L' } }
    const __owImport = (name: string) => {
      const m = modules[name] as Record<string, unknown>
      return m.__esModule ? m : { ...m, default: m }
    }
    const code = "import _ from 'lodash'\nimport { a, b as c } from 'x'\n\nreturn [_, a, c]"
    const run = new Function('__owImport', `return (async () => {\n${rewriteImports(code)}\n})()`)
    expect(await run(__owImport)).toEqual(['L', 1, 2])
    // `null.boom` on the body's third line, with or without an import line above it.
    const lineOf = async (body: string) => {
      const stack = await new Function('__owImport', `return (async () => {\n${rewriteImports(body)}\n})()`)(
        __owImport,
      ).catch((e: Error) => e.stack ?? '')
      return /<anonymous>:(\d+):/.exec(stack)?.[1]
    }
    expect(await lineOf("import { a } from 'x'\n\nnull.boom")).toBe(await lineOf('const a = 1\n\nnull.boom'))
    expect(await lineOf("import {\n  a,\n} from 'x'\nnull.boom")).toBe(await lineOf('\n\n\nnull.boom'))
  })

  it('blanks them for analysis: offsets stay, imported names are not free', () => {
    const code = "import { a } from 'x'\nreturn a + b"
    const imports = parseImports(code)
    expect(blankImports(code, imports)).toBe(`${' '.repeat(21)}\nreturn a + b`)
    const refs = freeIdentifierRefs(code, 'function-body')
    expect(refs.map((r) => r.name)).toEqual(['b'])
    expect(code.slice(refs[0]!.start, refs[0]!.end)).toBe('b')
    expect(
      freeIdentifierRefs("import _ from 'lodash'\nreturn _.map(x)", 'sync-function-body').map((r) => r.name),
    ).toEqual(['x'])
  })

  it('names packages', () => {
    expect(packageName('lodash/chunk')).toBe('lodash')
    expect(packageName('@acme/utils/x/y')).toBe('@acme/utils')
    expect(packageName('zod')).toBe('zod')
  })
})
