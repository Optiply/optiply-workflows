import { type Db, users } from '@ow/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import * as oidc from 'openid-client'
import { z } from 'zod'
import { recordAudit } from '../audit'
import { type Config, isGoogle } from '../config'
import { notifyAdminsOfRequest, provisionUser, SignInRefused, signInDecision } from '../services/users'
import { verifyPassword } from './password'
import { createSession, deleteSession, SESSION_COOKIE } from './sessions'

const OIDC_STATE_COOKIE = 'ow_oidc'

const LocalLoginBody = z.object({ email: z.string().email(), password: z.string().min(1).max(500) })

/**
 * OIDC discovery is lazy and memoized so the API boots even when the IdP is unreachable. Without a client secret it's
 * a public client (Auth0's single-page app, session 58): the code exchange is protected by PKCE alone.
 */
function oidcClient(config: Config) {
  let discovered: Promise<oidc.Configuration> | undefined
  return () => {
    discovered ??= oidc
      .discovery(
        new URL(config.OIDC_ISSUER),
        config.OIDC_CLIENT_ID!,
        config.OIDC_CLIENT_SECRET || undefined,
        config.OIDC_CLIENT_SECRET ? undefined : oidc.None(),
        config.OIDC_ALLOW_HTTP ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err) => {
        discovered = undefined
        throw err
      })
    return discovered
  }
}

/**
 * Where signing out sends the browser so the provider's own session ends too (else Sign in lets the person straight
 * back in): its end_session_endpoint (OIDC RP-initiated logout), or Auth0's /v2/logout; none for Google.
 */
async function providerLogoutUrl(
  config: Config,
  getOidc: () => Promise<oidc.Configuration>,
): Promise<string | null> {
  if (isGoogle(config.OIDC_ISSUER)) return null
  // The site's root (it sends a signed-out person on to /login): what Auth0 apps allow as their logout URL.
  const returnTo = new URL('/', config.PUBLIC_URL).toString()
  try {
    const client = await getOidc()
    if (client.serverMetadata().end_session_endpoint) {
      return oidc
        .buildEndSessionUrl(client, { client_id: config.OIDC_CLIENT_ID!, post_logout_redirect_uri: returnTo })
        .toString()
    }
  } catch {
    // The provider unreachable: its session stays, ours is gone anyway.
    return null
  }
  if (/\.auth0\.com$/.test(new URL(config.OIDC_ISSUER).hostname)) {
    const url = new URL('/v2/logout', config.OIDC_ISSUER)
    url.searchParams.set('client_id', config.OIDC_CLIENT_ID!)
    url.searchParams.set('returnTo', returnTo)
    return url.toString()
  }
  return null
}

