import { readFileSync } from 'node:fs'
import { startTestSshServer } from '@ow/connectors/testing'
import { expect, type Page, test } from '@playwright/test'
import { E2E_IAP_VM, E2E_MEMBER_EMAIL } from './global-setup'
import { signIn, trpcMutate, trpcQuery } from './helpers'

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/connectors/test/fixtures/ssh/${name}`, import.meta.url), 'utf8')
const KEY_EMAIL = 'tunnel@fake-project.iam.gserviceaccount.com'

/** Reloads the page (or opens `url`) and goes to Settings (a configured resource opens on Query). */
async function reopen(page: Page, url?: string) {
  if (url) await page.goto(url)
  else await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
}

/** M18 step 5a: the first SSH server reached through Google Cloud IAP, with a key and with the server's identity. */
test("reach the SSH server through Google Cloud IAP: a key, then the server's own identity", async ({
  page,
  browser,
}) => {
  await signIn(page)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'postgres',
    name: 'Behind IAP',
    slug: `iap_${Date.now().toString(36)}`,
  })
  await page.goto(`/resources/${resource.id}`)
  await page.getByLabel('Host', { exact: true }).first().fill('db.internal')
  await page.getByLabel('Database', { exact: true }).fill('shop')
  await page.getByLabel(/^User/).first().fill('reader')

  const tunnel = page.getByTestId('ssh-tunnel')
  await tunnel.getByLabel('Connect through an SSH tunnel').check()
  const server = tunnel.locator('fieldset').last()

  await test.step('through IAP the VM replaces the host; a pasted key shows its account at once', async () => {
    await server.getByTestId('ssh-reach').selectOption('iap')
    await expect(server).toContainText('Reached through Google Cloud IAP')
    await expect(server.getByLabel('Host', { exact: true })).toHaveCount(0)
    await server.getByLabel('Project', { exact: true }).fill(E2E_IAP_VM.project)
    await server.getByLabel('Zone', { exact: true }).fill(E2E_IAP_VM.zone)
    await server.getByLabel(/^Instance/).fill(E2E_IAP_VM.instance)
    await server.getByLabel('User', { exact: true }).fill('ow')
    await server.getByTestId('ssh-private-key').fill(fixture('openssh-rsa-encrypted'))
    await server.getByLabel(/^Passphrase/).fill('fixture pass')
    await server.getByTestId('iap-key').fill('{"nope": true}')
    await expect(server.getByTestId('iap-key-info')).toContainText("doesn't look like a service account key")
    await server.getByTestId('iap-key').fill(process.env.E2E_IAP_KEY!)
    await expect(server.getByTestId('iap-key-info')).toContainText(KEY_EMAIL)
  })

  await test.step('saved: the key shows only its account, the VM its fields', async () => {
    await save(page)
    await expect(page.getByText('Saved.')).toBeVisible()
    await reopen(page)
    const again = page.getByTestId('ssh-tunnel').locator('fieldset').last()
    await expect(again.getByTestId('ssh-reach')).toHaveValue('iap')
    await expect(again.getByLabel(/^Instance/)).toHaveValue(E2E_IAP_VM.instance)
    await expect(again.getByTestId('iap-key-info')).toContainText(KEY_EMAIL)
    await expect(page.locator('body')).not.toContainText('PRIVATE KEY')
  })

  await test.step("the server's identity: whose it is, and the key is no longer asked for", async () => {
    const again = page.getByTestId('ssh-tunnel').locator('fieldset').last()
    await again.getByTestId('iap-identity').selectOption('server')
    await expect(again.getByTestId('iap-server-note')).toContainText('Signs in as')
    await expect(again.getByTestId('iap-key')).toHaveCount(0)
    await save(page)
    await expect(page.getByText('Saved.')).toBeVisible()
  })

  await test.step("an editor keeps the admin's choice but can't move it", async () => {
    const groups = await (await page.request.get('/api/trpc/groups.list')).json()
    const everyone = (groups.result.data.json as { id: string; systemKind: string | null }[]).find(
      (g) => g.systemKind === 'all_users',
    )!
    await trpcMutate(page, 'permissions.set', {
      objectType: 'resource',
      objectId: resource.id,
      groupId: everyone.id,
      environmentId: null,
      level: 'edit',
    })
    const context = await browser.newContext()
    const member = await context.newPage()
    await signIn(member, E2E_MEMBER_EMAIL)
    await reopen(member, `/resources/${resource.id}`)
    const theirs = member.getByTestId('ssh-tunnel').locator('fieldset').last()
    await expect(theirs.getByTestId('iap-server-note')).toContainText(
      'only admins can point it at another VM',
    )
    await expect(theirs.getByLabel(/^Instance/)).toBeDisabled()
    await expect(theirs.getByTestId('iap-identity')).toBeDisabled()
    await expect(theirs.getByLabel('User', { exact: true })).toBeEnabled()
    await context.close()
  })
})

/**
 * M18 step 5b: Test connection through IAP: a line for IAP (the VM, whose identity), then the SSH server's host key to
 * trust, then the database through both; a VM IAP doesn't know stops at the IAP line with why.
 */
test('test a connection through Google Cloud IAP, trust the VM, query through it', async ({ page }) => {
  const pg = new URL(process.env.E2E_PG_URL!)
  // The VM: the fake IAP endpoint connects to it at 127.0.0.1 on the port the settings name.
  const ssh = await startTestSshServer({
    users: [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }],
    hosts: { 'db.internal': pg.hostname },
  })
  try {
    await signIn(page)
    const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
      type: 'postgres',
      name: 'Through IAP',
      slug: `iap_test_${Date.now().toString(36)}`,
    })
    const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
    const environmentId = envs.find((e) => e.slug === 'production')!.id
    const config = (iap: Record<string, unknown> = {}) => ({
      host: 'db.internal',
      port: Number(pg.port),
      database: pg.pathname.slice(1),
      user: decodeURIComponent(pg.username),
      ssl: 'disable',
      ssh: {
        hops: [
          {
            id: 'vm',
            reach: 'iap',
            iap: { ...E2E_IAP_VM, ...iap },
            port: ssh.port,
            username: 'ow',
            auth: 'key',
          },
        ],
      },
    })
    await trpcMutate(page, 'resources.saveConfig', {
      resourceId: resource.id,
      environmentId,
      config: config(),
      secrets: {
        password: decodeURIComponent(pg.password),
        ssh: { vm: { privateKey: fixture('openssh-ed25519'), iapKey: process.env.E2E_IAP_KEY! } },
      },
    })
    await reopen(page, `/resources/${resource.id}`)
    const vm = `${E2E_IAP_VM.project}/${E2E_IAP_VM.zone}/${E2E_IAP_VM.instance}:${ssh.port}`

    await test.step('IAP opens with the key; the VM presents its host key', async () => {
      await page.getByRole('button', { name: 'Test connection' }).click()
      const iap = page.getByTestId('ssh-step-vm-iap')
      await expect(iap).toContainText(`Google Cloud IAP to ${vm}`)
      await expect(iap).toContainText(`as ${KEY_EMAIL}`)
      await expect(page.getByTestId('ssh-step-vm')).toContainText(
        `SSH server ${E2E_IAP_VM.instance}:${ssh.port}`,
      )
      await expect(page.getByTestId('ssh-presented-key')).toHaveText(ssh.hostKey.fingerprint)
    })

    await test.step('trusted: through IAP and the VM to the database, then saved and queried', async () => {
      await page.getByRole('button', { name: 'Trust this key' }).click()
      await expect(page.getByTestId('ssh-step-vm')).toContainText('Host key trusted')
      await expect(page.getByText(/Connected · PostgreSQL/)).toBeVisible()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('Saved.')).toBeVisible()
      const run = await trpcMutate<{ ok: boolean; data: unknown }>(page, 'resources.run', {
        resourceId: resource.id,
        environmentId,
        query: { sql: 'select count(*)::int as n from customers' },
      })
      expect(run).toMatchObject({ ok: true, data: [{ n: 2 }] })
      expect(ssh.forwards.at(-1)).toMatchObject({ host: 'db.internal', allowed: true })
    })

    await test.step("a VM IAP doesn't know: the IAP line says why, and nothing after it", async () => {
      await page
        .getByTestId('ssh-tunnel')
        .getByLabel(/^Instance/)
        .fill('gone')
      await page.getByRole('button', { name: 'Test connection' }).click()
      const iap = page.getByTestId('ssh-step-vm-iap')
      await expect(iap).toContainText(`Google Cloud IAP to ${E2E_IAP_VM.project}/${E2E_IAP_VM.zone}/gone`)
      await expect(iap).toContainText("Google IAP couldn't find the VM gone")
      await expect(iap).toContainText('check the project, zone and instance name')
      await expect(page.getByTestId('ssh-step-vm')).toHaveCount(0)
      await expect(page.getByText(/Connected/)).toHaveCount(0)
    })
  } finally {
    await ssh.close()
  }
})

/** M18 review: a jump host added to a server reached through IAP goes after it; another VM forgets the host key. */
test('a jump host after the IAP server, and another VM forgets its host key', async ({ page }) => {
  await signIn(page)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'postgres',
    name: 'IAP then a jump',
    slug: `iap_jump_${Date.now().toString(36)}`,
  })
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  const environmentId = envs.find((e) => e.slug === 'production')!.id
  const pin = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK' }
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId,
    config: {
      host: 'db.internal',
      port: 5432,
      database: 'shop',
      user: 'reader',
      ssl: 'disable',
      ssh: {
        hops: [{ id: 'vm', reach: 'iap', iap: E2E_IAP_VM, username: 'ow', auth: 'password', hostKey: pin }],
      },
    },
    secrets: { password: 'x', ssh: { vm: { password: 'y', iapKey: process.env.E2E_IAP_KEY! } } },
  })
  await reopen(page, `/resources/${resource.id}`)
  const tunnel = page.getByTestId('ssh-tunnel')
  const vm = tunnel.getByTestId('ssh-hop-vm')

  await test.step('another zone is another VM: its trusted host key goes', async () => {
    await expect(vm.getByTestId('ssh-host-key')).toContainText(pin.fingerprint)
    await vm.getByLabel('Zone', { exact: true }).fill('europe-west1-d')
    await expect(vm.getByTestId('ssh-host-key')).toContainText('not trusted yet')
  })

  await test.step('Add a jump host: the IAP server stays first, the new one comes after it', async () => {
    await tunnel.getByRole('button', { name: 'Add a jump host' }).click()
    const hops = tunnel.locator('fieldset')
    await expect(hops).toHaveCount(2)
    await expect(hops.first()).toHaveAttribute('data-testid', 'ssh-hop-vm')
    await expect(hops.first()).toContainText('Jump host 1')
    await expect(hops.first()).toContainText('Connected to first, through Google Cloud IAP.')
    await expect(hops.last()).toContainText('SSH server')
    await expect(hops.last().getByTestId('ssh-reach')).toHaveCount(0)
    await hops.last().getByLabel('Host', { exact: true }).fill('inner.internal')
    await hops.last().getByLabel('User', { exact: true }).fill('hop')
    await hops.last().getByLabel('Sign in with').selectOption('password')
    await hops
      .last()
      .getByLabel(/^Password/)
      .fill('z')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
  })
})
