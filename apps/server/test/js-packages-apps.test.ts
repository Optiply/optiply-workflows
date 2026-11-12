import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { appReleases, apps, auditEvents, jsBundles } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'
import { startTestRegistry, type TestRegistry } from './npm-registry'

/**
 * An app's JavaScript packages on the server: its releases keep their lock and bundle (publish, rollback), viewers
 * get the bundle's hash with the live release and fetch it from /api/js-bundles (rebuilt from the lock when gone),
 * and the editor's preview asks for the draft's bundle.
 */

let env: TestEnv
let registry: TestRegistry
let work: string
let admin: ReturnType<typeof trpc>
let cookie: string

type Res = { status: number; body: { result?: { data: unknown }; error?: { message: string } } }
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}

const definition = (packages: string[]) => ({
  schemaVersion: 1,
  components: [],
  queries: [{ name: 'q1', kind: 'js', code: "import pad from 'pad'\nreturn pad('x')" }],
  javascript: { packages },
})

async function appWith(slug: string, packages: string[]) {
  const { id } = data(await admin.mutate('apps.create', { slug, name: slug }))
  data(await admin.mutate('apps.saveDraft', { id, revision: 1, definition: definition(packages) }))
  const [app] = await env.db.select().from(apps).where(eq(apps.id, id))
  return app!
}
const publish = (app: { id: string; draftRevision: number }) =>
  admin.mutate('apps.publish', { appId: app.id, draftRevision: app.draftRevision })
const fetchBundle = (file: string, appId: string | null, as: string | null = cookie, extra = '') =>
  env.app.inject({
    method: 'GET',
    url: `/api/js-bundles/${file}${appId ? `?app=${appId}${extra}` : ''}`,
    headers: as ? { cookie: as } : {},
  })
const modulesOf = (js: string) => {
  const context: Record<string, any> = {}
  runInNewContext(js, context)
  return context.__owModules
}

