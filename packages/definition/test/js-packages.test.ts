/** A workflow's JavaScript packages in the definition: `settings.javascript.packages`. */
import { describe, expect, it } from 'vitest'
import {
  definitionHash,
  jsDependencies,
  MAX_JS_PACKAGES,
  parseJsPackage,
  splitJsPackage,
  validateDefinition,
  workflowDefinitionSchema,
} from '../src'
import { start, wf } from './helpers'

const code = { name: 'code1', type: 'code', config: { code: 'return 1' } }
const withPackages = (packages: string[]) =>
  wf([start, code], [['startTrigger', 'code1']], { settings: { javascript: { packages } } })
const problems = (packages: string[]) =>
  validateDefinition(withPackages(packages))
    .diagnostics.filter((d) => d.code === 'invalid_js_package')
    .map(({ path, message }) => ({ path, message }))
const error = (text: string) => (parseJsPackage(text) as { error?: string }).error

describe('JavaScript packages', () => {
  it('reads a name and an optional range or tag', () => {
    expect(parseJsPackage('date-fns')).toEqual({ package: { name: 'date-fns', range: '' } })
    expect(parseJsPackage(' zod@^3 ')).toEqual({ package: { name: 'zod', range: '^3' } })
    expect(parseJsPackage('@acme/utils@1.2.0')).toEqual({ package: { name: '@acme/utils', range: '1.2.0' } })
    expect(parseJsPackage('@acme/utils')).toEqual({ package: { name: '@acme/utils', range: '' } })
    expect(parseJsPackage('lodash-es@>=4  <5')).toEqual({ package: { name: 'lodash-es', range: '>=4 <5' } })
    for (const ok of ['a@latest', 'x@next', 'y@1.x || 2', 'z@~2.0.1', 'p@1.0.0-beta.2', 'q.js@*', 'r_s@1'])
      expect(parseJsPackage(ok)).toHaveProperty('package')
  })

  it('refuses what would fetch from elsewhere, and names npm would refuse', () => {
    expect(error('https://example.com/x.tgz')).toMatch(/no URLs/)
    expect(error('x@git+https://github.com/a/b')).toMatch(/no URLs/)
    expect(error('x@github:a/b')).toMatch(/no URLs/)
    expect(error('x@file:../x')).toMatch(/no URLs/)
    expect(error('x@npm:other@1')).toMatch(/no URLs/)
    expect(error('x@workspace:*')).toMatch(/no URLs/)
    expect(error('./local')).toMatch(/no paths/)
    expect(error('/abs/path')).toMatch(/no paths/)
    expect(error('user/repo')).toMatch(/GitHub repository/)
    expect(error('React')).toMatch(/isn't an npm package name/)
    expect(error('_private')).toMatch(/isn't an npm package name/)
    expect(error('.hidden')).toMatch(/no paths/)
    expect(error('@scope')).toMatch(/isn't an npm package name/)
    expect(error('zod@')).toMatch(/Nothing after "zod@"/)
    // npm reads these as directories (review fix): never ranges.
    for (const dir of ['foo@..', 'foo@.', 'foo@.1', 'a@...'])
      expect(error(dir)).toMatch(/no URLs, git, paths/)
    expect(error('zod@^3; rm -rf')).toMatch(/isn't a version range/)
    expect(error('# a comment')).toMatch(/Comments/)
    expect(error('--save-dev')).toMatch(/options/)
    expect(error('   ')).toMatch(/empty/)
    expect(error(`a${'b'.repeat(300)}`)).toMatch(/at most/)
  })

  it('reports each line, duplicates and too many', () => {
    expect(problems(['zod', 'Bad', 'zod@^3'])).toEqual([
      {
        path: ['settings', 'javascript', 'packages', 1],
        message: '"Bad" isn\'t an npm package name (lowercase, like date-fns or @acme/utils)',
      },
      { path: ['settings', 'javascript', 'packages', 2], message: '"zod" is already on line 1' },
    ])
    const many = Array.from({ length: MAX_JS_PACKAGES + 1 }, (_, i) => `pkg${i}`)
    expect(problems(many)).toEqual([
      { path: ['settings', 'javascript', 'packages'], message: `At most ${MAX_JS_PACKAGES} packages` },
    ])
  })

  it('is optional, and absent leaves the hash as it was', () => {
    const plain = wf([start, code], [['startTrigger', 'code1']])
    expect(workflowDefinitionSchema.parse(withPackages(['zod'])).settings).toEqual({
      javascript: { packages: ['zod'] },
    })
    expect(definitionHash(workflowDefinitionSchema.parse(plain))).not.toBe(
      definitionHash(workflowDefinitionSchema.parse(withPackages(['zod']))),
    )
    expect(validateDefinition(plain).ok).toBe(true)
    expect(validateDefinition(withPackages(['zod@^3', '@acme/utils'])).ok).toBe(true)
    expect(validateDefinition(withPackages(['user/repo'])).ok).toBe(false)
    expect(() => workflowDefinitionSchema.parse(withPackages([]))).not.toThrow()
  })

  it('turns into npm dependencies, the ones that parse', () => {
    const packages = ['zod@^3', 'date-fns', '@acme/utils@1.2.0', 'Bad']
    expect(jsDependencies(packages)).toEqual({ zod: '^3', 'date-fns': '*', '@acme/utils': '1.2.0' })
    expect(splitJsPackage(' @acme/utils@ 1.2 ')).toEqual({ name: '@acme/utils', range: '1.2' })
    expect(splitJsPackage('Bad')).toEqual({ name: 'Bad', range: '' })
  })
})

describe('import lines in JavaScript code', () => {
  const withCode = (code: string, packages?: string[]) =>
    wf([start, { name: 'code1', type: 'code', config: { code } }], [['startTrigger', 'code1']], {
      ...(packages && { settings: { javascript: { packages } } }),
    })
  const imports = (code: string, packages?: string[]) =>
    validateDefinition(withCode(code, packages))
      .diagnostics.filter((d) => d.code !== 'invalid_js_package')
      .map(({ code: c, message, start: s, end }) => ({ code: c, message, at: [s, end] }))

  it('names the workflow’s packages: their imports bind names for the code', () => {
    expect(
      imports("import { z } from 'zod'\nimport fmt from 'date-fns'\nreturn [z, fmt]", ['zod@^3', 'date-fns']),
    ).toEqual([])
  })

  it('says when a package isn’t one of them, or a file inside one is imported', () => {
    const code = "import _ from 'lodash'\nimport chunk from 'zod/lib/x'\nreturn [_, chunk]"
    expect(imports(code, ['zod'])).toEqual([
      {
        code: 'unknown_js_import',
        message: 'The package "lodash" isn\'t one of the workflow\'s JavaScript packages',
        at: [15, 21],
      },
      {
        code: 'unknown_js_import',
        message: 'Import "zod/lib/x": only a package itself can be imported, from "zod"',
        at: [42, 51],
      },
    ])
    expect(imports("import _ from 'lodash'\nreturn _")[0]?.code).toBe('unknown_js_import')
  })

  it('a broken import line is a syntax error, and imports after other code too', () => {
    expect(imports("import { a from 'x'\nreturn a", ['x']).map((d) => d.code)).toEqual(['syntax'])
    expect(imports("const a = 1\nimport b from 'x'\nreturn b", ['x']).map((d) => d.code)).toContain('syntax')
  })

  it('leaves Python code alone', () => {
    const python = wf(
      [start, { name: 'py', type: 'code', config: { code: 'import json\nreturn 1', language: 'python' } }],
      [['startTrigger', 'py']],
    )
    expect(validateDefinition(python).diagnostics.filter((d) => d.code === 'unknown_js_import')).toEqual([])
  })
})
