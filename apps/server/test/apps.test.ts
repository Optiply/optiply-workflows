import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { apps as appsTable, auditEvents, folders, permissions, workflows } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * Apps on the server: drafts, releases, access, and running queries by name with the values the browser sends.
 * Queries go to the built-in optiply_db, provisioned in both environments at startup.
 */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberGroupId: string
let prodId: string
let stagingId: string

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

const sqlQuery = (name: string, sql: string, run: 'auto' | 'manual' = 'auto') => ({
  name,
  kind: 'resource',
  resource: 'optiply_db',
  query: { sql },
  run,
})

/** The CRUD app the tests use: a table of customers, a search box, an insert and a "who am I" query. */
const crudApp = (extra: { queries?: object[] } = {}) => ({
  schemaVersion: 1,
  components: [
    { name: 'search', type: 'textInput', props: { label: 'Search' } },
    { name: 'table1', type: 'table', props: { data: '{{ customers.data }}' } },
  ],
  queries: [
    sqlQuery(
      'setup',
      'create table if not exists customers (id bigint generated always as identity primary key, name text not null, owner text)',
      'manual',
    ),
    sqlQuery(
      'customers',
      "select id, name, owner from customers where name ilike {{ '%' + search.value + '%' }} order by id",
    ),
    sqlQuery(
      'insert',
      'insert into customers (name, owner) values ({{ search.value }}, {{ current_user.email }}) returning id, name, owner',
      'manual',
    ),
    sqlQuery('whoami', 'select {{ current_user.email }}::text as email'),
    { name: 'script', kind: 'js', code: 'return 1' },
    ...(extra.queries ?? []),
  ],
  layout: { search: { x: 0, y: 0, w: 4, h: 3 }, table1: { x: 0, y: 3, w: 12, h: 20 } },
})

/** An app with a saved draft; `save` saves the next draft and tracks the revision. */
async function appWith(slug: string, def: object) {
  const created = data(await admin.mutate('apps.create', { slug, name: slug }))
  let revision = 1
  const save = async (next: object) => {
    revision = data(
      await admin.mutate('apps.saveDraft', { id: created.id, revision, definition: next }),
    ).revision
    return revision
  }
  await save(def)
  return { id: created.id as string, slug, save, revision: () => revision }
}

const run = (
  client: ReturnType<typeof trpc>,
  appId: string,
  query: string,
  values: Record<string, unknown> = {},
  opts: { releaseId?: string | null; environmentId?: string } = {},
) =>
  client.mutate('apps.runQuery', {
    appId,
    releaseId: opts.releaseId ?? null,
    query,
    environmentId: opts.environmentId ?? prodId,
    values,
  })

const grantApp = (appId: string, level: 'use' | 'edit' | 'own' | null) =>
  admin.mutate('permissions.set', {
    objectType: 'app',
    objectId: appId,
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
  stagingId = envs.find((e) => e.slug === 'staging')!.id
  memberGroupId = data(await admin.mutate('groups.create', { name: 'Ops' })).id
  await admin.mutate('groups.addMember', { groupId: memberGroupId, userId: memberUser.id })
})
afterAll(async () => {
  await env?.stop()
})

