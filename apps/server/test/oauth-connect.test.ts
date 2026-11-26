import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { auditEvents, groups, oauthTokens, permissions, resourceConfigs } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decryptConfigSecrets } from '../src/services/resources'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const CLIENT_SECRET = 'Client-S3cret-Value-8841'

let env: TestEnv
let provider: Server
let tokenUrl: string
let adminCookie: string
let memberCookie: string
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminId: string
let memberId: string
let prodId: string
/** Every response body any client received in this file (tRPC and the OAuth pages). */
const responses: string[] = []

/** Codes the fake provider issued: what it remembers about each consent. */
const codes = new Map<string, { challenge: string | null; redirectUri: string }>()
let issued = 0
let lastTokenForm: URLSearchParams | undefined
/** Set to make the next code exchange fail with this answer. */
let failExchange: { status: number; body: unknown } | undefined
/** The forms posted to the fake's /revoke, and its answer to the next one. */
const revoked: URLSearchParams[] = []
let failRevoke: { status: number; body: unknown } | undefined

beforeAll(async () => {
  env = await startTestApp()
  adminId = (await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })).id
  memberId = (await createLocalUser(env.db, 'member@optiply.nl')).id
  adminCookie = await login(env.app, 'admin@optiply.nl')
  memberCookie = await login(env.app, 'member@optiply.nl')
  admin = trpc(env.app, adminCookie, { record: responses })
  member = trpc(env.app, memberCookie, { record: responses })
  const envs = (await admin.query('environments.list')).body.result!.data as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id

  provider = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const form = new URLSearchParams(body)
    lastTokenForm = form
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url === '/revoke') {
      revoked.push(form)
      return failRevoke ? send(failRevoke.status, failRevoke.body) : send(200, {})
    }
    if (failExchange) return send(failExchange.status, failExchange.body)
    const code = form.get('code') ?? ''
    const grant = codes.get(code)
    codes.delete(code)
    const verifier = form.get('code_verifier')
    const pkceOk = grant?.challenge
      ? !!verifier && createHash('sha256').update(verifier).digest('base64url') === grant.challenge
      : !verifier
    if (
      !grant ||
      form.get('client_secret') !== CLIENT_SECRET ||
      form.get('redirect_uri') !== grant.redirectUri ||
      !pkceOk
    ) {
      return send(400, { error: 'invalid_grant' })
    }
    issued++
    const idToken = `e30.${Buffer.from(JSON.stringify({ email: 'ada@optiply.nl' })).toString('base64url')}.x`
    send(200, {
      access_token: `Access-Tok3n-${issued}-${'x'.repeat(12)}`,
      refresh_token: `Refresh-Tok3n-${issued}-${'y'.repeat(12)}`,
      expires_in: 3600,
      scope: 'contacts',
      id_token: idToken,
    })
  })
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r))
  tokenUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/token`
})
afterAll(async () => {
  await new Promise((r) => provider?.close(r))
  await env?.stop()
})
beforeEach(() => {
  failExchange = undefined
  failRevoke = undefined
  revoked.length = 0
})

// biome-ignore lint/suspicious/noExplicitAny: test JSON
const data = (res: { body: { result?: { data: unknown } } }) => res.body.result?.data as any

const oauthAuth = (overrides: Record<string, unknown> = {}) => ({
  type: 'oauth2AuthorizationCode',
  authorizeUrl: 'https://auth.example.com/authorize',
  tokenUrl,
  clientId: 'crm-client',
  scope: 'contacts',
  ...overrides,
})

async function restResource(slug: string, auth: Record<string, unknown> = oauthAuth()) {
  const id = data(await admin.mutate('resources.create', { type: 'rest', name: slug, slug })).id as string
  await saveAuth(id, auth)
  // Members may use it in production.
  const [all] = await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users'))
  await env.db
    .insert(permissions)
    .values({ groupId: all!.id, objectType: 'resource', objectId: id, environmentId: prodId, level: 'use' })
  return id
}

async function saveAuth(id: string, auth: Record<string, unknown>) {
  const saved = await admin.mutate('resources.saveConfig', {
    resourceId: id,
    environmentId: prodId,
    config: { baseUrl: 'https://api.example.com', auth, allowPrivateNetwork: true },
    secrets: { clientSecret: CLIENT_SECRET },
  })
  expect(saved.status).toBe(200)
}

const startUrl = (resourceId: string, account = 'shared') =>
  `/api/oauth/start?resourceId=${resourceId}&environmentId=${prodId}&account=${account}`

/** The browser's side of the start: the redirect to the consent screen and the pending cookie. */
async function start(cookie: string, resourceId: string, account = 'shared') {
  const res = await env.app.inject({ method: 'GET', url: startUrl(resourceId, account), headers: { cookie } })
  responses.push(res.body)
  const pending = res.cookies.find((c) => c.name.startsWith('ow_oauth_'))
  const location = res.headers.location ? new URL(String(res.headers.location)) : undefined
  return { res, pending, location }
}

/** The provider shows its consent screen and redirects back with a code. */
function consent(location: URL): { code: string; state: string } {
  const code = `code-${codes.size}-${Math.random().toString(36).slice(2)}`
  codes.set(code, {
    challenge: location.searchParams.get('code_challenge'),
    redirectUri: location.searchParams.get('redirect_uri')!,
  })
  return { code, state: location.searchParams.get('state')! }
}

async function callback(cookie: string, query: Record<string, string>) {
  const res = await env.app.inject({
    method: 'GET',
    url: `/api/oauth/callback?${new URLSearchParams(query)}`,
    headers: { cookie },
  })
  responses.push(res.body)
  return res
}

/** Start, consent and callback in one go, as the same signed-in person. */
async function connect(cookie: string, resourceId: string, account = 'shared') {
  const { pending, location } = await start(cookie, resourceId, account)
  expect(location, 'start redirects to the provider').toBeDefined()
  return callback(`${cookie}; ${pending!.name}=${pending!.value}`, consent(location!))
}

/** The `ow:oauth` message the result page posts to its opener. */
function postedMessage(html: string) {
  const match = html.match(/postMessage\((\{.*?\}), ("[^"]*")\)/)
  expect(match, 'the page posts a message').not.toBeNull()
  return { message: JSON.parse(match![1]!), origin: JSON.parse(match![2]!) }
}

const tokensOf = async (resourceId: string) => {
  const [config] = await env.db
    .select()
    .from(resourceConfigs)
    .where(eq(resourceConfigs.resourceId, resourceId))
  return env.db.select().from(oauthTokens).where(eq(oauthTokens.resourceConfigId, config!.id))
}

describe('connecting the shared account', () => {
  let crm: string

  it('sends the browser to the consent screen with state and PKCE in a signed cookie', async () => {
    crm = await restResource('crm')
    const { res, pending, location } = await start(adminCookie, crm)
    expect(res.statusCode).toBe(302)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(location!.origin + location!.pathname).toBe('https://auth.example.com/authorize')
    const params = Object.fromEntries(location!.searchParams)
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'crm-client',
      redirect_uri: 'http://localhost:5173/api/oauth/callback',
      scope: 'contacts',
      code_challenge_method: 'S256',
    })
    expect(params.state).toMatch(/^[\w-]{32}$/)
    expect(params.code_challenge).toMatch(/^[\w-]{43}$/)
    expect(pending).toMatchObject({
      name: `ow_oauth_${params.state!.slice(0, 16)}`,
      path: '/api/oauth',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 600,
    })
    // Signed, and the verifier isn't in the URL.
    expect(pending!.value).toMatch(/\.[\w+/-]+$/)
    expect(res.headers.location).not.toContain(JSON.parse(pending!.value.replace(/\.[^.]+$/, '')).verifier)
  })

  it('stores the tokens on the callback and tells the opener', async () => {
    const res = await connect(adminCookie, crm)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.body).toContain('Connected as ada@optiply.nl')
    expect(postedMessage(res.body)).toEqual({
      message: {
        type: 'ow:oauth',
        ok: true,
        message: 'Connected as ada@optiply.nl. You can close this window.',
        resourceId: crm,
        environmentId: prodId,
        account: 'shared',
      },
      origin: 'http://localhost:5173',
    })
    // The pending cookie is single-use.
    expect(res.cookies.find((c) => c.name.startsWith('ow_oauth_'))).toMatchObject({
      value: '',
      path: '/api/oauth',
    })
    // The code went to the provider with the verifier and the client secret.
    expect(lastTokenForm!.get('code_verifier')).toMatch(/^[\w-]{43}$/)

    const rows = await tokensOf(crm)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: null,
      account: 'ada@optiply.nl',
      connectedBy: adminId,
      status: 'active',
    })

    const status = data(await admin.query('resources.oauthConnections', { resourceId: crm }))
    expect(status.redirectUri).toBe('http://localhost:5173/api/oauth/callback')
    expect(status.environments).toContainEqual(
      expect.objectContaining({
        environmentId: prodId,
        tokens: 'shared',
        canConnect: true,
        connectedPeople: null,
        connection: expect.objectContaining({ connected: true, status: 'active', account: 'ada@optiply.nl' }),
      }),
    )
    const [audit] = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.objectId, crm), eq(auditEvents.action, 'resource.oauth_connected')))
    expect(audit).toMatchObject({
      actorUserId: adminId,
      environmentId: prodId,
      metadata: {
        account: 'shared',
        provider: 'custom',
        connectedAccount: 'ada@optiply.nl',
        scope: 'contacts',
      },
    })
  })

  it('accepts a callback only with its own cookie, once, in the session that started', async () => {
    const { pending, location } = await start(adminCookie, crm)
    const answer = consent(location!)
    const cookie = `${pending!.name}=${pending!.value}`

    // No cookie (another browser), a tampered one, or another state.
    for (const res of [
      await callback(adminCookie, answer),
      await callback(`${adminCookie}; ${pending!.name}=${pending!.value.replace(/^./, 'x')}`, answer),
      await callback(`${adminCookie}; ${cookie}`, { ...answer, state: `${answer.state.slice(0, 16)}other` }),
    ]) {
      expect(res.statusCode).toBe(400)
      expect(postedMessage(res.body).message).toMatchObject({
        ok: false,
        message: expect.stringMatching(/expired/),
      })
    }
    // Someone else's session carrying the cookie.
    const other = await callback(`${memberCookie}; ${cookie}`, answer)
    expect(other.statusCode).toBe(401)
    expect(postedMessage(other.body).message.message).toMatch(/person who started/)

    const before = await tokensOf(crm)
    const ok = await callback(`${adminCookie}; ${cookie}`, answer)
    expect(ok.statusCode).toBe(200)
    // The code can't be replayed by the provider (single-use) — and the cookie is gone anyway.
    const replay = await callback(adminCookie, answer)
    expect(replay.statusCode).toBe(400)
    expect((await tokensOf(crm))[0]!.id).toBe(before[0]!.id)
  })

  it('reports a declined consent and a refused code without storing anything', async () => {
    const other = await restResource('crm_declined')
    const { pending, location } = await start(adminCookie, other)
    const cookie = `${adminCookie}; ${pending!.name}=${pending!.value}`
    const declined = await callback(cookie, {
      state: location!.searchParams.get('state')!,
      error: 'access_denied',
    })
    expect(postedMessage(declined.body).message).toMatchObject({
      ok: false,
      message: 'Access was declined at the provider',
    })

    const second = await start(adminCookie, other)
    failExchange = {
      status: 400,
      body: { error: 'invalid_request', error_description: `bad secret ${CLIENT_SECRET}` },
    }
    const refused = await callback(
      `${adminCookie}; ${second.pending!.name}=${second.pending!.value}`,
      consent(second.location!),
    )
    expect(refused.statusCode).toBe(502)
    expect(postedMessage(refused.body).message).toMatchObject({
      ok: false,
      message: 'OAuth2 token request failed: HTTP 400',
    })
    expect(await tokensOf(other)).toEqual([])
  })

  it('escapes what the provider sends back', async () => {
    const { pending, location } = await start(adminCookie, crm)
    const res = await callback(`${adminCookie}; ${pending!.name}=${pending!.value}`, {
      state: location!.searchParams.get('state')!,
      error: 'server_error',
      error_description: '</script><script>alert(1)</script><b>x</b>',
    })
    expect(res.body).not.toContain('<script>alert(1)')
    expect(res.body).not.toContain('<b>x</b>')
    expect(res.body).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(postedMessage(res.body).message.message).toBe(
      'The provider refused (server_error: </script><script>alert(1)</script><b>x</b>)',
    )
  })

  it('refuses a callback for settings that changed meanwhile', async () => {
    const other = await restResource('crm_changed')
    const { pending, location } = await start(adminCookie, other)
    await saveAuth(other, oauthAuth({ scope: 'contacts deals' }))
    const res = await callback(`${adminCookie}; ${pending!.name}=${pending!.value}`, consent(location!))
    expect(res.statusCode).toBe(400)
    expect(postedMessage(res.body).message.message).toMatch(/settings changed while you were signing in/)
    expect(await tokensOf(other)).toEqual([])
  })

  it('needs Edit for the shared account, and lets only Edit disconnect it', async () => {
    const { res, location } = await start(memberCookie, crm)
    expect(res.statusCode).toBe(403)
    expect(location).toBeUndefined()
    expect(postedMessage(res.body).message.message).toMatch(/edit access/)
    const seen = data(await member.query('resources.oauthConnections', { resourceId: crm }))
    expect(seen.environments).toEqual([
      expect.objectContaining({ environmentId: prodId, tokens: 'shared', canConnect: false }),
    ])

    const refused = await member.mutate('resources.oauthDisconnect', {
      resourceId: crm,
      environmentId: prodId,
      account: 'shared',
    })
    expect(refused.status).toBe(403)
    expect(
      data(
        await admin.mutate('resources.oauthDisconnect', {
          resourceId: crm,
          environmentId: prodId,
          account: 'shared',
        }),
      ),
    ).toEqual({ disconnected: true, revoked: 'none' })
    expect(await tokensOf(crm)).toEqual([])
    const audit = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.objectId, crm), eq(auditEvents.action, 'resource.oauth_disconnected')))
    expect(audit).toHaveLength(1)
  })
})

describe('revoking on disconnect', () => {
  const revokeUrl = () => tokenUrl.replace(/\/token$/, '/revoke')
  const disconnect = (id: string) =>
    admin.mutate('resources.oauthDisconnect', { resourceId: id, environmentId: prodId, account: 'shared' })

  it('revokes the refresh token at the provider (RFC 7009), then forgets the tokens', async () => {
    const id = await restResource('crm_revoke', oauthAuth({ revokeUrl: revokeUrl() }))
    await connect(adminCookie, id)
    expect(data(await disconnect(id))).toEqual({ disconnected: true, revoked: 'yes' })
    expect(revoked).toHaveLength(1)
    expect(revoked[0]!.get('token')).toMatch(/^Refresh-Tok3n-/)
    expect(revoked[0]!.get('token_type_hint')).toBe('refresh_token')
    expect(revoked[0]!.get('client_secret')).toBe(CLIENT_SECRET)
    expect(await tokensOf(id)).toEqual([])
    const [audit] = await env.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.objectId, id), eq(auditEvents.action, 'resource.oauth_disconnected')))
    expect(audit!.metadata).toMatchObject({ account: 'shared', revoked: 'yes' })
  })

  it('still disconnects when the provider refuses, saying why', async () => {
    const id = await restResource('crm_revoke_refused', oauthAuth({ revokeUrl: revokeUrl() }))
    await connect(adminCookie, id)
    failRevoke = { status: 503, body: { error: 'temporarily_unavailable' } }
    expect(data(await disconnect(id))).toEqual({
      disconnected: true,
      revoked: 'failed',
      reason: "The provider didn't revoke the token: temporarily_unavailable",
    })
    expect(await tokensOf(id)).toEqual([])
  })

  it('refuses a revocation URL off the token URL’s origin', async () => {
    const id = data(
      await admin.mutate('resources.create', { type: 'rest', name: 'x', slug: 'crm_revoke_far' }),
    ).id
    const saved = await admin.mutate('resources.saveConfig', {
      resourceId: id,
      environmentId: prodId,
      config: {
        baseUrl: 'https://api.example.com',
        auth: oauthAuth({ revokeUrl: 'https://elsewhere.example.com/revoke' }),
        allowPrivateNetwork: true,
      },
      secrets: { clientSecret: CLIENT_SECRET },
    })
    expect(saved.status).toBe(400)
    expect(JSON.stringify(saved.body)).toContain('revocation URL on the token URL’s origin')
  })
})

describe('connecting through an app', () => {
  it('counts a library query of the live release that runs on the resource (M14)', async () => {
    const id = data(
      await admin.mutate('resources.create', { type: 'rest', name: 'Tickets', slug: 'tickets' }),
    ).id
    await saveAuth(id, oauthAuth({ tokens: 'perUser', pkce: false }))
    const lib = data(await admin.mutate('libraryQueries.create', { slug: 'my_tickets', name: 'My tickets' }))
    const libDraft = data(
      await admin.mutate('libraryQueries.saveDraft', {
        id: lib.id,
        revision: 1,
        definition: { schemaVersion: 1, resource: 'tickets', query: { path: 'me' }, params: [] },
      }),
    )
    data(
      await admin.mutate('libraryQueries.publish', {
        libraryQueryId: lib.id,
        draftRevision: libDraft.revision,
      }),
    )
    const app = data(await admin.mutate('apps.create', { slug: 'tickets-app', name: 'Tickets' }))
    const draft = data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [{ name: 'mine', kind: 'library', library: 'my_tickets', version: 'latest', run: 'auto' }],
          layout: {},
        },
      }),
    )
    data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: draft.revision }))
    const [all] = await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users'))
    await env.db
      .insert(permissions)
      .values({ groupId: all!.id, objectType: 'app', objectId: app.id, level: 'use' })
    const res = await env.app.inject({
      method: 'GET',
      url: `${startUrl(id, 'mine')}&appId=${app.id}`,
      headers: { cookie: memberCookie },
    })
    expect(res.statusCode).toBe(302)
  })

  it('counts a module instance of the live release whose module release runs on the resource (M14)', async () => {
    const id = data(await admin.mutate('resources.create', { type: 'rest', name: 'Desk', slug: 'desk' })).id
    await saveAuth(id, oauthAuth({ tokens: 'perUser', pkce: false }))
    const mod = data(await admin.mutate('modules.create', { slug: 'desk_panel', name: 'Desk panel' }))
    const modDraft = data(
      await admin.mutate('modules.saveDraft', {
        id: mod.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [{ name: 'mine', kind: 'resource', resource: 'desk', query: { path: 'me' }, run: 'auto' }],
          layout: {},
          module: { inputs: [], outputs: [], events: [] },
        },
      }),
    )
    data(await admin.mutate('modules.publish', { moduleId: mod.id, draftRevision: modDraft.revision }))
    const app = data(await admin.mutate('apps.create', { slug: 'desk-app', name: 'Desk' }))
    const draft = data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [
            { name: 'deskPanel1', type: 'module', props: { module: 'desk_panel', version: 'latest' } },
          ],
          queries: [],
          layout: { deskPanel1: { x: 0, y: 0, w: 6, h: 6 } },
        },
      }),
    )
    data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: draft.revision }))
    const [all] = await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users'))
    await env.db
      .insert(permissions)
      .values({ groupId: all!.id, objectType: 'app', objectId: app.id, level: 'use' })
    const res = await env.app.inject({
      method: 'GET',
      url: `${startUrl(id, 'mine')}&appId=${app.id}`,
      headers: { cookie: memberCookie },
    })
    expect(res.statusCode).toBe(302)
  })

  it("lets an app's viewers connect their own account without access to the resource", async () => {
    // A per-user resource the member has no grant on, queried by a live app the member may use.
    const id = data(await admin.mutate('resources.create', { type: 'rest', name: 'Notes', slug: 'notes' })).id
    await saveAuth(id, oauthAuth({ tokens: 'perUser', pkce: false }))
    const app = data(await admin.mutate('apps.create', { slug: 'notes-app', name: 'Notes' }))
    const draft = data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [{ name: 'me', kind: 'resource', resource: 'notes', query: { path: 'me' }, run: 'auto' }],
          layout: {},
        },
      }),
    )
    data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: draft.revision }))
    const other = data(await admin.mutate('apps.create', { slug: 'other-app', name: 'Other' }))
    const [all] = await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users'))
    for (const appId of [app.id, other.id]) {
      await env.db
        .insert(permissions)
        .values({ groupId: all!.id, objectType: 'app', objectId: appId, level: 'use' })
    }

    const startVia = (appId?: string) =>
      env.app.inject({
        method: 'GET',
        url: `${startUrl(id, 'mine')}${appId ? `&appId=${appId}` : ''}`,
        headers: { cookie: memberCookie },
      })
    expect((await startVia()).statusCode).toBe(404)
    expect((await startVia(other.id)).statusCode).toBe(404)
    const res = await startVia(app.id)
    expect(res.statusCode).toBe(302)
    const pending = res.cookies.find((c) => c.name.startsWith('ow_oauth_'))!
    const done = await callback(
      `${memberCookie}; ${pending.name}=${pending.value}`,
      consent(new URL(String(res.headers.location))),
    )
    expect(done.statusCode).toBe(200)
    expect(await tokensOf(id)).toEqual([expect.objectContaining({ userId: memberId })])

    // The shared account still needs Edit on the resource, app or not.
    const sharedVia = await env.app.inject({
      method: 'GET',
      url: `${startUrl(id, 'shared')}&appId=${app.id}`,
      headers: { cookie: memberCookie },
    })
    expect(sharedVia.statusCode).toBe(404)

    const disconnect = (appId?: string) =>
      member.mutate('resources.oauthDisconnect', {
        resourceId: id,
        environmentId: prodId,
        account: 'mine',
        ...(appId && { appId }),
      })
    expect((await disconnect()).status).toBe(404)
    expect(data(await disconnect(app.id))).toEqual({ disconnected: true, revoked: 'none' })
  })
})

describe('per-user accounts', () => {
  it('lets each person with Use connect and disconnect their own', async () => {
    const mail = await restResource('mail', oauthAuth({ tokens: 'perUser', pkce: false }))
    // Accounts must match the resource's kind of tokens.
    expect((await start(memberCookie, mail, 'shared')).res.statusCode).toBe(400)
    expect((await start(adminCookie, mail, 'mine')).location).toBeDefined()

    const res = await connect(memberCookie, mail, 'mine')
    expect(res.statusCode).toBe(200)
    expect(lastTokenForm!.has('code_verifier')).toBe(false)
    const rows = await tokensOf(mail)
    expect(rows).toEqual([expect.objectContaining({ userId: memberId, connectedBy: memberId })])

    const mine = data(await member.query('resources.oauthConnections', { resourceId: mail }))
    expect(mine.environments).toContainEqual(
      expect.objectContaining({
        tokens: 'perUser',
        canConnect: true,
        connectedPeople: null,
        connection: expect.objectContaining({ connected: true }),
      }),
    )
    // The admin hasn't connected theirs, and sees how many people have.
    const theirs = data(await admin.query('resources.oauthConnections', { resourceId: mail }))
    expect(theirs.environments).toContainEqual(
      expect.objectContaining({
        environmentId: prodId,
        connection: { connected: false },
        connectedPeople: 1,
      }),
    )

    expect(
      data(
        await member.mutate('resources.oauthDisconnect', {
          resourceId: mail,
          environmentId: prodId,
          account: 'mine',
        }),
      ),
    ).toEqual({ disconnected: true, revoked: 'none' })
    expect(await tokensOf(mail)).toEqual([])
  })
})

describe('refusals before the provider', () => {
  it('needs a session, a configured REST resource, and the authorization code', async () => {
    const noSession = await env.app.inject({
      method: 'GET',
      url: startUrl('00000000-0000-7000-8000-000000000000'),
    })
    expect(noSession.statusCode).toBe(401)
    expect(postedMessage(noSession.body).message.message).toMatch(/Sign in first/)

    expect((await start(adminCookie, '00000000-0000-7000-8000-000000000000')).res.statusCode).toBe(404)

    const bearer = await restResource('bearer_api', { type: 'bearer' })
    const notOauth = await start(adminCookie, bearer)
    expect(notOauth.res.statusCode).toBe(400)
    expect(postedMessage(notOauth.res.body).message.message).toMatch(/doesn't use OAuth/)
    expect(
      data(await admin.query('resources.oauthConnections', { resourceId: bearer })).environments,
    ).toContainEqual(expect.objectContaining({ environmentId: prodId, tokens: null, connection: null }))

    const bad = await env.app.inject({
      method: 'GET',
      url: '/api/oauth/start?resourceId=x',
      headers: { cookie: adminCookie },
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('BigQuery with Google OAuth sign-in', () => {
  const base = {
    location: 'EU',
    maximumBytesBilled: 10 * 1024 ** 3,
    maxRows: 1000,
    statementTimeoutMs: 60_000,
    labels: {},
  }
  const save = (resourceId: string, config: Record<string, unknown>, secrets: Record<string, unknown> = {}) =>
    admin.mutate('resources.saveConfig', { resourceId, environmentId: prodId, config, secrets })

  it('checks the sign-in on save, then sends each person to Google for the BigQuery scope', async () => {
    const id = data(
      await admin.mutate('resources.create', { type: 'bigquery', name: 'Warehouse', slug: 'warehouse' }),
    ).id as string
    const oauth = { type: 'oauth', clientId: 'bq-client.apps.googleusercontent.com', tokens: 'perUser' }
    for (const [config, secrets, message] of [
      [base, {}, 'Add the service account key'],
      [
        { ...base, projectId: 'optiply-dw', auth: { ...oauth, clientId: ' ' } },
        { clientSecret: CLIENT_SECRET },
        'Add the OAuth app’s client id',
      ],
      [
        { ...base, projectId: 'optiply-dw', auth: { type: 'oauth', tokens: 'perUser' } },
        { clientSecret: CLIENT_SECRET },
        'Add the OAuth app’s client id',
      ],
      [{ ...base, projectId: 'optiply-dw', auth: oauth }, {}, 'client secret'],
      [{ ...base, auth: oauth }, { clientSecret: CLIENT_SECRET }, 'Set the project'],
    ] as const) {
      const refused = await save(id, config, secrets)
      expect(refused.status, message).toBe(400)
      expect(refused.body.error?.message).toContain(message)
    }
    expect(
      (await save(id, { ...base, projectId: 'optiply-dw', auth: oauth }, { clientSecret: CLIENT_SECRET }))
        .status,
    ).toBe(200)
    const [all] = await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users'))
    await env.db
      .insert(permissions)
      .values({ groupId: all!.id, objectType: 'resource', objectId: id, environmentId: prodId, level: 'use' })

    const { res, location } = await start(memberCookie, id, 'mine')
    expect(res.statusCode).toBe(302)
    expect(location!.origin + location!.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(location!.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'bq-client.apps.googleusercontent.com',
      redirect_uri: 'http://localhost:5173/api/oauth/callback',
      scope: 'openid email https://www.googleapis.com/auth/bigquery',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256',
    })
    // Each person connects their own: there is no shared account to connect.
    expect((await start(adminCookie, id, 'shared')).res.statusCode).toBe(400)
  })

  it("Optiply sign-in: saved without a client secret, each person goes to Optiply's Auth0 for the API audience", async () => {
    const id = data(
      await admin.mutate('resources.create', {
        type: 'bigquery',
        name: 'Data platform',
        slug: 'data_platform',
      }),
    ).id as string
    const optiply = { type: 'optiply', clientId: 'optiply-workflows-spa' }
    for (const [config, message] of [
      [
        { ...base, projectId: 'optiply-workflows', auth: { ...optiply, clientId: ' ' } },
        'Add the Optiply app’s client id',
      ],
      [
        { ...base, projectId: 'optiply-workflows', auth: { type: 'optiply' } },
        'Add the Optiply app’s client id',
      ],
      [{ ...base, auth: optiply }, 'Set the project'],
    ] as const) {
      const refused = await save(id, config)
      expect(refused.status, message).toBe(400)
      expect(refused.body.error?.message).toContain(message)
    }
    expect((await save(id, { ...base, projectId: 'optiply-workflows', auth: optiply })).status).toBe(200)
    const [all] = await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users'))
    await env.db
      .insert(permissions)
      .values({ groupId: all!.id, objectType: 'resource', objectId: id, environmentId: prodId, level: 'use' })

    const { res, location } = await start(memberCookie, id, 'mine')
    expect(res.statusCode).toBe(302)
    expect(location!.origin + location!.pathname).toBe('https://login.optiply.com/authorize')
    expect(Object.fromEntries(location!.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'optiply-workflows-spa',
      redirect_uri: 'http://localhost:5173/api/oauth/callback',
      scope: 'openid email offline_access',
      audience: 'https://api.optiply.com/internal',
      code_challenge_method: 'S256',
    })
    expect((await start(adminCookie, id, 'shared')).res.statusCode).toBe(400)
  })

  it('switching from Google OAuth to Optiply sign-in drops the stored Google client secret', async () => {
    const id = data(
      await admin.mutate('resources.create', { type: 'bigquery', name: 'Switched', slug: 'switched_signin' }),
    ).id as string
    const google = { type: 'oauth', clientId: 'bq-client.apps.googleusercontent.com', tokens: 'perUser' }
    expect(
      (await save(id, { ...base, projectId: 'optiply-dw', auth: google }, { clientSecret: CLIENT_SECRET }))
        .status,
    ).toBe(200)
    const stored = async () => {
      const [row] = await env.db
        .select()
        .from(resourceConfigs)
        .where(and(eq(resourceConfigs.resourceId, id), eq(resourceConfigs.environmentId, prodId)))
      return decryptConfigSecrets(env.config.keyring, row!)
    }
    expect(await stored()).toEqual({ clientSecret: CLIENT_SECRET })
    // The Optiply form has no secret field: the browser sends no secrets, and the old one isn't kept.
    expect(
      (
        await save(id, {
          ...base,
          projectId: 'optiply-workflows',
          auth: { type: 'optiply', clientId: 'spa' },
        })
      ).status,
    ).toBe(200)
    expect(await stored()).toEqual({})
  })
})

describe('secrets', () => {
  it('never sends a token or the client secret in any response', async () => {
    // Tokens were issued (and stored) during this file's flows.
    expect(issued).toBeGreaterThan(2)
    const all = responses.join('\n')
    expect(all).not.toContain(CLIENT_SECRET)
    expect(all).not.toMatch(/Access-Tok3n|Refresh-Tok3n/)
  })
})
