import { auditEvents, folders, users } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAccess } from '../src/services/permissions'
import { systemGroupId } from '../src/services/users'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

/**
 * People whose access is apps only (users.access = 'apps_only'): admins approve or invite them that way or switch
 * them later; they use the apps given to them (directly or through a group, never All Users' default sharing), at
 * most Use, and nothing else of the platform answers them.
 */
let env: TestEnv
let admin: ReturnType<typeof trpc>
let partner: ReturnType<typeof trpc>
let partnerCookie: string
let adminId: string
let partnerId: string
let prodId: string
let shared: { id: string; slug: string; releaseId: string }
let other: { id: string; slug: string; releaseId: string }

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

const appDef = {
  schemaVersion: 1,
  components: [],
  queries: [
    { name: 'one', kind: 'resource', resource: 'optiply_db', query: { sql: 'select 1 as one' }, run: 'auto' },
  ],
  layout: {},
}

/** A published app (made by an admin: shared with All Users by default). */
async function publishedApp(slug: string, folderId?: string) {
  const created = data(await admin.mutate('apps.create', { slug, name: slug, ...(folderId && { folderId }) }))
  const { revision } = data(
    await admin.mutate('apps.saveDraft', { id: created.id, revision: 1, definition: appDef }),
  )
  const release = data(await admin.mutate('apps.publish', { appId: created.id, draftRevision: revision }))
  return { id: created.id as string, slug, releaseId: release.id as string }
}

const runOne = (client: ReturnType<typeof trpc>, app: { id: string; releaseId: string }) =>
  client.mutate('apps.runQuery', {
    appId: app.id,
    releaseId: app.releaseId,
    query: 'one',
    environmentId: prodId,
    values: {},
  })

const listedSlugs = async (client: ReturnType<typeof trpc>) =>
  (data(await client.query('apps.list')) as { slug: string; level: string }[]).map(
    (a) => `${a.slug}:${a.level}`,
  )

beforeAll(async () => {
  env = await startTestApp({ SHARE_NEW_WITH_EVERYONE: 'true' })
  adminId = (await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })).id
  partnerId = (await createLocalUser(env.db, 'partner@optiply.nl')).id
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  partnerCookie = await login(env.app, 'partner@optiply.nl')
  partner = trpc(env.app, partnerCookie)
  const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  shared = await publishedApp('stock-report')
  other = await publishedApp('finance')
  data(await admin.mutate('workflows.create', { slug: 'nightly', name: 'Nightly' }))
  // Edit on the one app, given to them directly.
  data(
    await admin.mutate('permissions.set', {
      objectType: 'app',
      objectId: shared.id,
      userId: partnerId,
      environmentId: null,
      level: 'edit',
    }),
  )
})
afterAll(() => env?.stop())