describe('apps: drafts and access', () => {
  it('creates, lists, saves with optimistic concurrency, and hides apps from people without access', async () => {
    const app = await appWith('crm', crudApp())
    expect(failure(await admin.mutate('apps.create', { slug: 'crm', name: 'Again' }))).toMatchObject({
      code: 'CONFLICT',
    })
    expect(failure(await member.mutate('apps.create', { slug: 'mine', name: 'Mine' }))).toMatchObject({
      code: 'FORBIDDEN',
    })

    const got = data(await admin.query('apps.get', { id: app.id }))
    expect(data(await admin.query('apps.get', { slug: 'crm' })).id).toBe(app.id)
    expect(got).toMatchObject({ slug: 'crm', draftRevision: 2, level: 'own', liveRelease: null })
    expect(got.draftHash).toMatch(/^[0-9a-f]{64}$/)
    // Connector checks run on the server: the SQL is fine, so no diagnostics.
    expect(got.diagnostics).toEqual([])

    // A stale revision is refused; a definition off the schema too; an invalid but well-formed one saves.
    expect(
      failure(await admin.mutate('apps.saveDraft', { id: app.id, revision: 1, definition: crudApp() })),
    ).toMatchObject({
      code: 'CONFLICT',
    })
    expect(
      failure(
        await admin.mutate('apps.saveDraft', { id: app.id, revision: 2, definition: { schemaVersion: 1 } }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Invalid app definition') })
    await app.save({
      ...crudApp(),
      components: [{ name: 'x', type: 'text', props: { value: '{{ nope }}' } }],
    })
    const broken = data(await admin.query('apps.get', { id: app.id }))
    expect(broken.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unknown_identifier', entity: 'x' }),
    )
    await app.save(crudApp())

    expect(data(await member.query('apps.list'))).toEqual([])
    expect(failure(await member.query('apps.get', { id: app.id }))).toMatchObject({ code: 'NOT_FOUND' })
    expect(failure(await member.query('apps.open', { slug: 'crm' }))).toMatchObject({ code: 'NOT_FOUND' })

    await grantApp(app.id, 'use')
    expect(
      data(await member.query('apps.list')).map((a: { slug: string; level: string }) => [a.slug, a.level]),
    ).toEqual([['crm', 'use']])
    // Use opens the live release only: no draft, and nothing is published yet.
    expect(failure(await member.query('apps.get', { id: app.id }))).toMatchObject({ code: 'FORBIDDEN' })
    expect(failure(await member.query('apps.open', { slug: 'crm' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: "This app hasn't been published yet",
    })
    expect(
      failure(
        await admin.mutate('permissions.set', {
          objectType: 'app',
          objectId: app.id,
          groupId: memberGroupId,
          environmentId: prodId,
          level: 'use',
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST', message: 'App access applies to every environment' })
    // Only owners manage access.
    expect(
      failure(
        await member.mutate('permissions.set', {
          objectType: 'app',
          objectId: app.id,
          groupId: memberGroupId,
          environmentId: null,
          level: 'own',
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('apps: running queries', () => {
  let app: Awaited<ReturnType<typeof appWith>>
  beforeAll(async () => {
    app = await appWith('people', crudApp())
    expect(data(await run(admin, app.id, 'setup'))).toMatchObject({ ok: true })
  })

  it('binds the values the browser sends as parameters', async () => {
    const evil = "Robert'); drop table customers; --"
    const inserted = data(await run(admin, app.id, 'insert', { ' search.value ': evil }))
    expect(inserted).toMatchObject({ ok: true, data: [{ name: evil, owner: 'admin@optiply.nl' }] })
    await run(admin, app.id, 'insert', { ' search.value ': 'Ada' })
    const found = data(await run(admin, app.id, 'customers', { " '%' + search.value + '%' ": '%robert%' }))
    expect(found.data.map((r: { name: string }) => r.name)).toEqual([evil])
    const all = data(await run(admin, app.id, 'customers', { " '%' + search.value + '%' ": '%' }))
    expect(all.data).toHaveLength(2)
  })

  it('sorts by a column the browser picks, only from the list in the stored query', async () => {
    const column = " sql.column(table1.sort?.column, ['id', 'name'], 'id') "
    const direction = ' sql.direction(table1.sort?.desc) '
    await app.save(
      crudApp({
        queries: [
          sqlQuery('sorted', `select name from customers order by {{${column}}} {{${direction}}}, id`),
          sqlQuery('misused', 'select name from customers order by {{ sql.column(table1.sort, cols) }}'),
        ],
      }),
    )
    const names = async (values: Record<string, unknown>) => data(await run(admin, app.id, 'sorted', values))
    const byName = await names({ [column]: 'name', [direction]: 'DESC' })
    expect(byName).toMatchObject({ ok: true })
    expect(byName.data.map((r: { name: string }) => r.name)[0]).toMatch(/^Robert/)
    expect(
      (await names({ [column]: null, [direction]: 'ASC' })).data.map((r: { name: string }) => r.name),
    ).toEqual([expect.stringMatching(/^Robert/), 'Ada'])
    for (const hostile of ['owner', 'name; drop table customers', '(select 1)', { name: 1 }]) {
      expect(await names({ [column]: hostile, [direction]: 'ASC' })).toMatchObject({
        ok: false,
        error: { code: 'expression', message: expect.stringContaining('expected one of "id", "name"') },
      })
    }
    expect(await names({ [column]: 'name', [direction]: 'asc, owner' })).toMatchObject({
      ok: false,
      error: { code: 'expression' },
    })
    // The server's own check, also shown to whoever edits the app.
    const got = data(await admin.query('apps.get', { id: app.id }))
    expect(got.diagnostics).toContainEqual(
      expect.objectContaining({ entity: 'misused', message: expect.stringContaining('list of strings') }),
    )
    await app.save(crudApp())
  })

  it('evaluates current_user on the server, whatever the browser sends', async () => {
    const who = data(await run(admin, app.id, 'whoami', { ' current_user.email ': 'ceo@optiply.nl' }))
    expect(who).toMatchObject({ ok: true, data: [{ email: 'admin@optiply.nl' }] })
  })

  it('refuses mixed current_user expressions and missing values', async () => {
    await app.save(
      crudApp({ queries: [sqlQuery('mixed', 'select {{ current_user.email + search.value }} as x')] }),
    )
    const mixed = data(await run(admin, app.id, 'mixed', { ' current_user.email + search.value ': 'x' }))
    expect(mixed).toMatchObject({
      ok: false,
      error: { code: 'expression', message: expect.stringContaining('of its own') },
    })
    const missing = data(await run(admin, app.id, 'customers', {}))
    expect(missing).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('reload the app') },
    })
    await app.save(crudApp())
  })

  it('refuses JS queries, unknown queries and unconfigured environments', async () => {
    expect(failure(await run(admin, app.id, 'script'))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(failure(await run(admin, app.id, 'nope'))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'The app has no query named "nope"',
    })
    // Each environment has its own managed schema: staging has no customers table yet.
    const staging = data(
      await run(
        admin,
        app.id,
        'customers',
        { " '%' + search.value + '%' ": '%' },
        { environmentId: stagingId },
      ),
    )
    expect(staging).toMatchObject({ ok: false, error: { message: expect.stringContaining('customers') } })
  })

  it('needs Edit on the app and Use on the resource for the draft', async () => {
    await grantApp(app.id, 'edit')
    expect(failure(await run(member, app.id, 'whoami'))).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('resource "optiply_db"'),
    })
    await grantApp(app.id, 'use')
    expect(failure(await run(member, app.id, 'whoami'))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You need edit access to this app to run its draft',
    })
    await grantApp(app.id, null)
    expect(failure(await run(member, app.id, 'whoami'))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('audits manual queries without their values, and not automatic ones', async () => {
    await run(admin, app.id, 'insert', { ' search.value ': 'secret-ish value' })
    await run(admin, app.id, 'whoami', {})
    const events = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'app.query_run'), eq(auditEvents.objectId, app.id)))
    expect(events.map((e) => e.metadata?.query)).toEqual(['setup', 'insert', 'insert', 'insert'])
    expect(JSON.stringify(events)).not.toContain('secret-ish')
    expect(events.at(-1)!.metadata).toMatchObject({ version: 'draft', ok: true })
  })
})

describe('apps: releases', () => {
  it('publishes with the right checks, serves the live release to Use, and refuses stale releases', async () => {
    const app = await appWith('orders', crudApp())
    data(await run(admin, app.id, 'setup'))
    const publish = (client = admin, extra: object = {}) =>
      client.mutate('apps.publish', { appId: app.id, draftRevision: app.revision(), ...extra })

    // An invalid draft can't be published.
    await app.save({
      ...crudApp(),
      components: [{ name: 'x', type: 'text', props: { value: '{{ nope }}' } }],
    })
    expect(failure(await publish())).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('"nope" is not defined'),
    })
    await app.save(crudApp())

    // Edit on the app isn't enough: the publisher vouches for the resources in every environment.
    await grantApp(app.id, 'edit')
    expect(failure(await publish(member))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You need use access to resource "optiply_db" in every environment to release this app',
    })

    expect(failure(await publish(admin, { draftRevision: 1 }))).toMatchObject({ code: 'CONFLICT' })
    const v1 = data(await publish())
    expect(v1.version).toBe('1.0.0')
    expect(failure(await publish())).toMatchObject({
      code: 'CONFLICT',
      message: 'Nothing changed since the live release, v1.0.0',
    })

    // Use on the app runs the live release's queries, with no grant on the resource.
    await grantApp(app.id, 'use')
    const opened = data(await member.query('apps.open', { slug: 'orders' }))
    expect(opened).toMatchObject({ slug: 'orders', level: 'use', release: { id: v1.id, version: '1.0.0' } })
    expect(opened.release.definition.queries.map((q: { name: string }) => q.name)).toEqual([
      'customers',
      'insert',
      'script',
      'setup',
      'whoami',
    ])
    const inserted = data(
      await run(member, app.id, 'insert', { ' search.value ': 'From member' }, { releaseId: v1.id }),
    )
    expect(inserted).toMatchObject({ ok: true, data: [{ name: 'From member', owner: 'member@optiply.nl' }] })

    // Moving the layout is a change worth releasing; the old release stops running queries.
    await app.save({
      ...crudApp(),
      layout: { search: { x: 1, y: 0, w: 4, h: 3 }, table1: { x: 0, y: 3, w: 12, h: 20 } },
    })
    const v2 = data(await publish(admin, { bump: 'minor', notes: 'Moved search' }))
    expect(v2.version).toBe('1.1.0')
    expect(failure(await run(member, app.id, 'whoami', {}, { releaseId: v1.id }))).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('no longer live'),
    })

    // Rollback.
    expect(failure(await member.mutate('apps.setLive', { appId: app.id, releaseId: v1.id }))).toMatchObject({
      code: 'FORBIDDEN',
    })
    data(await admin.mutate('apps.setLive', { appId: app.id, releaseId: v1.id }))
    expect(data(await member.query('apps.open', { slug: 'orders' })).release.version).toBe('1.0.0')
    const releases = data(await admin.query('apps.releases', { appId: app.id }))
    expect(releases.map((r: { version: string; live: boolean }) => [r.version, r.live])).toEqual([
      ['1.1.0', false],
      ['1.0.0', true],
    ])
    expect(failure(await publish(admin, { version: '1.0.5' }))).toMatchObject({ code: 'CONFLICT' })
  })

  it('deletes an app with its releases and grants', async () => {
    const app = await appWith('gone', crudApp())
    await grantApp(app.id, 'use')
    expect(failure(await member.mutate('apps.delete', { id: app.id }))).toMatchObject({ code: 'FORBIDDEN' })
    data(await admin.mutate('apps.delete', { id: app.id }))
    const left = await env.db.select().from(permissions).where(eq(permissions.objectId, app.id))
    expect(left).toEqual([])
    expect(failure(await admin.query('apps.get', { id: app.id }))).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('apps: folders', () => {
  it('folders per type: managed by who can create that type, listed apart, deleted without what they hold', async () => {
    expect(failure(await member.mutate('folders.create', { name: 'Mine', type: 'app' }))).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You need edit access to all apps to manage their folders',
    })
    const folder = data(await admin.mutate('folders.create', { name: 'Sales apps', type: 'app' }))
    const workflowFolder = data(
      await admin.mutate('folders.create', { name: 'Sales flows', type: 'workflow' }),
    )
    expect(data(await admin.query('folders.list', { type: 'app' }))).toMatchObject({
      canManage: true,
      folders: [{ id: folder.id, name: 'Sales apps', parentId: null }],
    })
    expect(data(await member.query('folders.list', { type: 'app' })).canManage).toBe(false)
    // Resources' folders when no type is given; each type's apart.
    const resourceFolders = data(await admin.query('folders.list')).folders.map((f: { id: string }) => f.id)
    expect(resourceFolders).not.toContain(folder.id)
    expect(data(await admin.query('folders.list', { type: 'workflow' })).folders).toEqual([
      expect.objectContaining({ id: workflowFolder.id }),
    ])
    // A subfolder is of its parent's type.
    expect(
      failure(
        await admin.mutate('folders.create', { name: 'Sub', type: 'app', parentId: workflowFolder.id }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    expect(failure(await member.mutate('folders.rename', { id: folder.id, name: 'X' }))).toMatchObject({
      code: 'FORBIDDEN',
    })
    data(await admin.mutate('folders.rename', { id: folder.id, name: 'Sales' }))
    // App access applies to every environment, through a folder too.
    const grant = (environmentId: string | null) =>
      admin.mutate('permissions.set', {
        objectType: 'folder',
        objectId: folder.id,
        groupId: memberGroupId,
        environmentId,
        level: 'use',
      })
    expect(failure(await grant(prodId))).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'App folder access applies to every environment',
    })
    data(await grant(null))

    // An app in it; deleting the folder leaves the app at the top.
    const app = await appWith('in-folder', crudApp())
    data(await admin.mutate('apps.update', { id: app.id, folderId: folder.id }))
    expect(data(await admin.query('apps.get', { id: app.id })).folderId).toBe(folder.id)
    data(await admin.mutate('folders.delete', { id: folder.id }))
    expect(data(await admin.query('apps.get', { id: app.id })).folderId).toBeNull()
    const [deleted] = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'folder.deleted'), eq(auditEvents.objectId, folder.id)))
    expect(deleted!.metadata).toEqual({ name: 'Sales', type: 'app' })
  })

  it('needs Own to move an app between folders, and only into app folders', async () => {
    const app = await appWith('foldered', crudApp())
    const [resourceFolder] = await env.db
      .insert(folders)
      .values({ objectType: 'resource', name: 'Prod DBs' })
      .returning()
    const [appFolder] = await env.db
      .insert(folders)
      .values({ objectType: 'app', name: 'Ops apps' })
      .returning()
    // The member's group owns the resource folder (and what's in it).
    await admin.mutate('permissions.set', {
      objectType: 'folder',
      objectId: resourceFolder!.id,
      groupId: memberGroupId,
      environmentId: null,
      level: 'own',
    })
    await grantApp(app.id, 'edit')
    // Edit isn't enough to move it: a folder's grants would reach it.
    expect(
      failure(await member.mutate('apps.update', { id: app.id, folderId: resourceFolder!.id })),
    ).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You need own access to this app to move it between folders',
    })
    // Renaming without moving still works with Edit.
    data(await member.mutate('apps.update', { id: app.id, name: 'Renamed' }))
    // Not into a resource folder, even for an owner.
    expect(
      failure(await admin.mutate('apps.update', { id: app.id, folderId: resourceFolder!.id })),
    ).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'No app folder has that id',
    })
    expect(
      failure(
        await admin.mutate('apps.create', {
          slug: 'into-resources',
          name: 'x',
          folderId: resourceFolder!.id,
        }),
      ),
    ).toMatchObject({
      code: 'BAD_REQUEST',
    })
    data(await admin.mutate('apps.update', { id: app.id, folderId: appFolder!.id }))

    // Even if one got there some other way, a resource folder's grants don't reach an app.
    await grantApp(app.id, null)
    await env.db.update(appsTable).set({ folderId: resourceFolder!.id }).where(eq(appsTable.id, app.id))
    expect(failure(await member.query('apps.get', { id: app.id }))).toMatchObject({ code: 'NOT_FOUND' })
    await env.db.update(appsTable).set({ folderId: appFolder!.id }).where(eq(appsTable.id, app.id))
    await admin.mutate('permissions.set', {
      objectType: 'folder',
      objectId: appFolder!.id,
      groupId: memberGroupId,
      environmentId: null,
      level: 'use',
    })
    expect(data(await member.query('apps.list')).find((a: { id: string }) => a.id === app.id)).toMatchObject({
      level: 'use',
    })
  })

  it('needs Own to move a workflow between folders too', async () => {
    const wf = data(await admin.mutate('workflows.create', { slug: 'moved-flow', name: 'Moved' }))
    const [resourceFolder] = await env.db
      .insert(folders)
      .values({ objectType: 'resource', name: 'More DBs' })
      .returning()
    await admin.mutate('permissions.set', {
      objectType: 'workflow',
      objectId: wf.id,
      groupId: memberGroupId,
      environmentId: null,
      level: 'edit',
    })
    expect(
      failure(await member.mutate('workflows.update', { id: wf.id, folderId: resourceFolder!.id })),
    ).toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(
      failure(await admin.mutate('workflows.update', { id: wf.id, folderId: resourceFolder!.id })),
    ).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'No workflow folder has that id',
    })
    const [row] = await env.db.select().from(workflows).where(eq(workflows.id, wf.id))
    expect(row!.folderId).toBeNull()
  })
})

