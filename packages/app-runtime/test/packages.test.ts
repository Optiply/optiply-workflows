import { afterEach, describe, expect, it } from 'vitest'
import { loadPackages, owImport } from '../src'

/** The app sandbox's JavaScript packages: a bundle loaded, read through `owImport` (`__owImport`). */

const bundle = {
  js: `globalThis.__owModules = Object.defineProperties(Object.create(null), {
  cjs: { enumerable: true, get: () => { const f = (n) => n * 2; f.half = (n) => n / 2; return f } },
  esm: { enumerable: true, get: () => ({ __esModule: true, default: 'D', named: 5 }) },
  prim: { enumerable: true, get: () => 'text' },
})`,
}

afterEach(() => loadPackages(null))

describe('app JavaScript packages', () => {
  it('reads CommonJS (default: the module) and ES modules, as workflows do', () => {
    loadPackages(bundle)
    const cjs = owImport('cjs') as { default: (n: number) => number; half: (n: number) => number }
    expect(cjs.default(2)).toBe(4)
    expect(cjs.half(8)).toBe(4)
    expect(owImport('esm')).toMatchObject({ default: 'D', named: 5 })
    expect(owImport('prim')).toEqual({ default: 'text' })
  })

  it('says what is missing; a new bundle replaces the old, none removes it', () => {
    loadPackages(bundle)
    expect(() => owImport('zod')).toThrow('The package "zod" is not installed')
    expect(() => owImport('cjs/sub')).toThrow('only a package itself can be imported, from "cjs"')
    loadPackages({ js: 'globalThis.__owModules = { other: 1 }' })
    expect(() => owImport('cjs')).toThrow('is not installed')
    loadPackages(null)
    expect(() => owImport('other')).toThrow('is not installed')
  })
})