beforeAll(async () => {
  registry = await startTestRegistry([
    { name: 'pad', version: '1.0.0', files: { 'index.js': 'module.exports = (s) => `[${s}]`' } },
    { name: 'pad', version: '1.1.0', files: { 'index.js': 'module.exports = (s) => `<${s}>`' } },
    { name: 'only-workflows', version: '1.0.0', files: { 'index.js': 'module.exports = 1' } },
  ])
  work = await mkdtemp(join(tmpdir(), 'ow-js-apps-test-'))
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

describe("an app's JavaScript packages", () => {
  it('a release keeps its lock and bundle; viewers get the hash and fetch the bundle', async () => {
    const app = await appWith('js-app', ['pad@^1'])
    const release = data(await publish(app))
    const [row] = await env.db.select().from(appReleases).where(eq(appReleases.id, release.id))
    expect(row!.jsBundleHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.jsLock).toContain('"node_modules/pad"')
    const open = data(await admin.query('apps.open', { slug: 'js-app' }))
    expect(open.release.jsBundleHash).toBe(row!.jsBundleHash)

    const res = await fetchBundle(`${row!.jsBundleHash}.js`, app.id)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/javascript')
    expect(modulesOf(res.body).pad('x')).toBe('<x>')
    expect((await fetchBundle(`${row!.jsBundleHash}.js`, app.id, null)).statusCode).toBe(401)
    expect((await fetchBundle('nope.js', app.id)).statusCode).toBe(404)
    expect((await fetchBundle(`${'f'.repeat(64)}.js`, app.id)).statusCode).toBe(404)
  })

  it('builds a bundle a release names again from its lock when it is gone', async () => {
    const [row] = await env.db
      .select()
      .from(appReleases)
      .innerJoin(apps, eq(apps.id, appReleases.appId))
      .where(eq(apps.slug, 'js-app'))
    await env.db.delete(jsBundles)
    const res = await fetchBundle(`${row!.app_releases.jsBundleHash}.js`, row!.apps.id)
    expect(res.statusCode).toBe(200)
    expect(modulesOf(res.body).pad('y')).toBe('<y>')
    const audits = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'js.bundle_built'), eq(auditEvents.objectId, row!.apps.id)))
    expect(audits.map((a) => (a.metadata as { fromLock?: boolean }).fromLock ?? false)).toEqual([false, true])
  })

  it("refuses to publish packages that can't be installed", async () => {
    const app = await appWith('js-app-bad', ['no-such-package'])
    // Its code imports pad, which isn't listed: fix that first, so the install is what fails.
    data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: app.draftRevision,
        definition: { ...definition(['no-such-package']), queries: [] },
      }),
    )
    const res = await admin.mutate('apps.publish', { appId: app.id, draftRevision: app.draftRevision + 1 })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain("The JavaScript packages couldn't be installed")
  })

  it('brings back the bundle of a release it rolls back to', async () => {
    const app = await appWith('js-app-rollback', ['pad@1.0.0'])
    const first = data(await publish(app))
    data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: app.draftRevision,
        definition: definition(['pad@1.1.0']),
      }),
    )
    data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: app.draftRevision + 1 }))
    await env.db.delete(jsBundles)
    data(await admin.mutate('apps.setLive', { appId: app.id, releaseId: first.id }))
    const open = data(await admin.query('apps.open', { slug: 'js-app-rollback' }))
    const res = await fetchBundle(`${open.release.jsBundleHash}.js`, app.id)
    expect(modulesOf(res.body).pad('z')).toBe('[z]')
  })

  it("gives the editor's preview the draft's bundle", async () => {
    const app = await appWith('js-app-draft', ['pad@1.0.0'])
    const state = data(
      await admin.mutate('jsPackages.install', {
        target: { kind: 'app', id: app.id },
        packages: ['pad@1.0.0'],
      }),
    )
    expect(state).toMatchObject({ state: 'ready', versions: { pad: '1.0.0' } })
    expect(modulesOf((await fetchBundle(`${state.bundleHash}.js`, app.id)).body).pad('d')).toBe('[d]')
  })

  it("serves a bundle only for an app the caller can see: its releases', or (editors) its draft's", async () => {
    const memberUser = await createLocalUser(env.db, 'viewer@optiply.nl')
    const viewer = await login(env.app, 'viewer@optiply.nl')
    const released = await appWith('js-access', ['pad@1.0.0'])
    data(await publish(released))
    const live = data(await admin.query('apps.open', { slug: 'js-access' })).release.jsBundleHash as string
    // A draft list differing from the release's: its bundle is a draft's only.
    const draftState = data(
      await admin.mutate('jsPackages.install', {
        target: { kind: 'app', id: released.id },
        packages: ['pad@1.1.0'],
      }),
    )
    data(
      await admin.mutate('apps.saveDraft', {
        id: released.id,
        revision: released.draftRevision,
        definition: definition(['pad@1.1.0']),
      }),
    )
    const other = await appWith('js-access-other', [])
    const hashOf = (h: string) => `${h}.js`

    // Nobody without access to the app; no app named: nothing.
    expect((await fetchBundle(hashOf(live), released.id, viewer)).statusCode).toBe(404)
    expect((await fetchBundle(hashOf(live), null)).statusCode).toBe(404)
    // With Use: the release's bundle, not the draft's.
    data(
      await admin.mutate('permissions.set', {
        objectType: 'app',
        objectId: released.id,
        userId: memberUser.id,
        environmentId: null,
        level: 'use',
      }),
    )
    expect((await fetchBundle(hashOf(live), released.id, viewer)).statusCode).toBe(200)
    expect((await fetchBundle(hashOf(draftState.bundleHash), released.id, viewer)).statusCode).toBe(404)
    // An editor: the draft's too; but not under another app, nor a bundle neither names.
    expect((await fetchBundle(hashOf(draftState.bundleHash), released.id)).statusCode).toBe(200)
    expect((await fetchBundle(hashOf(live), other.id)).statusCode).toBe(404)
    expect((await fetchBundle(hashOf(draftState.bundleHash), other.id)).statusCode).toBe(404)
    // A branch draft that isn't this app's: nothing.
    expect(
      (await fetchBundle(hashOf(draftState.bundleHash), released.id, cookie, `&branchDraft=${other.id}`))
        .statusCode,
    ).toBe(404)
    // A bundle only a workflow uses (the same content as an app's would be that app's): never served.
    const wf = data(
      await admin.mutate('jsPackages.install', {
        target: {
          kind: 'workflow',
          id: data(await admin.mutate('workflows.create', { slug: 'js-wf', name: 'wf' })).id,
        },
        packages: ['only-workflows'],
      }),
    )
    expect(wf.state).toBe('ready')
    expect((await fetchBundle(hashOf(wf.bundleHash), released.id)).statusCode).toBe(404)
  })

  it('needs no bundle for an app without packages', async () => {
    const { id } = data(await admin.mutate('apps.create', { slug: 'js-app-none', name: 'none' }))
    const [app] = await env.db.select().from(apps).where(eq(apps.id, id))
    data(await publish(app!))
    expect(data(await admin.query('apps.open', { slug: 'js-app-none' })).release.jsBundleHash).toBeNull()
  })
})
