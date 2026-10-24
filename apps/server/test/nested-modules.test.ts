import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * Modules inside modules on the server (M21 step 4a): three levels at most below an app, no cycles, checked when
 * saving (the problems), publishing, and making a release live that others follow on `latest`.
 */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let prodId: string

type Res = {
  status: number
  body: { result?: { data: unknown }; error?: { message: string; data?: { code: string } } }
}
// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: Res): any => {
  if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
  return res.body.result.data
}
const failure = (res: Res) => ({ code: res.body.error?.data?.code, message: res.body.error?.message })

/** A module (or, without `module`, an app) placing `holds` (slugs, `latest`) above a text, with `queries`. */
const definition = (holds: string[], module = true, queries: object[] = []) => ({
  schemaVersion: 1,
  components: [
    { name: 'label', type: 'text', props: { value: 'hi' } },
    ...holds.map((slug, i) => ({ name: `m${i}`, type: 'module', props: { module: slug } })),
  ],
  queries,
  layout: Object.fromEntries([
    ['label', { x: 0, y: 0, w: 4, h: 2 }],
    ...holds.map((_, i) => [`m${i}`, { x: 0, y: 2 + i * 6, w: 12, h: 6 }]),
  ]),
  ...(module && { module: { inputs: [], outputs: [], events: [] } }),
})

const where = (at: string) => ({
  name: 'where',
  kind: 'resource',
  resource: 'optiply_db',
  query: { sql: `select '${at}' as at` },
  run: 'auto',
})

const objects = new Map<string, { id: string; revision: number }>()

async function saveModule(slug: string, holds: string[], queries: object[] = []) {
  let known = objects.get(slug)
  if (!known) {
    known = { id: data(await admin.mutate('modules.create', { slug, name: slug })).id, revision: 1 }
    objects.set(slug, known)
  }
  known.revision = data(
    await admin.mutate('modules.saveDraft', {
      id: known.id,
      revision: known.revision,
      definition: definition(holds, true, queries),
    }),
  ).revision
  return known
}
const publishModule = (slug: string) => {
  const m = objects.get(slug)!
  return admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision })
}
const problems = async (slug: string) =>
  (
    data(await admin.query('modules.get', { id: objects.get(slug)!.id })).diagnostics as {
      code: string
      message: string
    }[]
  ).filter((d) => d.code.startsWith('module_'))

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id

  // leaf ← middle ← top, all following latest, and an app placing top: three levels below the app.
  for (const [slug, holds] of [
    ['leaf', []],
    ['middle', ['leaf']],
    ['top', ['middle']],
  ] as const) {
    await saveModule(slug, [...holds])
    data(await publishModule(slug))
  }
  const app = data(await admin.mutate('apps.create', { slug: 'holder', name: 'Holder' }))
  const saved = data(
    await admin.mutate('apps.saveDraft', { id: app.id, revision: 1, definition: definition(['top'], false) }),
  )
  data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: saved.revision }))
})
afterAll(async () => {
  await env?.stop()
})

