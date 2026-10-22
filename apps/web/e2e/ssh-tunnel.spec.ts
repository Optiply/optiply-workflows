import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { startTestSshServer } from '@ow/connectors/testing'
import { expect, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/connectors/test/fixtures/ssh/${name}`, import.meta.url), 'utf8')

/** `ssh-keygen -l`'s fingerprint of a public key line. */
function fingerprintOf(publicLine: string): string {
  const blob = Buffer.from(publicLine.trim().split(' ')[1]!, 'base64')
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** Reloads the page (or opens `url`) and goes to Settings (a configured resource opens on Query). */
async function reopen(page: Page, url?: string) {
  if (url) await page.goto(url)
  else await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
}

/** M17 step 5a: a Postgres resource's SSH tunnel settings: the server, its key, jump hosts, off again. */
test('set up an SSH tunnel with a key and a jump host, and turn it off', async ({ page }) => {
  await signIn(page)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'postgres',
    name: 'Behind a bastion',
    slug: `bastion_${Date.now().toString(36)}`,
  })
  await page.goto(`/resources/${resource.id}`)
  await page.getByLabel('Host', { exact: true }).first().fill('db.internal')
  await page.getByLabel('Database', { exact: true }).fill('shop')
  await page.getByLabel(/^User/).first().fill('reader')

  const tunnel = page.getByTestId('ssh-tunnel')
  await tunnel.getByLabel('Connect through an SSH tunnel').check()
  const server = tunnel.locator('fieldset').last()
  await expect(server).toContainText('SSH server')

  await test.step('a key with the wrong passphrase is refused, naming the server', async () => {
    await server.getByLabel('Host').fill('bastion.example.com')
    await server.getByLabel('User').fill('ow')
    await server.getByTestId('ssh-private-key').fill(fixture('openssh-rsa-encrypted'))
    await server.getByLabel('Passphrase').fill('not it')
    await save(page)
    await expect(
      page.getByText("SSH server bastion.example.com: The passphrase doesn't open this key"),
    ).toBeVisible()
  })

  await test.step('saved with its passphrase: the key shows its fingerprint and public half, never itself', async () => {
    await server.getByLabel('Passphrase').fill('fixture pass')
    await save(page)
    await expect(page.getByText('Saved.')).toBeVisible()
    const info = server.getByTestId('ssh-key-info')
    await expect(info).toContainText(fingerprintOf(fixture('openssh-rsa-encrypted.pub')))
    await expect(info).toContainText('ssh-rsa AAAA')
    await expect(info.getByRole('button', { name: /Copy public key/ })).toBeVisible()
    await reopen(page)
    const again = page.getByTestId('ssh-tunnel').locator('fieldset').last()
    await expect(again.getByLabel('Host')).toHaveValue('bastion.example.com')
    await expect(again).toContainText('Stored securely')
    await expect(again.getByTestId('ssh-host-key')).toContainText('not trusted yet')
    await expect(page.locator('body')).not.toContainText('PRIVATE KEY')
  })

  await test.step('a jump host before it, signing in with a password', async () => {
    const t = page.getByTestId('ssh-tunnel')
    await t.getByRole('button', { name: 'Add a jump host' }).click()
    const jump = t.locator('fieldset').first()
    await expect(jump).toContainText('Jump host 1')
    await expect(t.locator('fieldset').last()).toContainText('SSH server')
    await jump.getByLabel('Host').fill('jump.example.com')
    await jump.getByLabel('User').fill('hop')
    await jump.getByLabel('Sign in with').selectOption('password')
    await save(page)
    await expect(page.getByText('SSH server jump.example.com: enter the password')).toBeVisible()
    await jump.getByLabel('Password', { exact: true }).fill('Jump-Pa55')
    await save(page)
    await expect(page.getByText('Saved.')).toBeVisible()
    await reopen(page)
    await expect(page.getByTestId('ssh-tunnel').locator('fieldset')).toHaveCount(2)
    await page.getByTestId('ssh-tunnel').getByTitle('Remove this jump host').click()
    await save(page)
    await expect(page.getByText('Saved.')).toBeVisible()
    await reopen(page)
    await expect(page.getByTestId('ssh-tunnel').locator('fieldset')).toHaveCount(1)
  })

  await test.step('turned off: no tunnel, and no browser password fields anywhere', async () => {
    await page.getByTestId('ssh-tunnel').getByLabel('Connect through an SSH tunnel').uncheck()
    await save(page)
    await expect(page.getByText('Saved.')).toBeVisible()
    await reopen(page)
    await expect(page.getByTestId('ssh-tunnel').getByLabel('Connect through an SSH tunnel')).not.toBeChecked()
    await expect(page.getByTestId('ssh-tunnel').locator('fieldset')).toHaveCount(0)
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
  })
})

/**
 * M17 step 5b: Test connection through a real (test) SSH server in front of the e2e database: the server's host key
 * shown and trusted, then the database reached through the tunnel; a changed key warned about with both fingerprints.
 */
test("trust an SSH server's host key in Test connection, then query through it", async ({ page }) => {
  const pg = new URL(process.env.E2E_PG_URL!)
  const ssh = await startTestSshServer({
    users: [{ username: 'ow', publicKey: fixture('openssh-ed25519.pub') }],
    hosts: { 'db.internal': pg.hostname },
  })
  try {
    await signIn(page)
    const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
      type: 'postgres',
      name: 'Through the bastion',
      slug: `trusted_${Date.now().toString(36)}`,
    })
    const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
    const environmentId = envs.find((e) => e.slug === 'production')!.id
    const hop = { id: 'srv', host: ssh.host, port: ssh.port, username: 'ow', auth: 'key' }
    const config = (hostKey?: unknown) => ({
      host: 'db.internal',
      port: Number(pg.port),
      database: pg.pathname.slice(1),
      user: decodeURIComponent(pg.username),
      ssl: 'disable',
      ssh: { hops: [{ ...hop, ...(hostKey ? { hostKey } : {}) }] },
    })
    await trpcMutate(page, 'resources.saveConfig', {
      resourceId: resource.id,
      environmentId,
      config: config(),
      secrets: {
        password: decodeURIComponent(pg.password),
        ssh: { srv: { privateKey: fixture('openssh-ed25519') } },
      },
    })
    await reopen(page, `/resources/${resource.id}`)

    await test.step('not trusted yet: Test connection shows the key it presented', async () => {
      await page.getByRole('button', { name: 'Test connection' }).click()
      const step = page.getByTestId('ssh-step-srv')
      await expect(step).toContainText(`SSH server ${ssh.host}:${ssh.port}`)
      await expect(step.getByTestId('ssh-presented-key')).toHaveText(ssh.hostKey.fingerprint)
      await expect(page.getByText(/Connected/)).toHaveCount(0)
    })

    await test.step('trusted: tried again, it reaches the database through the tunnel', async () => {
      await page.getByRole('button', { name: 'Trust this key' }).click()
      await expect(page.getByTestId('ssh-step-srv')).toContainText('Host key trusted')
      await expect(page.getByText(/Connected · PostgreSQL/)).toBeVisible()
      await expect(page.getByText('Save to keep the trusted host key.')).toBeVisible()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('Saved.')).toBeVisible()
      await reopen(page)
      await expect(page.getByTestId('ssh-host-key')).toContainText(ssh.hostKey.fingerprint)
      const run = await trpcMutate<{ ok: boolean; data: unknown }>(page, 'resources.run', {
        resourceId: resource.id,
        environmentId,
        query: { sql: 'select count(*)::int as n from customers' },
      })
      expect(run).toMatchObject({ ok: true, data: [{ n: 2 }] })
      expect(ssh.forwards.at(-1)).toMatchObject({ host: 'db.internal', allowed: true })
    })

    await test.step('a changed host key is a warning, with both fingerprints', async () => {
      const other = {
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK',
      }
      await trpcMutate(page, 'resources.saveConfig', {
        resourceId: resource.id,
        environmentId,
        config: config(other),
      })
      await reopen(page)
      await page.getByRole('button', { name: 'Test connection' }).click()
      const step = page.getByTestId('ssh-step-srv')
      await expect(step).toContainText("This server's host key changed")
      await expect(step).toContainText(other.fingerprint)
      await expect(step.getByTestId('ssh-presented-key')).toHaveText(ssh.hostKey.fingerprint)
      await expect(step.getByRole('button', { name: 'Trust the new key' })).toBeVisible()
    })
  } finally {
    await ssh.close()
  }
})
