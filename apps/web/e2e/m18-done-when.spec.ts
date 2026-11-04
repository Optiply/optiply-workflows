import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { startTestSshServer, type TestSshServer } from '@ow/connectors/testing'
import { expect, type Page, test } from '@playwright/test'
import { E2E_IAP_VM, E2E_MEMBER_EMAIL } from './global-setup'
import { signIn } from './helpers'

/**
 * M18's done-when (architecture.md §2.7): a Postgres resource whose SSH server is reached through Google Cloud IAP (the
 * fake IAP endpoint from global setup, forwarding to a test SSH server as the VM) runs queries from the playground, a
 * workflow and an app, signed in with a service account key and with the server's own identity (the fake metadata
 * server); IAP refusing the identity shows `iap_auth`, an unknown instance or a closed port `iap_target`, in Test
 * connection; a WebSocket dropped in the middle of a query resumes and the query finishes; a jump host after the IAP hop
 * works; the key never appears in an API response; a non-admin can't point the server's identity at a VM. Elsewhere:
 * the server's identity from a credentials file of each type (packages/connectors/test/google-auth.test.ts), no server
 * identity where the instance hasn't opted in and no key in the audit log (apps/server/test/resources.test.ts), and
 * Optiply's production resource through the real IAP (the Compose check, by hand).
 */

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/connectors/test/fixtures/ssh/${name}`, import.meta.url), 'utf8')
const KEY_EMAIL = 'tunnel@fake-project.iam.gserviceaccount.com'
const VM_EMAIL = 'vm@fake-project.iam.gserviceaccount.com'
const INNER_PASSWORD = 'Inner-Passw0rd-M18-5823'
const IAP_KEY = process.env.E2E_IAP_KEY!
/** A line of each private key: any of it in a response shows up as this. */
const SECRETS = [
  (JSON.parse(IAP_KEY).private_key as string).split('\n')[5]!,
  fixture('openssh-ed25519').trim().split('\n').at(-2)!,
  INNER_PASSWORD,
]

/** Steers the fake IAP endpoint (global setup's control routes). */
const control = (path: string, method = 'POST') =>
  fetch(`${process.env.E2E_IAP_CONTROL}${path}`, { method }).then((r) => r.json().catch(() => null))

let vm: TestSshServer
let inner: TestSshServer
let closedPort: number

test.beforeAll(async () => {
  const pg = new URL(process.env.E2E_PG_URL!)
  // The VM IAP reaches; an SSH server behind it (a jump host after the IAP hop) that resolves the database.
  vm = await startTestSshServer({
    users: [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }],
    hosts: { 'db.internal': pg.hostname },
  })
  inner = await startTestSshServer({
    users: [{ username: 'hop', password: INNER_PASSWORD }],
    hosts: { 'db.internal': pg.hostname },
  })
  // A port nothing listens on.
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  closedPort = (probe.address() as { port: number }).port
  await new Promise((r) => probe.close(r))
})
test.afterAll(async () => {
  await inner?.close()
  await vm?.close()
})

/** Every API response this spec saw, to scan for secrets. */
const seen: string[] = []

async function call<T>(
  page: Page,
  path: string,
  input: unknown,
  method: 'mutate' | 'query' = 'mutate',
): Promise<T> {
  const res =
    method === 'mutate'
      ? await page.request.post(`/api/trpc/${path}`, { data: { json: input } })
      : await page.request.get(
          `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
        )
  const text = await res.text()
  seen.push(text)
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${text}`)
  return JSON.parse(text).result.data.json as T
}

test('Postgres through Google Cloud IAP, with a key and the server identity, from the playground, a workflow and an app', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000)
  page.on('response', async (res) => {
    if (res.url().includes('/api/')) seen.push(await res.text().catch(() => ''))
  })
  await signIn(page)
  const stamp = Date.now().toString(36)
  const envs = await call<{ id: string; slug: string }[]>(page, 'environments.list', undefined, 'query')
  const environmentId = envs.find((e) => e.slug === 'production')!.id
  const pg = new URL(process.env.E2E_PG_URL!)
  const database = {
    host: 'db.internal',
    port: Number(pg.port),
    database: pg.pathname.slice(1),
    user: decodeURIComponent(pg.username),
    ssl: 'disable',
  }
  const viaIap = (iap: Record<string, unknown>, port = vm.port) => ({
    id: 'vm',
    reach: 'iap',
    iap: { ...E2E_IAP_VM, ...iap },
    port,
    username: 'ow',
    auth: 'key',
    hostKey: vm.hostKey,
  })
  const make = async (slug: string, config: object, secrets: object) => {
    const { id } = await call<{ id: string }>(page, 'resources.create', {
      type: 'postgres',
      name: slug,
      slug,
    })
    await call(page, 'resources.saveConfig', { resourceId: id, environmentId, config, secrets })
    return id
  }

  // With a service account key, straight to the database.
  const keySlug = `iap_key_${stamp}`
  const keyConfig = (iap: Record<string, unknown> = {}, port?: number) => ({
    ...database,
    ssh: { hops: [viaIap({ identity: 'key', ...iap }, port)] },
  })
  const keyId = await make(keySlug, keyConfig(), {
    password: decodeURIComponent(pg.password),
    ssh: { vm: { privateKey: fixture('openssh-ed25519'), iapKey: IAP_KEY } },
  })
  // With the server's own identity, then a jump host behind the VM.
  const serverSlug = `iap_server_${stamp}`
  const serverConfig = (iap: Record<string, unknown> = {}) => ({
    ...database,
    ssh: {
      hops: [
        viaIap({ identity: 'server', ...iap }),
        {
          id: 'inner',
          host: inner.host,
          port: inner.port,
          username: 'hop',
          auth: 'password',
          hostKey: inner.hostKey,
        },
      ],
    },
  })
  const serverId = await make(serverSlug, serverConfig(), {
    password: decodeURIComponent(pg.password),
    ssh: { vm: { privateKey: fixture('openssh-ed25519') }, inner: { password: INNER_PASSWORD } },
  })

  await test.step("Test connection: IAP as the server's identity, the VM, the jump host after it", async () => {
    await page.goto(`/resources/${serverId}`)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByTestId('ssh-step-vm-iap')).toContainText(`as ${VM_EMAIL}`)
    await expect(page.getByTestId('ssh-step-vm')).toContainText('Host key trusted')
    await expect(page.getByTestId('ssh-step-inner')).toContainText('Host key trusted')
    await expect(page.getByText(/Connected · PostgreSQL/)).toBeVisible()
    expect(vm.forwards.at(-1)).toMatchObject({ host: inner.host, port: inner.port, allowed: true })
    expect(inner.forwards.at(-1)).toMatchObject({ host: 'db.internal', allowed: true })
  })

  await test.step('the playground queries through IAP with the key', async () => {
    await page.goto(`/resources/${keyId}`)
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await page.getByRole('textbox', { name: /^SQL/ }).fill('select email from customers order by id')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('grace@example.com')).toBeVisible()
    expect(vm.forwards.at(-1)).toMatchObject({ host: 'db.internal', allowed: true })
  })

  await test.step('a workflow queries both', async () => {
    const slug = `m18-${stamp}`
    const flow = await call<{ id: string }>(page, 'workflows.create', { slug, name: slug })
    const blocks = [
      { name: 'startTrigger', type: 'startTrigger' },
      ...[
        ['withKey', keySlug],
        ['asServer', serverSlug],
      ].map(([name, resource]) => ({
        name,
        type: 'resourceQuery',
        config: { resource, query: { sql: 'select count(*)::int as n from customers' } },
      })),
    ]
    await call(page, 'workflows.saveDraft', {
      id: flow.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks,
        edges: blocks.slice(1).map((b) => ({ from: 'startTrigger', port: 'out', to: b.name })),
      },
    })
    const started = await page.request.post(`/api/v1/workflows/${slug}/runs`, { data: {} })
    expect(started.status()).toBe(202)
    const id = (await started.json()).run.id as string
    await expect
      .poll(async () => (await (await page.request.get(`/api/v1/runs/${id}`)).json()).run.status, {
        timeout: 60_000,
      })
      .toBe('succeeded')
    for (const block of ['withKey', 'asServer']) {
      const text = await (await page.request.get(`/api/v1/runs/${id}/blocks/${block}`)).text()
      seen.push(text)
      expect(JSON.parse(text).block.data).toEqual([{ n: 2 }])
    }
  })

  await test.step('an app runs its queries through both', async () => {
    const slug = `m18-app-${stamp}`
    const app = await call<{ id: string }>(page, 'apps.create', { slug, name: slug })
    await call(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [
          { name: 'keyText', type: 'text', props: { value: 'key {{ withKey.data[0].n }}' } },
          { name: 'serverText', type: 'text', props: { value: 'server {{ asServer.data[0].n }}' } },
        ],
        queries: [
          ['withKey', keySlug],
          ['asServer', serverSlug],
        ].map(([name, resource]) => ({
          name,
          kind: 'resource',
          resource,
          query: { sql: 'select count(*)::int as n from customers' },
          run: 'auto',
        })),
        layout: { keyText: { x: 0, y: 0, w: 4, h: 1 }, serverText: { x: 4, y: 0, w: 4, h: 1 } },
      },
    })
    await page.goto(`/apps/${slug}/edit`)
    await expect(page.getByTestId('frame-keyText')).toContainText('key 2', { timeout: 30_000 })
    await expect(page.getByTestId('frame-serverText')).toContainText('server 2')
  })

  await test.step('a WebSocket dropped in the middle of a query resumes, and the query finishes', async () => {
    const run = (sql: string) =>
      call<{ ok: boolean; data?: unknown }>(page, 'resources.run', {
        resourceId: keyId,
        environmentId,
        query: { sql },
      })
    // The tunnel is open from the steps before; this query is under way when IAP's WebSocket goes.
    const before = await control('/stats', 'GET')
    const slow = run('select pg_sleep(2), count(*)::int as n from customers')
    await new Promise((r) => setTimeout(r, 500))
    await control('/drop')
    expect(await slow).toMatchObject({ ok: true, data: [{ n: 2 }] })
    const after = await control('/stats', 'GET')
    expect(after.reconnects).toBeGreaterThan(before.reconnects)
    expect(after.connects).toBe(before.connects)
  })

  await test.step('Test connection: IAP refusing the identity is iap_auth; a wrong VM or port iap_target', async () => {
    const test_ = (config?: object) =>
      call<{ ok: boolean; ssh: { via?: string; error?: { code: string; message: string } }[] }>(
        page,
        'resources.test',
        { resourceId: keyId, environmentId, ...(config ? { config } : {}) },
      )
    await control(`/refuse-next?code=4033&reason=${encodeURIComponent('not authorized')}`)
    const refused = await test_()
    expect(refused.ok).toBe(false)
    expect(refused.ssh).toMatchObject([{ via: 'iap', error: { code: 'iap_auth' } }])
    const unknown = await test_(keyConfig({ instance: 'gone' }))
    expect(unknown.ssh).toMatchObject([
      {
        via: 'iap',
        error: { code: 'iap_target', message: expect.stringMatching(/couldn't find the VM gone/) },
      },
    ])
    const closed = await test_(keyConfig({}, closedPort))
    expect(closed.ssh).toMatchObject([
      { via: 'iap', error: { code: 'iap_target', message: expect.stringMatching(/firewall/) } },
    ])
    // As the settings page shows it.
    await page.goto(`/resources/${keyId}`)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await control(`/refuse-next?code=4033&reason=${encodeURIComponent('not authorized')}`)
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByTestId('ssh-step-vm-iap')).toContainText(refused.ssh[0]!.error!.message)
    await expect(page.getByTestId('ssh-step-vm-iap')).toContainText(`as ${KEY_EMAIL}`)
  })

  await test.step("a non-admin can't point the server's identity at a VM", async () => {
    const groups = await call<{ id: string; systemKind: string | null }[]>(
      page,
      'groups.list',
      undefined,
      'query',
    )
    const everyone = groups.find((g) => g.systemKind === 'all_users')!
    for (const objectId of [keyId, serverId]) {
      await call(page, 'permissions.set', {
        objectType: 'resource',
        objectId,
        groupId: everyone.id,
        environmentId: null,
        level: 'edit',
      })
    }
    const context = await browser.newContext()
    const member = await context.newPage()
    await signIn(member, E2E_MEMBER_EMAIL)
    const save = (resourceId: string, config: object) =>
      member.request.post('/api/trpc/resources.saveConfig', {
        data: { json: { resourceId, environmentId, config } },
      })
    // The key's resource switched to the server's identity; the server identity's moved to another VM.
    for (const [resourceId, config] of [
      [keyId, keyConfig({ identity: 'server' })],
      [serverId, serverConfig({ instance: 'elsewhere' })],
    ] as const) {
      const res = await save(resourceId, config)
      seen.push(await res.text())
      expect(res.status()).toBe(403)
    }
    // The rest of the settings, yes.
    const kept = await save(serverId, { ...serverConfig(), user: database.user })
    expect(kept.status()).toBe(200)
    await context.close()
  })

  await test.step('no key or password in anything the API sent', async () => {
    for (const id of [keyId, serverId]) await call(page, 'resources.get', { id }, 'query')
    expect(seen.length).toBeGreaterThan(20)
    for (const body of seen) for (const secret of SECRETS) expect(body).not.toContain(secret)
  })
})
