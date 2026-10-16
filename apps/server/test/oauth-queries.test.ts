/**
 * Connected OAuth accounts in use: the playground, workflow runs (draft and live) and app queries send the right
 * account's token to the API, refresh it when it expires or the API refuses it, and ask for a connection when
 * there's none. Workflows can't go live on resources that use each person's own account.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDb, groups, permissions, resourceConfigs } from '@ow/db'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authFingerprint, saveTokens } from '../src/services/oauth-tokens'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

let env: TestEnv
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let adminCookie: string
let adminId: string
let memberId: string
let prodId: string
let allUsersId: string
let stopWorker: () => Promise<void>

// The API and its authorization server: access tokens it accepts, refresh tokens it would swap.
let api: Server
let origin: string
/** Access token → whose account it is (`<resource>:<admin|member|shared>`); the API answers with that, never the token. */
const validAccess = new Map<string, string>()
/** Refresh token → whose account it is. */
const validRefresh = new Map<string, string>()
let refreshes = 0
/** The Authorization header of every API call. */
const apiCalls: string[] = []

beforeAll(async () => {
  env = await startTestApp()
  adminId = (await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })).id
  memberId = (await createLocalUser(env.db, 'member@optiply.nl')).id
  adminCookie = await login(env.app, 'admin@optiply.nl')
  admin = trpc(env.app, adminCookie)
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'))
  const envs = (await admin.query('environments.list')).body.result!.data as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  allUsersId = (await env.db.select().from(groups).where(eq(groups.systemKind, 'all_users')))[0]!.id

  api = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url === '/token') {
      const form = new URLSearchParams(body)
      const owner = validRefresh.get(form.get('refresh_token') ?? '')
      if (!owner) return send(400, { error: 'invalid_grant' })
      validRefresh.delete(form.get('refresh_token')!)
      refreshes++
      const access = `refreshed-${refreshes}`
      validAccess.set(access, owner)
      validRefresh.set(`rt-${access}`, owner)
      return send(200, { access_token: access, refresh_token: `rt-${access}`, expires_in: 3600 })
    }
    apiCalls.push(String(req.headers.authorization ?? ''))
    const who = validAccess.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
    if (!who) return send(401, { error: 'invalid_token' })
    send(200, { who })
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`

  const workerDb = createDb(env.databaseUrl, { max: 5 })
  const worker = await startWorker({
    db: workerDb.db,
    sql: workerDb.sql,
    config: env.config,
    log: pino({ level: 'silent' }),
  })
  stopWorker = async () => {
    await worker.stop()
    await workerDb.close()
  }
}, 60_000)
afterAll(async () => {
  await stopWorker?.()
  await new Promise((r) => api?.close(r))
  await env?.stop()
})

// biome-ignore lint/suspicious/noExplicitAny: untyped test JSON
const data = (res: { body: { result?: { data: unknown } } }): any => {
  if (!res.body.result) throw new Error(`tRPC call failed: ${JSON.stringify(res.body)}`)
  return res.body.result.data
}

const oauth = (tokens: 'shared' | 'perUser') => ({
  type: 'oauth2AuthorizationCode',
  authorizeUrl: 'https://auth.example.com/authorize',
  tokenUrl: `${origin}/token`,
  clientId: 'cid',
  scope: 'me',
  tokens,
})

async function saveAuth(id: string, tokens: 'shared' | 'perUser') {
  data(
    await admin.mutate('resources.saveConfig', {
      resourceId: id,
      environmentId: prodId,
      config: { baseUrl: `${origin}/api`, auth: oauth(tokens), allowPrivateNetwork: true },
      secrets: { clientSecret: 'cs' },
    }),
  )
}

/** A REST resource on the fake API that everyone may use in production. */
async function oauthResource(slug: string, tokens: 'shared' | 'perUser') {
  const id = data(await admin.mutate('resources.create', { type: 'rest', name: slug, slug })).id as string
  await saveAuth(id, tokens)
  await env.db.insert(permissions).values({
    groupId: allUsersId,
    objectType: 'resource',
    objectId: id,
    environmentId: prodId,
    level: 'use',
  })
  return id
}

/**
 * Connects an account as the connect flow would (step 3 tests the flow itself). An access token
 * `<resource>-<owner>-<n>` is the account `<resource>:<owner>` at the API.
 */
async function connect(
  resourceId: string,
  userId: string | null,
  access: string,
  expiresAt: Date | null = null,
) {
  const [row] = await env.db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, resourceId))
  const [resource, owner] = access.split('-')
  validAccess.set(access, `${resource}:${owner}`)
  validRefresh.set(`rt-${access}`, `${resource}:${owner}`)
  await saveTokens(env.db, env.config.keyring, {
    resourceConfigId: row!.id,
    environmentId: prodId,
    userId,
    tokens: { accessToken: access, refreshToken: `rt-${access}`, expiresAt, scope: 'me', account: null },
    consentHash: authFingerprint(row!.config)!,
    connectedBy: userId ?? adminId,
  })
}

const playground = (client: ReturnType<typeof trpc>, resourceId: string) =>
  client
    .mutate('resources.run', { resourceId, environmentId: prodId, query: { path: 'me' } })
    .then((res) => data(res))

async function rest(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: adminCookie },
    ...(payload !== undefined && { payload: payload as object }),
  })
  return { status: res.statusCode, body: res.json() }
}

async function runWorkflow(slug: string, version: 'draft' | 'live') {
  const started = await rest('POST', `/workflows/${slug}/runs?environment=production`, { version })
  expect(started.status, JSON.stringify(started.body)).toBe(202)
  const deadline = Date.now() + 20_000
  for (;;) {
    const { body } = await rest('GET', `/runs/${started.body.run.id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(body.run.status)) return body.run
    if (Date.now() > deadline) throw new Error(`run still ${body.run.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** A draft workflow that calls the API through `resource` and replies with what it answered. */
async function meWorkflow(slug: string, resource: string) {
  const created = data(await admin.mutate('workflows.create', { slug, name: slug }))
  const saved = data(
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          { name: 'me', type: 'resourceQuery', config: { resource, query: { path: 'me' } } },
          { name: 'reply', type: 'response', config: { status: '200', body: '{{ me.data }}' } },
        ],
        edges: [
          { from: 'startTrigger', port: 'out', to: 'me' },
          { from: 'me', port: 'out', to: 'reply' },
        ],
      },
    }),
  )
  return { id: created.id as string, revision: saved.revision as number }
}

describe('the playground', () => {
  it('uses the shared account, refreshing it when it expires or the API refuses it', async () => {
    const crm = await oauthResource('crm', 'shared')
    expect(await playground(admin, crm)).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'not_connected', account: 'shared' } },
    })

    await connect(crm, null, 'crm-shared-1')
    expect(await playground(member, crm)).toMatchObject({ ok: true, data: { who: 'crm:shared' } })

    // Expired: refreshed before the request.
    const before = refreshes
    await connect(crm, null, 'crm-shared-2', new Date(Date.now() - 1000))
    const expired = await playground(admin, crm)
    expect(expired).toMatchObject({ ok: true, data: { who: 'crm:shared' } })
    expect(refreshes).toBe(before + 1)

    // The API stops accepting the current token: refreshed once, and the request retried.
    validAccess.clear()
    const refused = await playground(admin, crm)
    expect(refused).toMatchObject({ ok: true, data: { who: 'crm:shared' } })
    expect(refreshes).toBe(before + 2)
  })

  it("uses each person's own account on per-user resources", async () => {
    const mail = await oauthResource('mail', 'perUser')
    await connect(mail, memberId, 'mail-member-1')
    expect(await playground(member, mail)).toMatchObject({ ok: true, data: { who: 'mail:member' } })
    expect(await playground(admin, mail)).toMatchObject({
      ok: false,
      error: { code: 'auth_required', message: 'Connect your account to this resource to use it.' },
    })
  })

  it('tests the connection with the connected account', async () => {
    const id = await oauthResource('crm_test', 'shared')
    // The test GETs the base URL.
    const [row] = await env.db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, id))
    await env.db
      .update(resourceConfigs)
      .set({ config: { ...row!.config, baseUrl: `${origin}/api/me` } })
      .where(eq(resourceConfigs.id, row!.id))
    const test = (config?: unknown) =>
      admin
        .mutate('resources.test', { resourceId: id, environmentId: prodId, ...(config ? { config } : {}) })
        .then((res) => data(res))
    expect(await test()).toMatchObject({ ok: false, error: { code: 'auth_required' } })
    await connect(id, null, 'crmtest-shared-1')
    expect(await test()).toMatchObject({ ok: true, message: 'HTTP 200 OK' })
    // Unsaved settings asking for another consent need a reconnect first.
    const changed = {
      baseUrl: `${origin}/api/me`,
      auth: { ...oauth('shared'), scope: 'more' },
      allowPrivateNetwork: true,
    }
    expect(await test(changed)).toMatchObject({
      ok: false,
      error: { details: { reason: 'settings_changed' } },
    })
    // Settings sending requests to another host (here the same server under another name) don't get the token.
    const elsewhere = {
      baseUrl: `${origin.replace('127.0.0.1', 'localhost')}/api/me`,
      auth: oauth('shared'),
      allowPrivateNetwork: true,
    }
    const before = apiCalls.length
    expect(await test(elsewhere)).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'settings_changed' } },
    })
    expect(apiCalls.length).toBe(before)
  })
})

describe('workflows', () => {
  it('draft runs use the shared account, or the account of whoever ran them', async () => {
    await meWorkflow('crm-draft', 'crm')
    await meWorkflow('mail-draft', 'mail')
    const shared = await runWorkflow('crm-draft', 'draft')
    expect(shared).toMatchObject({ status: 'succeeded', response: { body: { who: 'crm:shared' } } })

    // The admin hasn't connected their own mail account yet.
    const notYet = await runWorkflow('mail-draft', 'draft')
    expect(notYet).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/Connect your account to this resource/) },
    })
    await connect((await resourceId('mail'))!, adminId, 'mail-admin-1')
    expect(await runWorkflow('mail-draft', 'draft')).toMatchObject({
      status: 'succeeded',
      response: { body: { who: 'mail:admin' } },
    })
  })

  it('live runs use the shared account; per-user resources are refused at publishing', async () => {
    const wf = await meWorkflow('crm-live', 'crm')
    data(await admin.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision }))
    expect(await runWorkflow('crm-live', 'live')).toMatchObject({
      status: 'succeeded',
      response: { body: { who: 'crm:shared' } },
    })

    const mailWf = await meWorkflow('mail-live', 'mail')
    const refused = await admin.mutate('releases.publish', {
      workflowId: mailWf.id,
      draftRevision: mailWf.revision,
    })
    expect(refused.status).toBe(400)
    expect(refused.body.error?.message).toBe(
      `Resource "mail" uses each person's own account in production, which a live run (webhook, schedule) has no one to use. Give it a shared account to release this workflow.`,
    )
  })

  it('a live run on a resource switched to per-user accounts fails asking for a shared one', async () => {
    const id = await oauthResource('crm_switch', 'shared')
    await connect(id, null, 'crmswitch-shared-1')
    const wf = await meWorkflow('switch-live', 'crm_switch')
    data(await admin.mutate('releases.publish', { workflowId: wf.id, draftRevision: wf.revision }))
    await saveAuth(id, 'perUser')
    await connect(id, adminId, 'crmswitch-admin-1')
    // Even started by someone with an account: a release has no person behind it.
    const run = await runWorkflow('switch-live', 'live')
    expect(run).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/each person's own account, and nobody is behind this run/) },
    })
  })
})

