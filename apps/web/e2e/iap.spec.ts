import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { E2E_IAP_VM, E2E_MEMBER_EMAIL } from './global-setup'
import { signIn, trpcMutate } from './helpers'

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
