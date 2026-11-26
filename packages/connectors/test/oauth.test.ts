import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AuthorizationCodeSettings,
  buildAuthorizeUrl,
  ConnectorError,
  createPkce,
  exchangeCode,
  fillPlaceholders,
  OAuthGrantError,
  oauthPresets,
  refreshAccessToken,
  restConnector,
  revokeToken,
} from '../src'

interface TokenRequest {
  form: URLSearchParams
  headers: IncomingHttpHeaders
}

let server: Server
let origin: string
let requests: TokenRequest[] = []
/** What the fake token endpoint answers next. */
let answer: (req: TokenRequest, res: ServerResponse) => void

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/moved') {
      res.writeHead(308, { location: '/token' })
      return res.end()
    }
    if (url.pathname === '/elsewhere') {
      // Same server, another origin (localhost instead of 127.0.0.1).
      res.writeHead(307, { location: `http://localhost:${(server.address() as AddressInfo).port}/token` })
      return res.end()
    }
    if (url.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' })
      return res.end()
    }
    const request = { form: new URLSearchParams(body), headers: req.headers }
    requests.push(request)
    answer(request, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise((r) => server?.close(r)))
beforeEach(() => {
  requests = []
  answer = (_req, res) => json(res, 200, { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 })
})

const settings = (overrides: Partial<AuthorizationCodeSettings> = {}): AuthorizationCodeSettings => ({
  provider: 'custom',
  authorizeUrl: 'https://auth.example.com/authorize',
  tokenUrl: `${origin}/token`,
  clientId: 'client id',
  scope: 'read write',
  authorizeParams: [],
  clientAuth: 'body',
  pkce: true,
  ...overrides,
})

const now = new Date('2026-10-16T10:00:00Z')
const opts = () => ({ signal: AbortSignal.timeout(5000), allowPrivateNetwork: true, now })

/** An unsigned JWT carrying the given claims (the account label never checks signatures). */
const idToken = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected the token request to fail')
}

describe('the consent URL', () => {
  it('carries the flow parameters, which extra parameters cannot replace', () => {
    const url = buildAuthorizeUrl(
      settings({
        authorizeUrl: 'https://auth.example.com/authorize?tenant=x',
        authorizeParams: [
          { key: 'access_type', value: 'offline' },
          { key: 'state', value: 'attacker' },
          { key: 'redirect_uri', value: 'https://evil.example.com' },
          { key: '', value: 'ignored' },
        ],
      }),
      { redirectUri: 'https://ow.example.com/api/oauth/callback', state: 'st-1', codeChallenge: 'ch-1' },
    )
    expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: 'x',
      access_type: 'offline',
      state: 'st-1',
      redirect_uri: 'https://ow.example.com/api/oauth/callback',
      response_type: 'code',
      client_id: 'client id',
      scope: 'read write',
      code_challenge: 'ch-1',
      code_challenge_method: 'S256',
    })
  })

  it('leaves out an empty scope and PKCE when not used', () => {
    const url = buildAuthorizeUrl(
      settings({ scope: '  ', authorizeParams: [{ key: 'code_challenge', value: 'x' }] }),
      { redirectUri: 'https://ow.example.com/cb', state: 's' },
    )
    expect(url.searchParams.has('scope')).toBe(false)
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
  })

  it('makes S256 PKCE pairs', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[\w-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(createPkce().verifier).not.toBe(verifier)
  })
})

