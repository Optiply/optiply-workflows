import { auditEvents, folders, permissions, resources } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * The Query Library on the server (M14 step 1): drafts, releases, access and running a draft with parameters.
 * Queries go to the built-in optiply_db, provisioned in both environments at startup.
 */

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

const definition = (sql: string, params: { name: string; testValue?: unknown }[] = []) => ({
  schemaVersion: 1,
  resource: 'optiply_db',
  query: { sql },
  params,
})

/** A library query with a saved draft; `save` saves the next draft and tracks the revision. */
async function libraryQuery(slug: string, def: object) {
  const created = data(await admin.mutate('libraryQueries.create', { slug, name: slug }))
  let revision = 1
  const save = async (next: object) => {
    revision = data(
      await admin.mutate('libraryQueries.saveDraft', { id: created.id, revision, definition: next }),
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

describe('library queries', () => {
  it('saves drafts, publishes semver releases and rolls back', async () => {
    const q = await libraryQuery(
      'orders_by_customer',
      definition('select {{ customerId }}::int as id', [{ name: 'customerId' }]),
    )
    const got = data(await admin.query('libraryQueries.get', { id: q.id }))
    expect(got).toMatchObject({
      slug: 'orders_by_customer',
      draftRevision: 2,
      diagnostics: [],
      liveRelease: null,
    })

    const v1 = data(
      await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() }),
    )
    expect(v1.version).toBe('1.0.0')
    expect(
      failure(
        await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() }),
      ),
    ).toEqual({
      code: 'CONFLICT',
      message: 'Nothing changed since the live release, v1.0.0',
    })

    await q.save(
      definition('select {{ customerId }}::int as id, {{ status }}::text as status', [
        { name: 'customerId' },
        { name: 'status' },
      ]),
    )
    expect(
      failure(
        await admin.mutate('libraryQueries.publish', {
          libraryQueryId: q.id,
          draftRevision: q.revision() - 1,
        }),
      ).code,
    ).toBe('CONFLICT')
    const v2 = data(
      await admin.mutate('libraryQueries.publish', {
        libraryQueryId: q.id,
        draftRevision: q.revision(),
        bump: 'minor',
        notes: 'status',
      }),
    )
    expect(v2.version).toBe('1.1.0')

    const releases = data(await admin.query('libraryQueries.releases', { libraryQueryId: q.id }))
    expect(releases.map((r: { version: string; live: boolean }) => [r.version, r.live])).toEqual([
      ['1.1.0', true],
      ['1.0.0', false],
    ])
    expect(releases[0].params).toEqual([{ name: 'customerId' }, { name: 'status' }])

    await admin.mutate('libraryQueries.setLive', { libraryQueryId: q.id, releaseId: v1.id })
    const list = data(await admin.query('libraryQueries.list'))
    expect(list.find((l: { id: string }) => l.id === q.id)).toMatchObject({
      liveReleaseId: v1.id,
      liveVersion: '1.0.0',
    })

    const actions = (await env.db.select().from(auditEvents).where(eq(auditEvents.objectId, q.id))).map(
      (e) => e.action,
    )
    expect(actions).toEqual(
      expect.arrayContaining([
        'library_query.created',
        'library_query.release_published',
        'library_query.release_live',
      ]),
    )
  })

  it('refuses publishing an invalid query and checks it against the connector', async () => {
    const q = await libraryQuery('reads_app_state', definition('select {{ table1.selectedRow.id }}'))
    expect(data(await admin.query('libraryQueries.get', { id: q.id })).diagnostics).toEqual([
      expect.objectContaining({ code: 'unknown_identifier', message: '"table1" is not a parameter' }),
    ])
    expect(
      failure(
        await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() }),
      ),
    ).toEqual({
      code: 'BAD_REQUEST',
      message: `The library query isn't valid: "table1" is not a parameter`,
    })
    await q.save({ ...definition('select 1'), resource: 'no_such_db' })
    expect(data(await admin.query('libraryQueries.get', { id: q.id })).diagnostics).toEqual([
      expect.objectContaining({ code: 'unknown_resource' }),
    ])
    expect(
      failure(
        await admin.mutate('libraryQueries.saveDraft', {
          id: q.id,
          revision: q.revision(),
          definition: { nope: 1 },
        }),
      ).code,
    ).toBe('BAD_REQUEST')
  })

  it('runs the draft with test values or given parameters, current_user from the session', async () => {
    const q = await libraryQuery(
      'plus_one',
      definition(
        'select {{ n }}::int + 1 as x, {{ label }}::text as label, {{ current_user.email }}::text as email',
        [{ name: 'n', testValue: 41 }, { name: 'label' }],
      ),
    )
    const run = (params?: Record<string, unknown>) =>
      admin.mutate('libraryQueries.run', {
        libraryQueryId: q.id,
        environmentId: prodId,
        ...(params && { params }),
      })
    expect(data(await run())).toMatchObject({
      ok: true,
      data: [{ x: 42, label: null, email: 'admin@optiply.nl' }],
    })
    // Values are bound as parameters; an undeclared `current_user` can't stand in for the session's.
    const evil = "'); drop table users; --"
    expect(data(await run({ n: 1, label: evil, current_user: { email: 'forged@x' } }))).toMatchObject({
      ok: true,
      data: [{ x: 2, label: evil, email: 'admin@optiply.nl' }],
    })
    expect(data(await run({ n: 'not a number' }))).toMatchObject({ ok: false })
    const [audit] = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.objectId, q.id), eq(auditEvents.action, 'library_query.query_run')))
    expect(audit!.metadata).toMatchObject({ version: 'draft', ok: true })
    expect(JSON.stringify(audit!.metadata)).not.toContain('drop table')
  })

  it('checks access: Use sees it, Edit runs and publishes with Use on the resource everywhere', async () => {
    const q = await libraryQuery(
      'access_check',
      definition('select {{ id }}::int as id', [{ name: 'id', testValue: 7 }]),
    )
    const run = () => member.mutate('libraryQueries.run', { libraryQueryId: q.id, environmentId: prodId })
    const publish = () =>
      member.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() })

    expect(failure(await member.query('libraryQueries.get', { id: q.id })).code).toBe('NOT_FOUND')
    expect(data(await member.query('libraryQueries.list')).some((l: { id: string }) => l.id === q.id)).toBe(
      false,
    )

    await grant('library_query', q.id, 'use')
    expect(data(await member.query('libraryQueries.list')).some((l: { id: string }) => l.id === q.id)).toBe(
      true,
    )
    expect(data(await member.query('libraryQueries.releases', { libraryQueryId: q.id }))).toEqual([])
    expect(failure(await member.query('libraryQueries.get', { id: q.id })).code).toBe('FORBIDDEN')
    expect(failure(await run()).code).toBe('FORBIDDEN')

    await grant('library_query', q.id, 'edit')
    expect(failure(await run())).toEqual({
      code: 'FORBIDDEN',
      message: `You need use access to resource "optiply_db" in this environment to run this library query's draft`,
    })
    expect(failure(await publish())).toEqual({
      code: 'FORBIDDEN',
      message:
        'You need use access to resource "optiply_db" in every environment to release this library query',
    })

    const [db] = await env.db.select().from(resources).where(eq(resources.slug, 'optiply_db'))
    await grant('resource', db!.id, 'use')
    expect(data(await run())).toMatchObject({ ok: true, data: [{ id: 7 }] })
    expect(data(await publish()).version).toBe('1.0.0')

    // Only Owners delete; grants go with it.
    expect(failure(await member.mutate('libraryQueries.delete', { id: q.id })).code).toBe('FORBIDDEN')
    await grant('library_query', q.id, 'own')
    expect(data(await member.mutate('libraryQueries.delete', { id: q.id }))).toEqual({ ok: true })
    const left = await env.db
      .select()
      .from(permissions)
      .where(and(eq(permissions.objectType, 'library_query'), eq(permissions.objectId, q.id)))
    expect(left).toEqual([])
    await grant('resource', db!.id, null)
  })

  it('creates in folders of its own kind; type-wide Edit creates', async () => {
    expect(failure(await member.mutate('libraryQueries.create', { slug: 'nope', name: 'Nope' })).code).toBe(
      'FORBIDDEN',
    )
    expect(data(await member.query('folders.list', { type: 'library_query' })).canManage).toBe(false)
    await grant('library_query', null, 'edit')
    expect(data(await member.query('folders.list', { type: 'library_query' })).canManage).toBe(true)
    const folder = data(await member.mutate('folders.create', { type: 'library_query', name: 'Orders' }))
    const [appFolder] = await env.db
      .insert(folders)
      .values({ objectType: 'app', name: 'Not for queries' })
      .returning()
    expect(
      failure(
        await member.mutate('libraryQueries.create', {
          slug: 'wrong_folder',
          name: 'x',
          folderId: appFolder!.id,
        }),
      ),
    ).toEqual({
      code: 'BAD_REQUEST',
      message: 'No library query folder has that id',
    })
    const created = data(
      await member.mutate('libraryQueries.create', { slug: 'in_folder', name: 'x', folderId: folder.id }),
    )
    expect(created).toMatchObject({ folderId: folder.id, level: 'edit' })
    expect(
      failure(
        await admin.mutate('permissions.set', {
          objectType: 'library_query',
          objectId: created.id,
          groupId: memberGroupId,
          environmentId: prodId,
          level: 'use',
        }),
      ),
    ).toEqual({ code: 'BAD_REQUEST', message: 'Library query access applies to every environment' })
    await grant('library_query', null, null)
  })
})

