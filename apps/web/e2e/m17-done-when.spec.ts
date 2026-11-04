import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  mysqlAvailable,
  startTestMysql,
  startTestSshServer,
  type TestMysql,
  type TestSshServer,
} from '@ow/connectors/testing'
import { expect, type Page, test } from '@playwright/test'
import { signIn } from './helpers'

/**
 * M17's done-when (architecture.md §2.7): a Postgres, a MySQL and a REST resource reachable only through an SSH server
 * (Postgres through a jump host first) run queries from the playground, a workflow and an app, with no tunnel started
 * by hand; an OpenSSH key, a PuTTY v2 key, an encrypted PuTTY v3 key and a password all work; unknown host keys are
 * refused until trusted in Test connection, a changed one is refused with both fingerprints; the tunnel comes back
 * after the SSH server restarts; the key, passphrase and passwords never appear in an API response. The databases and
 * the API have names only the bastion resolves (`*.internal`). (Logs: apps/server/test/ssh-log.test.ts and the
 * Compose check, against a real OpenSSH server.)
 */

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/connectors/test/fixtures/ssh/${name}`, import.meta.url), 'utf8')
const PASSPHRASE = 'fixture pass'
const JUMP_PASSWORD = 'Jump-Passw0rd-M17-4471'
/** A line from the encrypted private part of the v3 key: any of it in a response shows up as this. */
const KEY_LINE = fixture('ppk3-ed25519-encrypted.ppk')
  .split('\n')
  .find((l, i, all) => i > all.indexOf('Private-Lines: 1') && l)!
const SECRETS = [PASSPHRASE, JUMP_PASSWORD, KEY_LINE]

let bastion: TestSshServer
let jump: TestSshServer
let api: Server
let apiPort: number
let mysql: TestMysql | undefined
const withMysql = mysqlAvailable()

test.beforeAll(async () => {
  test.setTimeout(240_000)
  api = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ greeting: 'hello from inside', path: req.url }))
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  apiPort = (api.address() as AddressInfo).port
  if (withMysql) mysql = await startTestMysql()
  const pg = new URL(process.env.E2E_PG_URL!)
  bastion = await startTestSshServer({
    users: [
      { username: 'putty3', publicKey: fixture('openssh-ed25519.pub') },
      { username: 'putty2', publicKey: fixture('openssh-rsa.pub') },
      { username: 'ow', publicKey: fixture('openssh-ecdsa256.pub') },
    ],
    hosts: {
      'db.internal': pg.hostname,
      'mysql.internal': mysql?.host ?? '127.0.0.1',
      'api.internal': '127.0.0.1',
    },
  })
  // The jump host may only forward to the bastion.
  jump = await startTestSshServer({
    users: [{ username: 'hop', password: JUMP_PASSWORD }],
    allowForward: (host, port) => host === bastion.host && port === bastion.port,
  })
})
test.afterAll(async () => {
  await jump?.close()
  await bastion?.close()
  await mysql?.stop()
  await new Promise((r) => api?.close(r))
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

test('Postgres, MySQL and REST through SSH, from the playground, a workflow and an app', async ({ page }) => {
  test.setTimeout(240_000)
  page.on('response', async (res) => {
    if (res.url().includes('/api/')) seen.push(await res.text().catch(() => ''))
  })
  await signIn(page)
  const stamp = Date.now().toString(36)
  const envs = await call<{ id: string; slug: string }[]>(page, 'environments.list', undefined, 'query')
  const environmentId = envs.find((e) => e.slug === 'production')!.id
  const pg = new URL(process.env.E2E_PG_URL!)
  const pinned = (server: TestSshServer) => server.hostKey

  const make = async (type: string, slug: string, config: object, secrets: object) => {
    const { id } = await call<{ id: string }>(page, 'resources.create', { type, name: slug, slug })
    await call(page, 'resources.saveConfig', { resourceId: id, environmentId, config, secrets })
    return id
  }

  // Postgres: a jump host (a password), then the bastion (an encrypted PuTTY v3 key); neither trusted yet.
  const pgSlug = `pg_ssh_${stamp}`
  const pgId = await make(
    'postgres',
    pgSlug,
    {
      host: 'db.internal',
      port: Number(pg.port),
      database: pg.pathname.slice(1),
      user: decodeURIComponent(pg.username),
      ssl: 'disable',
      ssh: {
        hops: [
          { id: 'jump', host: jump.host, port: jump.port, username: 'hop', auth: 'password' },
          { id: 'bastion', host: bastion.host, port: bastion.port, username: 'putty3', auth: 'key' },
        ],
      },
    },
    {
      password: decodeURIComponent(pg.password),
      ssh: {
        jump: { password: JUMP_PASSWORD },
        bastion: { privateKey: fixture('ppk3-ed25519-encrypted.ppk'), passphrase: PASSPHRASE },
      },
    },
  )
  // REST: the bastion with an OpenSSH key; trusted already.
  const restSlug = `rest_ssh_${stamp}`
  const restConfig = (hostKey: object) => ({
    baseUrl: `http://api.internal:${apiPort}`,
    ssh: {
      hops: [{ id: 'bastion', host: bastion.host, port: bastion.port, username: 'ow', auth: 'key', hostKey }],
    },
  })
  const restId = await make('rest', restSlug, restConfig(pinned(bastion)), {
    ssh: { bastion: { privateKey: fixture('openssh-ecdsa256') } },
  })
  // MySQL: the bastion with a PuTTY v2 key; trusted already.
  const mysqlSlug = `mysql_ssh_${stamp}`
  const mysqlId = mysql
    ? await make(
        'mysql',
        mysqlSlug,
        {
          host: 'mysql.internal',
          port: mysql.port,
          database: mysql.database,
          user: mysql.user,
          ssl: 'require',
          ssh: {
            hops: [
              {
                id: 'bastion',
                host: bastion.host,
                port: bastion.port,
                username: 'putty2',
                auth: 'key',
                hostKey: pinned(bastion),
              },
            ],
          },
        },
        { password: mysql.password, ssh: { bastion: { privateKey: fixture('ppk2-rsa.ppk') } } },
      )
    : undefined

  await test.step('Postgres: each host key refused until trusted in Test connection, the jump host first', async () => {
    await page.goto(`/resources/${pgId}`)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByTestId('ssh-step-jump').getByTestId('ssh-presented-key')).toHaveText(
      jump.hostKey.fingerprint,
    )
    await expect(page.getByTestId('ssh-step-bastion')).toHaveCount(0)
    await page.getByRole('button', { name: 'Trust this key' }).click()
    await expect(page.getByTestId('ssh-step-bastion').getByTestId('ssh-presented-key')).toHaveText(
      bastion.hostKey.fingerprint,
    )
    await page.getByRole('button', { name: 'Trust this key' }).click()
    await expect(page.getByText(/Connected · PostgreSQL/)).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
  })

  await test.step('the playground queries Postgres through both SSH servers', async () => {
    await page.getByRole('button', { name: 'Query', exact: true }).click()
    await page.getByRole('textbox', { name: /^SQL/ }).fill('select email from customers order by id')
    await page.getByRole('button', { name: 'Run' }).click()
    await expect(page.getByText('grace@example.com')).toBeVisible()
    expect(jump.forwards.at(-1)).toMatchObject({ host: bastion.host, port: bastion.port, allowed: true })
    expect(bastion.forwards.at(-1)).toMatchObject({ host: 'db.internal', allowed: true })
  })

  await test.step('a workflow queries all three through the tunnels', async () => {
    const slug = `m17-${stamp}`
    const flow = await call<{ id: string }>(page, 'workflows.create', { slug, name: slug })
    const blocks: object[] = [
      { name: 'startTrigger', type: 'startTrigger' },
      {
        name: 'pg',
        type: 'resourceQuery',
        config: { resource: pgSlug, query: { sql: 'select count(*)::int as n from customers' } },
      },
      {
        name: 'rest',
        type: 'resourceQuery',
        config: { resource: restSlug, query: { method: 'GET', path: 'from-a-workflow' } },
      },
      ...(mysql
        ? [
            {
              name: 'my',
              type: 'resourceQuery',
              config: { resource: mysqlSlug, query: { sql: 'SELECT 40 + 2 AS n' } },
            },
          ]
        : []),
    ]
    await call(page, 'workflows.saveDraft', {
      id: flow.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks,
        edges: blocks
          .slice(1)
          .map((b) => ({ from: 'startTrigger', port: 'out', to: (b as { name: string }).name })),
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
    const data = async (block: string) => {
      const text = await (await page.request.get(`/api/v1/runs/${id}/blocks/${block}`)).text()
      seen.push(text)
      return JSON.parse(text).block.data
    }
    expect(await data('pg')).toEqual([{ n: 2 }])
    expect(await data('rest')).toMatchObject({ greeting: 'hello from inside', path: '/from-a-workflow' })
    if (mysql) expect(await data('my')).toEqual([{ n: 42 }])
  })

  await test.step('an app runs its queries through them too', async () => {
    const slug = `m17-app-${stamp}`
    const app = await call<{ id: string }>(page, 'apps.create', { slug, name: slug })
    await call(page, 'apps.saveDraft', {
      id: app.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [
          { name: 'pgText', type: 'text', props: { value: 'pg {{ pgCount.data[0].n }}' } },
          { name: 'restText', type: 'text', props: { value: 'rest {{ hello.data.greeting }}' } },
          ...(mysql ? [{ name: 'myText', type: 'text', props: { value: 'my {{ answer.data[0].n }}' } }] : []),
        ],
        queries: [
          {
            name: 'pgCount',
            kind: 'resource',
            resource: pgSlug,
            query: { sql: 'select count(*)::int as n from customers' },
            run: 'auto',
          },
          {
            name: 'hello',
            kind: 'resource',
            resource: restSlug,
            query: { method: 'GET', path: 'from-an-app' },
            run: 'auto',
          },
          ...(mysql
            ? [
                {
                  name: 'answer',
                  kind: 'resource',
                  resource: mysqlSlug,
                  query: { sql: 'SELECT 40 + 2 AS n' },
                  run: 'auto',
                },
              ]
            : []),
        ],
        layout: {
          pgText: { x: 0, y: 0, w: 4, h: 1 },
          restText: { x: 4, y: 0, w: 4, h: 1 },
          ...(mysql ? { myText: { x: 8, y: 0, w: 4, h: 1 } } : {}),
        },
      },
    })
    await page.goto(`/apps/${slug}/edit`)
    await expect(page.getByTestId('frame-pgText')).toContainText('pg 2', { timeout: 30_000 })
    await expect(page.getByTestId('frame-restText')).toContainText('rest hello from inside')
    if (mysql) await expect(page.getByTestId('frame-myText')).toContainText('my 42')
  })

  await test.step('the tunnels come back after the SSH servers restart', async () => {
    await bastion.restart()
    await jump.restart()
    await expect
      .poll(
        async () => {
          const run = await call<{ ok: boolean; data?: unknown }>(page, 'resources.run', {
            resourceId: pgId,
            environmentId,
            query: { sql: 'select 1 as back' },
          })
          return run.ok && run.data
        },
        { timeout: 30_000 },
      )
      .toEqual([{ back: 1 }])
  })

  await test.step('a changed host key is refused, with both fingerprints', async () => {
    const other = {
      algorithm: 'ecdsa-sha2-nistp256',
      fingerprint: 'SHA256:AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK',
    }
    await call(page, 'resources.saveConfig', { resourceId: restId, environmentId, config: restConfig(other) })
    const tested = await call<{ ok: boolean; ssh: { hostKey: object; error: { code: string } }[] }>(
      page,
      'resources.test',
      { resourceId: restId, environmentId },
    )
    expect(tested.ok).toBe(false)
    expect(tested.ssh[0]).toMatchObject({
      hostKey: { fingerprint: bastion.hostKey.fingerprint, trusted: other.fingerprint, status: 'changed' },
      error: { code: 'ssh_host_key_changed' },
    })
    const run = await call<{ ok: boolean; error?: { code: string; details: { ssh: { code: string } } } }>(
      page,
      'resources.run',
      { resourceId: restId, environmentId, query: { method: 'GET', path: 'x' } },
    )
    expect(run).toMatchObject({
      ok: false,
      error: { code: 'connection', details: { ssh: { code: 'ssh_host_key_changed' } } },
    })
  })

  await test.step('no key, passphrase or password in anything the API sent', async () => {
    for (const id of [pgId, restId, ...(mysqlId ? [mysqlId] : [])])
      await call(page, 'resources.get', { id }, 'query')
    await call(page, 'resources.list', undefined, 'query')
    expect(seen.length).toBeGreaterThan(20)
    for (const body of seen) for (const secret of SECRETS) expect(body).not.toContain(secret)
  })
})
