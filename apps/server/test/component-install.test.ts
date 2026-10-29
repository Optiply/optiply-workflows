import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installDependencies } from '../src/services/components/install'
import { startTestRegistry, type TestRegistry } from './npm-registry'

/** Installing a component library's npm dependencies (M25 step 3a), from a fake registry. */

let registry: TestRegistry
let work: string

beforeAll(async () => {
  registry = await startTestRegistry([
    { name: 'pad', version: '1.0.0', files: { 'index.js': 'module.exports = (s) => `[${s}]`' } },
    { name: 'pad', version: '1.1.0', files: { 'index.js': 'module.exports = (s) => `<${s}>`' } },
    {
      name: '@acme/greet',
      version: '2.0.0',
      files: { 'index.js': 'const pad = require("pad"); module.exports = (n) => pad("hi " + n)' },
      dependencies: { pad: '^1.0.0' },
    },
    {
      name: 'evil',
      version: '1.0.0',
      files: { 'index.js': '' },
      scripts: { preinstall: "node -e \"require('fs').writeFileSync('PWNED', 'x')\"" },
    },
  ])
  work = await mkdtemp(join(tmpdir(), 'ow-install-test-'))
}, 60_000)
afterAll(async () => {
  await registry?.stop()
  await rm(work, { recursive: true, force: true })
})

const fresh = async (name: string) => {
  const dir = join(work, name)
  await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
  return dir
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
const install = (dir: string, dependencies: Record<string, string>, lock: string | null = null) =>
  installDependencies(dir, { dependencies, lock, registry: registry.url, cacheDir: join(work, 'cache') })

describe('installing dependencies', () => {
  it('needs nothing without dependencies', async () => {
    expect(await install(await fresh('none'), {})).toEqual({ ok: true, lock: null, log: '' })
    expect(registry.requests).toEqual([])
  })

  it('installs scoped and transitive packages and returns the lock', async () => {
    const dir = await fresh('greet')
    const result = await install(dir, { '@acme/greet': '^2.0.0' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lock = JSON.parse(result.lock!)
    expect(lock.packages['node_modules/@acme/greet'].version).toBe('2.0.0')
    expect(lock.packages['node_modules/pad'].version).toBe('1.1.0')
    expect(await readFile(join(dir, 'node_modules/pad/index.js'), 'utf8')).toContain('<')
  }, 60_000)

  it('follows the lock it is given while the ranges allow', async () => {
    const first = await install(await fresh('pinned-a'), { pad: '1.0.0' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // The range now allows 1.1.0, but the lock says 1.0.0.
    const dir = await fresh('pinned-b')
    const second = await install(dir, { pad: '^1.0.0' }, first.lock)
    expect(second.ok && JSON.parse(second.lock!).packages['node_modules/pad'].version).toBe('1.0.0')
    expect(await readFile(join(dir, 'node_modules/pad/index.js'), 'utf8')).toContain('[')
  }, 60_000)

  it('never runs install scripts', async () => {
    const dir = await fresh('evil')
    const result = await install(dir, { evil: '1.0.0' })
    expect(result.ok).toBe(true)
    expect(await exists(join(dir, 'node_modules/evil/PWNED'))).toBe(false)
    expect(await exists(join(dir, 'PWNED'))).toBe(false)
  }, 60_000)

  it('reports a package that isn’t there, and the size limit', async () => {
    const missing = await install(await fresh('missing'), { 'no-such-package': '^1.0.0' })
    expect(missing).toMatchObject({ ok: false, kind: 'install' })
    expect(!missing.ok && missing.message).toMatch(/404|no-such-package/)
    const big = await installDependencies(await fresh('big'), {
      dependencies: { pad: '1.0.0' },
      lock: null,
      registry: registry.url,
      cacheDir: join(work, 'cache'),
      limits: { timeoutMs: 60_000, maxBytes: 10 },
    })
    expect(big).toMatchObject({ ok: false, kind: 'too_large' })
  }, 60_000)
})
