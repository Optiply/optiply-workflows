import { auditEvents, users } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/password'
import { provisionUser, signInDecision } from '../src/services/users'
import { createLocalUser, login, PASSWORD, startTestApp, type TestEnv, trpc } from './helpers'

/** New users wait for an admin; outsiders come in by invitation (session 44, step 4). */

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>

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

const loginStatus = async (email: string) =>
  (await env.app.inject({ method: 'POST', url: '/api/auth/local', payload: { email, password: PASSWORD } }))
    .statusCode

/** A first sign-in as the Google callback makes it: a waiting account (with a password, to try signing in). */
const request = async (email: string) =>
  provisionUser(
    env.db,
    { email, name: email.split('@')[0]!, passwordHash: await hashPassword(PASSWORD) },
    {
      status: 'pending',
    },
  )

const actions = async (userId: string) =>
  (
    await env.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.objectId, userId))
  ).map((r) => r.action)

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
})
afterAll(async () => {
  await env?.stop()
})

describe('signInDecision', () => {
  const decide = (email: string, existing: Parameters<typeof signInDecision>[0]['existing'], hd?: string) =>
    signInDecision({ email, domain: 'optiply.nl', hd, existing })

  it('lets in the domain and anyone already known; refuses outsiders, disabled and rejected accounts', () => {
    expect(decide('new@optiply.nl', null)).toEqual({ ok: true })
    expect(decide('new@optiply.nl', null, 'other.com')).toMatchObject({ ok: false })
    expect(decide('stranger@gmail.com', null)).toEqual({
      ok: false,
      reason: 'Only @optiply.nl accounts or invited people can sign in',
    })
    expect(decide('guest@partner.com', { status: 'invited', disabled: false }, 'partner.com')).toEqual({
      ok: true,
    })
    expect(decide('guest@partner.com', { status: 'active', disabled: false })).toEqual({ ok: true })
    expect(decide('waiting@optiply.nl', { status: 'pending', disabled: false })).toEqual({ ok: true })
    expect(decide('no@optiply.nl', { status: 'rejected', disabled: false })).toMatchObject({ ok: false })
    expect(decide('off@optiply.nl', { status: 'active', disabled: true })).toEqual({
      ok: false,
      reason: 'Your account has been disabled',
    })
  })
})

