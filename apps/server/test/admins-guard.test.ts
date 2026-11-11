import { groupMembers, groups, users } from '@ow/db'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let adminsId: string
let first: { id: string; cookie: string }
let second: { id: string; cookie: string }
let disabledId: string

beforeAll(async () => {
  env = await startTestApp()
  const a = await createLocalUser(env.db, 'first@optiply.nl')
  const b = await createLocalUser(env.db, 'second@optiply.nl', { admin: true })
  // An admin who can't sign in: must not count as someone who can let the others back in.
  const c = await createLocalUser(env.db, 'gone@optiply.nl', { admin: true })
  await env.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, c.id))
  first = { id: a.id, cookie: await login(env.app, 'first@optiply.nl') }
  second = { id: b.id, cookie: await login(env.app, 'second@optiply.nl') }
  disabledId = c.id
  const [admins] = await env.db.select().from(groups).where(eq(groups.systemKind, 'admins'))
  adminsId = admins!.id
})
afterAll(() => env?.stop())

const activeAdmins = () =>
  env.db
    .select({ id: users.id })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, adminsId), eq(users.status, 'active'), isNull(users.disabledAt)))

describe('keeping someone able to run the platform', () => {
  it('no admin can take themselves out of Admins, even with other admins around', async () => {
    const res = await trpc(env.app, first.cookie).mutate('groups.removeMember', {
      groupId: adminsId,
      userId: first.id,
    })
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain('remove yourself')
    expect((await activeAdmins()).map((a) => a.id)).toContain(first.id)
  })

  it('two admins removing each other leave one of them in', async () => {
    // Its own start: both admins in, whatever ran before.
    await env.db
      .insert(groupMembers)
      .values([first, second].map((u) => ({ groupId: adminsId, userId: u.id })))
      .onConflictDoNothing()
    const [x, y] = await Promise.all([
      trpc(env.app, first.cookie).mutate('groups.removeMember', { groupId: adminsId, userId: second.id }),
      trpc(env.app, second.cookie).mutate('groups.removeMember', { groupId: adminsId, userId: first.id }),
    ])
    expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1)
    // The disabled admin is still a member but doesn't count: someone who can sign in is left.
    expect(await activeAdmins()).toHaveLength(1)
  })

  it('an admin can still remove other admins, disabled ones included', async () => {
    const left = (await activeAdmins())[0]!.id
    const cookie = left === first.id ? first.cookie : second.cookie
    const res = await trpc(env.app, cookie).mutate('groups.removeMember', {
      groupId: adminsId,
      userId: disabledId,
    })
    expect(res.status).toBe(200)
  })
})