describe('apps: REST queries', () => {
  it('keeps a value from the browser inside its path segment', async () => {
    const seen: string[] = []
    const server = createServer((req: IncomingMessage, res) => {
      seen.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const resource = data(
        await admin.mutate('resources.create', { type: 'rest', name: 'Orders API', slug: 'orders_api' }),
      )
      for (const environmentId of [prodId, stagingId]) {
        data(
          await admin.mutate('resources.saveConfig', {
            resourceId: resource.id,
            environmentId,
            config: { baseUrl: `http://127.0.0.1:${port}/api`, allowPrivateNetwork: true },
          }),
        )
      }
      const app = await appWith('orders-rest', {
        schemaVersion: 1,
        components: [{ name: 'orderId', type: 'textInput' }],
        queries: [
          {
            name: 'getOrder',
            kind: 'resource',
            resource: 'orders_api',
            run: 'manual',
            query: {
              method: 'GET',
              path: '/orders/{{ orderId.value }}',
              params: [{ key: 'q', value: '{{ orderId.value }}' }],
            },
          },
        ],
      })
      const release = data(
        await admin.mutate('apps.publish', { appId: app.id, draftRevision: app.revision() }),
      )
      const evil = '../users/42'
      expect(
        data(await run(admin, app.id, 'getOrder', { ' orderId.value ': evil }, { releaseId: release.id })),
      ).toMatchObject({
        ok: true,
      })
      // One encoded segment in the path; the query string encodes it as usual.
      expect(seen.at(-1)).toBe('/api/orders/..%2Fusers%2F42?q=..%2Fusers%2F42')
      // A plain id goes through unchanged.
      data(await run(admin, app.id, 'getOrder', { ' orderId.value ': 1042 }, { releaseId: release.id }))
      expect(seen.at(-1)).toBe('/api/orders/1042?q=1042')
    } finally {
      server.close()
    }
  })
})
