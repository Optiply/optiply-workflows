/** A workflow's Python packages in the definition (M23, docs/architecture.md §2.26). */
import { describe, expect, it } from 'vitest'
import {
  definitionHash,
  MAX_REQUIREMENTS,
  normalizePackageName,
  parseRequirement,
  validateDefinition,
  workflowDefinitionSchema,
} from '../src'
import { start, wf } from './helpers'

const python = { name: 'python1', type: 'code', config: { code: 'return 1', language: 'python' } }
const withPackages = (requirements: string[]) =>
  wf([start, python], [['startTrigger', 'python1']], { settings: { python: { requirements } } })
const problems = (requirements: string[]) =>
  validateDefinition(withPackages(requirements))
    .diagnostics.filter((d) => d.code === 'invalid_requirement')
    .map(({ path, message }) => ({ path, message }))

describe('requirements', () => {
  it('reads a name, extras and version specifiers', () => {
    expect(parseRequirement('polars')).toEqual({
      requirement: { name: 'polars', normalized: 'polars', extras: [], specifiers: [] },
    })
    expect(parseRequirement(' Scikit_Learn [ alldeps , tests ] >= 1.5 , < 2 ')).toEqual({
      requirement: {
        name: 'Scikit_Learn',
        normalized: 'scikit-learn',
        extras: ['alldeps', 'tests'],
        specifiers: ['>=1.5', '<2'],
      },
    })
    for (const ok of ['openpyxl==3.1.5', 'numpy~=2.1', 'pkg!=1.0.*', 'a.b-c_d===1.0+local', 'x<=2', 'x>1'])
      expect(parseRequirement(ok)).toHaveProperty('requirement')
    expect(normalizePackageName('Zope.Interface__x')).toBe('zope-interface-x')
  })

  it('refuses what would fetch from elsewhere or depend on the platform', () => {
    const error = (text: string) => (parseRequirement(text) as { error?: string }).error
    expect(error('-e git+https://github.com/x/y')).toMatch(/pip options/)
    expect(error('--index-url https://evil.example/simple')).toMatch(/pip options/)
    expect(error('pkg @ https://example.com/pkg.whl')).toMatch(/no URLs/)
    expect(error('git+https://github.com/x/y')).toMatch(/no URLs/)
    expect(error('./local/pkg')).toMatch(/no paths/)
    expect(error('pywin32; sys_platform == "win32"')).toMatch(/Environment markers/)
    expect(error('# a comment')).toMatch(/Comments/)
    expect(error('')).toMatch(/empty/)
    expect(error('-pkg')).toMatch(/pip options/)
    expect(error('pkg.')).toMatch(/isn't a package name/)
    expect(error('pkg >= ')).toMatch(/isn't a version specifier/)
    expect(error('pkg 1.0')).toMatch(/isn't a version specifier/)
    expect(error(`p${'x'.repeat(200)}`)).toMatch(/at most 200/)
  })

  it("puts each problem on its line in the workflow's settings, duplicates by normalized name", () => {
    expect(problems(['polars==1.9.0', 'openpyxl>=3.1'])).toEqual([])
    expect(problems(['polars', 'requests @ https://x.example/r.whl', 'Polars>=1'])).toEqual([
      { path: ['settings', 'python', 'requirements', 1], message: 'Only packages from the index: no URLs' },
      { path: ['settings', 'python', 'requirements', 2], message: '"Polars" is already on line 1' },
    ])
    const many = Array.from({ length: MAX_REQUIREMENTS + 1 }, (_, i) => `pkg${i}`)
    expect(problems(many)).toEqual([
      { path: ['settings', 'python', 'requirements'], message: `At most ${MAX_REQUIREMENTS} packages` },
    ])
  })

  it('is optional, and absent leaves the hash as it was', () => {
    const plain = wf([start, python], [['startTrigger', 'python1']])
    expect(workflowDefinitionSchema.parse(withPackages(['polars'])).settings).toEqual({
      python: { requirements: ['polars'] },
    })
    expect(definitionHash(workflowDefinitionSchema.parse(plain))).not.toBe(
      definitionHash(workflowDefinitionSchema.parse(withPackages(['polars']))),
    )
    expect(validateDefinition(plain).ok).toBe(true)
    expect(validateDefinition(withPackages(['polars'])).ok).toBe(true)
    expect(validateDefinition(withPackages(['-e .'])).ok).toBe(false)
  })

  it('takes a package index by its slug (M32)', () => {
    const withIndex = (index: string) =>
      wf([start, python], [['startTrigger', 'python1']], {
        settings: { python: { requirements: ['owtest-private'], index } },
      })
    expect(validateDefinition(withIndex('private-pypi_2')).ok).toBe(true)
    const bad = validateDefinition(withIndex('Not A Slug'))
    expect(bad.ok).toBe(false)
    expect(bad.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid_python_index', path: ['settings', 'python', 'index'] }),
    )
  })
})
