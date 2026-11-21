/**
 * Custom auth flows on the server: signing in on first use and storing the variables encrypted, reusing them,
 * signing in again when they run out, refreshing on a 401 (falling back to signing in), one sign-in at a time
 * across processes, and through the playground, Test connection and saving the settings; the status card's state,
 * Sign in now and Sign out, and the failures it shows.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { restConnector } from '@ow/connectors'
import { startTestGraphql } from '@ow/connectors/testing'
import { environments, oauthTokens, resourceConfigs } from '@ow/db'
import { IvmRuntime } from '@ow/sandbox'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { customAuthCredentials } from '../src/services/custom-auth'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let prodId: string
const sandbox = new IvmRuntime()

let api: Server
let origin: string
let logins = 0
let refusedLogins = 0
let refreshes = 0
const sessions = new Set<string>()
const refreshTokens = new Set<string>()
let loginDelayMs = 0

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'))
  const envs = (await admin.query('environments.list')).body.result!.data as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id

  api = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url === '/api/login') {
      const { user, password } = JSON.parse(body || '{}')
      await new Promise((r) => setTimeout(r, loginDelayMs))
      if (user !== 'ada' || password !== 'Pw-S3cret-777') {
        refusedLogins++
        return send(401, { error: 'bad credentials' })
      }
      logins++
      const session = `Session-${logins}-${'s'.repeat(10)}`
      sessions.add(session)
      refreshTokens.add(`refresh-${logins}`)
      return send(200, { session, refresh: `refresh-${logins}` })
    }
    if (req.url === '/api/refresh') {
      const { refresh } = JSON.parse(body || '{}')
      if (!refreshTokens.has(refresh)) return send(401, { error: 'refresh expired' })
      refreshes++
      const session = `Renewed-${refreshes}-${'r'.repeat(10)}`
      sessions.add(session)
      return send(200, { session })
    }
    if (req.url === '/api/echo-fail') return send(400, { seen: req.headers['x-key'] })
    if (!sessions.has(String(req.headers['x-session']))) return send(401, { error: 'no session' })
    send(200, { ok: true, session: req.headers['x-session'] })
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(async () => {
  sandbox.dispose()
  await new Promise((r) => api?.close(r))
  await env?.stop()
})
beforeEach(() => {
  loginDelayMs = 0
})

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { body: { result?: { data: unknown } } }): any => {
  if (!res.body.result) throw new Error(`tRPC call failed: ${JSON.stringify(res.body)}`)
  return res.body.result.data
}

const signInSteps = [
  {
    type: 'request',
    name: 'login',
    method: 'POST',
    path: 'login',
    body: { type: 'json', json: '{"user": {{ secrets.user }}, "password": {{ secrets.password }}}' },
  },
  { type: 'variable', name: 'session', value: '{{ login.data.session }}' },
  { type: 'variable', name: 'refresh', value: '{{ login.data.refresh }}' },
]
const refreshSteps = [
  {
    type: 'request',
    name: 'renew',
    method: 'POST',
    path: 'refresh',
    body: { type: 'json', json: '{"refresh": {{ auth.refresh }}}' },
  },
  { type: 'variable', name: 'session', value: '{{ renew.data.session }}' },
]

const flowConfig = (auth: Record<string, unknown> = {}) => ({
  baseUrl: `${origin}/api`,
  allowPrivateNetwork: true,
  headers: [{ key: 'x-session', value: '{{ auth.session }}' }],
  auth: { type: 'custom', steps: signInSteps, refreshSteps, ...auth },
})

/** A REST resource with a custom flow, configured in production through the API. */
async function flowResource(slug: string, auth: Record<string, unknown> = {}) {
  const id = data(await admin.mutate('resources.create', { type: 'rest', name: slug, slug })).id as string
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: id,
      environmentId: prodId,
      config: flowConfig(auth),
      secrets: { values: { user: 'ada', password: 'Pw-S3cret-777' } },
    }),
  )
  const [row] = await env.db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, id))
  return { id, row: row! }
}

function source(row: { id: string; resourceId: string; config: unknown }, store = true) {
  return customAuthCredentials(
    { db: env.db, keyring: env.config.keyring, sandbox },
    {
      resourceId: row.resourceId,
      userId: null,
      resourceConfigId: row.id,
      environmentId: prodId,
      config: restConnector.configSchema.parse(row.config),
      secrets: restConnector.secretsSchema.parse({ values: { user: 'ada', password: 'Pw-S3cret-777' } }),
      store,
    },
  )
}
const session = async (s: ReturnType<typeof source>, force = false) =>
  (await s.authVariables!({ signal: AbortSignal.timeout(10_000), force })).evaluate('auth.session')
const stored = (configId: string) =>
  env.db.select().from(oauthTokens).where(eq(oauthTokens.resourceConfigId, configId))

