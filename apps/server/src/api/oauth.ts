import { buildAuthorizeUrl, ConnectorError, createPkce, createState, exchangeCode } from '@ow/connectors'
import { scrubSecrets } from '@ow/crypto'
import type { Db } from '@ow/db'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../audit'
import { lookupSession, SESSION_COOKIE, type SessionUser } from '../auth/sessions'
import type { Config } from '../config'
import {
  type ConnectResult,
  connectTarget,
  OAuthConnectError,
  oauthRedirectUri,
  PENDING_COOKIE_PATH,
  PENDING_MAX_AGE_S,
  type PendingConnect,
  pendingCookieName,
  resultPage,
} from '../services/oauth-connect'
import { authFingerprint, saveTokens } from '../services/oauth-tokens'

const StartQuery = z.object({
  resourceId: z.string().uuid(),
  environmentId: z.string().uuid(),
  account: z.enum(['shared', 'mine']).default('shared'),
  /** Connecting one's own account from an app whose resource the person has no access to. */
  appId: z.string().uuid().optional(),
})

const CallbackQuery = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
})

/** The token exchange gets this long. */
const EXCHANGE_TIMEOUT_MS = 15_000

/**
 * Connecting an account to a REST resource with the OAuth 2.0 authorization code: the browser opens
 * `/api/oauth/start` (in a popup), which sends it to the provider's consent screen; the provider sends it back to
 * `/api/oauth/callback`, which trades the code for tokens, stores them and ends on a page telling the opener how
 * it went. State and the PKCE verifier live in a short-lived signed cookie bound to the person who started.
 */