describe('exchanging the code', () => {
  it('sends the code, redirect URI, verifier and client credentials in the body', async () => {
    answer = (_req, res) =>
      json(res, 200, {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: '3600',
        scope: 'read',
        id_token: idToken({ email: 'ada@optiply.nl', name: 'Ada' }),
      })
    const tokens = await exchangeCode(
      settings(),
      'cs-1',
      { code: 'code-1', redirectUri: 'https://ow.example.com/cb', codeVerifier: 'v-1' },
      opts(),
    )
    expect(tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: new Date('2026-10-16T11:00:00Z'),
      scope: 'read',
      account: 'ada@optiply.nl',
    })
    const [req] = requests
    expect(Object.fromEntries(req!.form)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://ow.example.com/cb',
      code_verifier: 'v-1',
      client_id: 'client id',
      client_secret: 'cs-1',
    })
    expect(req!.headers.authorization).toBeUndefined()
  })

  it('uses HTTP Basic when the resource says so, and no secret for public clients', async () => {
    await exchangeCode(settings({ clientAuth: 'basic' }), 'p:ss', { code: 'c', redirectUri: 'r' }, opts())
    const [basic] = requests
    expect(basic!.headers.authorization).toBe(`Basic ${Buffer.from('client%20id:p%3Ass').toString('base64')}`)
    expect(basic!.form.has('client_secret')).toBe(false)
    expect(basic!.form.has('client_id')).toBe(false)
    expect(basic!.form.has('code_verifier')).toBe(false)

    await exchangeCode(settings({ clientAuth: 'basic' }), undefined, { code: 'c', redirectUri: 'r' }, opts())
    expect(requests[1]!.headers.authorization).toBeUndefined()
    expect(requests[1]!.form.get('client_id')).toBe('client id')
    expect(requests[1]!.form.has('client_secret')).toBe(false)
  })

  it('sends a public app’s client id only, even when a secret is stored (clientAuth none)', async () => {
    const pub = settings({ clientAuth: 'none', revokeUrl: `${origin}/revoke` })
    await exchangeCode(pub, 'GOCSPX-stale', { code: 'c', redirectUri: 'r' }, opts())
    await refreshAccessToken(pub, 'GOCSPX-stale', 'rt-1', opts())
    answer = (_req, res) => json(res, 200, {})
    await revokeToken(pub, 'GOCSPX-stale', { value: 'rt-1', type: 'refresh_token' }, opts())
    expect(requests).toHaveLength(3)
    for (const r of requests) {
      expect(r.form.get('client_id')).toBe('client id')
      expect(r.form.has('client_secret')).toBe(false)
      expect(r.headers.authorization).toBeUndefined()
    }
  })

  it('has no expiry when the provider gives none, and reads form-encoded answers', async () => {
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' })
      res.end('access_token=at-form&token_type=bearer&scope=repo')
    }
    const tokens = await exchangeCode(settings(), 'cs', { code: 'c', redirectUri: 'r' }, opts())
    expect(tokens).toEqual({
      accessToken: 'at-form',
      refreshToken: null,
      expiresAt: null,
      scope: 'repo',
      account: null,
    })
  })

  it('reports a refused grant as "reconnect" and other failures as HTTP errors', async () => {
    answer = (_req, res) => json(res, 400, { error: 'invalid_grant', error_description: 'Code expired' })
    const grant = await failure(exchangeCode(settings(), 'cs', { code: 'c', redirectUri: 'r' }, opts()))
    expect(grant).toBeInstanceOf(OAuthGrantError)
    expect(grant).toMatchObject({
      code: 'auth_required',
      message: 'The provider refused the connection (invalid_grant: Code expired)',
      details: { reason: 'invalid_grant' },
    })

    answer = (_req, res) => json(res, 401, { error: 'invalid_client' })
    const client = await failure(exchangeCode(settings(), 'cs', { code: 'c', redirectUri: 'r' }, opts()))
    expect(client).not.toBeInstanceOf(OAuthGrantError)
    expect(client).toMatchObject({
      code: 'http',
      message: 'OAuth2 token request failed: HTTP 401',
      details: { status: 401 },
    })

    answer = (_req, res) => json(res, 200, { token_type: 'Bearer' })
    expect(
      (await failure(exchangeCode(settings(), 'cs', { code: 'c', redirectUri: 'r' }, opts()))).message,
    ).toBe('OAuth2 token response has no access_token')

    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>login</html>')
    }
    expect(
      (await failure(exchangeCode(settings(), 'cs', { code: 'c', redirectUri: 'r' }, opts()))).message,
    ).toBe('OAuth2 token response is not JSON')
  })

  it('refuses private token URLs unless the resource allows them', async () => {
    const blocked = await failure(
      exchangeCode(
        settings(),
        'cs',
        { code: 'c', redirectUri: 'r' },
        { ...opts(), allowPrivateNetwork: false },
      ),
    )
    expect(blocked).toMatchObject({ code: 'blocked', message: '127.0.0.1 is a private address' })

    const named = await failure(
      exchangeCode(
        settings({ tokenUrl: `${origin.replace('127.0.0.1', 'localhost')}/token` }),
        'cs',
        { code: 'c', redirectUri: 'r' },
        { ...opts(), allowPrivateNetwork: false },
      ),
    )
    expect(named).toMatchObject({ code: 'blocked', message: expect.stringMatching(/private address/) })
    expect(requests).toHaveLength(0)
  })

  it('follows redirects on the same origin only, re-sending the request', async () => {
    const moved = await exchangeCode(
      settings({ tokenUrl: `${origin}/moved` }),
      'cs',
      { code: 'c', redirectUri: 'r' },
      opts(),
    )
    expect(moved.accessToken).toBe('at-1')
    expect(requests[0]!.form.get('client_secret')).toBe('cs')

    const elsewhere = await failure(
      exchangeCode(
        settings({ tokenUrl: `${origin}/elsewhere` }),
        'cs',
        { code: 'c', redirectUri: 'r' },
        opts(),
      ),
    )
    expect(elsewhere.message).toMatch(/redirects to another origin \(http:\/\/localhost:/)
    const loop = await failure(
      exchangeCode(settings({ tokenUrl: `${origin}/loop` }), 'cs', { code: 'c', redirectUri: 'r' }, opts()),
    )
    expect(loop.message).toBe('The OAuth2 token URL redirects too many times')
    expect(requests).toHaveLength(1)
  })
})