describe('signing in', () => {
  it('signs in on first use, stores the variables encrypted, and reuses them', async () => {
    const { row } = await flowResource('flow_store')
    const before = logins
    const first = await session(source(row))
    expect(first).toMatch(/^Session-/)
    expect(logins).toBe(before + 1)
    const [saved] = await stored(row.id)
    expect(saved).toMatchObject({ userId: null, status: 'active', expiresAt: null })
    expect(saved!.tokens).toMatch(/^v1\./)
    expect(JSON.stringify(saved)).not.toMatch(/Session-|refresh-/)

    // Another process (another source) uses what's stored.
    expect(await session(source(row))).toBe(first)
    expect(logins).toBe(before + 1)
  })

  it('signs in again once ttlSeconds runs out', async () => {
    const { row } = await flowResource('flow_ttl', { ttlSeconds: 600 })
    const before = logins
    await session(source(row))
    const [saved] = await stored(row.id)
    expect(saved!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 590_000)
    await env.db
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.id, saved!.id))
    await session(source(row))
    expect(logins).toBe(before + 2)
  })

  it('signs in once when several processes need it at the same time', async () => {
    const { row } = await flowResource('flow_race')
    const before = logins
    loginDelayMs = 200
    const values = await Promise.all(Array.from({ length: 5 }, () => session(source(row))))
    expect(new Set(values).size).toBe(1)
    expect(logins).toBe(before + 1)
  })

  it('refreshes on a 401 with the refresh steps, once, and signs in again if they fail', async () => {
    const { row } = await flowResource('flow_refresh')
    const sources = [source(row), source(row), source(row)]
    const first = await Promise.all(sources.map((s) => session(s)))
    const loginsBefore = logins
    const refreshesBefore = refreshes

    const renewed = await Promise.all(sources.map((s) => session(s, true)))
    expect(new Set(renewed).size).toBe(1)
    // A query that got the variables before someone refreshed them, refused too, uses theirs (no second refresh).
    const late = source(row)
    await session(late)
    await env.db
      .update(oauthTokens)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(oauthTokens.resourceConfigId, row.id))
    expect(await session(late, true)).toBe(renewed[0])
    expect(renewed[0]).toMatch(/^Renewed-/)
    expect(renewed[0]).not.toBe(first[0])
    expect(refreshes).toBe(refreshesBefore + 1)
    expect(logins).toBe(loginsBefore)
    // The refresh kept the variables it didn't change.
    const vars = await sources[0]!.authVariables!({ signal: AbortSignal.timeout(5000) })
    expect(await vars.evaluate('auth.refresh')).toMatch(/^refresh-/)

    // The refresh token stops working: a refresh falls back to signing in.
    refreshTokens.clear()
    const again = source(row)
    await session(again)
    expect(await session(again, true)).toMatch(/^Session-/)
    expect(logins).toBe(loginsBefore + 1)
  })

  it('reports a failing sign-in without storing anything, backs off, and tries again once the secrets change', async () => {
    const { row } = await flowResource('flow_fail')
    const bad = customAuthCredentials(
      { db: env.db, keyring: env.config.keyring, sandbox },
      {
        resourceId: row.resourceId,
        userId: null,
        resourceConfigId: row.id,
        environmentId: prodId,
        config: restConnector.configSchema.parse(row.config),
        secrets: restConnector.secretsSchema.parse({ values: { user: 'ada', password: 'wrong' } }),
        store: true,
      },
    )
    const refusedBefore = refusedLogins
    await expect(bad.authVariables!({ signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({
      code: 'auth_required',
      details: { reason: 'flow_failed', step: 'login', status: 401 },
    })
    expect(await stored(row.id)).toEqual([])
    // The next query doesn't send the wrong password again while the back-off lasts (5 s after one failure).
    await expect(bad.authVariables!({ signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({
      code: 'auth_required',
      message: expect.stringMatching(
        /^Signing in failed at step "login": .*\(failed 1 time in a row; signing in again in [1-5] s\)$/,
      ),
      details: { reason: 'flow_failed', step: 'login', retryAt: expect.any(String) },
    })
    expect(refusedLogins).toBe(refusedBefore + 1)
    // The password fixed (other secrets): signed in at once.
    expect(await session(source(row))).toMatch(/^Session-/)
  })

  it('scrubs secret variables only', async () => {
    const { row } = await flowResource('flow_public', {
      steps: [...signInSteps, { type: 'variable', name: 'tenant', value: 'acme-prod', secret: false }],
    })
    const vars = await source(row).authVariables!({ signal: AbortSignal.timeout(5000) })
    expect(vars.secrets).not.toContain('acme-prod')
    expect(vars.secrets.some((v) => v.startsWith('Session-'))).toBe(true)
    expect(await vars.evaluate('auth.tenant')).toBe('acme-prod')
  })

  it('keeps a failed sign-in on the row for the status card, scrubbed, and stops using its variables', async () => {
    const { row } = await flowResource('flow_failure_kept')
    await session(source(row))
    const [before] = await stored(row.id)
    // The same config, now with a step that fails and says the password.
    const failing = customAuthCredentials(
      { db: env.db, keyring: env.config.keyring, sandbox },
      {
        resourceId: row.resourceId,
        userId: null,
        resourceConfigId: row.id,
        environmentId: prodId,
        config: restConnector.configSchema.parse(
          flowConfig({
            steps: [
              ...signInSteps,
              { type: 'code', name: 'check', code: 'throw new Error("refused for " + secrets.password)' },
            ],
          }),
        ),
        secrets: restConnector.secretsSchema.parse({ values: { user: 'ada', password: 'Pw-S3cret-777' } }),
        store: true,
      },
    )
    await expect(failing.authVariables!({ signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({
      code: 'auth_required',
      details: { step: 'check' },
    })
    const [after] = await stored(row.id)
    expect(after).toMatchObject({ status: 'reconnect', updatedAt: before!.updatedAt })
    expect(after!.lastError).toBe('Signing in failed at step "check": refused for [REDACTED]')

    // The working flow can't use those variables any more: it signs in, and the failure is cleared.
    const loginsBefore = logins
    expect(await session(source(row))).toMatch(/^Session-/)
    expect(logins).toBe(loginsBefore + 1)
    expect((await stored(row.id))[0]).toMatchObject({ status: 'active', lastError: null })
  })

  it('keeps unsaved test sign-ins in memory', async () => {
    const { row } = await flowResource('flow_memory')
    const s = source(row, false)
    const value = await session(s)
    expect(await session(s)).toBe(value)
    expect(await stored(row.id)).toEqual([])
  })
})

describe('through the API', () => {
  it('runs playground queries with the variables, and Test connection signs in', async () => {
    const { id } = await flowResource('flow_api')
    const run = data(
      await admin.mutate('resources.run', { resourceId: id, environmentId: prodId, query: { path: 'data' } }),
    )
    expect(run).toMatchObject({ ok: true, data: { ok: true, session: '[REDACTED]' } })

    // The API ends every session: the playground refreshes and retries.
    sessions.clear()
    expect(
      data(
        await admin.mutate('resources.run', {
          resourceId: id,
          environmentId: prodId,
          query: { path: 'data' },
        }),
      ),
    ).toMatchObject({ ok: true })

    const test = data(
      await admin.mutate('resources.test', {
        resourceId: id,
        environmentId: prodId,
        config: {
          ...flowConfig(),
          baseUrl: `${origin}/api/data`,
          auth: {
            type: 'custom',
            steps: signInSteps.map((s) => (s.type === 'request' ? { ...s, path: `${origin}/api/login` } : s)),
          },
        },
      }),
    )
    expect(test).toMatchObject({ ok: true, message: 'HTTP 200 OK' })

    const wrong = data(
      await admin.mutate('resources.test', {
        resourceId: id,
        environmentId: prodId,
        secrets: { values: { user: 'ada', password: 'nope' } },
      }),
    )
    expect(wrong).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'flow_failed', step: 'login' } },
    })
    expect(JSON.stringify(wrong)).not.toContain('Pw-S3cret-777')
  })

  it('drops the stored variables when the flow changes, not for other settings', async () => {
    const { id, row } = await flowResource('flow_save')
    await session(source(row))
    expect(await stored(row.id)).toHaveLength(1)
    const save = (config: unknown) =>
      admin.mutate('resources.saveConfig', { resourceId: id, environmentId: prodId, config })
    data(
      await save({
        ...flowConfig(),
        headers: [
          { key: 'x-session', value: '{{ auth.session }}' },
          { key: 'x-extra', value: '1' },
        ],
      }),
    )
    expect(await stored(row.id)).toHaveLength(1)
    data(
      await save(
        flowConfig({
          ttlSeconds: 60,
          steps: [...signInSteps, { type: 'variable', name: 'extra', value: 'x' }],
        }),
      ),
    )
    expect(await stored(row.id)).toEqual([])
  })

  it('shows the status card, signs in now, keeps the last failure and signs out', async () => {
    const { id, row } = await flowResource('flow_card')
    const status = async () =>
      data(await admin.query('resources.customAuthStatus', { resourceId: id })).environments.find(
        (e: { environmentId: string }) => e.environmentId === prodId,
      )
    const act = async (name: string) =>
      data(await admin.mutate(name, { resourceId: id, environmentId: prodId }))

    expect(await status()).toEqual({
      environmentId: prodId,
      status: { state: 'none', signedInAt: null, expiresAt: null, lastError: null },
      variables: ['session', 'refresh'],
      perUser: false,
      form: [],
      signedInPeople: null,
      canSignIn: true,
    })

    const loginsBefore = logins
    expect(await act('resources.customAuthSignIn')).toEqual({ ok: true })
    expect(logins).toBe(loginsBefore + 1)
    const signedIn = await status()
    expect(signedIn.status).toMatchObject({ state: 'signedIn', lastError: null, expiresAt: null })
    expect(Date.parse(signedIn.status.signedInAt)).toBeGreaterThan(Date.now() - 60_000)

    // The password changes at the provider: Sign in now fails, but the variables stay in use.
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: id,
        environmentId: prodId,
        config: flowConfig(),
        secrets: { values: { user: 'ada', password: 'Wrong-Pass-4242' } },
      }),
    )
    const failed = await act('resources.customAuthSignIn')
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'flow_failed', step: 'login', status: 401 } },
    })
    expect(JSON.stringify(failed)).not.toContain('Wrong-Pass-4242')
    expect((await status()).status).toMatchObject({
      state: 'signedIn',
      lastError: 'Signing in failed at step "login": HTTP 401 Unauthorized',
    })
    expect(
      data(
        await admin.mutate('resources.run', {
          resourceId: id,
          environmentId: prodId,
          query: { path: 'data' },
        }),
      ),
    ).toMatchObject({ ok: true })

    // Once a query needs a new sign-in and it fails, the card says so.
    await env.db
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.resourceConfigId, row.id))
    expect(
      data(
        await admin.mutate('resources.run', {
          resourceId: id,
          environmentId: prodId,
          query: { path: 'data' },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'auth_required' } })
    expect((await status()).status).toMatchObject({
      state: 'failed',
      lastError: 'Signing in failed at step "login": HTTP 401 Unauthorized',
    })

    expect(await act('resources.customAuthSignOut')).toEqual({ signedOut: true })
    expect((await status()).status).toMatchObject({ state: 'none' })
    expect(await act('resources.customAuthSignOut')).toEqual({ signedOut: false })
  })

  it('lets only people with Edit sign in or out', async () => {
    const { id } = await flowResource('flow_card_access')
    await createLocalUser(env.db, 'member-card@optiply.nl')
    const member = trpc(env.app, await login(env.app, 'member-card@optiply.nl'))
    const users = data(await admin.query('users.directory')) as { id: string; email: string }[]
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: id,
        userId: users.find((u) => u.email === 'member-card@optiply.nl')!.id,
        environmentId: null,
        level: 'use',
      }),
    )
    const card = data(await member.query('resources.customAuthStatus', { resourceId: id }))
    expect(
      card.environments.find((e: { environmentId: string }) => e.environmentId === prodId),
    ).toMatchObject({
      status: { state: 'none' },
      canSignIn: false,
    })
    for (const name of ['resources.customAuthSignIn', 'resources.customAuthSignOut']) {
      const res = await member.mutate(name, { resourceId: id, environmentId: prodId })
      expect(res.body.error?.data?.code).toBe('FORBIDDEN')
    }
  })
})

