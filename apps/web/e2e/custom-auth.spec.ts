import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * Custom auth flows in the browser: request steps with a multipart body, and the sign-in card (signed in, Sign in now,
 * the last failure, Sign out) against a small sign-in API started here.
 */
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
    name: 'Partner API',
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
    name: 'Multipart flow',
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
