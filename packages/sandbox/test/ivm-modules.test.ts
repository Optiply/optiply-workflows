import { afterEach, describe, expect, it } from 'vitest'
import { IvmRuntime, SandboxError } from '../src'

/** JavaScript packages in the isolate: a bundle setting `__owModules`, read through `__owImport`. */

let runtime: IvmRuntime
afterEach(() => runtime?.dispose())

/** Like the server's bundles: a lazy getter per package. `loads` counts how often a package's body ran. */
const bundle = (extra = '') => ({
  hash: `h${extra.length}`,
  js: `(() => {
  const modules = Object.create(null)
  globalThis.loads = 0
  const once = (load) => { let done = false, value; return () => { if (!done) { value = load(); done = true } return value } }
  Object.defineProperty(modules, 'cjs', { enumerable: true, get: once(() => { globalThis.loads++; const f = (x) => x * 2; f.half = (x) => x / 2; return f }) })
  Object.defineProperty(modules, 'esm', { enumerable: true, get: once(() => ({ __esModule: true, default: 'D', named: 5 })) })
  Object.defineProperty(modules, 'prim', { enumerable: true, get: () => 'just a string' })
  Object.defineProperty(modules, 'broken', { enumerable: true, get: () => { throw new Error('broken at load') } })
  ${extra}
  globalThis.__owModules = modules
})()`,
})

// What `rewriteImports` (@ow/expressions) makes of import lines.
const imports = {
  cjsDefault: 'const __owImport0 = __owImport("cjs"), double = __owImport0.default;',
  cjsNamed: 'const __owImport0 = __owImport("cjs"), { "half": half } = __owImport0;',
  esm: 'const __owImport0 = __owImport("esm"), d = __owImport0.default, { "named": named } = __owImport0;',
  ns: 'const __owImport0 = __owImport("esm"), ns = __owImport0;',
}

describe('IvmRuntime: JavaScript packages', () => {
  it('reads CommonJS (default = the module, its properties named) and ES modules', async () => {
    runtime = new IvmRuntime()
    const modules = bundle()
    expect(await runtime.runCode(`${imports.cjsDefault}\nreturn double(21)`, {}, { modules })).toBe(42)
    expect(await runtime.runCode(`${imports.cjsNamed}\nreturn half(8)`, {}, { modules })).toBe(4)
    expect(await runtime.runCode(`${imports.esm}\nreturn [d, named]`, {}, { modules })).toEqual(['D', 5])
    expect(await runtime.runCode(`${imports.ns}\nreturn [ns.default, ns.named]`, {}, { modules })).toEqual([
      'D',
      5,
    ])
    expect(
      await runtime.runCode('const p = __owImport("prim")\nreturn [p.default]', {}, { modules }),
    ).toEqual(['just a string'])
  })

  it('loads a package on first use, in each evaluation’s own context', async () => {
    runtime = new IvmRuntime()
    const modules = bundle()
    expect(await runtime.runCode('return loads', {}, { modules })).toBe(0)
    expect(
      await runtime.runCode(
        `${imports.cjsDefault}\ndouble(1)\n__owImport("cjs")\nreturn loads`,
        {},
        { modules },
      ),
    ).toBe(1)
    // A new evaluation starts over: nothing leaks between contexts.
    expect(await runtime.runCode('return loads', {}, { modules })).toBe(0)
    expect(await runtime.runCode('return typeof __owModules', {}, {})).toBe('undefined')
  })

  it('says what is missing: a package not installed, a subpath, no packages at all, one failing to load', async () => {
    runtime = new IvmRuntime()
    const modules = bundle()
    await expect(runtime.runCode('__owImport("zod")', {}, { modules })).rejects.toThrow(
      'The package "zod" is not installed: add it to the JavaScript packages',
    )
    await expect(runtime.runCode('__owImport("cjs/sub")', {}, { modules })).rejects.toThrow(
      'Import "cjs/sub": only a package itself can be imported, from "cjs"',
    )
    await expect(runtime.runCode('__owImport("cjs")', {}, {})).rejects.toThrow('is not installed')
    await expect(runtime.runCode('__owImport("broken")', {}, { modules })).rejects.toThrow('broken at load')
    // The others still load.
    expect(await runtime.runCode(`${imports.cjsDefault}\nreturn double(2)`, {}, { modules })).toBe(4)
  })

  it('compiles a bundle once per isolate; a bad bundle is a clear error', async () => {
    runtime = new IvmRuntime()
    const modules = bundle()
    await runtime.runCode('return 1', {}, { modules })
    await runtime.runCode('return 1', {}, { modules })
    expect((runtime as unknown as { scripts: Map<string, unknown> }).scripts.size).toBe(1)
    const err = await runtime
      .runCode('return 1', {}, { modules: { hash: 'bad', js: 'this is not (' } })
      .catch((e) => e)
    expect(err).toBeInstanceOf(SandboxError)
    expect((err as SandboxError).message).toMatch(/^The JavaScript packages couldn't be loaded/)
  })

  it('keeps error lines right below import lines', async () => {
    runtime = new IvmRuntime()
    const modules = bundle()
    const lineOf = async (code: string) => {
      const err = (await runtime.runCode(code, {}, { modules }).catch((e) => e)) as SandboxError
      return /user-code\.js:(\d+)/.exec(err.userStack ?? '')?.[1]
    }
    const line = await lineOf(`${imports.cjsDefault}\n\nnull.boom`)
    expect(line).toBe('3')
    expect(line).toBe(await lineOf('const a = 1\n\nnull.boom'))
  })

  it('counts the bundle’s time toward the limit', async () => {
    runtime = new IvmRuntime()
    const slow = bundle('const end = Date.now() + 400; while (Date.now() < end) {}')
    const err = await runtime
      .runCode('while (true) {}', {}, { modules: slow, timeoutMs: 300 })
      .catch((e) => e)
    expect((err as SandboxError).kind).toBe('timeout')
  })

  it('works in expressions too, and keeps fetch and functions', async () => {
    runtime = new IvmRuntime()
    const modules = bundle()
    expect(await runtime.evalExpression('__owImport("cjs").default(5)', {}, { modules })).toBe(10)
    const out = await runtime.runCode(
      `${imports.cjsDefault}\nreturn double(await twice(3))`,
      {},
      { modules, functions: { twice: async ([n]) => (n as number) * 2 } },
    )
    expect(out).toBe(12)
  })
})
