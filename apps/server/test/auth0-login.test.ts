import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { users } from '@ow/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalUser, startTestApp, type TestEnv, trpc } from './helpers'

// Signing in through Optiply's Auth0 (session 58), as the feedback app does: a public client (no secret: Auth0's
// single-page app), PKCE, an ID token signed by the provider, and signing out at the provider too. Against a fake
// provider shaped like Auth0's (discovery, /authorize, /oauth/token, JWKS, end_session_endpoint).

const CLIENT_ID = 'test-auth0-spa-client'

interface Fake {
  base: string
  /** The next ID token's claims (the test reads the nonce from /authorize). */
  claims: Record<string, unknown>
  tokenRequests: URLSearchParams[]
  stop(): Promise<void>
}

async function startFakeAuth0(): Promise<Fake> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const fake = { claims: {}, tokenRequests: [] } as unknown as Fake
  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const path = new URL(req.url ?? '/', fake.base).pathname
    if (path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: `${fake.base}/`,
        authorization_endpoint: `${fake.base}/authorize`,
        token_endpoint: `${fake.base}/oauth/token`,
        jwks_uri: `${fake.base}/.well-known/jwks.json`,
        end_session_endpoint: `${fake.base}/oidc/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (path === '/.well-known/jwks.json') return json(200, { keys: [jwk] })
    if (path === '/oauth/token' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      fake.tokenRequests.push(form)
      const now = Math.floor(Date.now() / 1000)
      const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
      const payload = b64({ iss: `${fake.base}/`, aud: CLIENT_ID, iat: now, exp: now + 600, ...fake.claims })
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString(
        'base64url',
      )
      return json(200, {
        access_token: 'opaque-access',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: `${header}.${payload}.${signature}`,
      })
    }
    json(404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.stop = () => new Promise((resolve) => server.close(() => resolve()))
  return fake
}

let fake: Fake
let env: TestEnv

beforeAll(async () => {
  fake = await startFakeAuth0()
  env = await startTestApp({
    OIDC_ISSUER: `${fake.base}/`,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_PROVIDER_NAME: 'Optiply',
    OIDC_ALLOW_HTTP: 'true',
  })
})
afterAll(async () => {
  await env?.stop()
  await fake?.stop()
})

const cookieFrom = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[])
    .concat(setCookie ?? [])
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith(`${name}=`))

/** /start, then the provider's answer for `claims`, then /callback: the callback's response. */
async function signIn(claims: Record<string, unknown>) {
  const start = await env.app.inject({ method: 'GET', url: '/api/auth/oidc/start' })
  expect(start.statusCode).toBe(302)
  const authorize = new URL(start.headers.location as string)
  fake.claims = { ...claims, nonce: authorize.searchParams.get('nonce') }
  const state = cookieFrom(start.headers['set-cookie'], 'ow_oidc')!
  return {
    authorize,
    callback: await env.app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=the-code&state=${authorize.searchParams.get('state')}`,
      headers: { cookie: state },
    }),
  }
}

