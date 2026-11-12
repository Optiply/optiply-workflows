/** An app's JavaScript packages: `javascript.packages`. */
import { describe, expect, it } from 'vitest'
import { appDefinitionSchema, canonicalizeApp, validateApp } from '../src'
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