export const oauthApi: FastifyPluginAsync<{ db: Db; config: Config }> = async (app, { db, config }) => {
  const redirectUri = oauthRedirectUri(config)
  const cookieOptions = {
    path: PENDING_COOKIE_PATH,
    httpOnly: true,
    // Lax: the provider's redirect back is a top-level GET navigation, which carries it.
    sameSite: 'lax' as const,
    secure: config.secureCookies,
  }

  const finish = (reply: FastifyReply, status: number, result: ConnectResult) =>
    reply
      .code(status)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(resultPage(config, result))

  const signedIn = (req: FastifyRequest): Promise<SessionUser | null> =>
    lookupSession(db, req.cookies[SESSION_COOKIE])

  app.get('/api/oauth/start', async (req, reply) => {
    const query = StartQuery.safeParse(req.query)
    if (!query.success) return finish(reply, 400, { ok: false, message: 'The connect link is incomplete' })
    const ids = { resourceId: query.data.resourceId, environmentId: query.data.environmentId }
    const user = await signedIn(req)
    if (!user) return finish(reply, 401, { ok: false, message: 'Sign in first, then connect again', ...ids })

    try {
      const target = await connectTarget(db, config.keyring, user, query.data)
      const state = createState()
      const pkce = target.auth.pkce ? createPkce() : undefined
      const pending: PendingConnect = {
        state,
        ...(pkce && { verifier: pkce.verifier }),
        ...ids,
        account: query.data.account,
        ...(query.data.appId && { appId: query.data.appId }),
        userId: user.id,
        consent: authFingerprint(target.config.config)!,
      }
      reply.setCookie(pendingCookieName(state), JSON.stringify(pending), {
        ...cookieOptions,
        maxAge: PENDING_MAX_AGE_S,
        signed: true,
      })
      const url = buildAuthorizeUrl(target.auth, {
        redirectUri,
        state,
        ...(pkce && { codeChallenge: pkce.challenge }),
      })
      return reply.header('cache-control', 'no-store').redirect(url.toString())
    } catch (err) {
      if (err instanceof OAuthConnectError)
        return finish(reply, err.status, { ok: false, message: err.message, ...ids })
      throw err
    }
  })

  app.get('/api/oauth/callback', async (req, reply) => {
    const query = CallbackQuery.safeParse(req.query)
    if (!query.success)
      return finish(reply, 400, { ok: false, message: 'The provider sent back an incomplete answer' })
    const { state } = query.data

    // The cookie is single-use: cleared whatever happens next.
    const name = pendingCookieName(state)
    const raw = req.cookies[name]
    reply.clearCookie(name, cookieOptions)
    const unsigned = raw ? req.unsignCookie(raw) : undefined
    let pending: PendingConnect | undefined
    try {
      pending = unsigned?.valid && unsigned.value ? (JSON.parse(unsigned.value) as PendingConnect) : undefined
    } catch {
      pending = undefined
    }
    if (!pending || pending.state !== state) {
      return finish(reply, 400, {
        ok: false,
        message: 'This sign-in expired or was started elsewhere. Connect again.',
      })
    }
    const ids = {
      resourceId: pending.resourceId,
      environmentId: pending.environmentId,
      account: pending.account,
    }

    const user = await signedIn(req)
    if (!user || user.id !== pending.userId) {
      return finish(reply, 401, {
        ok: false,
        message: 'Sign in as the person who started connecting, then connect again',
        ...ids,
      })
    }
    if (query.data.error) {
      const declined = query.data.error === 'access_denied'
      const detail = query.data.error_description ? `: ${query.data.error_description}` : ''
      return finish(reply, 400, {
        ok: false,
        message: declined
          ? 'Access was declined at the provider'
          : `The provider refused (${query.data.error}${detail})`,
        ...ids,
      })
    }
    if (!query.data.code)
      return finish(reply, 400, { ok: false, message: 'The provider sent no code', ...ids })

    let target: Awaited<ReturnType<typeof connectTarget>>
    try {
      // Checked again: access or settings may have changed while the consent screen was open.
      target = await connectTarget(db, config.keyring, user, pending)
    } catch (err) {
      if (err instanceof OAuthConnectError)
        return finish(reply, err.status, { ok: false, message: err.message, ...ids })
      throw err
    }
    const consent = authFingerprint(target.config.config)!
    if (consent !== pending.consent) {
      return finish(reply, 400, {
        ok: false,
        message: "The resource's OAuth settings changed while you were signing in. Connect again.",
        ...ids,
      })
    }

    let tokens: Awaited<ReturnType<typeof exchangeCode>>
    try {
      tokens = await exchangeCode(
        target.auth,
        target.clientSecret,
        { code: query.data.code, redirectUri, ...(pending.verifier && { codeVerifier: pending.verifier }) },
        { signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS), allowPrivateNetwork: target.allowPrivateNetwork },
      )
    } catch (err) {
      const secrets = [target.clientSecret, query.data.code].filter((s): s is string => !!s)
      const message =
        err instanceof ConnectorError
          ? scrubSecrets(err.message, secrets)
          : (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError'
            ? 'The provider took too long to answer'
            : 'The provider could not be reached'
      req.log.warn({ resourceId: target.resource.id, message }, 'OAuth code exchange failed')
      return finish(reply, 502, { ok: false, message, ...ids })
    }

    await saveTokens(db, config.keyring, {
      resourceConfigId: target.config.id,
      environmentId: target.config.environmentId,
      userId: target.userId,
      tokens,
      consentHash: consent,
      connectedBy: user.id,
    })
    await recordAudit(db, {
      actorUserId: user.id,
      action: 'resource.oauth_connected',
      objectType: 'resource',
      objectId: target.resource.id,
      environmentId: target.config.environmentId,
      metadata: {
        account: target.userId === null ? 'shared' : 'user',
        provider: target.auth.provider,
        connectedAccount: tokens.account,
        scope: tokens.scope,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    return finish(reply, 200, {
      ok: true,
      message: tokens.account
        ? `Connected as ${tokens.account}. You can close this window.`
        : 'Connected. You can close this window.',
      ...ids,
    })
  })
}
