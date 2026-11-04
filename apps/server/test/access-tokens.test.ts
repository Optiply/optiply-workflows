/**
 * Personal access tokens (M33, docs/architecture.md §2.36): made by a user for the components CLI, shown once,
 * acting as that user within their scope on tRPC (`Authorization: Bearer owpat_…`), revocable, expiring, audited.
 */
import { auditEvents, personalAccessTokens, users } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

describe('personal access tokens', () => {
  let env: TestEnv
  let admin: ReturnType<typeof trpc>
  let member: ReturnType<typeof trpc>

  // biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
  const data = (res: { status: number; body: { result?: { data: any }; error?: { message: string } } }) => {
    if (!res.body.result) throw new Error(`tRPC call failed (${res.status}): ${res.body.error?.message}`)
    return res.body.result.data
  }
  const make = async (as: ReturnType<typeof trpc>, name: string) =>
    data(
      await as.mutate('accessTokens.create', { name, scopes: ['component-libraries'], expiresAt: null }),
    ) as {
      id: string
      token: string
    }
  const withToken = (token: string) => trpc(env.app, undefined, { bearer: token })

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

  it('shows a token once, keeps only its hash, and lists it without the secret', async () => {
    const made = await make(member, 'laptop')
    expect(made.token).toMatch(/^owpat_[A-Za-z0-9_-]{43}$/)
    const [row] = await env.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, made.id))
    expect(row!.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(made.token)
    const listed = data(await member.query('accessTokens.list'))
    expect(listed).toEqual([
      expect.objectContaining({ id: made.id, name: 'laptop', prefix: made.token.slice(0, 14) }),
    ])
    expect(JSON.stringify(listed)).not.toContain(made.token)
    // Only admins see everyone's.
    expect((await member.query('accessTokens.list', { everyone: true })).status).toBe(403)
    expect(data(await admin.query('accessTokens.list', { everyone: true }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: made.id, userEmail: 'member@optiply.nl' })]),
    )
  })

  it('acts as its user on component libraries, and on nothing outside its scope', async () => {
    // With its user's permissions: a member may not create libraries, through a token neither.
    const { token: memberToken } = await make(member, 'cli')
    expect(data(await withToken(memberToken).query('me'))).toMatchObject({ email: 'member@optiply.nl' })
    expect(
      (
        await withToken(memberToken).mutate('componentLibraries.create', {
          slug: 'nope',
          name: 'Nope',
          folderId: null,
        })
      ).body.error?.message,
    ).toContain('You need edit access')
    const { token } = await make(admin, 'cli')
    const cli = withToken(token)
    const created = data(
      await cli.mutate('componentLibraries.create', { slug: 'via-token', name: 'Via token', folderId: null }),
    )
    expect(created.id).toBeTruthy()
    expect((await cli.query('componentLibraries.list')).status).toBe(200)
    const outside = await cli.query('workflows.list')
    expect(outside.status).toBe(403)
    expect(outside.body.error?.message).toContain('outside its scope')
    // Tokens can't make tokens.
    expect(
      (
        await cli.mutate('accessTokens.create', {
          name: 'x',
          scopes: ['component-libraries'],
          expiresAt: null,
        })
      ).status,
    ).toBe(403)
    // What it does is audited as its user, with the token named.
    const [event] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'component_library.created'))
    expect(event!.metadata).toMatchObject({ via: token.slice(0, 14) })
  })

  it('stops working when revoked, expired, unknown, or its user is disabled', async () => {
    const revoked = await make(member, 'revoked')
    data(await member.mutate('accessTokens.revoke', { id: revoked.id }))
    const answer = await withToken(revoked.token).query('componentLibraries.list')
    expect(answer.status).toBe(401)
    expect(answer.body.error?.message).toContain('unknown, revoked or expired')

    const expired = await make(member, 'expired')
    await env.db
      .update(personalAccessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(personalAccessTokens.id, expired.id))
    expect((await withToken(expired.token).query('componentLibraries.list')).status).toBe(401)
    expect((await withToken(`owpat_${'x'.repeat(43)}`).query('componentLibraries.list')).status).toBe(401)

    // Someone else's token: not theirs to revoke (an admin may).
    const other = await make(admin, 'admin-token')
    expect((await member.mutate('accessTokens.revoke', { id: other.id })).status).toBe(404)
    const mine = await make(member, 'to-be-revoked-by-admin')
    data(await admin.mutate('accessTokens.revoke', { id: mine.id }))
    expect((await withToken(mine.token).query('componentLibraries.list')).status).toBe(401)

    const live = await make(member, 'disabled-user')
    expect((await withToken(live.token).query('componentLibraries.list')).status).toBe(200)
    await env.db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, 'member@optiply.nl'))
    expect((await withToken(live.token).query('componentLibraries.list')).status).toBe(401)
    await env.db.update(users).set({ disabledAt: null }).where(eq(users.email, 'member@optiply.nl'))
  })

  it('refuses an expiry in the past, and audits making and revoking', async () => {
    const res = await member.mutate('accessTokens.create', {
      name: 'old',
      scopes: ['component-libraries'],
      expiresAt: '2000-01-01T00:00:00.000Z',
    })
    expect(res.status).toBe(400)
    const actions = (await env.db.select({ action: auditEvents.action }).from(auditEvents)).map(
      (e) => e.action,
    )
    expect(actions).toContain('access_token.created')
    expect(actions).toContain('access_token.revoked')
  })
})