describe('apps only', () => {
  it('starts as the whole platform: everything shared with everyone shows', async () => {
    const me = data(await partner.query('me'))
    expect(me).toMatchObject({ appsOnly: false, sections: { workflows: true, apps: true } })
    expect(await listedSlugs(partner)).toEqual(['finance:use', 'stock-report:edit'])
  })

  it('an admin switches them to apps only: it counts from their next request, and is audited', async () => {
    data(await admin.mutate('users.setAccess', { userId: partnerId, access: 'apps_only' }))
    const me = data(await partner.query('me'))
    expect(me.appsOnly).toBe(true)
    expect(Object.values(me.sections).every((on) => on === false)).toBe(true)
    expect(Object.values(me.canCreate).every((on) => on === false)).toBe(true)
    const [event] = await env.db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'user.access_changed'), eq(auditEvents.objectId, partnerId)))
    expect(event?.metadata).toMatchObject({ email: 'partner@optiply.nl', from: 'full', to: 'apps_only' })
    const listed = data(await admin.query('users.list')) as { email: string; access: string }[]
    expect(listed.find((u) => u.email === 'partner@optiply.nl')?.access).toBe('apps_only')
  })

  it('only the apps given to them, not All Users’ default sharing, and at most Use', async () => {
    expect(await listedSlugs(partner)).toEqual(['stock-report:use'])
    expect(data(await partner.query('apps.access', { slug: 'stock-report' }))).toMatchObject({
      level: 'use',
      published: true,
    })
    expect(data(await partner.query('apps.access', { slug: 'finance' }))).toMatchObject({ level: null })
  })

  it('opens and uses that app; not the other, and not its editor', async () => {
    expect(data(await partner.query('apps.open', { slug: 'stock-report' })).release.id).toBe(shared.releaseId)
    expect(data(await runOne(partner, shared))).toMatchObject({ ok: true, data: [{ one: 1 }] })
    expect(failure(await partner.query('apps.open', { slug: 'finance' })).code).toMatch(/NOT_FOUND|FORBIDDEN/)
    expect(failure(await runOne(partner, other)).code).toMatch(/NOT_FOUND|FORBIDDEN/)
    expect(failure(await partner.query('apps.get', { slug: 'stock-report' })).code).toBe('FORBIDDEN')
  })

  it('nothing else of the platform answers them', async () => {
    for (const path of [
      'workflows.list',
      'resources.list',
      'folders.list',
      'users.directory',
      'tasks.openCount',
      'groups.list',
      'configVars.list',
    ]) {
      expect({ path, ...failure(await partner.query(path)) }).toEqual({
        path,
        code: 'FORBIDDEN',
        message: 'Your account can only use the apps shared with you',
      })
    }
    // Workflows reach nobody apps only, whatever All Users holds.
    const access = await loadAccess(env.db, { id: partnerId, isAdmin: false })
    expect(access.reaches('workflow')).toBe(false)
    expect(access.canShare).toBe(false)
  })

  it('nor do the REST API, the database export or live collaboration on the app’s draft', async () => {
    const runs = await env.app.inject({
      method: 'GET',
      url: '/api/v1/runs',
      headers: { cookie: partnerCookie },
    })
    expect(runs.statusCode).toBe(403)
    expect(runs.json().error.message).toBe('Your account can only use the apps shared with you')
    const csv = await env.app.inject({
      method: 'GET',
      url: `/api/v1/database/export.csv?environmentId=${prodId}&table=x`,
      headers: { cookie: partnerCookie },
    })
    expect(csv.statusCode).toBe(403)
    // The draft of the very app they use: watching it is the editor's, not theirs.
    const base = (await env.app.listen({ port: 0, host: '127.0.0.1' })).replace('http', 'ws')
    const ws = new WebSocket(`${base}/api/collab/app:${shared.id}`, {
      headers: { cookie: partnerCookie },
    } as never)
    const ended = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason })
    })
    expect(ended).toEqual({ code: 4403, reason: 'Your account can only use the apps shared with you' })
  })

  it('owners see them in the directory as apps only', async () => {
    const people = data(await admin.query('users.directory')) as { email: string; appsOnly: boolean }[]
    expect(people.find((p) => p.email === 'partner@optiply.nl')?.appsOnly).toBe(true)
    expect(people.find((p) => p.email === 'admin@optiply.nl')?.appsOnly).toBe(false)
  })

  it('a group’s grant counts (not All Users’), and an app folder’s', async () => {
    const group = data(await admin.mutate('groups.create', { name: 'Partners' }))
    data(await admin.mutate('groups.addMember', { groupId: group.id, userId: partnerId }))
    data(
      await admin.mutate('permissions.set', {
        objectType: 'app',
        objectId: other.id,
        groupId: group.id,
        environmentId: null,
        level: 'own',
      }),
    )
    expect(await listedSlugs(partner)).toEqual(['finance:use', 'stock-report:use'])

    const [folder] = await env.db
      .insert(folders)
      .values({ name: 'Reports', objectType: 'app' })
      .returning({ id: folders.id })
    const inFolder = await publishedApp('weekly', folder!.id)
    expect(await listedSlugs(partner)).not.toContain('weekly:use')
    data(
      await admin.mutate('permissions.set', {
        objectType: 'folder',
        objectId: folder!.id,
        groupId: group.id,
        environmentId: null,
        level: 'use',
      }),
    )
    expect(await listedSlugs(partner)).toContain('weekly:use')
    expect(data(await runOne(partner, inFolder))).toMatchObject({ ok: true })
  })

  it('back to the whole platform: everything returns as it was', async () => {
    data(await admin.mutate('users.setAccess', { userId: partnerId, access: 'full' }))
    expect(data(await partner.query('me')).appsOnly).toBe(false)
    expect(data(await partner.query('workflows.list'))).toEqual([
      expect.objectContaining({ slug: 'nightly' }),
    ])
    expect(await listedSlugs(partner)).toContain('stock-report:edit')
  })
})

describe('admins stay admins', () => {
  it("an admin can't be made apps only, nor can you change your own access", async () => {
    const other = await createLocalUser(env.db, 'admin2@optiply.nl', { admin: true })
    expect(failure(await admin.mutate('users.setAccess', { userId: other.id, access: 'apps_only' }))).toEqual(
      {
        code: 'BAD_REQUEST',
        message: expect.stringContaining("can't be in Admins and have access to apps only"),
      },
    )
    expect(failure(await admin.mutate('users.setAccess', { userId: adminId, access: 'apps_only' }))).toEqual({
      code: 'BAD_REQUEST',
      message: 'You cannot change your own access',
    })
  })

  it("someone apps only can't be added to Admins; an ordinary group is fine", async () => {
    const someone = await createLocalUser(env.db, 'viewer@optiply.nl')
    data(await admin.mutate('users.setAccess', { userId: someone.id, access: 'apps_only' }))
    const adminsId = await systemGroupId(env.db, 'admins')
    expect(
      failure(await admin.mutate('groups.addMember', { groupId: adminsId, userId: someone.id })),
    ).toEqual({
      code: 'BAD_REQUEST',
      message: expect.stringContaining("can't be in Admins and have access to apps only"),
    })
  })

  it('approve and invite take the access; not apps only with Admins', async () => {
    const waiting = await createLocalUser(env.db, 'waiting@optiply.nl')
    await env.db.update(users).set({ status: 'pending' }).where(eq(users.id, waiting.id))
    const adminsId = await systemGroupId(env.db, 'admins')
    expect(
      failure(
        await admin.mutate('users.approve', {
          userId: waiting.id,
          groupIds: [adminsId],
          access: 'apps_only',
        }),
      ).code,
    ).toBe('BAD_REQUEST')
    data(await admin.mutate('users.approve', { userId: waiting.id, access: 'apps_only' }))
    const invited = data(
      await admin.mutate('users.invite', { email: 'guest@example.com', access: 'apps_only' }),
    )
    const rows = await env.db.select({ id: users.id, access: users.access, status: users.status }).from(users)
    expect(rows.find((r) => r.id === waiting.id)).toMatchObject({ access: 'apps_only', status: 'active' })
    expect(rows.find((r) => r.id === invited.id)).toMatchObject({ access: 'apps_only', status: 'invited' })
    // The default stays the whole platform.
    const plain = data(await admin.mutate('users.invite', { email: 'plain@example.com' }))
    expect((await env.db.select().from(users).where(eq(users.id, plain.id)))[0]?.access).toBe('full')
  })
})