describe('approval', () => {
  it('a first sign-in waits; an admin approves into groups; then they can sign in', async () => {
    const asked = await request('newbie@optiply.nl')
    expect(asked).toMatchObject({ created: true, status: 'pending' })
    expect(await loginStatus('newbie@optiply.nl')).toBe(401)
    expect(data(await admin.query('users.pendingCount'))).toBeGreaterThanOrEqual(1)
    const listed = data(await admin.query('users.list')).find(
      (u: { email: string }) => u.email === 'newbie@optiply.nl',
    )
    expect(listed).toMatchObject({ status: 'pending', requestedAt: expect.anything() })
    // Signing in again while waiting doesn't make a second account or change anything.
    expect(await request('newbie@optiply.nl')).toMatchObject({ created: false, status: 'pending' })

    const ops = data(await admin.mutate('groups.create', { name: 'Ops' })).id
    expect(
      failure(await member.mutate('users.approve', { userId: asked.id, groupIds: [ops] })),
    ).toMatchObject({
      code: 'FORBIDDEN',
    })
    data(await admin.mutate('users.approve', { userId: asked.id, groupIds: [ops] }))
    expect(await loginStatus('newbie@optiply.nl')).toBe(200)
    const after = data(await admin.query('users.list')).find(
      (u: { email: string }) => u.email === 'newbie@optiply.nl',
    )
    expect(after.status).toBe('active')
    expect(after.groups.map((g: { name: string }) => g.name).sort()).toEqual(['All Users', 'Ops'])
    expect(await actions(asked.id)).toContain('user.approved')
    // Approving someone already in is refused.
    expect(failure(await admin.mutate('users.approve', { userId: asked.id }))).toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('a rejected person can’t sign in, nor ask again; approving later still works', async () => {
    const asked = await request('nope@optiply.nl')
    data(await admin.mutate('users.reject', { userId: asked.id }))
    expect(await loginStatus('nope@optiply.nl')).toBe(401)
    expect(await request('nope@optiply.nl')).toMatchObject({ status: 'rejected' })
    data(await admin.mutate('users.approve', { userId: asked.id }))
    expect(await loginStatus('nope@optiply.nl')).toBe(200)
    expect(await actions(asked.id)).toEqual(expect.arrayContaining(['user.rejected', 'user.approved']))
  })

  it('a waiting person’s session or token never works, even if one existed', async () => {
    const asked = await request('limbo@optiply.nl')
    data(await admin.mutate('users.approve', { userId: asked.id }))
    const cookie = await login(env.app, 'limbo@optiply.nl')
    expect(data(await trpc(env.app, cookie).query('me'))).toMatchObject({ email: 'limbo@optiply.nl' })
    // Back to waiting (as a reset would leave them): the cookie stops working.
    await env.db.update(users).set({ status: 'pending' }).where(eq(users.id, asked.id))
    expect(data(await trpc(env.app, cookie).query('me'))).toBeNull()
  })

  it('the CLI’s accounts and the first person of an installation are active', async () => {
    const made = await createLocalUser(env.db, 'cli@optiply.nl')
    expect(made.status).toBe('active')
  })
})

describe('invitations', () => {
  it('an outsider invited into a group is in at their first sign-in, with that group', async () => {
    const guests = data(await admin.mutate('groups.create', { name: 'Guests' })).id
    const { id } = data(
      await admin.mutate('users.invite', { email: 'Guest@Partner.com', name: 'Guest', groupIds: [guests] }),
    )
    const listed = data(await admin.query('users.list')).find((u: { id: string }) => u.id === id)
    expect(listed).toMatchObject({
      email: 'guest@partner.com',
      status: 'invited',
      invitedBy: expect.any(String),
    })
    expect(listed.groups.map((g: { name: string }) => g.name).sort()).toEqual(['All Users', 'Guests'])
    // Not in the directory (owners share with people who can sign in) until they're in.
    expect(data(await member.query('users.directory')).some((u: { id: string }) => u.id === id)).toBe(false)

    const first = await provisionUser(env.db, {
      email: 'guest@partner.com',
      name: 'Guest Person',
      oidcSubject: 'g-1',
    })
    expect(first).toMatchObject({ id, created: false, status: 'active' })
    expect(data(await member.query('users.directory')).some((u: { id: string }) => u.id === id)).toBe(true)
    expect(await actions(id)).toContain('user.invited')
  })

  it('refuses an address that already has an account or a request, and only admins invite', async () => {
    expect(failure(await admin.mutate('users.invite', { email: 'member@optiply.nl' }))).toMatchObject({
      code: 'CONFLICT',
      message: 'member@optiply.nl has an account already',
    })
    await request('asking@optiply.nl')
    expect(failure(await admin.mutate('users.invite', { email: 'asking@optiply.nl' }))).toMatchObject({
      code: 'CONFLICT',
      message: 'asking@optiply.nl is waiting for approval: approve them instead',
    })
    expect(failure(await member.mutate('users.invite', { email: 'x@y.com' }))).toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('an invitation can be withdrawn until it’s taken up', async () => {
    const { id } = data(await admin.mutate('users.invite', { email: 'maybe@partner.com' }))
    data(await admin.mutate('users.cancelInvite', { userId: id }))
    expect(data(await admin.query('users.list')).some((u: { id: string }) => u.id === id)).toBe(false)
    const member2 = data(await admin.query('users.list')).find(
      (u: { email: string }) => u.email === 'member@optiply.nl',
    )
    expect(failure(await admin.mutate('users.cancelInvite', { userId: member2.id }))).toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
})