describe('a form step: each person signs in with their own details', () => {
  /** Asks for the username and password; the API's own login, then the session as the variable. */
  const formSteps = [
    {
      type: 'form',
      name: 'signin',
      title: 'Sign in with your Acme account',
      fields: [
        { name: 'user', label: 'Username' },
        { name: 'password', label: 'Password', kind: 'password' },
      ],
    },
    {
      type: 'request',
      name: 'login',
      method: 'POST',
      path: 'login',
      body: { type: 'json', json: '{"user": {{ signin.user }}, "password": {{ signin.password }}}' },
    },
    { type: 'variable', name: 'session', value: '{{ login.data.session }}' },
    { type: 'variable', name: 'refresh', value: '{{ login.data.refresh }}' },
  ]
  const typed = { signin: { user: 'ada', password: 'Pw-S3cret-777' } }

  async function people() {
    const members = await Promise.all(
      ['form-a@optiply.nl', 'form-b@optiply.nl'].map(async (email) => {
        const existing = (data(await admin.query('users.directory')) as { id: string; email: string }[]).find(
          (u) => u.email === email,
        )
        if (!existing) await createLocalUser(env.db, email)
        const users = data(await admin.query('users.directory')) as { id: string; email: string }[]
        return {
          id: users.find((u) => u.email === email)!.id,
          api: trpc(env.app, await login(env.app, email)),
        }
      }),
    )
    return members as [(typeof members)[0], (typeof members)[0]]
  }

  async function formResource(
    slug: string,
    auth: Record<string, unknown> = {},
    secrets: Record<string, unknown> = { values: {} },
  ) {
    const id = data(await admin.mutate('resources.create', { type: 'rest', name: slug, slug })).id as string
    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: id,
        environmentId: prodId,
        config: flowConfig({ steps: formSteps, ...auth }),
        secrets,
      }),
    )
    const [row] = await env.db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, id))
    const [a, b] = await people()
    for (const person of [a, b]) {
      data(
        await admin.mutate('permissions.set', {
          objectType: 'resource',
          objectId: id,
          userId: person.id,
          environmentId: null,
          level: 'use',
        }),
      )
    }
    return { id, row: row!, a, b }
  }
  const run = async (api: ReturnType<typeof trpc>, id: string) =>
    data(
      await api.mutate('resources.run', { resourceId: id, environmentId: prodId, query: { path: 'data' } }),
    )
  const signInAs = async (api: ReturnType<typeof trpc>, id: string, form: unknown = typed) =>
    data(await api.mutate('resources.customAuthSignIn', { resourceId: id, environmentId: prodId, form }))

  it('asks each person to sign in, keeps their variables apart, and never stores what they typed', async () => {
    const { id, row, a, b } = await formResource('form_people')

    // Nobody signed in: the query asks this person for the form.
    expect(await run(a.api, id)).toMatchObject({
      ok: false,
      error: {
        code: 'auth_required',
        details: {
          reason: 'not_connected',
          account: 'user',
          flow: 'form',
          resourceId: id,
          environmentId: prodId,
        },
      },
    })

    const form = data(
      await a.api.query('resources.customAuthForm', { resourceId: id, environmentId: prodId }),
    )
    expect(form).toEqual({
      resourceName: 'form_people',
      sendsTo: [new URL(origin).host],
      form: [
        {
          step: 'signin',
          title: 'Sign in with your Acme account',
          fields: [
            { name: 'user', label: 'Username', kind: 'text' },
            { name: 'password', label: 'Password', kind: 'password' },
          ],
        },
      ],
      status: { state: 'none', signedInAt: null, expiresAt: null, lastError: null },
    })

    const before = logins
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    expect(logins).toBe(before + 1)
    expect(await run(a.api, id)).toMatchObject({ ok: true, data: { ok: true, session: '[REDACTED]' } })
    // B hasn't signed in: A's sign-in isn't theirs.
    expect(await run(b.api, id)).toMatchObject({ ok: false, error: { details: { reason: 'not_connected' } } })

    const rows = await stored(row.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: a.id, status: 'active' })
    expect(JSON.stringify(rows)).not.toMatch(/Pw-S3cret-777|Session-/)
    const audit = await env.db.execute<{ metadata: unknown }>(
      sql`select metadata from audit_events where action = 'resource.custom_auth_signed_in' and object_id = ${id}`,
    )
    expect(JSON.stringify([...audit])).not.toContain('Pw-S3cret-777')
    expect([...audit][0]).toMatchObject({ metadata: { account: 'user' } })

    // B signs in too; the card counts both for people with Edit, and shows each their own.
    expect(await signInAs(b.api, id)).toEqual({ ok: true })
    const card = data(await admin.query('resources.customAuthStatus', { resourceId: id })).environments.find(
      (e: { environmentId: string }) => e.environmentId === prodId,
    )
    expect(card).toMatchObject({
      perUser: true,
      signedInPeople: 2,
      canSignIn: true,
      status: { state: 'none' },
    })
    const own = data(await a.api.query('resources.customAuthStatus', { resourceId: id })).environments.find(
      (e: { environmentId: string }) => e.environmentId === prodId,
    )
    expect(own).toMatchObject({
      perUser: true,
      signedInPeople: null,
      canSignIn: true,
      status: { state: 'signedIn' },
    })

    // A signs out: only their sign-in goes.
    expect(
      data(await a.api.mutate('resources.customAuthSignOut', { resourceId: id, environmentId: prodId })),
    ).toEqual({ signedOut: true })
    expect(await run(a.api, id)).toMatchObject({ ok: false, error: { details: { reason: 'not_connected' } } })
    expect(await run(b.api, id)).toMatchObject({ ok: true })
  })

  it('reports a wrong password scrubbed, backs off for that person only, and needs a form to sign in', async () => {
    const { id, row, a, b } = await formResource('form_wrong')
    const wrong = { signin: { user: 'ada', password: 'Wrong-Typed-4242' } }
    const failed = await signInAs(a.api, id, wrong)
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'flow_failed', step: 'login', status: 401 } },
    })
    expect(JSON.stringify(failed)).not.toContain('Wrong-Typed-4242')
    // Right away again: the back-off answers without sending the password to the API.
    const refusedBefore = refusedLogins
    expect(await signInAs(a.api, id, typed)).toMatchObject({
      ok: false,
      error: {
        message: expect.stringMatching(/failed 1 time in the last hour; signing in again in [1-5] s/),
      },
    })
    expect(refusedLogins).toBe(refusedBefore)
    // Someone else isn't held back.
    expect(await signInAs(b.api, id)).toEqual({ ok: true })
    // Without the form: asked for it, and not counted as a failure.
    expect(await signInAs(b.api, id, {})).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'form_needed', step: 'signin' } },
    })
    const [kept] = (await stored(row.id)).filter((r) => r.userId === b.id)
    expect(kept).toMatchObject({ status: 'active', lastError: null })
  })

  it('renews a person’s variables with the refresh steps, else asks them to sign in again', async () => {
    const { id, row, a } = await formResource('form_refresh', { ttlSeconds: 600 })
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    const expire = () =>
      env.db
        .update(oauthTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(oauthTokens.resourceConfigId, row.id))

    // Ran out: the refresh steps renew it without asking.
    await expire()
    const refreshesBefore = refreshes
    expect(await run(a.api, id)).toMatchObject({ ok: true })
    expect(refreshes).toBe(refreshesBefore + 1)

    // The refresh token stops working too: the person is asked to sign in again, and queries stop refreshing.
    refreshTokens.clear()
    await expire()
    expect(await run(a.api, id)).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'expired', account: 'user', flow: 'form' } },
    })
    expect((await stored(row.id))[0]).toMatchObject({ status: 'reconnect' })
    expect(await run(a.api, id)).toMatchObject({ ok: false, error: { details: { reason: 'expired' } } })
    expect(refreshes).toBe(refreshesBefore + 1)
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    expect(await run(a.api, id)).toMatchObject({ ok: true })
  })

  it('fails runs nobody is behind, Test connection asks to save first, and changing the flow signs everyone out', async () => {
    const { id, row, a } = await formResource('form_nobody')
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    const nobody = customAuthCredentials(
      { db: env.db, keyring: env.config.keyring, sandbox },
      {
        resourceId: id,
        userId: null,
        resourceConfigId: row.id,
        environmentId: prodId,
        config: restConnector.configSchema.parse(row.config),
        secrets: restConnector.secretsSchema.parse({}),
        store: true,
      },
    )
    await expect(nobody.authVariables!({ signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({
      code: 'auth_required',
      details: { reason: 'no_user', account: 'user', flow: 'form' },
    })

    expect(
      data(await admin.mutate('resources.test', { resourceId: id, environmentId: prodId })),
    ).toMatchObject({ ok: false, error: { code: 'auth_required', details: { reason: 'form_needed' } } })

    data(
      await admin.mutate('resources.saveConfig', {
        resourceId: id,
        environmentId: prodId,
        config: flowConfig({ steps: [...formSteps, { type: 'variable', name: 'extra', value: 'x' }] }),
      }),
    )
    expect(await stored(row.id)).toEqual([])
  })

  it('lets app viewers sign in through the app, and nobody else', async () => {
    const { id } = await formResource('form_app')
    await createLocalUser(env.db, 'form-viewer@optiply.nl')
    const viewer = trpc(env.app, await login(env.app, 'form-viewer@optiply.nl'))
    const viewerId = (data(await admin.query('users.directory')) as { id: string; email: string }[]).find(
      (u) => u.email === 'form-viewer@optiply.nl',
    )!.id
    const publishedApp = async (slug: string, resource: string) => {
      const app = data(await admin.mutate('apps.create', { slug, name: slug }))
      const draft = data(
        await admin.mutate('apps.saveDraft', {
          id: app.id,
          revision: 1,
          definition: {
            schemaVersion: 1,
            components: [],
            queries: [{ name: 'feed', kind: 'resource', resource, query: { path: 'data' }, run: 'auto' }],
            layout: {},
          },
        }),
      )
      const release = data(
        await admin.mutate('apps.publish', { appId: app.id, draftRevision: draft.revision }),
      )
      data(
        await admin.mutate('permissions.set', {
          objectType: 'app',
          objectId: app.id,
          userId: viewerId,
          environmentId: null,
          level: 'use',
        }),
      )
      return { appId: app.id as string, releaseId: release.id as string }
    }
    const app = await publishedApp('form-app-feed', 'form_app')
    const other = await publishedApp('form-app-other', 'flow_store')

    // Without the app, or through an app that doesn't query the resource: not found.
    for (const appId of [undefined, other.appId]) {
      const res = await viewer.mutate('resources.customAuthSignIn', {
        resourceId: id,
        environmentId: prodId,
        form: typed,
        ...(appId && { appId }),
      })
      expect(res.body.error?.data?.code).toBe('NOT_FOUND')
      const form = await viewer.query('resources.customAuthForm', {
        resourceId: id,
        environmentId: prodId,
        ...(appId && { appId }),
      })
      expect(form.body.error?.data?.code).toBe('NOT_FOUND')
    }

    const query = () =>
      viewer
        .mutate('apps.runQuery', {
          appId: app.appId,
          releaseId: app.releaseId,
          query: 'feed',
          environmentId: prodId,
          values: {},
        })
        .then((res) => data(res))
    expect(await query()).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'not_connected', account: 'user', flow: 'form' } },
    })
    expect(
      data(
        await viewer.query('resources.customAuthForm', {
          resourceId: id,
          environmentId: prodId,
          appId: app.appId,
        }),
      ),
    ).toMatchObject({ resourceName: 'form_app', status: { state: 'none' } })
    expect(
      data(
        await viewer.mutate('resources.customAuthSignIn', {
          resourceId: id,
          environmentId: prodId,
          appId: app.appId,
          form: typed,
        }),
      ),
    ).toEqual({ ok: true })
    expect(await query()).toMatchObject({ ok: true, data: { ok: true } })
    // The resource's own card stays out of reach.
    expect(
      (await viewer.query('resources.customAuthStatus', { resourceId: id })).body.error?.data?.code,
    ).toBe('NOT_FOUND')
    // Someone whose access is apps only signs in through the app too.
    data(await admin.mutate('users.setAccess', { userId: viewerId, access: 'apps_only' }))
    const through = { resourceId: id, environmentId: prodId, appId: app.appId }
    expect(data(await viewer.mutate('resources.customAuthSignOut', through))).toEqual({ signedOut: true })
    expect(data(await viewer.query('resources.customAuthForm', through))).toMatchObject({
      status: { state: 'none' },
    })
    expect(data(await viewer.mutate('resources.customAuthSignIn', { ...through, form: typed }))).toEqual({
      ok: true,
    })
    expect(await query()).toMatchObject({ ok: true })
    // …but not into anything else.
    expect(
      (await viewer.query('resources.customAuthStatus', { resourceId: id })).body.error?.data?.code,
    ).toBe('FORBIDDEN')
    data(await admin.mutate('users.setAccess', { userId: viewerId, access: 'full' }))

    // Not in an environment only admins may use (Staging), even with the flow set up there.
    const envs = data(await admin.query('environments.list')) as { id: string; slug: string }[]
    const stagingId = envs.find((e) => e.slug === 'staging')!.id
    const [staging] = await env.db.select().from(environments).where(eq(environments.id, stagingId))
    await env.db.update(environments).set({ adminOnly: true }).where(eq(environments.id, stagingId))
    try {
      data(
        await admin.mutate('resources.saveConfig', {
          resourceId: id,
          environmentId: stagingId,
          config: flowConfig({ steps: formSteps }),
          secrets: { values: {} },
        }),
      )
      const there = { resourceId: id, environmentId: stagingId, appId: app.appId }
      expect((await viewer.query('resources.customAuthForm', there)).body.error?.data?.code).toBe('NOT_FOUND')
      expect(
        (await viewer.mutate('resources.customAuthSignIn', { ...there, form: typed })).body.error?.data?.code,
      ).toBe('NOT_FOUND')
    } finally {
      await env.db
        .update(environments)
        .set({ adminOnly: staging!.adminOnly })
        .where(eq(environments.id, stagingId))
    }
  })

  it('tries one password at a time: attempts sent together after a failure wait out the back-off', async () => {
    const { id, a } = await formResource('form_parallel')
    loginDelayMs = 100
    const refusedBefore = refusedLogins
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        signInAs(a.api, id, { signin: { user: 'ada', password: `Wrong-Guess-${i}` } }),
      ),
    )
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false, false])
    expect(refusedLogins).toBe(refusedBefore + 1)
  })

  it('marks a person’s sign-in failed when an API refuses it and nothing can renew it', async () => {
    const { id, row, a } = await formResource('form_refused', { refreshSteps: [] })
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    sessions.clear()
    expect(await run(a.api, id)).toMatchObject({
      ok: false,
      error: {
        code: 'auth_required',
        message: 'An API refused your sign-in to this resource: sign in again.',
        details: { reason: 'expired', account: 'user', flow: 'form' },
      },
    })
    expect((await stored(row.id))[0]).toMatchObject({
      status: 'reconnect',
      lastError: 'An API refused the stored sign-in.',
    })
    expect(
      data(await a.api.query('resources.customAuthForm', { resourceId: id, environmentId: prodId })).status,
    ).toMatchObject({ state: 'failed' })
  })

  it('keeps a person’s stored variables out of a failed refresh’s query error', async () => {
    const { id, row, a } = await formResource('form_refresh_scrub', {
      ttlSeconds: 600,
      refreshSteps: [{ type: 'code', name: 'boom', code: 'throw new Error("dead " + auth.refresh)' }],
    })
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    await env.db
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.resourceConfigId, row.id))
    const failed = await run(a.api, id)
    expect(failed).toMatchObject({ ok: false, error: { details: { reason: 'expired' } } })
    expect(failed.error.message).toContain('dead [REDACTED]')
    expect(JSON.stringify(failed)).not.toMatch(/refresh-\d/)
  })

  it('scrubs every secret of the resource from a failed sign-in, secret headers too', async () => {
    const { id, a } = await formResource(
      'form_header_echo',
      {
        steps: [
          formSteps[0],
          { type: 'request', name: 'echo', method: 'POST', path: 'echo-fail' },
          { type: 'variable', name: 'session', value: '{{ echo.data.seen }}' },
        ],
      },
      { values: {}, headers: { 'x-key': 'Header-Secret-5555' } },
    )
    const failed = await signInAs(a.api, id)
    expect(failed).toMatchObject({ ok: false, error: { details: { step: 'echo', status: 400 } } })
    expect(JSON.stringify(failed)).not.toContain('Header-Secret-5555')
    expect(JSON.stringify(failed)).toContain('[REDACTED]')
  })

  it('keeps each person’s GraphQL schema to themselves', async () => {
    const gql = await startTestGraphql({ token: 'Gql-Person-Token-1' })
    try {
      const id = data(
        await admin.mutate('resources.create', { type: 'graphql', name: 'Shop', slug: 'form_gql' }),
      ).id as string
      data(
        await admin.mutate('resources.saveConfig', {
          resourceId: id,
          environmentId: prodId,
          config: {
            baseUrl: gql.url,
            allowPrivateNetwork: true,
            headers: [{ key: 'authorization', value: 'Bearer {{ auth.token }}' }],
            auth: {
              type: 'custom',
              steps: [
                {
                  type: 'form',
                  name: 'signin',
                  fields: [{ name: 'token', label: 'Token', kind: 'password' }],
                },
                { type: 'variable', name: 'token', value: '{{ signin.token }}' },
              ],
            },
          },
          secrets: { values: {} },
        }),
      )
      const [a, b] = await people()
      for (const person of [a, b]) {
        data(
          await admin.mutate('permissions.set', {
            objectType: 'resource',
            objectId: id,
            userId: person.id,
            environmentId: null,
            level: 'use',
          }),
        )
      }
      expect(await signInAs(a.api, id, { signin: { token: 'Gql-Person-Token-1' } })).toEqual({ ok: true })
      const schema = (api: ReturnType<typeof trpc>) =>
        api
          .query('resources.graphqlSchema', { resourceId: id, environmentId: prodId })
          .then((res) => data(res))
      expect(await schema(a.api)).toMatchObject({ ok: true })
      // B hasn't signed in: asked to, not handed A's schema.
      expect(await schema(b.api)).toMatchObject({ ok: false, error: { code: 'auth_required' } })
    } finally {
      await gql.stop()
    }
  })

  it('refuses to release a workflow on a resource that asks each person to sign in', async () => {
    await formResource('form_release')
    const created = data(
      await admin.mutate('workflows.create', { slug: 'form-release', name: 'form-release' }),
    )
    const saved = data(
      await admin.mutate('workflows.saveDraft', {
        id: created.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          blocks: [
            { name: 'startTrigger', type: 'startTrigger' },
            {
              name: 'feed',
              type: 'resourceQuery',
              config: { resource: 'form_release', query: { path: 'data' } },
            },
          ],
          edges: [{ from: 'startTrigger', port: 'out', to: 'feed' }],
        },
      }),
    )
    const refused = await admin.mutate('releases.publish', {
      workflowId: created.id,
      draftRevision: saved.revision,
    })
    expect(refused.status).toBe(400)
    expect(refused.body.error?.message).toBe(
      'Resource "form_release" asks each person to sign in in production (its sign-in has a form step), which a live run (webhook, schedule) has no one to do. Give it a sign-in without a form to release this workflow.',
    )
  })

  it('lets only admins set up or change the sign-in of a flow with a form step', async () => {
    const { id } = await formResource('form_admin_only')
    await createLocalUser(env.db, 'form-editor@optiply.nl')
    const editor = trpc(env.app, await login(env.app, 'form-editor@optiply.nl'))
    const editorId = (data(await admin.query('users.directory')) as { id: string; email: string }[]).find(
      (u) => u.email === 'form-editor@optiply.nl',
    )!.id
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: id,
        userId: editorId,
        environmentId: null,
        level: 'edit',
      }),
    )
    const save = (config: unknown) =>
      editor.mutate('resources.saveConfig', { resourceId: id, environmentId: prodId, config })
    const forbidden =
      'Only admins can set up or change the sign-in of a flow with a form step (its steps, base URL or allowed hosts): it sends what each person types'
    // Another host, or another step: where what people type goes.
    for (const config of [
      { ...flowConfig({ steps: formSteps }), allowedHosts: ['collector.example.com'] },
      flowConfig({
        steps: [...formSteps, { type: 'variable', name: 'extra', value: '{{ signin.password }}' }],
      }),
    ]) {
      const res = await save(config)
      expect(res.body.error?.data?.code).toBe('FORBIDDEN')
      expect(res.body.error?.message).toBe(forbidden)
    }
    // Other settings stay theirs.
    data(
      await save({
        ...flowConfig({ steps: formSteps }),
        headers: [
          { key: 'x-session', value: '{{ auth.session }}' },
          { key: 'x-extra', value: '1' },
        ],
      }),
    )
    // Nor can they turn a shared flow into one asking people for their details.
    const { id: sharedId } = await flowResource('form_admin_only_shared')
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: sharedId,
        userId: editorId,
        environmentId: null,
        level: 'edit',
      }),
    )
    const res = await editor.mutate('resources.saveConfig', {
      resourceId: sharedId,
      environmentId: prodId,
      config: flowConfig({ steps: formSteps }),
    })
    expect(res.body.error?.message).toBe(forbidden)
  })

  it('counts a person’s failures for an hour whatever succeeds between, audits them, and keeps no typed text', async () => {
    const { id, row, a } = await formResource('form_window')
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    const wrong = { signin: { user: 'ada', password: 'Wrong-Typed-7777' } }
    expect(await signInAs(a.api, id, wrong)).toMatchObject({ ok: false })
    expect((await stored(row.id))[0]!.lastError).toBe('Signing in failed at step "login": HTTP 401')

    await new Promise((r) => setTimeout(r, 5_100))
    expect(await signInAs(a.api, id)).toEqual({ ok: true })
    expect(await signInAs(a.api, id, wrong)).toMatchObject({ ok: false })
    // Signing in with a working login between didn't start the count over: the second failure waits 10 s.
    expect(await signInAs(a.api, id)).toMatchObject({
      ok: false,
      error: {
        message: expect.stringMatching(/failed 2 times in the last hour; signing in again in (9|10) s/),
      },
    })

    const audit = [
      ...(await env.db.execute<{ action: string; metadata: unknown }>(
        sql`select action, metadata from audit_events where object_id = ${id} order by at`,
      )),
    ]
    const failed = audit.filter((e) => e.action === 'resource.custom_auth_sign_in_failed')
    expect(failed.length).toBeGreaterThanOrEqual(2)
    expect(failed[0]).toMatchObject({ metadata: { account: 'user', step: 'login' } })
    expect(JSON.stringify(audit)).not.toContain('Wrong-Typed-7777')
  })

  it('keeps a shared flow’s Sign in now for people with Edit', async () => {
    const { id } = await flowResource('form_shared_edit')
    const [a] = await people()
    data(
      await admin.mutate('permissions.set', {
        objectType: 'resource',
        objectId: id,
        userId: a.id,
        environmentId: null,
        level: 'use',
      }),
    )
    const res = await a.api.mutate('resources.customAuthSignIn', {
      resourceId: id,
      environmentId: prodId,
      form: typed,
    })
    expect(res.body.error?.data?.code).toBe('FORBIDDEN')
  })
})
