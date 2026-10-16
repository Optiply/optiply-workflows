import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type AuthorizationCodeSettings, ConnectorError, type TokenSet } from '@ow/connectors'
import { generateKey, parseKeyring } from '@ow/crypto'
import {
  auditEvents,
  createDb,
  type Db,
  environments,
  oauthTokens,
  resourceConfigs,
  resources,
  users,
} from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type CredentialTarget,
  connectionStatus,
  consentHash,
  deleteTokens,
  oauthCredentials,
  saveTokens,
} from '../src/services/oauth-tokens'
import { rekeyAll, verifySecrets } from '../src/services/secrets'

const k1 = generateKey()
const keyring = parseKeyring(`v1:${k1}`)
const rotated = parseKeyring(`v1:${k1},v9:${generateKey()}`)

let db: Db
let stop: () => Promise<void>
let prodId: string
let alice: string
let bob: string

// A provider that rotates refresh tokens and refuses a used one, like Entra ID and HubSpot.
let server: Server
let tokenUrl: string
let issued = 0
let refreshRequests = 0
let validRefresh = new Set<string>()
let refreshDelayMs = 0
let refreshStatus = 200

beforeAll(async () => {
  const pg = await startTestDatabase()
  const conn = createDb(pg.url, { max: 10 })
  db = conn.db
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const form = new URLSearchParams(body)
    refreshRequests++
    await new Promise((r) => setTimeout(r, refreshDelayMs))
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (refreshStatus !== 200) return send(refreshStatus, { error: 'server_error' })
    const used = form.get('refresh_token') ?? ''
    if (form.get('grant_type') !== 'refresh_token' || !validRefresh.delete(used)) {
      return send(400, { error: 'invalid_grant', error_description: 'refresh token reused or revoked' })
    }
    issued++
    validRefresh.add(`rt-${issued}`)
    send(200, { access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600 })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`
  stop = async () => {
    await new Promise((r) => server.close(r))
    await conn.close()
    await pg.stop()
  }
  prodId = (await db.select().from(environments).where(eq(environments.slug, 'production')))[0]!.id
  const made = await db
    .insert(users)
    .values([
      { email: 'alice@optiply.nl', name: 'Alice' },
      { email: 'bob@optiply.nl', name: 'Bob' },
    ])
    .returning()
  alice = made[0]!.id
  bob = made[1]!.id
})
afterAll(() => stop?.())
beforeEach(() => {
  refreshRequests = 0
  refreshDelayMs = 0
  refreshStatus = 200
  validRefresh = new Set()
})

const auth = (overrides: Partial<AuthorizationCodeSettings> = {}): AuthorizationCodeSettings => ({
  provider: 'custom',
  authorizeUrl: 'https://auth.example.com/authorize',
  tokenUrl,
  clientId: 'cid',
  scope: 'read',
  authorizeParams: [],
  clientAuth: 'body',
  pkce: true,
  ...overrides,
})

/** A REST resource configured in production, and a target for its shared account. */
async function setup(): Promise<CredentialTarget> {
  const [resource] = await db
    .insert(resources)
    .values({ slug: `r_${uuidv7().slice(-12)}`, name: 'R', type: 'rest' })
    .returning()
  const [config] = await db
    .insert(resourceConfigs)
    .values({ resourceId: resource!.id, environmentId: prodId, config: {} })
    .returning()
  return {
    resourceId: resource!.id,
    resourceConfigId: config!.id,
    environmentId: prodId,
    userId: null,
    auth: auth(),
    consent: consentOf(auth()),
    clientSecret: 'cs',
    allowPrivateNetwork: true,
  }
}

/** The consent fingerprint of `a` on the resource the tests use (its base URL and allowed hosts). */
const consentOf = (a: AuthorizationCodeSettings, where: { baseUrl?: string; allowedHosts?: string[] } = {}) =>
  consentHash({
    baseUrl: where.baseUrl ?? 'https://api.example.com',
    allowedHosts: where.allowedHosts ?? [],
    auth: a,
  })

const tokenSet = (overrides: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'at-0',
  refreshToken: 'rt-0',
  expiresAt: new Date(Date.now() + 3600_000),
  scope: 'read',
  account: 'ada@optiply.nl',
  ...overrides,
})

async function connect(target: CredentialTarget, tokens: TokenSet = tokenSet()) {
  if (tokens.refreshToken) validRefresh.add(tokens.refreshToken)
  await saveTokens(db, keyring, {
    resourceConfigId: target.resourceConfigId,
    environmentId: target.environmentId,
    userId: target.userId,
    tokens,
    consentHash: target.consent,
    connectedBy: alice,
  })
}

async function expire(target: CredentialTarget) {
  await db
    .update(oauthTokens)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(oauthTokens.resourceConfigId, target.resourceConfigId))
}

const signal = () => AbortSignal.timeout(10_000)
const token = (target: CredentialTarget, force = false) =>
  oauthCredentials({ db, keyring }, target).accessToken({ signal: signal(), force })

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError)
    return err as ConnectorError
  }
  throw new Error('expected it to fail')
}

describe('storing a connection', () => {
  it('encrypts the tokens and reports the connection without them', async () => {
    const target = await setup()
    expect(await connectionStatus(db, target.resourceConfigId, null, target.consent)).toEqual({
      connected: false,
    })
    await connect(target, tokenSet({ accessToken: 'at-plain-text-123', refreshToken: 'rt-plain-text-456' }))

    const [row] = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.resourceConfigId, target.resourceConfigId))
    expect(row!.tokens).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toMatch(/plain-text/)

    const status = await connectionStatus(db, target.resourceConfigId, null, target.consent)
    expect(status).toMatchObject({
      connected: true,
      status: 'active',
      reason: null,
      account: 'ada@optiply.nl',
    })
    expect(JSON.stringify(status)).not.toMatch(/plain-text/)
    expect(await token(target)).toBe('at-plain-text-123')
  })

  it('keeps the shared account and each person’s apart, and replaces one owner’s on reconnect', async () => {
    const shared = await setup()
    const mine = { ...shared, userId: alice }
    const theirs = { ...shared, userId: bob }
    await connect(shared, tokenSet({ accessToken: 'at-shared' }))
    await connect(mine, tokenSet({ accessToken: 'at-alice' }))
    expect(await token(shared)).toBe('at-shared')
    expect(await token(mine)).toBe('at-alice')
    const err = await failure(token(theirs))
    expect(err).toMatchObject({
      code: 'auth_required',
      message: 'Connect your account to this resource to use it.',
      details: { reason: 'not_connected', account: 'user' },
    })

    await connect(mine, tokenSet({ accessToken: 'at-alice-2', account: 'alice@other' }))
    expect(await token(mine)).toBe('at-alice-2')
    const rows = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.resourceConfigId, shared.resourceConfigId))
    expect(rows).toHaveLength(2)

    expect(await deleteTokens(db, shared.resourceConfigId, alice)).toBe(1)
    expect(await token(shared)).toBe('at-shared')
    expect(await deleteTokens(db, shared.resourceConfigId)).toBe(1)
    expect(await failure(token(shared))).toMatchObject({
      code: 'auth_required',
      message: expect.stringMatching(/^No account is connected/),
      details: { reason: 'not_connected', account: 'shared' },
    })
  })

  it("replaces one owner's connection in turn when two connects finish at once", async () => {
    const target = await setup()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => connect(target, tokenSet({ accessToken: `at-${i}` }))),
    )
    expect(
      await db.select().from(oauthTokens).where(eq(oauthTokens.resourceConfigId, target.resourceConfigId)),
    ).toHaveLength(1)

    // A connect waits for the owner's lock (the one refreshes take: `ow_oauth:<config>:<owner>`).
    let release!: () => void
    let locked!: () => void
    const isLocked = new Promise<void>((r) => {
      locked = r
    })
    const held = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ow_oauth:${target.resourceConfigId}:shared`}, 0))`,
      )
      locked()
      await new Promise<void>((r) => {
        release = r
      })
    })
    await isLocked
    let saved = false
    const saving = connect(target, tokenSet({ accessToken: 'at-late' })).then(() => {
      saved = true
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(saved).toBe(false)
    release()
    await held
    await saving
    expect(await token(target)).toBe('at-late')
  })

  it('goes when the resource config goes', async () => {
    const target = await setup()
    await connect(target)
    await db.delete(resourceConfigs).where(eq(resourceConfigs.id, target.resourceConfigId))
    expect(
      await db.select().from(oauthTokens).where(eq(oauthTokens.resourceConfigId, target.resourceConfigId)),
    ).toEqual([])
  })
})

describe('refreshing', () => {
  it('refreshes an expiring token and stores the rotated refresh token, keeping the account', async () => {
    const target = await setup()
    await connect(target, tokenSet({ expiresAt: new Date(Date.now() + 30_000) }))
    const fresh = await token(target)
    expect(fresh).toMatch(/^at-\d+$/)
    expect(fresh).not.toBe('at-0')
    expect(refreshRequests).toBe(1)

    // The new token is stored: the next query uses it without calling the provider.
    expect(await token(target)).toBe(fresh)
    expect(refreshRequests).toBe(1)
    const status = await connectionStatus(db, target.resourceConfigId, null, target.consent)
    expect(status).toMatchObject({ status: 'active', account: 'ada@optiply.nl', scope: 'read' })
    expect(status.connected && status.refreshedAt).toBeInstanceOf(Date)

    // The rotated refresh token was stored too: a second refresh works.
    await expire(target)
    const third = await token(target)
    expect(third).not.toBe(fresh)
    expect(refreshRequests).toBe(2)
  })

  it('refreshes once when several workers find the token expired at the same time', async () => {
    const target = await setup()
    await connect(target)
    await expire(target)
    refreshDelayMs = 400
    // Separate sources, as on separate workers; each would spend the same refresh token.
    const pending = Promise.all(Array.from({ length: 5 }, () => token(target)))
    // While one refreshes, the others wait without holding a connection (or a lock request) in the database.
    await new Promise((r) => setTimeout(r, 200))
    const [locks] = await db.execute<{ waiting: number; held: number }>(
      sql`select count(*) filter (where not granted)::int as waiting, count(*) filter (where granted)::int as held
          from pg_locks where locktype = 'advisory'`,
    )
    expect(locks).toEqual({ waiting: 0, held: 1 })
    const tokens = await pending
    expect(new Set(tokens).size).toBe(1)
    expect(refreshRequests).toBe(1)
    const [row] = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.resourceConfigId, target.resourceConfigId))
    expect(row!.status).toBe('active')
  })

  it('refreshes a token an API refused, once, even if several queries saw it refused', async () => {
    const target = await setup()
    await connect(target)
    const sources = Array.from({ length: 3 }, () => oauthCredentials({ db, keyring }, target))
    const first = await Promise.all(sources.map((s) => s.accessToken({ signal: signal() })))
    expect(first).toEqual(['at-0', 'at-0', 'at-0'])

    refreshDelayMs = 100
    const forced = await Promise.all(sources.map((s) => s.accessToken({ signal: signal(), force: true })))
    expect(new Set(forced).size).toBe(1)
    expect(forced[0]).not.toBe('at-0')
    expect(refreshRequests).toBe(1)

    // A source refused again with the new token does refresh.
    const again = await sources[0]!.accessToken({ signal: signal(), force: true })
    expect(again).not.toBe(forced[0])
    expect(refreshRequests).toBe(2)
  })

  it('asks for a reconnect when the provider refuses the refresh, without calling it again', async () => {
    const target = await setup()
    await connect(target, tokenSet({ refreshToken: 'rt-revoked' }))
    validRefresh.delete('rt-revoked')
    await expire(target)

    const err = await failure(token(target))
    expect(err).toMatchObject({
      code: 'auth_required',
      message:
        'The account connected to this resource must be connected again: the provider no longer accepts it (invalid_grant).',
      details: { reason: 'invalid_grant', account: 'shared' },
    })
    expect(refreshRequests).toBe(1)
    expect(await connectionStatus(db, target.resourceConfigId, null, target.consent)).toMatchObject({
      status: 'reconnect',
      reason: 'invalid_grant',
    })
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.objectId, target.resourceId))
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'resource.oauth_refresh_failed',
        actorUserId: null,
        environmentId: prodId,
        metadata: { reason: 'invalid_grant', account: 'shared', userId: null },
      }),
    ])

    expect((await failure(token(target))).details).toMatchObject({ reason: 'invalid_grant' })
    expect(refreshRequests).toBe(1)

    // Connecting again clears it.
    await connect(target)
    expect(await token(target)).toBe('at-0')
  })

  it('keeps the connection when the provider fails for another reason', async () => {
    const target = await setup()
    await connect(target)
    await expire(target)
    refreshStatus = 503
    expect(await failure(token(target))).toMatchObject({ code: 'http', details: { status: 503 } })
    refreshStatus = 200
    expect(await token(target)).not.toBe('at-0')
  })

  it('without a refresh token: an expired token needs a reconnect, a refused one is sent back as is', async () => {
    const target = await setup()
    await connect(target, tokenSet({ refreshToken: null }))
    const source = oauthCredentials({ db, keyring }, target)
    expect(await source.accessToken({ signal: signal() })).toBe('at-0')
    // Nothing to refresh with: the request is retried with the same token and fails with the API's answer.
    expect(await source.accessToken({ signal: signal(), force: true })).toBe('at-0')

    await expire(target)
    expect(await failure(token(target))).toMatchObject({ details: { reason: 'expired' } })
    expect(refreshRequests).toBe(0)
  })

  it('never expires a token whose expiry the provider didn’t give', async () => {
    const target = await setup()
    await connect(target, tokenSet({ expiresAt: null }))
    expect(await token(target)).toBe('at-0')
    expect(refreshRequests).toBe(0)
  })
})

describe('consent', () => {
  it('needs a reconnect once the client, URLs, scopes or consent parameters change', async () => {
    const target = await setup()
    await connect(target)
    const changes: Partial<AuthorizationCodeSettings>[] = [
      { clientId: 'other' },
      { scope: 'read write' },
      { authorizeUrl: 'https://auth.example.com/v2/authorize' },
      { tokenUrl: `${tokenUrl}?v=2` },
      { authorizeParams: [{ key: 'prompt', value: 'consent' }] },
    ]
    for (const change of changes) {
      const changed = { ...target, auth: auth(change), consent: consentOf(auth(change)) }
      expect(changed.consent).not.toBe(target.consent)
      expect(await failure(token(changed))).toMatchObject({
        code: 'auth_required',
        details: { reason: 'settings_changed' },
      })
    }
    // Same consent: whitespace around scopes, the order of parameters, PKCE, the client secret.
    const same = auth({ scope: ' read ', pkce: false, clientAuth: 'basic' })
    expect(consentOf(same)).toBe(target.consent)
    expect(
      consentOf(
        auth({
          authorizeParams: [
            { key: 'b', value: '2' },
            { key: 'a', value: '1' },
            { key: '', value: 'x' },
          ],
        }),
      ),
    ).toBe(
      consentOf(
        auth({
          authorizeParams: [
            { key: 'a', value: '1' },
            { key: 'b', value: '2' },
          ],
        }),
      ),
    )
    expect(await token({ ...target, auth: same, consent: consentOf(same), clientSecret: 'rotated' })).toBe(
      'at-0',
    )
  })
})

describe('key rotation', () => {
  it('rekey and verify-secrets cover the tokens', async () => {
    const target = await setup()
    await connect(target, tokenSet({ accessToken: 'at-rekeyed' }))
    const report = await rekeyAll(db, rotated)
    expect(report.find((r) => r.table === 'oauth_tokens')).toMatchObject({ failed: [] })
    expect(report.find((r) => r.table === 'oauth_tokens')!.rekeyed).toBeGreaterThan(0)

    const verified = await verifySecrets(db, rotated)
    expect(verified.find((r) => r.table === 'oauth_tokens')).toMatchObject({
      failed: [],
      keys: { v9: expect.any(Number) },
    })
    expect(await oauthCredentials({ db, keyring: rotated }, target).accessToken({ signal: signal() })).toBe(
      'at-rekeyed',
    )
  })
})
