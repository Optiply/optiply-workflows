import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * Custom auth flows in the browser: request steps with a multipart body, and the sign-in card (signed in, Sign in now,
 * the last failure, Sign out) against a small sign-in API started here.
 */
// Resource names sort after "Shop DB": the workflow editor offers the first resource by name for a new query, and
// editor.spec.ts (which runs after this file) expects that to be global-setup's Shop DB.
let api: Server
let origin: string
let password = 'Right-Pass-123'

test.beforeAll(async () => {
  api = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/login') {
      if (JSON.parse(body || '{}').password !== password) {
        res.writeHead(401)
        return res.end(JSON.stringify({ error: 'bad credentials' }))
      }
      return res.end(JSON.stringify({ session: 'session-from-login' }))
    }
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  await new Promise((r) => api?.close(r))
})

const flowConfig = () => ({
  baseUrl: `${origin}/api`,
  allowPrivateNetwork: true,
  headers: [{ key: 'x-session', value: '{{ auth.session }}' }],
  auth: {
    type: 'custom',
    steps: [
      {
        type: 'request',
        name: 'login',
        method: 'POST',
        path: 'login',
        body: { type: 'json', json: '{"password": {{ secrets.password }}}' },
      },
      { type: 'variable', name: 'session', value: '{{ login.data.session }}' },
    ],
    ttlSeconds: 3600,
  },
})

async function flowResource(page: Parameters<typeof signIn>[0], secret: string) {
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Sign-in partner API',
    slug: `partner_${Date.now().toString(36)}`,
  })
  const environments = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  const environmentId = environments.find((e) => e.slug === 'production')!.id
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId,
    config: flowConfig(),
    secrets: { values: { password: secret } },
  })
  return { ...resource, environmentId }
}

test('a request step can send a multipart body', async ({ page }) => {
  await signIn(page)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Sign-in multipart',
    slug: `multipart_${Date.now().toString(36)}`,
  })
  await page.goto(`/resources/${resource.id}`)
  await page.getByRole('combobox', { name: 'Authentication' }).selectOption('custom')
  await page.getByRole('button', { name: 'Sign-in request' }).click()
  await page.getByRole('combobox', { name: 'Sign-in step 1 body' }).selectOption('multipart')
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('Part name').fill('username')
  await page.getByLabel('Part value').fill('{{ secrets.username }}')
  await expect(page.getByLabel('Part value')).toHaveValue('{{ secrets.username }}')
})

test('the sign-in card signs in now, shows the last failure and signs out', async ({ page }) => {
  password = 'Right-Pass-123'
  await signIn(page)
  const resource = await flowResource(page, 'Right-Pass-123')
  await page.goto(`/resources/${resource.id}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const card = page.getByRole('region', { name: 'Sign-in status' })
  await expect(card).toContainText('Not signed in')
  await expect(card).toContainText('auth.session')

  await card.getByRole('button', { name: 'Sign in now' }).click()
  await expect(card).toContainText('Signed in.')
  await expect(card.getByText('Signed in', { exact: true })).toBeVisible()
  await expect(card).toContainText('Signs in again')

  // The password changes at the provider: Sign in now fails, the variables stay in use, the card says why.
  password = 'Changed-Pass-456'
  await card.getByRole('button', { name: 'Sign in now' }).click()
  await expect(card).toContainText('The last sign-in failed: Signing in failed at step "login": HTTP 401')
  await expect(card.getByText('Signed in', { exact: true })).toBeVisible()

  await card.getByRole('button', { name: 'Sign out' }).click()
  await page.getByTestId('confirm-ok').click()
  await expect(card).toContainText('Not signed in')
  await expect(card.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
})

/** A flow asking each person for their own details: a form, the API's login with what they typed, the session. */
const formConfig = () => ({
  ...flowConfig(),
  auth: {
    type: 'custom',
    steps: [
      {
        type: 'form',
        name: 'signin',
        title: 'Sign in with your Partner account',
        fields: [
          { name: 'username', label: 'Username', kind: 'text' },
          { name: 'password', label: 'Password', kind: 'password' },
        ],
      },
      {
        type: 'request',
        name: 'login',
        method: 'POST',
        path: 'login',
        body: { type: 'json', json: '{"user": {{ signin.username }}, "password": {{ signin.password }}}' },
      },
      { type: 'variable', name: 'session', value: '{{ login.data.session }}' },
    ],
  },
})

async function formResource(page: Parameters<typeof signIn>[0]) {
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Sign-in portal',
    slug: `portal_${Date.now().toString(36)}`,
  })
  const environments = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId: environments.find((e) => e.slug === 'production')!.id,
    config: formConfig(),
    secrets: { values: {} },
  })
  return resource
}

test('a form step can be added to the sign-in steps, not the refresh steps', async ({ page }) => {
  await signIn(page)
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Sign-in form flow',
    slug: `formflow_${Date.now().toString(36)}`,
  })
  await page.goto(`/resources/${resource.id}`)
  await page.getByRole('combobox', { name: 'Authentication' }).selectOption('custom')
  await page.getByRole('button', { name: 'Sign-in form' }).click()
  await expect(page.getByLabel('Sign-in step 1 field 1 name')).toHaveValue('username')
  await expect(page.getByLabel('Sign-in step 1 field 2 kind')).toHaveValue('password')
  await page.getByLabel('Sign-in step 1 title').fill('Sign in with your Acme account')
  await expect(page.getByRole('button', { name: 'Refresh form' })).toHaveCount(0)
})

test('each person signs in with the form: from the card, and when a query asks', async ({ page }) => {
  password = 'Right-Pass-123'
  await signIn(page)
  const resource = await formResource(page)
  await page.goto(`/resources/${resource.id}`)

  // A query asks for the sign-in, and signing in from there lets it run.
  await page.getByRole('button', { name: 'Run' }).click()
  const note = page.getByRole('alert').filter({ hasText: 'Sign in to this resource with your own details' })
  await expect(note).toBeVisible()
  await note.getByRole('button', { name: 'Sign in' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Sign in to Sign-in portal')
  await expect(dialog).toContainText('Sign in with your Partner account')
  await dialog.getByLabel('Username').fill('ada')
  await dialog.getByLabel('Password').fill('Wrong-Pass-000')
  await dialog.getByRole('button', { name: 'Sign in' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Signing in failed at step "login": HTTP 401')
  await expect(dialog).not.toContainText('Wrong-Pass-000')
  // Wait out the back-off a failed attempt starts (5 s), then the right password.
  await page.waitForTimeout(5500)
  await dialog.getByLabel('Password').fill('Right-Pass-123')
  await dialog.getByRole('button', { name: 'Sign in' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(note).toHaveCount(0)

  // The card: your own sign-in, how many people signed in, and signing out.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const card = page.getByRole('region', { name: 'Sign-in status' })
  await expect(card.getByRole('heading', { name: 'Your sign-in' })).toBeVisible()
  await expect(card.getByText('Signed in', { exact: true })).toBeVisible()
  await expect(card).toContainText('1 person has signed in here.')
  await card.getByRole('button', { name: 'Sign out' }).click()
  await page.getByTestId('confirm-ok').click()
  await expect(card).toContainText('You haven’t signed in here yet.')
  await card.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Username').fill('ada')
  await page.getByRole('dialog').getByLabel('Password').fill('Right-Pass-123')
  await page.getByRole('dialog').getByLabel('Password').press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(card).toContainText('Signed in.')
})