describe('modules inside modules', () => {
  it('nest three levels below an app, and no deeper', async () => {
    await saveModule('too_deep', ['top'])
    expect(await problems('too_deep')).toEqual([
      expect.objectContaining({
        code: 'module_depth',
        message: 'Modules nest 3 levels deep at most: "top" v1.0.0 is 3 deep, and this module adds one',
      }),
    ])
    expect(failure(await publishModule('too_deep'))).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/^The module isn't valid: Modules nest 3 levels deep at most/),
    })
  })

  it('refuse a module holding itself, directly or through those it holds', async () => {
    await saveModule('leaf', ['leaf'])
    expect((await problems('leaf')).map((p) => p.code)).toEqual(['module_cycle'])
    await saveModule('leaf', ['top'])
    expect(await problems('leaf')).toEqual([
      expect.objectContaining({
        code: 'module_cycle',
        message: 'Module "top" holds this module (directly or through others): a module can’t hold itself',
      }),
    ])
    expect(failure(await publishModule('leaf')).code).toBe('BAD_REQUEST')
  })

  it('refuse a live release nesting those following it on latest too deep, naming them', async () => {
    await saveModule('tiny', [])
    data(await publishModule('tiny'))
    // leaf itself is fine holding tiny (two deep), but middle, top and the app follow it on latest.
    await saveModule('leaf', ['tiny'])
    expect(await problems('leaf')).toEqual([])
    expect(failure(await publishModule('leaf'))).toEqual({
      code: 'BAD_REQUEST',
      message:
        'Making this release live would nest modules more than 3 deep in module "top", app "Holder", which follow it on latest',
    })
    // The draft stays as it was; leaf's live release is still the first.
    const leaf = data(await admin.query('modules.get', { id: objects.get('leaf')!.id }))
    expect(leaf.liveRelease.version).toBe('1.0.0')
  })

  it('list the modules holding a module, which can’t be deleted meanwhile', async () => {
    const used = data(await admin.query('modules.usedBy', { moduleId: objects.get('leaf')!.id }))
    expect(used.modules.map((m: { slug: string }) => m.slug)).toEqual(['middle'])
    expect(failure(await admin.mutate('modules.delete', { id: objects.get('leaf')!.id }))).toEqual({
      code: 'CONFLICT',
      message: 'Modules use this module: "middle". Remove it from them first',
    })
  })
})

describe('nested instances at run time', () => {
  it('open with every release the page runs, and run the innermost query through the path', async () => {
    await saveModule('q_leaf', [], [where('leaf')])
    await saveModule('q_mid', ['q_leaf'])
    await saveModule('q_top', ['q_mid'], [where('top')])
    const ids: Record<string, string> = {}
    for (const slug of ['q_leaf', 'q_mid', 'q_top']) ids[slug] = data(await publishModule(slug)).id
    const app = data(await admin.mutate('apps.create', { slug: 'chain-app', name: 'Chain app' }))
    const saved = data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: definition(['q_top'], false),
      }),
    )
    const live = data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: saved.revision }))

    const opened = data(await admin.query('apps.open', { slug: 'chain-app' }))
    expect(Object.keys(opened.modules).sort()).toEqual(['q_leaf@latest', 'q_mid@latest', 'q_top@latest'])
    expect(opened.modules['q_leaf@latest'].releaseId).toBe(ids.q_leaf)

    const run = (module: object) =>
      admin.mutate('apps.runQuery', {
        appId: app.id,
        releaseId: live.id,
        query: 'where',
        module,
        environmentId: prodId,
        values: {},
      })
    const path = [
      { instance: 'm0', releaseId: ids.q_top },
      { instance: 'm0', releaseId: ids.q_mid },
      { instance: 'm0', releaseId: ids.q_leaf },
    ]
    expect(data(await run(path))).toMatchObject({ ok: true, data: [{ at: 'leaf' }] })
    // The outer instance's own query: a path of one.
    expect(data(await run([path[0]]))).toMatchObject({ data: [{ at: 'top' }] })
    // A release the page no longer runs, or an instance that isn't there.
    expect(failure(await run([path[0], { ...path[1], releaseId: ids.q_leaf }, path[2]])).code).toBe(
      'CONFLICT',
    )
    expect(failure(await run([path[0], { instance: 'nope', releaseId: ids.q_mid }]))).toEqual({
      code: 'NOT_FOUND',
      message: 'Module "q_top" has no module instance named "nope"',
    })
  })

  it("run a module draft's nested instance queries from their releases", async () => {
    const top = objects.get('q_top')!
    const mid = data(await admin.query('modules.get', { id: objects.get('q_mid')!.id })).liveRelease.id
    const leaf = data(await admin.query('modules.get', { id: objects.get('q_leaf')!.id })).liveRelease.id
    const res = await admin.mutate('modules.runQuery', {
      moduleId: top.id,
      query: 'where',
      path: [
        { instance: 'm0', releaseId: mid },
        { instance: 'm0', releaseId: leaf },
      ],
      environmentId: prodId,
      values: {},
    })
    expect(data(res)).toMatchObject({ ok: true, data: [{ at: 'leaf' }] })
  })
})
