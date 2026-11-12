import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { appReleases, apps, jsBundles, npmRegistries } from '@ow/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildJsBundle,
  bundleEntry,
  deleteUnusedJsBundles,
  type JsBundleConfig,
  jsBundleByHash,
  jsInputHash,
  packageOf,
  recordBundle,
} from '../src/services/js-bundles'
import { startTestApp, type TestEnv } from './helpers'
import { startTestRegistry, type TestRegistry } from './npm-registry'

/** JavaScript packages bundled for the sandboxes: install, bundle, Node built-ins, the cache, failures. */

let env: TestEnv
let registry: TestRegistry
let work: string
let config: JsBundleConfig

beforeAll(async () => {
  registry = await startTestRegistry([
    { name: 'pad', version: '1.0.0', files: { 'index.js': 'module.exports = (s) => `[${s}]`' } },
    { name: 'pad', version: '1.1.0', files: { 'index.js': 'module.exports = (s) => `<${s}>`' } },
    {
      name: 'shout',
      version: '2.0.0',
      files: { 'index.js': 'export const shout = (s) => s.toUpperCase() + "!"\nexport default "shout"' },
    },
    {
      name: 'needs-fs',
      version: '1.0.0',
      files: {
        'index.js':
          'const fs = require("fs")\nexports.sum = (a, b) => a + b\nexports.read = (p) => fs.readFileSync(p, "utf8")',
      },
    },
    {
      name: 'events',
      version: '3.3.0',
      files: { 'index.js': 'module.exports = function EventEmitter() { this.browser = true }' },
    },
    {
      name: 'emits',
      version: '1.0.0',
      dependencies: { events: '^3' },
      files: { 'index.js': 'const E = require("events")\nmodule.exports = () => new E().browser' },
    },
    {
      name: 'throws-on-load',
      version: '1.0.0',
      files: { 'index.js': 'throw new Error("broken at load")' },
    },
    { name: 'bad-syntax', version: '1.0.0', files: { 'index.js': 'module.exports = (' } },
    {
      name: 'scripted',
      version: '1.0.0',
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('/tmp/ow-js-bundle-ran', 'x')\"" },
      files: { 'index.js': 'module.exports = 1' },
    },
  ])
  work = await mkdtemp(join(tmpdir(), 'ow-js-bundle-test-'))
  env = await startTestApp({ NPM_REGISTRY_URL: registry.url, COMPONENT_BUILD_DIR: work })
  config = { registry: registry.url, workDir: work, maxBytes: 5 * 1024 * 1024 }
}, 60_000)
afterAll(async () => {
  await env?.stop()
  await registry?.stop()
  await rm(work, { recursive: true, force: true })
})

/** The bundle run as the sandboxes run it: a script in a context of its own; its modules. */
function load(js: string): Record<string, any> {
  const context: Record<string, unknown> = {}
  runInNewContext(js, context)
  return context.__owModules as Record<string, any>
}