describe('signing in through Auth0', () => {
  it('asks as a public client with PKCE, and says which provider on the login page', async () => {
    const config = (await trpc(env.app, '').query('authConfig')).body.result?.data as Record<string, unknown>
    expect(config).toMatchObject({ oidcEnabled: true, oidcProvider: 'Optiply' })
    const start = await env.app.inject({ method: 'GET', url: '/api/auth/oidc/start' })
    const authorize = new URL(start.headers.location as string)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${fake.base}/authorize`)
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      redirect_uri: expect.stringMatching(/\/api\/auth\/oidc\/callback$/),
    })
    // Google's hints aren't sent to Auth0.
    expect(authorize.searchParams.has('hd')).toBe(false)
  })

  it('lets an existing colleague in by their email, keeping their account, and signs out at Auth0 too', async () => {
    const existing = await createLocalUser(env.db, 'colleague@optiply.nl')
    const { callback } = await signIn({
      sub: 'google-oauth2|1234',
      email: 'Colleague@optiply.nl',
      email_verified: true,
      name: 'A Colleague',
    })
    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/')
    // The code exchange: no secret, the PKCE verifier.
    const token = fake.tokenRequests.at(-1)!
    expect(token.get('code_verifier')).toBeTruthy()
    expect(token.get('client_id')).toBe(CLIENT_ID)
    expect(token.has('client_secret')).toBe(false)

    const session = cookieFrom(callback.headers['set-cookie'], 'ow_session')!
    const me = (await trpc(env.app, session).query('me')).body.result?.data as { id: string; email: string }
    expect(me).toMatchObject({ id: existing.id, email: 'colleague@optiply.nl' })
    const [row] = await env.db.select().from(users).where(eq(users.id, existing.id))
    expect(row!.oidcSubject).toBe('google-oauth2|1234')

    const out = await env.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session },
    })
    const redirect = new URL(out.json().redirect)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(`${fake.base}/oidc/logout`)
    expect(redirect.searchParams.get('client_id')).toBe(CLIENT_ID)
    // The site's root: what Auth0 apps allow as their logout URL (it sends a signed-out person on to /login).
    expect(redirect.searchParams.get('post_logout_redirect_uri')).toMatch(/^http:\/\/[^/]+\/$/)
    expect((await trpc(env.app, session).query('me')).body.result?.data).toBeNull()
  })

  it('keeps the rules: a new colleague waits, an outsider and an unverified email are refused', async () => {
    const newcomer = await signIn({ sub: 'auth0|new', email: 'newcomer@optiply.nl', email_verified: true })
    expect(newcomer.callback.headers.location).toBe('/login?pending=1')

    const outsider = await signIn({ sub: 'auth0|out', email: 'someone@example.com', email_verified: true })
    expect(decodeURIComponent(outsider.callback.headers.location as string)).toContain(
      'Only @optiply.nl accounts or invited people can sign in',
    )

    // Auth0 database users may not have verified their address: anyone could sign up with a colleague's.
    const unverified = await signIn({ sub: 'auth0|fake', email: 'boss@optiply.nl', email_verified: false })
    expect(decodeURIComponent(unverified.callback.headers.location as string)).toContain(
      'Your email address is not verified',
    )
  })
})

describe('with the callback at the site’s root (an Auth0 app that allows only that)', () => {
  let rootEnv: TestEnv
  beforeAll(async () => {
    rootEnv = await startTestApp({
      OIDC_ISSUER: `${fake.base}/`,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_PROVIDER_NAME: 'Optiply',
      OIDC_ALLOW_HTTP: 'true',
      OIDC_CALLBACK_PATH: '/',
    })
  })
  afterAll(async () => {
    await rootEnv?.stop()
  })

  it('comes back to / and signs in there; other requests to / are left alone', async () => {
    await createLocalUser(rootEnv.db, 'root@optiply.nl')
    const start = await rootEnv.app.inject({ method: 'GET', url: '/api/auth/oidc/start' })
    const authorize = new URL(start.headers.location as string)
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/[^/]+\/$/)
    fake.claims = {
      sub: 'google-oauth2|root',
      email: 'root@optiply.nl',
      email_verified: true,
      nonce: authorize.searchParams.get('nonce'),
    }
    const state = cookieFrom(start.headers['set-cookie'], 'ow_oidc')!
    const back = await rootEnv.app.inject({
      method: 'GET',
      url: `/?code=the-code&state=${authorize.searchParams.get('state')}`,
      headers: { cookie: state },
    })
    expect(back.statusCode).toBe(302)
    expect(back.headers.location).toBe('/')
    const session = cookieFrom(back.headers['set-cookie'], 'ow_session')!
    expect((await trpc(rootEnv.app, session).query('me')).body.result?.data).toMatchObject({
      email: 'root@optiply.nl',
    })
    // A plain / (and one without the sign-in's state) is the web app's, as before.
    const plain = await rootEnv.app.inject({ method: 'GET', url: '/?code=x' })
    expect(String(plain.headers.location ?? '')).not.toMatch(/login\?error/)
    // After signing out, Auth0 returns to the site's root (what the app allows), which sends on to /login.
    const out = await rootEnv.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session },
    })
    expect(new URL(out.json().redirect).searchParams.get('post_logout_redirect_uri')).toMatch(
      /^http:\/\/[^/]+\/$/,
    )
  })
})