describe('library queries in apps', () => {
  /** An app whose `orders` query uses the library query `slug` at `version`, its parameter from an input. */
  const appUsing = (
    slug: string,
    version: string,
    params: object = { customerId: '{{ customer.value }}' },
  ) => ({
    schemaVersion: 1,
    components: [{ name: 'customer', type: 'numberInput', props: { defaultValue: 5 } }],
    queries: [{ name: 'orders', kind: 'library', library: slug, version, params, run: 'auto' }],
    layout: { customer: { x: 0, y: 0, w: 4, h: 3 } },
  })
  const saveApp = async (client: ReturnType<typeof trpc>, slug: string, def: object) => {
    const created = data(await admin.mutate('apps.create', { slug, name: slug }))
    const revision = data(
      await client.mutate('apps.saveDraft', { id: created.id, revision: 1, definition: def }),
    ).revision
    return { id: created.id as string, revision: revision as number }
  }
  const publishApp = (client: ReturnType<typeof trpc>, a: { id: string; revision: number }) =>
    client.mutate('apps.publish', { appId: a.id, draftRevision: a.revision })
  const runOrders = (
    client: ReturnType<typeof trpc>,
    appId: string,
    releaseId: string | null,
    values: Record<string, unknown> = { ' customer.value ': 5 },
  ) => client.mutate('apps.runQuery', { appId, releaseId, query: 'orders', environmentId: prodId, values })
  const libSql = (tag: string) =>
    `select {{ customerId }}::int as id, '${tag}' as v, {{ current_user.email }}::text as email`

  it('runs the pinned release or the live one, with the parameters the browser evaluated', async () => {
    const q = await libraryQuery('orders_lib', definition(libSql('v1'), [{ name: 'customerId' }]))
    const v1 = data(
      await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() }),
    )
    await q.save(definition(libSql('v2'), [{ name: 'customerId' }]))
    await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() })

    const pinned = await saveApp(admin, 'pinned_app', appUsing('orders_lib', '1.0.0'))
    const latest = await saveApp(admin, 'latest_app', appUsing('orders_lib', 'latest'))
    const pinnedRelease = data(await publishApp(admin, pinned))
    const latestRelease = data(await publishApp(admin, latest))
    await grant('app', pinned.id, 'use')
    await grant('app', latest.id, 'use')

    // A viewer with Use on the apps only; current_user is the session's.
    expect(data(await runOrders(member, pinned.id, pinnedRelease.id))).toMatchObject({
      ok: true,
      data: [{ id: 5, v: 'v1', email: 'member@optiply.nl' }],
    })
    expect(data(await runOrders(member, latest.id, latestRelease.id))).toMatchObject({
      ok: true,
      data: [{ v: 'v2' }],
    })

    await q.save(definition(libSql('v3'), [{ name: 'customerId' }]))
    await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() })
    expect(data(await runOrders(member, latest.id, latestRelease.id))).toMatchObject({ data: [{ v: 'v3' }] })
    expect(data(await runOrders(member, pinned.id, pinnedRelease.id))).toMatchObject({ data: [{ v: 'v1' }] })
    // Rolling the library back is what `latest` runs next.
    await admin.mutate('libraryQueries.setLive', { libraryQueryId: q.id, releaseId: v1.id })
    expect(data(await runOrders(member, latest.id, latestRelease.id))).toMatchObject({ data: [{ v: 'v1' }] })

    // The browser's values are data: an injection string is bound as a value (and isn't an int).
    expect(
      data(
        await runOrders(member, pinned.id, pinnedRelease.id, { ' customer.value ': '1; drop table users' }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'query' } })

    // Who uses it; deleting it is refused meanwhile.
    expect(data(await admin.query('libraryQueries.usedBy', { libraryQueryId: q.id }))).toEqual({
      apps: [
        expect.objectContaining({ slug: 'latest_app', where: ['draft', 'live'] }),
        expect.objectContaining({ slug: 'pinned_app', where: ['draft', 'live'] }),
      ],
      modules: [],
      hidden: 0,
    })
    expect(failure(await admin.mutate('libraryQueries.delete', { id: q.id }))).toEqual({
      code: 'CONFLICT',
      message: 'Apps use this library query: "latest_app", "pinned_app". Remove it from them first',
    })
    await grant('app', pinned.id, null)
    await grant('app', latest.id, null)
  })

  it('renders parameters: constants, current_user on the server, errors as the query’s outcome', async () => {
    const q = await libraryQuery(
      'params_lib',
      definition('select {{ a }}::int as a, {{ b }}::text as b', [{ name: 'a' }, { name: 'b' }]),
    )
    await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() })
    const a = await saveApp(
      admin,
      'params_app',
      appUsing('params_lib', 'latest', { a: 41, b: 'Hi {{ current_user.email }}' }),
    )
    expect(data(await runOrders(admin, a.id, null, {}))).toMatchObject({
      ok: true,
      data: [{ a: 41, b: 'Hi admin@optiply.nl' }],
    })
    const broken = await saveApp(
      admin,
      'broken_params',
      appUsing('params_lib', 'latest', { a: '{{ customer.value }}' }),
    )
    const outcome = data(await runOrders(admin, broken.id, null, {}))
    expect(outcome).toMatchObject({ ok: false, error: { code: 'expression' } })
    expect(outcome.error.message).toContain('parameter a: The browser sent no value for it')
  })

  it('needs Use on the library query to publish an app using it or run its draft', async () => {
    const q = await libraryQuery(
      'guarded_lib',
      definition('select {{ customerId }}::int as id', [{ name: 'customerId' }]),
    )
    await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() })
    const a = await saveApp(admin, 'guarded_app', appUsing('guarded_lib', 'latest'))
    await grant('app', a.id, 'edit')

    expect(failure(await runOrders(member, a.id, null))).toEqual({
      code: 'FORBIDDEN',
      message: `You need use access to library query "guarded_lib" to run the draft's queries`,
    })
    expect(failure(await publishApp(member, a))).toEqual({
      code: 'FORBIDDEN',
      message: 'You need use access to library query "guarded_lib" to release this app, which uses it',
    })

    await grant('library_query', q.id, 'use')
    // No grant on the resource is needed: the library query's publisher vouched for it.
    expect(data(await runOrders(member, a.id, null))).toMatchObject({ ok: true, data: [{ id: 5 }] })
    expect(data(await publishApp(member, a)).version).toBe('1.0.0')
    // Someone who can't see the app isn't told its name.
    await grant('app', a.id, null)
    await grant('library_query', q.id, 'own')
    expect(failure(await member.mutate('libraryQueries.delete', { id: q.id }))).toEqual({
      code: 'CONFLICT',
      message: 'Apps use this library query: 1 app. Remove it from them first',
    })
    expect(data(await member.query('libraryQueries.usedBy', { libraryQueryId: q.id }))).toEqual({
      apps: [],
      modules: [],
      hidden: 1,
    })
    await grant('library_query', q.id, null)
  })

  it('counts modules using it: deleting it is refused while one does', async () => {
    const q = await libraryQuery('module_lib', definition('select {{ x }}::int as x', [{ name: 'x' }]))
    await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() })
    const created = data(await admin.mutate('modules.create', { slug: 'lib_module', name: 'Lib module' }))
    await admin.mutate('modules.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [],
        queries: [
          {
            name: 'lookup',
            kind: 'library',
            library: 'module_lib',
            version: 'latest',
            params: { x: '1' },
            run: 'auto',
          },
        ],
        layout: {},
        module: { inputs: [], outputs: [], events: [] },
      },
    })
    expect(data(await admin.query('libraryQueries.usedBy', { libraryQueryId: q.id }))).toEqual({
      apps: [],
      modules: [expect.objectContaining({ slug: 'lib_module', where: ['draft'] })],
      hidden: 0,
    })
    expect(failure(await admin.mutate('libraryQueries.delete', { id: q.id }))).toEqual({
      code: 'CONFLICT',
      message: 'Apps or modules use this library query: "Lib module". Remove it from them first',
    })
    await admin.mutate('modules.delete', { id: created.id })
    expect(data(await admin.mutate('libraryQueries.delete', { id: q.id }))).toBeDefined()
  })

  it('checks the reference when publishing and in the editor', async () => {
    const q = await libraryQuery('checked_lib', definition('select {{ x }}::int as x', [{ name: 'x' }]))
    const a = await saveApp(admin, 'checked_app', appUsing('checked_lib', 'latest', { x: 1 }))
    expect(failure(await publishApp(admin, a))).toEqual({
      code: 'BAD_REQUEST',
      message: `The app isn't valid: Library query "checked_lib" has no live release yet`,
    })
    await admin.mutate('libraryQueries.publish', { libraryQueryId: q.id, draftRevision: q.revision() })
    const b = await saveApp(admin, 'checked_app2', appUsing('checked_lib', '2.0.0', { x: 1, y: 2 }))
    expect(
      data(await admin.query('apps.get', { id: b.id })).diagnostics.map((d: { code: string }) => d.code),
    ).toEqual(['unknown_version'])
    expect(failure(await runOrders(admin, b.id, null, {}))).toEqual({
      code: 'BAD_REQUEST',
      message: 'Library query "checked_lib" has no release 2.0.0',
    })
  })
})