describe('refreshing', () => {
  it('keeps the refresh token when the provider sends none, and takes a rotated one', async () => {
    const kept = await refreshAccessToken(settings(), 'cs', 'rt-old', opts())
    expect(kept).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-old' })
    expect(Object.fromEntries(requests[0]!.form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
      client_id: 'client id',
      client_secret: 'cs',
    })

    answer = (_req, res) => json(res, 200, { access_token: 'at-2', refresh_token: 'rt-new', expires_in: 60 })
    const rotated = await refreshAccessToken(settings(), 'cs', 'rt-old', opts())
    expect(rotated).toMatchObject({
      accessToken: 'at-2',
      refreshToken: 'rt-new',
      expiresAt: new Date('2026-10-16T10:01:00Z'),
    })
  })

  it('sends the scopes again only to Microsoft', async () => {
    await refreshAccessToken(settings({ provider: 'microsoft' }), 'cs', 'rt', opts())
    await refreshAccessToken(settings({ provider: 'google' }), 'cs', 'rt', opts())
    expect(requests[0]!.form.get('scope')).toBe('read write')
    expect(requests[1]!.form.has('scope')).toBe(false)
  })

  it('reports a revoked refresh token as "reconnect"', async () => {
    answer = (_req, res) => json(res, 400, { error: 'invalid_grant' })
    const err = await failure(refreshAccessToken(settings(), 'cs', 'rt', opts()))
    expect(err).toBeInstanceOf(OAuthGrantError)
    expect(err.code).toBe('auth_required')
  })
})

describe('Slack', () => {
  const slack = () => settings({ provider: 'slack' })

  it('reads the bot token and the workspace name', async () => {
    answer = (_req, res) =>
      json(res, 200, {
        ok: true,
        access_token: 'xoxb-1',
        token_type: 'bot',
        scope: 'chat:write',
        team: { id: 'T1', name: 'Optiply' },
        authed_user: { id: 'U1' },
      })
    const tokens = await exchangeCode(slack(), 'cs', { code: 'c', redirectUri: 'r' }, opts())
    expect(tokens).toEqual({
      accessToken: 'xoxb-1',
      refreshToken: null,
      expiresAt: null,
      scope: 'chat:write',
      account: 'Optiply',
    })
  })

  it('reads a user token (with rotation) from authed_user', async () => {
    answer = (_req, res) =>
      json(res, 200, {
        ok: true,
        team: { name: 'Optiply' },
        authed_user: {
          id: 'U1',
          access_token: 'xoxe.xoxp-1',
          refresh_token: 'xoxe-1',
          expires_in: 43200,
          scope: 'search:read',
        },
      })
    const tokens = await exchangeCode(slack(), 'cs', { code: 'c', redirectUri: 'r' }, opts())
    expect(tokens).toMatchObject({
      accessToken: 'xoxe.xoxp-1',
      refreshToken: 'xoxe-1',
      expiresAt: new Date('2026-10-16T22:00:00Z'),
      scope: 'search:read',
      account: 'Optiply',
    })
  })

  it('treats ok: false as a failure, and a used code or revoked token as "reconnect"', async () => {
    answer = (_req, res) => json(res, 200, { ok: false, error: 'invalid_code' })
    expect(
      await failure(exchangeCode(slack(), 'cs', { code: 'c', redirectUri: 'r' }, opts())),
    ).toBeInstanceOf(OAuthGrantError)

    answer = (_req, res) => json(res, 200, { ok: false, error: 'bad_redirect_uri' })
    const err = await failure(exchangeCode(slack(), 'cs', { code: 'c', redirectUri: 'r' }, opts()))
    expect(err).toMatchObject({ code: 'http', message: 'OAuth2 token request failed: bad_redirect_uri' })
  })
})

