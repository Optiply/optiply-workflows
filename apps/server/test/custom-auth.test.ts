/**
 * Custom auth flows on the server: signing in on first use and storing the variables encrypted, reusing them,
 * signing in again when they run out, refreshing on a 401 (falling back to signing in), one sign-in at a time
 * across processes, and through the playground, Test connection and saving the settings; the status card's state,
 * Sign in now and Sign out, and the failures it shows.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { restConnector } from '@ow/connectors'
import { oauthTokens, resourceConfigs } from '@ow/db'
import { IvmRuntime } from '@ow/sandbox'
import { eq } from 'drizzle-orm'
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

function source(row: { id: string; config: unknown }, store = true) {
  return customAuthCredentials(
    { db: env.db, keyring: env.config.keyring, sandbox },
    {
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
