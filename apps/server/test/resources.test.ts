import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startTestSshServer } from '@ow/connectors/testing'
import { auditEvents, configVarValues, oauthTokens, permissions, resourceConfigs } from '@ow/db'
import { desc, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { saveTokens } from '../src/services/oauth-tokens'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

// Distinctive values, so finding one anywhere in a response is unambiguous.
const PG_SECRET = 'Pg-R3ader-Secret-7731'
const REST_SECRET = 'Rest-B3arer-Secret-9152'
const HEADER_SECRET = 'Hdr-T0ken-Secret-4410'
const TOKEN_SECRET = 'Cfg-Var-Secret-6628'
// M17: an SSH key (an encrypted test key from the connectors' fixtures), its passphrase and an SSH password.
const SSH_KEY = readFileSync(
  new URL('../../../packages/connectors/test/fixtures/ssh/openssh-rsa-encrypted', import.meta.url),
  'utf8',
)
const SSH_PASSPHRASE = 'fixture pass'
const SSH_PASSWORD = 'Ssh-Passw0rd-Secret-3307'
/**
 * A line from the end of the key (the encrypted private part; the file's first lines hold the public key, which the
 * settings do show): any of the private key in a response would show up as this.
 */
const SSH_KEY_LINE = SSH_KEY.trim().split('\n').at(-2)!
const SECRETS = [
  PG_SECRET,
  REST_SECRET,
  HEADER_SECRET,
  TOKEN_SECRET,
  SSH_PASSPHRASE,
  SSH_PASSWORD,
  SSH_KEY_LINE,
]

let env: TestEnv
let echo: Server
let echoUrl: string
let admin: ReturnType<typeof trpc>
let member: ReturnType<typeof trpc>
let memberId: string
let prodId: string
let stagingId: string
let pgConfig: Record<string, unknown>
/** Every raw response body any client received in this file. */
const responses: string[] = []

beforeAll(async () => {
  env = await startTestApp()
  await createLocalUser(env.db, 'admin@optiply.nl')
  memberId = (await createLocalUser(env.db, 'member@optiply.nl')).id
  admin = trpc(env.app, await login(env.app, 'admin@optiply.nl'), { record: responses })
  member = trpc(env.app, await login(env.app, 'member@optiply.nl'), { record: responses })

  // A read-only role with a known password, so a Postgres resource can point at the test database.
  const sql = postgres(env.databaseUrl, { onnotice: () => {} })
  await sql.unsafe(`
    create table customers (id int primary key, email text);
    insert into customers values (1, 'a@x.nl'), (2, 'b@x.nl'), (3, 'c@x.nl');
    create role ow_reader login password '${PG_SECRET}';
    grant select on customers to ow_reader;
  `)
  await sql.end()
  const url = new URL(env.databaseUrl)
  pgConfig = {
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    user: 'ow_reader',
    ssl: 'disable',
  }

  echo = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, headers: req.headers }))
  })
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`

  const envs = (await admin.query('environments.list')).body.result!.data as { id: string; slug: string }[]
  prodId = envs.find((e) => e.slug === 'production')!.id
  stagingId = envs.find((e) => e.slug === 'staging')!.id
})
afterAll(async () => {
  await new Promise((r) => echo?.close(r))
  await env?.stop()
})

/** The procedure's output; untyped JSON is fine in assertions. */
// biome-ignore lint/suspicious/noExplicitAny: test JSON
const data = (res: { body: { result?: { data: unknown } } }) => res.body.result?.data as any

let pgId: string
let restId: string

describe('resources (admin)', () => {
  it('creates a Postgres resource and saves settings per environment', async () => {
    const created = await admin.mutate('resources.create', {
      type: 'postgres',
      name: 'Warehouse',
      slug: 'warehouse',
    })
    expect(created.status).toBe(200)
    pgId = data(created).id

    const saved = await admin.mutate('resources.saveConfig', {
      resourceId: pgId,
      environmentId: prodId,
      config: pgConfig,
      secrets: { password: PG_SECRET },
    })
    expect(saved.status).toBe(200)
    expect(data(saved).secrets).toEqual({ password: { set: true } })
    expect(data(saved).config).toMatchObject({
      ...pgConfig,
      port: pgConfig.port,
      maxRows: 10_000,
      readOnly: false,
    })

    const got = data(await admin.query('resources.get', { id: pgId }))
    const prod = got.environments.find((e: { environmentId: string }) => e.environmentId === prodId)
    const staging = got.environments.find((e: { environmentId: string }) => e.environmentId === stagingId)
    expect(prod.secrets).toMatchInlineSnapshot(`
      {
        "password": {
          "set": true,
        },
      }
    `)
    expect(staging).toMatchObject({ config: null, secrets: null, level: 'own' })

    // Stored encrypted, bound to its row.
    const [row] = await env.db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, pgId))
    expect(row!.secrets).toMatch(/^v1\./)
    expect(row!.secrets).not.toContain(PG_SECRET)
  })

  it('rejects duplicate slugs and unknown types', async () => {
    expect(
      (await admin.mutate('resources.create', { type: 'postgres', name: 'X', slug: 'warehouse' })).status,
    ).toBe(409)
    expect(
      (await admin.mutate('resources.create', { type: 'mongo', name: 'X', slug: 'mongo_db' })).status,
    ).toBe(400)
    expect(
      (await admin.mutate('resources.create', { type: 'postgres', name: 'X', slug: 'Bad Slug' })).status,
    ).toBe(400)
  })

  it('tests the connection and runs queries with {{ }} from test values and config vars', async () => {
    const test = data(await admin.mutate('resources.test', { resourceId: pgId, environmentId: prodId }))
    expect(test).toMatchObject({ ok: true, message: expect.stringMatching(/^PostgreSQL 18/) })

    const run = data(
      await admin.mutate('resources.run', {
        resourceId: pgId,
        environmentId: prodId,
        query: { sql: 'select id, email from customers where id = any({{ ids }}) order by id' },
        scope: { ids: [1, 3] },
      }),
    )
    expect(run).toMatchObject({
      ok: true,
      data: [
        { id: 1, email: 'a@x.nl' },
        { id: 3, email: 'c@x.nl' },
      ],
    })
    expect(run.metadata.rowCount).toBe(2)

    const region = data(await admin.mutate('configVars.create', { name: 'REGION' }))
    await admin.mutate('configVars.setValue', {
      configVarId: region.id,
      environmentId: prodId,
      value: 'eu-west',
    })
    const token = data(await admin.mutate('configVars.create', { name: 'TOKEN', isSecret: true }))
    await admin.mutate('configVars.setValue', {
      configVarId: token.id,
      environmentId: prodId,
      value: TOKEN_SECRET,
    })

    const vars = data(
      await admin.mutate('resources.run', {
        resourceId: pgId,
        environmentId: prodId,
        query: {
          sql: 'select {{ configVars.REGION }}::text as region, {{ typeof configVars.TOKEN }}::text as token, {{ current_user.email }}::text as me',
        },
      }),
    )
    // Secret config vars are never in the playground scope: anyone who can run a query could select them.
    expect(vars.data).toEqual([{ region: 'eu-west', token: 'undefined', me: 'admin@optiply.nl' }])
  })

  it('returns query failures as data, with codes and hints', async () => {
    const run = (sql: string, scope = {}) =>
      admin
        .mutate('resources.run', { resourceId: pgId, environmentId: prodId, query: { sql }, scope })
        .then(data)
    expect(await run('selec 1')).toMatchObject({
      ok: false,
      error: { code: 'query', details: { sqlState: '42601' } },
    })
    expect(await run("select * from customers where email = '{{ e }}'", { e: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_query', details: { hint: expect.stringMatching(/Remove the quotes/) } },
    })
    expect(await run('select {{ nope.x }}')).toMatchObject({ ok: false, error: { code: 'expression' } })
    expect(await run('select {{ (() => { while (true) {} })() }}')).toMatchObject({
      ok: false,
      error: { code: 'expression', message: expect.stringMatching(/exceeded its time limit/) },
    })
    expect(
      (
        await admin.mutate('resources.run', {
          resourceId: pgId,
          environmentId: stagingId,
          query: { sql: 'select 1' },
        })
      ).status,
    ).toBe(400)
  })

  it('treats secrets as a write-only patch: keep, replace, clear', async () => {
    const save = (secrets?: Record<string, unknown>) =>
      admin.mutate('resources.saveConfig', {
        resourceId: pgId,
        environmentId: prodId,
        config: pgConfig,
        secrets,
      })
    // Omitted: the stored password stays and queries keep working.
    expect(data(await save()).secrets).toEqual({ password: { set: true } })
    const ok = await admin.mutate('resources.test', { resourceId: pgId, environmentId: prodId })
    expect(data(ok).ok).toBe(true)

    // A patch can be tested before it's saved.
    const wrong = data(
      await admin.mutate('resources.test', {
        resourceId: pgId,
        environmentId: prodId,
        secrets: { password: 'nope-nope' },
      }),
    )
    expect(wrong.ok).toBe(false)

    expect(data(await save({ password: null })).secrets).toEqual({})
    expect(data(await admin.mutate('resources.test', { resourceId: pgId, environmentId: prodId })).ok).toBe(
      false,
    )
    expect(data(await save({ password: PG_SECRET })).secrets).toEqual({ password: { set: true } })
  })

  it('validates settings without echoing secret values', async () => {
    const badConfig = await admin.mutate('resources.saveConfig', {
      resourceId: pgId,
      environmentId: prodId,
      config: { ...pgConfig, host: '' },
    })
    expect(badConfig.status).toBe(400)
    expect(badConfig.body.error?.message).toMatch(/host/)

    const badSecret = await admin.mutate('resources.saveConfig', {
      resourceId: pgId,
      environmentId: prodId,
      config: pgConfig,
      secrets: { password: 424242 },
    })
    expect(badSecret.status).toBe(400)
    expect(badSecret.body.error?.message).toBe('Invalid credentials: password')
  })

  it('runs REST queries and scrubs secrets that the API echoes back', async () => {
    restId = data(
      await admin.mutate('resources.create', { type: 'rest', name: 'Echo API', slug: 'echo_api' }),
    ).id
    const saved = await admin.mutate('resources.saveConfig', {
      resourceId: restId,
      environmentId: prodId,
      config: { baseUrl: echoUrl, auth: { type: 'bearer' }, allowPrivateNetwork: true },
      secrets: { bearerToken: REST_SECRET, headers: { 'x-api-token': HEADER_SECRET } },
    })
    expect(data(saved).secrets).toEqual({
      bearerToken: { set: true },
      headers: { 'x-api-token': { set: true } },
    })

    const run = data(
      await admin.mutate('resources.run', {
        resourceId: restId,
        environmentId: prodId,
        query: { path: '/orders/{{ id }}' },
        scope: { id: 42 },
      }),
    )
    expect(run.ok).toBe(true)
    expect(run.data.path).toBe('/orders/42')
    expect(run.data.headers.authorization).toBe('Bearer [REDACTED]')
    expect(run.data.headers['x-api-token']).toBe('[REDACTED]')
  })

  it('disconnects OAuth accounts when the consent settings change, and only then', async () => {
    const id = data(
      await admin.mutate('resources.create', { type: 'rest', name: 'CRM', slug: 'crm_oauth' }),
    ).id
    const oauth = {
      type: 'oauth2AuthorizationCode',
      authorizeUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      scope: 'contacts',
    }
    const save = (config: Record<string, unknown>, secrets?: Record<string, unknown>) =>
      admin.mutate('resources.saveConfig', { resourceId: id, environmentId: prodId, config, secrets })
    expect((await save({ baseUrl: 'https://api.example.com', auth: oauth })).status).toBe(200)
    const [config] = await env.db.select().from(resourceConfigs).where(eq(resourceConfigs.resourceId, id))
    const connectAccounts = async () => {
      await env.db.delete(oauthTokens).where(eq(oauthTokens.resourceConfigId, config!.id))
      for (const userId of [null, memberId]) {
        await saveTokens(env.db, env.config.keyring, {
          resourceConfigId: config!.id,
          environmentId: prodId,
          userId,
          tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: null, scope: null, account: null },
          consentHash: 'any',
          connectedBy: memberId,
        })
      }
    }
    const accounts = async () =>
      (await env.db.select().from(oauthTokens).where(eq(oauthTokens.resourceConfigId, config!.id))).length

    await connectAccounts()
    // Other settings and the client secret: the accounts stay.
    await save(
      { baseUrl: 'https://api.example.com/v2', auth: { ...oauth, pkce: false } },
      { clientSecret: 'new' },
    )
    expect(await accounts()).toBe(2)

    await save({ baseUrl: 'https://api.example.com/v2', auth: { ...oauth, scope: 'contacts deals' } })
    expect(await accounts()).toBe(0)
    const [audit] = await env.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.objectId, id))
      .orderBy(desc(auditEvents.id))
      .limit(1)
    expect(audit!.metadata).toMatchObject({ disconnectedAccounts: 2 })

    // Tokens go only where they were connected for: another host, more allowed hosts, the other token mode, or
    // another auth type disconnects them.
    for (const elsewhere of [
      { baseUrl: 'https://attacker.example.com', auth: oauth },
      { baseUrl: 'https://api.example.com/v2', auth: oauth, allowedHosts: ['*.example.org'] },
      { baseUrl: 'https://api.example.com/v2', auth: { ...oauth, tokens: 'perUser' } },
      { baseUrl: 'https://api.example.com/v2', auth: { type: 'bearer' } },
    ]) {
      await save({ baseUrl: 'https://api.example.com/v2', auth: oauth })
      await connectAccounts()
      await save(elsewhere)
      expect(await accounts(), JSON.stringify(elsewhere)).toBe(0)
    }
  })
})

describe('permissions', () => {
  let groupId: string

  it('hides resources from users without a grant', async () => {
    expect(data(await member.query('resources.list'))).toEqual({ resources: [], canCreate: false })
    expect((await member.query('resources.get', { id: pgId })).status).toBe(404)
    expect(
      (
        await member.mutate('resources.run', {
          resourceId: pgId,
          environmentId: prodId,
          query: { sql: 'select 1' },
        })
      ).status,
    ).toBe(404)
    expect((await member.mutate('resources.create', { type: 'rest', name: 'X', slug: 'nope' })).status).toBe(
      403,
    )
  })

  it('a Use grant on one environment allows running queries there and nothing more', async () => {
    groupId = data(await admin.mutate('groups.create', { name: 'Analysts' })).id
    await admin.mutate('groups.addMember', { groupId, userId: memberId })
    const grant = await admin.mutate('permissions.set', {
      objectType: 'resource',
      objectId: pgId,
      groupId,
      environmentId: prodId,
      level: 'use',
    })
    expect(grant.status).toBe(200)

    const list = data(await member.query('resources.list'))
    expect(list.resources).toHaveLength(1)
    expect(list.resources[0].environments).toEqual(
      expect.arrayContaining([
        { environmentId: prodId, level: 'use', configured: true },
        { environmentId: stagingId, level: null, configured: false },
      ]),
    )
    const got = data(await member.query('resources.get', { id: pgId }))
    expect(got.environments.map((e: { environmentId: string }) => e.environmentId)).toEqual([prodId])
    expect(got.environments[0].secrets).toEqual({ password: { set: true } })

    const run = data(
      await member.mutate('resources.run', {
        resourceId: pgId,
        environmentId: prodId,
        query: { sql: 'select 1 as one' },
      }),
    )
    expect(run).toMatchObject({ ok: true, data: [{ one: 1 }] })
    expect(
      (
        await member.mutate('resources.run', {
          resourceId: pgId,
          environmentId: stagingId,
          query: { sql: 'select 1' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await member.mutate('resources.saveConfig', {
          resourceId: pgId,
          environmentId: prodId,
          config: pgConfig,
        })
      ).status,
    ).toBe(403)
    expect((await member.mutate('resources.test', { resourceId: pgId, environmentId: prodId })).status).toBe(
      403,
    )
    expect((await member.query('permissions.list', { objectType: 'resource', objectId: pgId })).status).toBe(
      403,
    )
  })

  it('folder grants apply to the resources inside, in every environment when unscoped', async () => {
    const folder = data(await admin.mutate('folders.create', { name: 'Finance' }))
    await admin.mutate('resources.update', { id: pgId, name: 'Warehouse', folderId: folder.id })
    await admin.mutate('permissions.set', {
      objectType: 'folder',
      objectId: folder.id,
      groupId,
      environmentId: null,
      level: 'edit',
    })
    const saved = await member.mutate('resources.saveConfig', {
      resourceId: pgId,
      environmentId: stagingId,
      config: pgConfig,
      secrets: { password: PG_SECRET },
    })
    expect(saved.status).toBe(200)
    // Edit isn't Own: still no deleting or managing access.
    expect((await member.mutate('resources.delete', { id: pgId })).status).toBe(403)
    // Folder-wide grants are admin-only.
    expect(
      (
        await member.mutate('permissions.set', {
          objectType: 'folder',
          objectId: folder.id,
          groupId,
          environmentId: null,
          level: 'own',
        })
      ).status,
    ).toBe(403)
  })

  it('a type-wide Edit grant lets a group create resources', async () => {
    await admin.mutate('permissions.set', {
      objectType: 'resource',
      objectId: null,
      groupId,
      environmentId: null,
      level: 'edit',
    })
    expect(data(await member.query('resources.list')).canCreate).toBe(true)
    const created = await member.mutate('resources.create', {
      type: 'rest',
      name: 'Member API',
      slug: 'member_api',
    })
    expect(created.status).toBe(200)
    await admin.mutate('permissions.set', {
      objectType: 'resource',
      objectId: null,
      groupId,
      environmentId: null,
      level: null,
    })
    expect(data(await member.query('resources.list')).canCreate).toBe(false)
  })

  it('deleting a resource removes its grants and configs', async () => {
    const tmp = data(
      await admin.mutate('resources.create', { type: 'rest', name: 'Tmp', slug: 'tmp_api' }),
    ).id
    await admin.mutate('permissions.set', {
      objectType: 'resource',
      objectId: tmp,
      groupId,
      environmentId: null,
      level: 'own',
    })
    expect((await member.mutate('resources.delete', { id: tmp })).status).toBe(200)
    expect(await env.db.select().from(permissions).where(eq(permissions.objectId, tmp))).toEqual([])
  })
})

describe('config vars', () => {
  it('only admins manage them; secret values are masked and encrypted', async () => {
    expect((await member.mutate('configVars.create', { name: 'NOPE' })).status).toBe(403)
    const list = data(await member.query('configVars.list'))
    const token = list.find((v: { name: string }) => v.name === 'TOKEN')
    const region = list.find((v: { name: string }) => v.name === 'REGION')
    expect(token.values[prodId]).toEqual({ set: true })
    expect(region.values[prodId]).toEqual({ value: 'eu-west' })
    const stored = await env.db
      .select()
      .from(configVarValues)
      .where(eq(configVarValues.configVarId, token.id))
    expect(stored[0]!.value).toBeNull()
    expect(stored[0]!.valueEncrypted).not.toContain(TOKEN_SECRET)
    expect((await admin.mutate('configVars.create', { name: '1bad' })).status).toBe(400)
  })
})

describe('SSH tunnel settings (M17)', () => {
  let id: string
  const bastion = { id: 'bastion', host: 'bastion.example.com', username: 'ow', auth: 'key' }
  const jump = { id: 'jump', host: 'jump.example.com', port: 2222, username: 'hop', auth: 'password' }
  const pin = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK' }
  const save = (ssh: unknown, secrets?: Record<string, unknown>) =>
    admin.mutate('resources.saveConfig', {
      resourceId: id,
      environmentId: prodId,
      config: { ...pgConfig, ssh },
      ...(secrets ? { secrets } : {}),
    })

  beforeAll(async () => {
    id = data(
      await admin.mutate('resources.create', { type: 'postgres', name: 'Tunnelled', slug: 'tunnelled' }),
    ).id
  })

  it('saves an SSH server with a key, masked like any secret', async () => {
    const saved = await save(
      { hops: [bastion] },
      { password: PG_SECRET, ssh: { bastion: { privateKey: SSH_KEY, passphrase: SSH_PASSPHRASE } } },
    )
    expect(saved.status).toBe(200)
    expect(data(saved).config.ssh).toEqual({ hops: [{ ...bastion, port: 22 }] })
    expect(data(saved).secrets).toEqual({
      password: { set: true },
      ssh: { bastion: { privateKey: { set: true }, passphrase: { set: true } } },
    })
    const got = data(await admin.query('resources.get', { id }))
    expect(
      got.environments.find((e: { environmentId: string }) => e.environmentId === prodId).secrets.ssh,
    ).toEqual({
      bastion: { privateKey: { set: true }, passphrase: { set: true } },
    })
  })

  it("refuses a key it can't open, or a hop without its key or password, saying which server", async () => {
    const wrong = await save({ hops: [bastion] }, { ssh: { bastion: { passphrase: 'not it' } } })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error?.message).toBe(
      "SSH server bastion.example.com: The passphrase doesn't open this key",
    )
    const noPassword = await save({ hops: [jump, bastion] })
    expect(noPassword.body.error?.message).toBe('SSH server jump.example.com: enter the password')
    const noKey = await save({ hops: [{ ...bastion, id: 'other' }] })
    expect(noKey.body.error?.message).toBe('SSH server bastion.example.com: add a private key')
    // Nothing was saved by the refusals.
    const got = data(await admin.query('resources.get', { id }))
    expect(
      got.environments.find((e: { environmentId: string }) => e.environmentId === prodId).config.ssh.hops,
    ).toHaveLength(1)
  })

  it('keeps secrets only for the hops still there, and only what each signs in with', async () => {
    const both = await save({ hops: [jump, bastion] }, { ssh: { jump: { password: SSH_PASSWORD } } })
    expect(data(both).secrets.ssh).toEqual({
      jump: { password: { set: true } },
      bastion: { privateKey: { set: true }, passphrase: { set: true } },
    })
    // The jump host goes: so does its password.
    const one = await save({ hops: [bastion] })
    expect(data(one).secrets.ssh).toEqual({
      bastion: { privateKey: { set: true }, passphrase: { set: true } },
    })
    // Signing in with a password instead: the key isn't kept.
    const password = await save(
      { hops: [{ ...bastion, auth: 'password' }] },
      { ssh: { bastion: { password: SSH_PASSWORD } } },
    )
    expect(data(password).secrets.ssh).toEqual({ bastion: { password: { set: true } } })
    await save({ hops: [bastion] }, { ssh: { bastion: { privateKey: SSH_KEY, passphrase: SSH_PASSPHRASE } } })
  })

  it("drops a trusted host key when its hop moves to another host or port, unless it's trusted anew", async () => {
    expect(data(await save({ hops: [{ ...bastion, hostKey: pin }] })).config.ssh.hops[0].hostKey).toEqual(pin)
    const moved = await save({ hops: [{ ...bastion, host: 'bastion2.example.com', hostKey: pin }] })
    expect(data(moved).config.ssh.hops[0].hostKey).toBeUndefined()
    const repinned = { ...pin, fingerprint: 'SHA256:ZZZZyyyyXXXXwwwwVVVVuuuuTTTTssssRRRRqqqqPPP' }
    const trusted = await save({
      hops: [{ ...bastion, host: 'bastion3.example.com', port: 22, hostKey: repinned }],
    })
    expect(data(trusted).config.ssh.hops[0].hostKey).toEqual(repinned)
    const port = await save({
      hops: [{ ...bastion, host: 'bastion3.example.com', port: 2200, hostKey: repinned }],
    })
    expect(data(port).config.ssh.hops[0].hostKey).toBeUndefined()
  })

  it('tests through a real SSH server hop by hop, trusts its host key, and then queries through it', async () => {
    const ssh = await startTestSshServer({
      users: [
        {
          username: 'ow',
          publicKey: readFileSync(
            new URL(
              '../../../packages/connectors/test/fixtures/ssh/openssh-rsa-encrypted.pub',
              import.meta.url,
            ),
            'utf8',
          ),
        },
      ],
      hosts: { 'db.internal': String(pgConfig.host) },
    })
    try {
      const viaId = data(
        await admin.mutate('resources.create', {
          type: 'postgres',
          name: 'Via bastion',
          slug: 'via_bastion',
        }),
      ).id
      const hop = { id: 'b', host: ssh.host, port: ssh.port, username: 'ow', auth: 'key' }
      const config = (hostKey?: unknown) => ({
        ...pgConfig,
        host: 'db.internal',
        ssh: { hops: [{ ...hop, hostKey }] },
      })
      const saved = await admin.mutate('resources.saveConfig', {
        resourceId: viaId,
        environmentId: prodId,
        config: config(),
        secrets: { password: PG_SECRET, ssh: { b: { privateKey: SSH_KEY, passphrase: SSH_PASSPHRASE } } },
      })
      // The key as the settings show it: its type, fingerprint and public half.
      expect(data(saved).sshKeys).toEqual({
        b: {
          type: 'ssh-rsa',
          fingerprint: expect.stringMatching(/^SHA256:/),
          publicKey: expect.stringMatching(/^ssh-rsa AAAA/),
        },
      })

      // Not trusted yet: the hop fails with the key it presented, and the database isn't tried.
      const first = data(await admin.mutate('resources.test', { resourceId: viaId, environmentId: prodId }))
      expect(first).toMatchObject({
        ok: false,
        error: { code: 'connection' },
        ssh: [
          {
            hop: 'b',
            ok: false,
            hostKey: { ...ssh.hostKey, status: 'untrusted' },
            error: { code: 'ssh_host_key_unknown' },
          },
        ],
      })

      // Trust: the fingerprint goes into the settings, then everything works through the tunnel.
      const presented = first.ssh[0].hostKey
      await admin.mutate('resources.saveConfig', {
        resourceId: viaId,
        environmentId: prodId,
        config: config({ algorithm: presented.algorithm, fingerprint: presented.fingerprint }),
      })
      const second = data(await admin.mutate('resources.test', { resourceId: viaId, environmentId: prodId }))
      expect(second).toMatchObject({
        ok: true,
        message: expect.stringMatching(/^PostgreSQL/),
        ssh: [{ hop: 'b', ok: true, hostKey: { status: 'trusted' } }],
      })
      const run = data(
        await admin.mutate('resources.run', {
          resourceId: viaId,
          environmentId: prodId,
          query: { sql: 'select count(*)::int as n from customers' },
        }),
      )
      expect(run).toMatchObject({ ok: true, data: [{ n: 3 }] })
      expect(ssh.forwards.at(-1)).toMatchObject({ host: 'db.internal', allowed: true })

      const got = data(await admin.query('resources.get', { id: viaId }))
      const prod = got.environments.find((e: { environmentId: string }) => e.environmentId === prodId)
      expect(prod.sshKeys.b.fingerprint).toBe(data(saved).sshKeys.b.fingerprint)
    } finally {
      await ssh.close()
    }
  })

  it('fails Test connection with why when a key is missing, before connecting anywhere', async () => {
    const tested = data(
      await admin.mutate('resources.test', {
        resourceId: id,
        environmentId: prodId,
        config: { ...pgConfig, ssh: { hops: [{ ...bastion, id: 'fresh' }] } },
      }),
    )
    expect(tested).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid_config',
        message: 'SSH server bastion.example.com: add a private key',
      }),
    })
  })
})

describe('no secret in any API response', () => {
  it('appears nowhere in what any client received, nor in the audit log', async () => {
    // Read everything once more as both users, then scan every recorded response body.
    await admin.query('resources.list')
    await admin.query('resources.get', { id: pgId })
    await admin.query('resources.get', { id: restId })
    await admin.query('configVars.list')
    await admin.query('audit.list', {})
    await member.query('resources.get', { id: pgId })
    await admin.query('resources.list')
    expect(responses.length).toBeGreaterThan(50)
    for (const body of responses) {
      for (const secret of SECRETS) expect(body).not.toContain(secret)
    }
    const audit = JSON.stringify(await env.db.select().from(auditEvents))
    for (const secret of SECRETS) expect(audit).not.toContain(secret)
    expect(audit).toContain('resource.config_saved')
  })
})
