import { auditEvents, groups } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let adminCookie: string
let memberCookie: string
let memberId: string

beforeAll(async () => {
  env = await startTestApp()
  // First user of the installation becomes admin automatically.
  await createLocalUser(env.db, 'admin@optiply.nl')
  memberId = (await createLocalUser(env.db, 'member@optiply.nl')).id
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
})
afterAll(() => env?.stop())

describe('health and auth', () => {
  it('reports health', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('rejects unauthenticated access to protected procedures', async () => {
    const res = await trpc(env.app).query('groups.list')
    expect(res.status).toBe(401)
    expect((await trpc(env.app).query('me')).body.result?.data).toBeNull()
  })

  it('rejects a wrong password and audits the failure', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/local',
      payload: { email: 'admin@optiply.nl', password: 'nope' },
    })
    expect(res.statusCode).toBe(401)
    const failures = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'auth.login_failed'))
    expect(failures.length).toBeGreaterThan(0)
    expect(JSON.stringify(failures)).not.toContain('nope')
  })

  it('returns the signed-in user, flagging the first user as admin', async () => {
    const admin = (await trpc(env.app, adminCookie).query('me')).body.result?.data
    expect(admin).toMatchObject({ email: 'admin@optiply.nl', isAdmin: true })
    const member = (await trpc(env.app, memberCookie).query('me')).body.result?.data
    expect(member).toMatchObject({ email: 'member@optiply.nl', isAdmin: false })
  })

  it('serves a batch of many tRPC calls in one request (an app running many queries at once)', async () => {
    const calls = Array.from({ length: 40 }, () => 'me')
    const input = encodeURIComponent(JSON.stringify(Object.fromEntries(calls.map((_, i) => [i, {}]))))
    const res = await env.app.inject({
      method: 'GET',
      url: `/api/trpc/${calls.join(',')}?batch=1&input=${input}`,
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(40)
  })

  it('logs out by deleting the session', async () => {
    const cookie = await login(env.app, 'member@optiply.nl')
    await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect((await trpc(env.app, cookie).query('me')).body.result?.data).toBeNull()
  })

  it('keeps OIDC endpoints off when SSO is not configured', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/auth/oidc/start' })
    expect(res.statusCode).toBe(404)
  })
})

describe('groups and permissions', () => {
  it('seeds environments and system groups', async () => {
    const envs = (await trpc(env.app, memberCookie).query('environments.list')).body.result?.data
    expect(envs.map((e: { slug: string }) => e.slug)).toEqual(['production', 'staging'])
    const list = (await trpc(env.app, memberCookie).query('groups.list')).body.result?.data
    expect(list.map((g: { systemKind: string }) => g.systemKind)).toEqual(['admins', 'all_users'])
  })

  it('forbids non-admins from admin procedures', async () => {
    const res = await trpc(env.app, memberCookie).mutate('groups.create', { name: 'Ops' })
    expect(res.status).toBe(403)
    expect((await trpc(env.app, memberCookie).query('audit.list', {})).status).toBe(403)
  })

  it('lets admins manage groups and members, with audit events', async () => {
    const api = trpc(env.app, adminCookie)
    const created = await api.mutate('groups.create', { name: 'Operations' })
    expect(created.status).toBe(200)
    const groupId = created.body.result?.data.id as string

    expect((await api.mutate('groups.create', { name: 'Operations' })).status).toBe(409)
    expect((await api.mutate('groups.addMember', { groupId, userId: memberId })).status).toBe(200)

    const detail = (await api.query('groups.get', { id: groupId })).body.result?.data
    expect(detail.members.map((m: { email: string }) => m.email)).toEqual(['member@optiply.nl'])

    const audit = (await api.query('audit.list', { objectId: groupId })).body.result?.data
    expect(audit.items.map((e: { action: string }) => e.action)).toEqual([
      'group.member_added',
      'group.created',
    ])
    expect(audit.items[0].actor.email).toBe('admin@optiply.nl')
  })

  it('protects built-in groups and keeps admins from removing themselves', async () => {
    const api = trpc(env.app, adminCookie)
    const [admins] = await env.db.select().from(groups).where(eq(groups.systemKind, 'admins'))
    const [allUsers] = await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users'))

    expect((await api.mutate('groups.delete', { id: admins!.id })).status).toBe(400)
    expect(
      (await api.mutate('groups.removeMember', { groupId: allUsers!.id, userId: memberId })).status,
    ).toBe(400)

    const me = (await api.query('me')).body.result?.data
    const res = await api.mutate('groups.removeMember', { groupId: admins!.id, userId: me.id })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain('remove yourself')
  })

  it('disabling a user revokes their sessions', async () => {
    const api = trpc(env.app, adminCookie)
    const cookie = await login(env.app, 'member@optiply.nl')
    expect((await api.mutate('users.setDisabled', { userId: memberId, disabled: true })).status).toBe(200)
    expect((await trpc(env.app, cookie).query('me')).body.result?.data).toBeNull()
    const relogin = await env.app.inject({
      method: 'POST',
      url: '/api/auth/local',
      payload: { email: 'member@optiply.nl', password: 'correct horse battery staple' },
    })
    expect(relogin.statusCode).toBe(401)
    await api.mutate('users.setDisabled', { userId: memberId, disabled: false })
  })
})
