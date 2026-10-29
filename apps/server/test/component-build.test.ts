import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyComponentLibrary } from '@ow/app-definition'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'
import { startTestRegistry, type TestRegistry } from './npm-registry'

/** Building component libraries (M25 step 3b-1): bundles, packages, located errors, confinement, the bundle route. */

let env: TestEnv
let registry: TestRegistry
let work: string
let admin: ReturnType<typeof trpc>
let cookie: string

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

beforeAll(async () => {
  registry = await startTestRegistry([
    {
      name: 'shout',
      version: '1.2.0',
      files: { 'index.js': 'module.exports = (s) => s.toUpperCase() + "!"' },
    },
  ])
  work = await mkdtemp(join(tmpdir(), 'ow-build-test-'))
  env = await startTestApp({ NPM_REGISTRY_URL: registry.url, COMPONENT_BUILD_DIR: work })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  cookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, cookie)
}, 60_000)
afterAll(async () => {
  await env?.stop()
  await registry?.stop()
  await rm(work, { recursive: true, force: true })
})

/** A library whose draft is `def`, and its build. */
async function built(slug: string, edit: (def: ReturnType<typeof emptyComponentLibrary>) => void) {
  const { id } = data(await admin.mutate('componentLibraries.create', { slug, name: slug }))
  const def = emptyComponentLibrary()
  edit(def)
  data(await admin.mutate('componentLibraries.saveDraft', { id, revision: 1, definition: def }))
  return { id, outcome: data(await admin.mutate('componentLibraries.build', { componentLibraryId: id })) }
}

const fetchBundle = (hash: string, ext: 'js' | 'css', withCookie = true) =>
  env.app.inject({
    method: 'GET',
    url: `/api/component-bundles/${hash}.${ext}`,
    headers: withCookie ? { cookie } : {},
  })

/** Runs a bundle in Node with a stand-in frame: JSX as plain objects, the SDK's hooks returning fixed values. */
async function load(js: string) {
  const g = globalThis as { __owFrame?: unknown }
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  g.__owFrame = {
    modules: {
      react: { useState: (v: unknown) => [v, () => {}] },
      'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
      '@ow/component-sdk': {
        useProp: (name: string) => `prop:${name}`,
        useStateValue: () => [2, () => {}],
        useEvent: () => () => {},
      },
    },
  }
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

describe('building component libraries', () => {
  it('bundles each component as a named export, with its CSS, and finds the build again', async () => {
    const { id, outcome } = await built('starter', (def) => {
      def.files.push({ path: 'src/hello.css', content: '.hello { color: var(--ow-primary) }' })
      def.files[0]!.content = `import './hello.css'\n${def.files[0]!.content}`
    })
    expect(outcome).toMatchObject({ ok: true, lock: null, cached: false })
    const js = await fetchBundle(outcome.bundleHash, 'js')
    expect(js.statusCode).toBe(200)
    expect(js.headers['cache-control']).toContain('immutable')
    expect(js.body).toContain('__owFrame')
    expect((await fetchBundle(outcome.bundleHash, 'css')).body).toContain('.hello')
    const mod = await load(js.body)
    const tree = JSON.stringify(mod.Hello())
    expect(tree).toContain('prop:name')
    expect(tree).toContain('button')

    const again = data(await admin.mutate('componentLibraries.build', { componentLibraryId: id }))
    expect(again).toMatchObject({ ok: true, bundleHash: outcome.bundleHash, cached: true })
  })

  it('installs npm packages, bundles them in and keeps the lock on the draft', async () => {
    const { id, outcome } = await built('shouty', (def) => {
      def.dependencies = { shout: '^1.0.0' }
      def.files[0]!.content =
        `import shout from 'shout'\nexport default function Hello() { return <b>{shout('hi')}</b> }`
    })
    expect(outcome.ok).toBe(true)
    const mod = await load((await fetchBundle(outcome.bundleHash, 'js')).body)
    expect(JSON.stringify(mod.Hello())).toContain('HI!')
    const draft = data(await admin.query('componentLibraries.get', { id }))
    expect(JSON.parse(draft.draftLock).packages['node_modules/shout'].version).toBe('1.2.0')
  }, 60_000)

  it('points at the file, line and column of a mistake', async () => {
    const { outcome } = await built('broken', (def) => {
      def.files[0]!.content = 'export default function Hello() {\n  return <b>{oops(</b>\n}'
    })
    expect(outcome).toMatchObject({ ok: false, stage: 'bundle' })
    expect(outcome.problems[0]).toMatchObject({ file: 'src/Hello.tsx', line: 2 })
    const invalid = await built('invalid', (def) => {
      def.components[0]!.entry = 'src/Nope.tsx'
    })
    expect(invalid.outcome).toMatchObject({ ok: false, stage: 'validate' })
    const missing = await built('missing-pkg', (def) => {
      def.dependencies = { 'not-there': '1.0.0' }
    })
    expect(missing.outcome).toMatchObject({
      ok: false,
      stage: 'install',
      problems: [{ file: 'package.json' }],
    })
  }, 60_000)

  it('reads no file outside the library, and only the frame’s React', async () => {
    const outside = join(process.cwd(), 'package.json')
    const { outcome } = await built('sneaky', (def) => {
      def.files[0]!.content = `import pkg from ${JSON.stringify(outside)}\nexport default () => pkg.name`
    })
    expect(outcome).toMatchObject({ ok: false, stage: 'bundle' })
    expect(outcome.problems[0].message).toContain('Only the library’s files')
    const relativeEscape = await built('sneaky2', (def) => {
      def.files[0]!.content =
        `import pkg from '../../../../../../../../../../${outside.slice(1)}'\nexport default () => pkg`
    })
    expect(relativeEscape.outcome).toMatchObject({ ok: false, stage: 'bundle' })
    const server = await built('ssr', (def) => {
      def.files[0]!.content =
        `import { renderToString } from 'react-dom/server'\nexport default () => renderToString`
    })
    expect(server.outcome.problems[0].message).toContain('isn’t available in a component')
  })

  it('serves bundles to people signed in, by a well-formed hash only', async () => {
    const { outcome } = await built('served', () => {})
    expect((await fetchBundle(outcome.bundleHash, 'js', false)).statusCode).toBe(401)
    expect((await fetchBundle('a'.repeat(64), 'js')).statusCode).toBe(404)
    const bad = await env.app.inject({
      method: 'GET',
      url: '/api/component-bundles/..%2Fx.js',
      headers: { cookie },
    })
    expect(bad.statusCode).toBe(404)
  })
})
