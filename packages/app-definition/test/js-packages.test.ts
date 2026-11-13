/** An app's JavaScript packages: `javascript.packages`. */
import { describe, expect, it } from 'vitest'
import { appDefinitionSchema, canonicalizeApp, functionRunner, validateApp } from '../src'
import { app } from './helpers'

const problems = (def: unknown) =>
  validateApp(def)
    .diagnostics.filter((d) => d.code === 'invalid_js_package')
    .map(({ path, message }) => ({ path, message }))

describe('app JavaScript packages', () => {
  it('takes npm packages, and says what is wrong with each', () => {
    expect(validateApp(app({ javascript: { packages: ['zod@^3', 'date-fns'] } })).ok).toBe(true)
    expect(problems(app({ javascript: { packages: ['zod', 'https://x/y.tgz', 'zod@1'] } }))).toEqual([
      {
        path: ['javascript', 'packages', 1],
        message: 'Only packages from the npm registries: no URLs, git, paths or aliases',
      },
      { path: ['javascript', 'packages', 2], message: '"zod" is already on line 1' },
    ])
  })

  it('is optional, and never on a module', () => {
    expect(appDefinitionSchema.parse(app()).javascript).toBeUndefined()
    expect(
      problems(app({ module: { inputs: [], outputs: [], events: [] }, javascript: { packages: ['zod'] } })),
    ).toEqual([
      { path: ['javascript'], message: "A module has no packages of its own: its code uses the app's" },
    ])
  })

  it('survives canonical form', () => {
    expect(canonicalizeApp(app({ javascript: { packages: ['zod'] } })).javascript).toEqual({
      packages: ['zod'],
    })
  })
})

describe('import lines in app code', () => {
  const jsQuery = (name: string, code: string) => ({ name, kind: 'js' as const, code })
  const imports = (def: unknown) =>
    validateApp(def)
      .diagnostics.filter((d) => d.code === 'unknown_js_import' || d.code === 'unknown_identifier')
      .map(({ code, message }) => ({ code, message }))

  it('names the app’s packages, in JS queries and transformers', () => {
    const ok = app({
      javascript: { packages: ['tiny-format@^1'] },
      queries: [jsQuery('q1', "import fmt from 'tiny-format'\nreturn fmt(1)")],
      transformers: [{ name: 't1', code: "import { a } from 'tiny-format'\nreturn a" }],
    })
    expect(imports(ok)).toEqual([])
  })

  it('says when one isn’t listed', () => {
    const def = app({ queries: [jsQuery('q1', "import fmt from 'tiny-format'\nreturn fmt(1)")] })
    expect(imports(def)).toEqual([
      {
        code: 'unknown_js_import',
        message: 'The package "tiny-format" isn\'t one of the app\'s JavaScript packages',
      },
    ])
  })

  it('leaves a module’s imports to the app it is placed in', () => {
    const def = app({
      module: { inputs: [], outputs: [], events: [] },
      queries: [jsQuery('q1', "import fmt from 'tiny-format'\nreturn fmt(1)")],
    })
    expect(imports(def)).toEqual([])
  })

  it('runs: the runner rewrites import lines to read __owImport', async () => {
    const g = globalThis as { __owImport?: (name: string) => unknown }
    g.__owImport = (name) => ({ default: (n: number) => `${name}:${n}` })
    try {
      const run = functionRunner()
      expect(await run('function-body', "import fmt from 'x'\nreturn fmt(2)", {})).toBe('x:2')
      expect(run('sync-function-body', "import fmt from 'y'\nreturn fmt(3)", {})).toBe('y:3')
      expect(run('expression', '1 + 1', {})).toBe(2)
    } finally {
      delete g.__owImport
    }
  })
})
