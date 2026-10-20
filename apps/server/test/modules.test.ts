import { auditEvents, folders, resources } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/** Modules on the server (M14 step 4): drafts, releases, access, running a draft's queries, apps placing them. */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberGroupId: string
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

/** A region picker: a query reading `inputs.region`, an output and an event. */
const picker = (tag = 'v1') => ({
  schemaVersion: 1,
  components: [
    { name: 'table1', type: 'table', props: { data: '{{ regions.data }}' } },
    {
      name: 'pick',
      type: 'button',
      props: { text: 'Pick' },
      events: [{ id: 'a', event: 'click', action: { type: 'moduleEvent', event: 'picked' } }],
    },
  ],
  queries: [
    {
      name: 'regions',
      kind: 'resource',
      resource: 'optiply_db',
      query: { sql: `select {{ inputs.region }}::text as region, '${tag}' as tag` },
      run: 'auto',
    },
  ],
  layout: { table1: { x: 0, y: 0, w: 12, h: 10 }, pick: { x: 0, y: 10, w: 2, h: 3 } },
  module: {
    inputs: [{ name: 'region', default: 'EU' }],
    outputs: [{ name: 'selectedRegion', value: '{{ table1.selectedRow?.region ?? null }}' }],
    events: [{ name: 'picked' }],
  },
})

async function moduleWith(slug: string, def: object, client = admin) {
  const created = data(await client.mutate('modules.create', { slug, name: slug }))
  let revision = 1
  const save = async (next: object) => {
    revision = data(
      await client.mutate('modules.saveDraft', { id: created.id, revision, definition: next }),
    ).revision
    return revision
  }
  await save(def)
  return { id: created.id as string, save, revision: () => revision }
}

const grant = (objectType: string, objectId: string | null, level: 'use' | 'edit' | 'own' | null) =>
  admin.mutate('permissions.set', {
    objectType,
    objectId,
    groupId: memberGroupId,
    environmentId: null,
    level,
  })

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  const memberUser = await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
})
afterAll(async () => {
  await env?.stop()
})

describe('modules', () => {
  it('saves drafts, publishes releases with their interface, rolls back', async () => {
    const m = await moduleWith('region_picker', picker())
    expect(data(await admin.query('modules.get', { id: m.id }))).toMatchObject({
      slug: 'region_picker',
      diagnostics: [],
      liveRelease: null,
    })
    const v1 = data(await admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision() }))
    expect(v1.version).toBe('1.0.0')
    expect(
      failure(await admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision() })).message,
    ).toBe('Nothing changed since the live release, v1.0.0')
    await m.save(picker('v2'))
    data(
      await admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision(), bump: 'minor' }),
    )
    const releases = data(await admin.query('modules.releases', { moduleId: m.id }))
    expect(releases.map((r: { version: string; live: boolean }) => [r.version, r.live])).toEqual([
      ['1.1.0', true],
      ['1.0.0', false],
    ])
    expect(releases[0].interface).toEqual({
      inputs: [{ name: 'region' }],
      outputs: [{ name: 'selectedRegion' }],
      events: [{ name: 'picked' }],
    })
    await admin.mutate('modules.setLive', { moduleId: m.id, releaseId: v1.id })
    expect(data(await admin.query('modules.list')).find((l: { id: string }) => l.id === m.id)).toMatchObject({
      liveVersion: '1.0.0',
    })
    const actions = (await env.db.select().from(auditEvents).where(eq(auditEvents.objectId, m.id))).map(
      (e) => e.action,
    )
    expect(actions).toEqual(
      expect.arrayContaining(['module.created', 'module.release_published', 'module.release_live']),
    )
  })

  it('refuses a definition that isn’t a module, and invalid ones at publish', async () => {
    const m = await moduleWith('broken_module', picker())
    const { module: _, ...plainApp } = picker()
    expect(
      failure(
        await admin.mutate('modules.saveDraft', { id: m.id, revision: m.revision(), definition: plainApp }),
      ),
    ).toEqual({ code: 'BAD_REQUEST', message: 'A module definition needs its module part' })
    const bad = picker()
    bad.components[1]!.events![0]!.action = { type: 'moduleEvent', event: 'nope' }
    await m.save(bad)
    expect(
      failure(await admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision() })),
    ).toEqual({
      code: 'BAD_REQUEST',
      message: `The module isn't valid: The module has no event "nope"`,
    })
  })

  it('runs a draft’s queries with the values the browser evaluated', async () => {
    const m = await moduleWith('run_module', picker())
    const run = (client: ReturnType<typeof trpc>) =>
      client.mutate('modules.runQuery', {
        moduleId: m.id,
        query: 'regions',
        environmentId: prodId,
        values: { ' inputs.region ': 'US' },
      })
    expect(data(await run(admin))).toMatchObject({ ok: true, data: [{ region: 'US', tag: 'v1' }] })
    expect(failure(await run(member)).code).toBe('NOT_FOUND')
    await grant('module', m.id, 'use')
    expect(failure(await run(member))).toEqual({
      code: 'FORBIDDEN',
      message: 'You need edit access to this module to run its draft',
    })
    await grant('module', m.id, 'edit')
    expect(failure(await run(member))).toEqual({
      code: 'FORBIDDEN',
      message: `You need use access to resource "optiply_db" in this environment to run the draft's queries`,
    })
    // Publishing vouches for the resource everywhere.
    expect(
      failure(await member.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision() }))
        .message,
    ).toBe('You need use access to resource "optiply_db" in every environment to release this module')
    await grant('module', m.id, null)
  })
})