describe('JavaScript package bundles', () => {
  it('bundles CommonJS and ESM packages into one script setting __owModules, with their versions', async () => {
    const outcome = await buildJsBundle(env.db, config, ['pad@^1', 'shout'])
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome).toMatchObject({ versions: { pad: '1.1.0', shout: '2.0.0' }, warnings: [], cached: false })
    expect(outcome.lock).toContain('"pad"')
    expect(outcome.bundleHash).toMatch(/^[0-9a-f]{64}$/)
    const modules = load(outcome.js)
    expect(Object.keys(modules)).toEqual(['pad', 'shout'])
    expect(modules.pad('x')).toBe('<x>')
    expect(modules.shout.shout('hi')).toBe('HI!')
    expect(modules.shout.default).toBe('shout')
    expect(modules.shout.__esModule).toBe(true)
  })

  it('builds the same packages once: found again, and by the bundle’s hash', async () => {
    const first = await buildJsBundle(env.db, config, ['pad@1.0.0'])
    const again = await buildJsBundle(env.db, config, [' pad@1.0.0 '])
    if (!first.ok || !again.ok) throw new Error('build failed')
    expect(again).toMatchObject({ cached: true, bundleHash: first.bundleHash, versions: { pad: '1.0.0' } })
    expect((await jsBundleByHash(env.db, first.bundleHash))?.js).toBe(first.js)
    expect(await jsBundleByHash(env.db, 'f'.repeat(64))).toBeNull()
    // Two at once: one build.
    const [a, b] = await Promise.all([
      buildJsBundle(env.db, config, ['pad@~1.0']),
      buildJsBundle(env.db, config, ['pad@~1.0']),
    ])
    expect(a).toEqual(b)
  })

  it('starts from a release’s lock: the version it locked, not the newest', async () => {
    const old = await buildJsBundle(env.db, config, ['pad@1.0.0'])
    if (!old.ok) throw new Error(old.message)
    // The same lock with a range now allowing 1.1.0: npm keeps the locked 1.0.0.
    const locked = await buildJsBundle(env.db, config, ['pad@^1'], { lock: old.lock })
    expect(locked).toMatchObject({ ok: true, versions: { pad: '1.0.0' } })
  })

  it('stubs Node built-ins (a warning; using one throws, naming it), unless an npm package has the name', async () => {
    const outcome = await buildJsBundle(env.db, config, ['needs-fs', 'emits'])
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.warnings).toEqual([
      "needs-fs uses Node's fs, which the sandbox doesn't have: it fails if that part is used",
    ])
    const modules = load(outcome.js)
    expect(modules['needs-fs'].sum(2, 3)).toBe(5)
    expect(() => modules['needs-fs'].read('/etc/passwd')).toThrow(
      "needs-fs needs Node's fs, which the sandbox doesn't have",
    )
    expect(modules.emits()).toBe(true)
  })

  it('loads each package on first use: one failing to load leaves the others', async () => {
    const outcome = await buildJsBundle(env.db, config, ['throws-on-load', 'pad'])
    if (!outcome.ok) throw new Error(outcome.message)
    const modules = load(outcome.js)
    expect(modules.pad('ok')).toBe('<ok>')
    expect(() => modules['throws-on-load']).toThrow('broken at load')
  })

  it('runs no install scripts', async () => {
    const { existsSync } = await import('node:fs')
    await rm('/tmp/ow-js-bundle-ran', { force: true })
    expect(await buildJsBundle(env.db, config, ['scripted'])).toMatchObject({ ok: true })
    expect(existsSync('/tmp/ow-js-bundle-ran')).toBe(false)
  })

  it('says why it failed, and keeps the failure (the next build tries again)', async () => {
    expect(await buildJsBundle(env.db, config, ['user/repo', 'Bad'])).toMatchObject({
      ok: false,
      kind: 'invalid',
      message: expect.stringContaining('Line 1: "user/repo" looks like a GitHub repository'),
    })
    const missing = await buildJsBundle(env.db, config, ['no-such-package'])
    expect(missing).toMatchObject({
      ok: false,
      kind: 'install',
      message: expect.stringMatching(/404|not found/i),
    })
    const syntax = await buildJsBundle(env.db, config, ['bad-syntax'])
    expect(syntax).toMatchObject({
      ok: false,
      kind: 'bundle',
      message: expect.stringContaining('bad-syntax/index.js:1'),
    })
    const rows = await env.db.select().from(jsBundles).where(eq(jsBundles.state, 'failed'))
    expect(rows.map((r) => r.error?.kind).sort()).toEqual(['bundle', 'install'])
    expect(await buildJsBundle(env.db, { ...config, maxBytes: 10 }, ['pad@1.1.0'])).toMatchObject({
      ok: false,
      kind: 'too_large',
    })
  })

  it('builds again when the registries change: they are part of what went in', async () => {
    const deps = { pad: '^1' }
    const before = jsInputHash(deps, [], registry.url, null)
    expect(
      jsInputHash(deps, [{ scope: '@acme', url: 'https://npm.acme.com/' }], registry.url, null),
    ).not.toBe(before)
    expect(jsInputHash(deps, [], registry.url, 'lock')).not.toBe(before)
    expect(jsInputHash({ pad: '^1' }, [], registry.url, null)).toBe(before)
    await env.db.insert(npmRegistries).values({ scope: '@acme', url: 'https://npm.acme.com/' })
    try {
      expect(await buildJsBundle(env.db, config, ['pad@1.0.0'])).toMatchObject({ ok: true, cached: false })
    } finally {
      await env.db.delete(npmRegistries)
    }
  })

  it('answers a failure from a moment ago again, unless asked to try again (review fix)', async () => {
    const asked = () => registry.requests.filter((r) => r.includes('never-there')).length
    expect(await buildJsBundle(env.db, config, ['never-there'])).toMatchObject({ ok: false, kind: 'install' })
    const after = asked()
    expect(after).toBeGreaterThan(0)
    expect(await buildJsBundle(env.db, config, ['never-there'])).toMatchObject({ ok: false, kind: 'install' })
    expect(asked()).toBe(after) // not asked again
    await buildJsBundle(env.db, config, ['never-there'], { retryFailedAfterMs: 0 })
    expect(asked()).toBeGreaterThan(after)
  })

  it('never replaces a ready bundle with a failure for the same inputs (review fix)', async () => {
    const ready = await buildJsBundle(env.db, config, ['pad@1.0.0'])
    if (!ready.ok) throw new Error(ready.message)
    const inputHash = jsInputHash({ pad: '1.0.0' }, [], registry.url, null)
    await recordBundle(env.db, inputHash, { pad: '1.0.0' }, { ok: false, kind: 'timeout', message: 'slow' })
    const [row] = await env.db.select().from(jsBundles).where(eq(jsBundles.inputHash, inputHash))
    expect(row).toMatchObject({ state: 'ready', bundleHash: ready.bundleHash })
  })

  it('retention: bundles unused for long that no release names, and old failures (review fix)', async () => {
    await env.db.delete(jsBundles)
    const old = sql`now() - interval '40 days'`
    const keep = await buildJsBundle(env.db, config, ['pad@1.0.0'])
    const drop = await buildJsBundle(env.db, config, ['pad@1.1.0'])
    await buildJsBundle(env.db, config, ['never-there'], { retryFailedAfterMs: 0 })
    if (!keep.ok || !drop.ok) throw new Error('build failed')
    await env.db.update(jsBundles).set({ lastUsedAt: old })
    // An app release names `keep`'s bundle.
    const [app] = await env.db
      .insert(apps)
      .values({
        slug: `keep-${Date.now()}`,
        name: 'keep',
        draftDefinition: { schemaVersion: 1, components: [], queries: [] },
      })
      .returning()
    await env.db.insert(appReleases).values({
      appId: app!.id,
      version: '1.0.0',
      definition: { schemaVersion: 1, components: [], queries: [] },
      definitionHash: 'a'.repeat(64),
      jsBundleHash: keep.bundleHash,
    })
    expect(await deleteUnusedJsBundles(env.db)).toBe(2)
    const left = await env.db.select({ bundleHash: jsBundles.bundleHash }).from(jsBundles)
    expect(left).toEqual([{ bundleHash: keep.bundleHash }])
  })

  it('names packages and writes the entry', () => {
    expect(packageOf('/w/node_modules/zod/lib/index.js')).toBe('zod')
    expect(packageOf('/w/node_modules/a/node_modules/@acme/utils/x.js')).toBe('@acme/utils')
    expect(packageOf('/w/src/x.js')).toBeNull()
    expect(bundleEntry(['zod'])).toContain('get: once(() => require("zod"))')
  })
})
