import type { SandboxModules } from '@ow/sandbox'
import { afterAll, describe, expect, it } from 'vitest'
import { code, wf as plainWf, run, testServices } from './helpers'

/** A run's JavaScript packages: import lines in code blocks and loop runners read the run's bundle. */

const shared = testServices()
afterAll(() => shared.close())

/** A workflow declaring the packages the tests import. */
const wf = (...args: Parameters<typeof plainWf>) => ({
  ...plainWf(...args),
  settings: { javascript: { packages: ['pad', 'esm', 'zod'] } },
})

const bundle: SandboxModules = {
  hash: 'b1',
  js: `globalThis.__owModules = Object.defineProperties(Object.create(null), {
  pad: { enumerable: true, get: () => (s) => '[' + s + ']' },
  esm: { enumerable: true, get: () => ({ __esModule: true, default: 'D', twice: (n) => n * 2 }) },
})`,
}

describe("a run's JavaScript packages", () => {
  it('lets code import them; the bundle is asked for once', async () => {
    let calls = 0
    const jsModules = async () => {
      calls++
      return bundle
    }
    const { outcome, data } = await run(
      { ...shared.services, jsModules },
      wf(
        [
          code('one', "import pad from 'pad'\nreturn pad('x')"),
          code('two', "import d, { twice } from 'esm'\n\nreturn [d, twice(one.data.length)]"),
        ],
        [
          ['startTrigger', 'one'],
          ['one', 'two'],
        ],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('two')).toEqual(['D', 6])
    expect(calls).toBe(2) // The services' own shared() makes it once per run; this stand-in counts each block.
  })

  it('skips the bundle for code without import lines', async () => {
    let calls = 0
    const { outcome, data } = await run(
      { ...shared.services, jsModules: async () => (calls++, bundle) },
      wf([code('plain', 'return 1 + 1')], [['startTrigger', 'plain']]),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('plain')).toBe(2)
    expect(calls).toBe(0)
  })

  it('fails the block clearly: no packages, a package not in the bundle, a failed install, a bad import line', async () => {
    const one = (src: string, services = {}) =>
      run({ ...shared.services, ...services }, wf([code('c', src)], [['startTrigger', 'c']]))
    expect((await one("import pad from 'pad'\nreturn pad(1)")).outcome.error).toMatchObject({
      block: 'c',
      message: expect.stringContaining('The package "pad" is not installed'),
    })
    // Not declared at all: the workflow isn't valid.
    const undeclared = await run(
      { ...shared.services, jsModules: async () => bundle },
      plainWf([code('c', "import pad from 'pad'\nreturn 1")], [['startTrigger', 'c']]),
    )
    expect(undeclared.outcome.error?.message).toContain(
      '"pad" isn\'t one of the workflow\'s JavaScript packages',
    )
    expect(
      (await one("import zod from 'zod'\nreturn zod", { jsModules: async () => bundle })).outcome.error
        ?.message,
    ).toContain('The package "zod" is not installed')
    expect(
      (
        await one("import pad from 'pad'\nreturn 1", {
          jsModules: async () => {
            throw new Error('npm said no')
          },
        })
      ).outcome.error?.message,
    ).toContain('npm said no')
    // A broken import line: the workflow isn't valid (a syntax problem).
    expect((await one("import { pad from 'pad'\nreturn 1")).outcome.error).toMatchObject({
      code: 'invalid_definition',
    })
  })

  it("reports the code's own error from below the import lines", async () => {
    const { outcome } = await run(
      { ...shared.services, jsModules: async () => bundle },
      wf([code('c', "import pad from 'pad'\n\nnull.boom")], [['startTrigger', 'c']]),
    )
    expect(outcome.error).toMatchObject({
      block: 'c',
      code: 'runtime',
      message: expect.stringContaining("'boom'"),
    })
  })

  it('says in the log that it waits for the packages', async () => {
    const { outcome, store } = await run(
      { ...shared.services, jsModules: () => new Promise<SandboxModules>(() => {}) },
      wf([code('slow', "import pad from 'pad'\nreturn 1", { timeoutMs: 1500 })], [['startTrigger', 'slow']]),
    )
    expect(outcome.error).toMatchObject({ block: 'slow', code: 'timeout' })
    expect(store.logs.map((l) => l.message)).toEqual([
      "Waiting for the workflow's JavaScript packages to install…",
    ])
  })
})
