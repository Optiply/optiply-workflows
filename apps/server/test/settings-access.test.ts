import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// Session 54: admin powers, and Settings with them, are for Optiply's admins (the sign-in domain) only. A member
// of Admins from outside the domain (an invited partner) is an ordinary user.
let env: TestEnv
const cookies: Record<string, string> = {}

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'boss@optiply.nl', { admin: true })
  await createLocalUser(env.db, 'member@optiply.nl')
  await createLocalUser(env.db, 'partner@partner.example', { admin: true })
  for (const email of ['boss@optiply.nl', 'member@optiply.nl', 'partner@partner.example'])
    cookies[email] = await login(env.app, email)
})
afterAll(() => env?.stop())

const as = (email: string) => trpc(env.app, cookies[email])
const me = async (email: string) => {
  const res = await as(email).query('me')
  expect(res.status).toBe(200)
  return res.body.result!.data as { isAdmin: boolean; settings: boolean }
}

describe('who is an admin, and sees Settings', () => {
  it('an admin from Optiply', async () => {
    expect(await me('boss@optiply.nl')).toMatchObject({ isAdmin: true, settings: true })
    expect((await as('boss@optiply.nl').query('users.list')).status).toBe(200)
  })

  it('a member from Optiply is not', async () => {
    expect(await me('member@optiply.nl')).toMatchObject({ isAdmin: false, settings: false })
  })

  it('a member of Admins from outside Optiply is not: admin-only calls are refused', async () => {
    expect(await me('partner@partner.example')).toMatchObject({ isAdmin: false, settings: false })
    const res = await as('partner@partner.example').query('users.list')
    expect(res.status).toBe(403)
    expect(res.body.error?.message).toContain('Admins only')
  })

  it('…and objects not shared with them stay out of reach', async () => {
    const created = await as('boss@optiply.nl').mutate('workflows.create', {
      slug: 'private',
      name: 'Private',
    })
    expect(created.status).toBe(200)
    const list = await as('partner@partner.example').query('workflows.list')
    expect(list.status).toBe(200)
    expect((list.body.result!.data as { slug: string }[]).map((w) => w.slug)).not.toContain('private')
  })
})