export async function authRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts
  // Where the provider sends the browser back: our own path, or the site's root where the provider's app allows only
  // that (Optiply's Auth0 app, session 58); there a request with `code` and `state` is the sign-in coming back.
  const callbackPath = config.OIDC_CALLBACK_PATH
  const redirectUri = new URL(callbackPath, config.PUBLIC_URL).toString()
  /** The sign-in's state cookie goes where the callback is. */
  const stateCookiePath = callbackPath === '/' ? '/' : '/api/auth/oidc'
  const getOidc = config.oidcEnabled ? oidcClient(config) : undefined

  const cookieBase = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
  }

  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] })

  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, method: string) {
    const { token, expiresAt } = await createSession(db, userId, config.SESSION_TTL_HOURS, meta(req))
    reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, expires: expiresAt })
    await recordAudit(db, { actorUserId: userId, action: 'auth.login', metadata: { method }, ...meta(req) })
  }

  app.get('/api/auth/oidc/start', async (_req, reply) => {
    if (!getOidc) return reply.code(404).send({ error: 'SSO is not configured' })
    const client = await getOidc()
    const verifier = oidc.randomPKCECodeVerifier()
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      // Google's hint (its account picker shows the domain's); the domain is still verified on the callback.
      ...(isGoogle(config.OIDC_ISSUER) && { hd: config.OIDC_ALLOWED_DOMAIN, prompt: 'select_account' }),
    })
    reply.setCookie(OIDC_STATE_COOKIE, JSON.stringify({ verifier, state, nonce }), {
      ...cookieBase,
      path: stateCookiePath,
      maxAge: 600,
      signed: true,
    })
    return reply.redirect(url.toString())
  })

  async function oidcCallback(req: FastifyRequest, reply: FastifyReply) {
    if (!getOidc) return reply.code(404).send({ error: 'SSO is not configured' })
    const fail = (reason: string) => {
      req.log.warn({ reason }, 'OIDC login rejected')
      return reply.redirect(`/login?error=${encodeURIComponent(reason)}`)
    }

    const raw = req.cookies[OIDC_STATE_COOKIE]
    reply.clearCookie(OIDC_STATE_COOKIE, { ...cookieBase, path: stateCookiePath })
    const unsigned = raw ? req.unsignCookie(raw) : undefined
    if (!unsigned?.valid || !unsigned.value) return fail('Login session expired, please try again')
    const { verifier, state, nonce } = JSON.parse(unsigned.value) as Record<string, string>

    let claims: oidc.IDToken | undefined
    try {
      const client = await getOidc()
      const currentUrl = new URL(req.url, config.PUBLIC_URL)
      const tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      })
      claims = tokens.claims()
    } catch (err) {
      req.log.error({ err }, 'OIDC code exchange failed')
      return fail('Sign-in failed')
    }

    const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : undefined
    const domain = config.OIDC_ALLOWED_DOMAIN.toLowerCase()
    if (!claims || !email || claims.email_verified !== true) return fail('Your email address is not verified')
    // A first sign-in waits for an admin's approval (session 44: everyone new, the domain's people too). Who may get
    // in at all (the domain, or invited) is decided inside provisioning's lock, on the row it uses.
    let user: Awaited<ReturnType<typeof provisionUser>>
    try {
      user = await provisionUser(
        db,
        {
          email,
          name: typeof claims.name === 'string' ? claims.name : email,
          avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
          oidcSubject: claims.sub,
        },
        {
          status: 'pending',
          admit: (existing) =>
            signInDecision({
              email,
              domain,
              hd: typeof claims.hd === 'string' ? claims.hd : undefined,
              sub: claims.sub,
              existing,
            }),
        },
      )
    } catch (err) {
      if (err instanceof SignInRefused) return fail(err.message)
      throw err
    }
    if (user.disabled) return fail('Your account has been disabled')
    if (user.status === 'pending') {
      if (user.created) {
        await recordAudit(db, {
          actorUserId: user.id,
          action: 'user.requested',
          objectType: 'user',
          objectId: user.id,
          metadata: { email },
          ...meta(req),
        })
        notifyAdminsOfRequest(req.log, { email })
      }
      return reply.redirect('/login?pending=1')
    }
    if (user.status !== 'active') return fail('Your request to use Optiply Workflows was not approved')
    await startSession(req, reply, user.id, 'oidc')
    return reply.redirect('/')
  }

  app.get('/api/auth/oidc/callback', oidcCallback)
  if (callbackPath === '/') {
    // The provider comes back to the root: answered here, before the web app (its static files) would be.
    app.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'GET') return
      const url = new URL(req.url, config.PUBLIC_URL)
      if (url.pathname !== '/' || !url.searchParams.has('state')) return
      if (!url.searchParams.has('code') && !url.searchParams.has('error')) return
      return oidcCallback(req, reply)
    })
  }

  app.post('/api/auth/local', async (req, reply) => {
    if (!config.LOCAL_LOGIN_ENABLED) return reply.code(404).send({ error: 'Local login is disabled' })
    const body = LocalLoginBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Email and password are required' })

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, body.data.email.toLowerCase()))
      .limit(1)
    const ok =
      user?.passwordHash &&
      !user.disabledAt &&
      user.status === 'active' &&
      (await verifyPassword(body.data.password, user.passwordHash))
    if (!user || !ok) {
      await recordAudit(db, {
        actorUserId: null,
        action: 'auth.login_failed',
        metadata: { method: 'local', email: body.data.email },
        ...meta(req),
      })
      return reply.code(401).send({ error: 'Invalid email or password' })
    }
    await startSession(req, reply, user.id, 'local')
    return { ok: true }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    await deleteSession(db, req.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, cookieBase)
    // The browser goes on to the provider's sign-out (Auth0's), which comes back to /login.
    const redirect = getOidc ? await providerLogoutUrl(config, getOidc) : null
    return { ok: true, redirect }
  })
}
// Not encapsulated (what fastify-plugin marks): the root callback's hook above must see `GET /`, which the web app's
// static files answer outside this plugin. It acts only on `/` with `state` and `code` (or `error`).
;(authRoutes as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true