describe('apps', () => {
  it("query with the viewer's own account, in the editor and the published app", async () => {
    const app = data(await admin.mutate('apps.create', { slug: 'inbox', name: 'Inbox' }))
    const saved = data(
      await admin.mutate('apps.saveDraft', {
        id: app.id,
        revision: 1,
        definition: {
          schemaVersion: 1,
          components: [],
          queries: [{ name: 'me', kind: 'resource', resource: 'mail', query: { path: 'me' }, run: 'auto' }],
          layout: {},
        },
      }),
    )
    const query = (client: ReturnType<typeof trpc>, releaseId: string | null) =>
      client
        .mutate('apps.runQuery', { appId: app.id, releaseId, query: 'me', environmentId: prodId, values: {} })
        .then((res) => data(res))

    // The admin connected their own mail account in the workflow tests.
    expect(await query(admin, null)).toMatchObject({ ok: true, data: { who: 'mail:admin' } })

    const release = data(await admin.mutate('apps.publish', { appId: app.id, draftRevision: saved.revision }))
    data(
      await admin.mutate('permissions.set', {
        objectType: 'app',
        objectId: app.id,
        groupId: allUsersId,
        environmentId: null,
        level: 'use',
      }),
    )
    const before = refreshes
    expect(await query(member, release.id)).toMatchObject({ ok: true, data: { who: 'mail:member' } })
    expect(refreshes).toBe(before)

    // The member disconnects: their queries ask them to connect; the admin's still work.
    data(
      await member.mutate('resources.oauthDisconnect', {
        resourceId: await resourceId('mail'),
        environmentId: prodId,
        account: 'mine',
      }),
    )
    expect(await query(member, release.id)).toMatchObject({
      ok: false,
      error: { code: 'auth_required', details: { reason: 'not_connected', account: 'user' } },
    })
    expect(await query(admin, release.id)).toMatchObject({ ok: true, data: { who: 'mail:admin' } })
  })
})

async function resourceId(slug: string): Promise<string> {
  const list = data(await admin.query('resources.list'))
  return list.resources.find((r: { slug: string }) => r.slug === slug).id
}