describe('revoking (Disconnect)', () => {
  const token = { value: 'rt-1', type: 'refresh_token' as const }
  const revoking = (overrides: Partial<AuthorizationCodeSettings> = {}) =>
    settings({ revokeUrl: `${origin}/revoke`, clientAuth: 'basic', ...overrides })

  it('posts the token with its hint and the client’s credentials (RFC 7009)', async () => {
    answer = (_req, res) => json(res, 200, {})
    await revokeToken(revoking(), 'shh', token, opts())
    expect(requests).toHaveLength(1)
    expect(Object.fromEntries(requests[0]!.form)).toEqual({ token: 'rt-1', token_type_hint: 'refresh_token' })
    expect(requests[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('client%20id:shh').toString('base64')}`,
    )
  })

  it('takes a token already gone as revoked, and reports Slack’s ok: false and HTTP errors', async () => {
    answer = (_req, res) => json(res, 400, { error: 'invalid_token' })
    await revokeToken(revoking(), 'shh', token, opts())
    answer = (_req, res) => json(res, 200, { ok: false, error: 'not_allowed_token_type' })
    expect((await failure(revokeToken(revoking(), 'shh', token, opts()))).message).toBe(
      "The provider didn't revoke the token: not_allowed_token_type",
    )
    answer = (_req, res) => json(res, 500, {})
    expect((await failure(revokeToken(revoking(), 'shh', token, opts()))).message).toBe(
      "The provider didn't revoke the token: HTTP 500",
    )
  })

  it('sends nothing off the token URL’s origin, or without a URL', async () => {
    const far = revoking({ revokeUrl: `http://localhost:${new URL(origin).port}/revoke` })
    expect((await failure(revokeToken(far, 'shh', token, opts()))).message).toMatch(/token URL’s origin/)
    expect((await failure(revokeToken(settings(), 'shh', token, opts()))).code).toBe('invalid_config')
    expect(requests).toEqual([])
  })
})

describe('presets', () => {
  it('each make a valid authorization-code resource once their placeholders are filled', () => {
    for (const preset of Object.values(oauthPresets)) {
      const values = Object.fromEntries(preset.placeholders.map((p) => [p.name, p.defaultValue]))
      const config = restConnector.configSchema.safeParse({
        baseUrl: preset.baseUrl,
        allowedHosts: preset.allowedHosts,
        auth: {
          type: 'oauth2AuthorizationCode',
          provider: preset.id,
          authorizeUrl: fillPlaceholders(preset.authorizeUrl, values),
          tokenUrl: fillPlaceholders(preset.tokenUrl, values),
          revokeUrl: preset.revokeUrl,
          clientId: 'id',
          scope: preset.scope,
          authorizeParams: preset.authorizeParams,
          clientAuth: preset.clientAuth,
          pkce: preset.pkce,
        },
      })
      expect(config.success, preset.id).toBe(true)
      expect(config.data?.auth).toMatchObject({ tokens: 'shared' })
    }
  })

  it('refuses a URL whose placeholder was left in', () => {
    const preset = oauthPresets.microsoft
    expect(fillPlaceholders(preset.tokenUrl, { tenant: 'a b' })).toBe(
      'https://login.microsoftonline.com/a%20b/oauth2/v2.0/token',
    )
    const config = restConnector.configSchema.safeParse({
      baseUrl: preset.baseUrl,
      auth: {
        type: 'oauth2AuthorizationCode',
        authorizeUrl: preset.authorizeUrl,
        tokenUrl: fillPlaceholders(preset.tokenUrl, {}),
        clientId: 'id',
      },
    })
    expect(config.success).toBe(false)
    expect(config.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['auth.authorizeUrl', 'Fill in the {placeholders} in the URL'],
      ['auth.tokenUrl', 'Fill in the {placeholders} in the URL'],
    ])
  })
})