describe('apps placing modules', () => {
  const appPlacing = (props: Record<string, unknown>) => ({
    schemaVersion: 1,
    components: [
      { name: 'picker1', type: 'module', props: { module: 'placed_picker', ...props } },
      { name: 'shown', type: 'text', props: { value: '{{ picker1.selectedRegion }}' } },
    ],
    queries: [],
    layout: { picker1: { x: 0, y: 0, w: 6, h: 12 }, shown: { x: 6, y: 0, w: 6, h: 2 } },
  })
  const saveApp = async (slug: string, def: object) => {
    const created = data(await admin.mutate('apps.create', { slug, name: slug }))
    const revision = data(
      await admin.mutate('apps.saveDraft', { id: created.id, revision: 1, definition: def }),
    ).revision
    return { id: created.id as string, revision: revision as number }
  }

  it('checks the instance against the release, needs Use on the module to publish, refuses deleting it', async () => {
    const m = await moduleWith('placed_picker', picker())
    const a = await saveApp('placing_app', appPlacing({ region: 'US' }))
    // Not published yet.
    expect(
      data(await admin.query('apps.get', { id: a.id })).diagnostics.map((d: { code: string }) => d.code),
    ).toEqual(['unpublished_module'])
    await admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision() })
    expect(data(await admin.query('apps.get', { id: a.id })).diagnostics).toEqual([])
    const wrong = await saveApp('wrong_props_app', appPlacing({ colour: 'red', version: '9.9.9' }))
    expect(
      data(await admin.query('apps.get', { id: wrong.id })).diagnostics.map((d: { code: string }) => d.code),
    ).toEqual(['unknown_version'])

    // A member with Edit on the app and Use on the resource still needs Use on the module.
    const [db] = await env.db.select().from(resources).where(eq(resources.slug, 'optiply_db'))
    await grant('app', a.id, 'edit')
    await grant('resource', db!.id, 'use')
    const publish = () => member.mutate('apps.publish', { appId: a.id, draftRevision: a.revision })
    expect(failure(await publish())).toEqual({
      code: 'FORBIDDEN',
      message: 'You need use access to module "placed_picker" to release this app, which uses it',
    })
    await grant('module', m.id, 'use')
    expect(data(await publish()).version).toBe('1.0.0')

    expect(data(await admin.query('modules.usedBy', { moduleId: m.id }))).toEqual({
      apps: [
        expect.objectContaining({ slug: 'placing_app', where: ['draft', 'live'] }),
        expect.objectContaining({ slug: 'wrong_props_app', where: ['draft'] }),
      ],
      modules: [],
      hidden: 0,
    })
    expect(failure(await admin.mutate('modules.delete', { id: m.id }))).toEqual({
      code: 'CONFLICT',
      message: 'Apps use this module: "placing_app", "wrong_props_app". Remove it from them first',
    })
    expect(
      data(
        await admin.query('modules.resolve', { slugs: ['placed_picker', 'nope', '{{ x }}', 'My Module'] }),
      ),
    ).toEqual({
      placed_picker: {
        id: m.id,
        name: 'placed_picker',
        liveVersion: '1.0.0',
        versions: { '1.0.0': { inputs: ['region'], outputs: ['selectedRegion'], events: ['picked'] } },
      },
    })
    for (const [type, id] of [
      ['app', a.id],
      ['resource', db!.id],
      ['module', m.id],
    ] as const) {
      await grant(type, id, null)
    }
  })

  it('opens an app with its instances’ module releases and runs their queries from them', async () => {
    const m = await moduleWith('run_picker', picker())
    const v1 = data(await admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision() }))
    const a = await saveApp('running_app', {
      schemaVersion: 1,
      components: [
        { name: 'picker1', type: 'module', props: { module: 'run_picker', region: 'US' } },
        { name: 'picker2', type: 'module', props: { module: 'run_picker', version: '1.0.0' } },
      ],
      queries: [],
      layout: { picker1: { x: 0, y: 0, w: 6, h: 12 }, picker2: { x: 6, y: 0, w: 6, h: 12 } },
    })
    const live = data(await admin.mutate('apps.publish', { appId: a.id, draftRevision: a.revision }))
    const opened = data(await admin.query('apps.open', { slug: 'running_app' }))
    expect(Object.keys(opened.modules).sort()).toEqual(['run_picker@1.0.0', 'run_picker@latest'])
    expect(opened.modules['run_picker@latest']).toMatchObject({ releaseId: v1.id, version: '1.0.0' })
    expect(opened.modules['run_picker@latest'].definition.module.inputs).toEqual([
      { name: 'region', default: 'EU' },
    ])

    const run = (
      instance: string,
      releaseId: string,
      opts: { client?: ReturnType<typeof trpc>; appRelease?: string | null } = {},
    ) =>
      (opts.client ?? admin).mutate('apps.runQuery', {
        appId: a.id,
        releaseId: opts.appRelease === undefined ? live.id : opts.appRelease,
        query: 'regions',
        module: { instance, releaseId },
        environmentId: prodId,
        values: { ' inputs.region ': 'US' },
      })
    expect(data(await run('picker1', v1.id))).toMatchObject({ ok: true, data: [{ region: 'US', tag: 'v1' }] })
    expect(failure(await run('nobody', v1.id))).toEqual({
      code: 'NOT_FOUND',
      message: 'The app has no module instance named "nobody"',
    })

    // A new live release: `latest` instances on a page still running v1 are told to reload; pinned ones aren't.
    await m.save(picker('v2'))
    const v2 = data(await admin.mutate('modules.publish', { moduleId: m.id, draftRevision: m.revision() }))
    expect(failure(await run('picker1', v1.id))).toEqual({
      code: 'CONFLICT',
      message: 'Module "run_picker" has a new version; reload to get it',
    })
    expect(data(await run('picker1', v2.id))).toMatchObject({ ok: true, data: [{ tag: 'v2' }] })
    expect(data(await run('picker2', v1.id))).toMatchObject({ ok: true, data: [{ tag: 'v1' }] })

    // The app's draft: Edit on the app and Use on the module; the module's publisher vouched for its resource.
    await grant('app', a.id, 'edit')
    expect(failure(await run('picker1', v2.id, { client: member, appRelease: null }))).toEqual({
      code: 'FORBIDDEN',
      message: 'You need use access to module "run_picker" to run the draft\'s queries',
    })
    const keys = ['run_picker@latest', 'run_picker@1.0.0', 'run_picker@9.9.9', 'nope@latest']
    expect(data(await member.query('modules.instanceReleases', { keys }))).toEqual({})
    await grant('module', m.id, 'use')
    expect(data(await run('picker1', v2.id, { client: member, appRelease: null }))).toMatchObject({
      ok: true,
      data: [{ tag: 'v2' }],
    })
    const forDraft = data(await member.query('modules.instanceReleases', { keys }))
    expect(
      Object.fromEntries(Object.entries(forDraft).map(([k, r]) => [k, (r as { version: string }).version])),
    ).toEqual({
      'run_picker@latest': '1.0.1',
      'run_picker@1.0.0': '1.0.0',
    })
    await grant('app', a.id, null)
    await grant('module', m.id, null)
  })

  it('has folders of its own and grants without environments', async () => {
    await grant('module', null, 'edit')
    const folder = data(await member.mutate('folders.create', { type: 'module', name: 'Pickers' }))
    const [appFolder] = await env.db
      .insert(folders)
      .values({ objectType: 'app', name: 'Apps here' })
      .returning()
    expect(
      failure(
        await member.mutate('modules.create', { slug: 'misplaced', name: 'x', folderId: appFolder!.id }),
      ),
    ).toEqual({ code: 'BAD_REQUEST', message: 'No module folder has that id' })
    const created = data(
      await member.mutate('modules.create', { slug: 'in_folder', name: 'x', folderId: folder.id }),
    )
    expect(created).toMatchObject({ folderId: folder.id, level: 'edit' })
    expect(
      failure(
        await admin.mutate('permissions.set', {
          objectType: 'module',
          objectId: created.id,
          groupId: memberGroupId,
          environmentId: prodId,
          level: 'use',
        }),
      ),
    ).toEqual({ code: 'BAD_REQUEST', message: 'Module access applies to every environment' })
    await grant('module', null, null)
  })
})
