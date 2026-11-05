/**
 * M9's done-when, in the browser against a fake OAuth provider and API:
 * - a REST resource connected with the authorization code runs queries from the playground, a workflow (a draft
 *   run and a scheduled live run) and an app; an expired token refreshes on its own; a revoked one asks for a
 *   reconnect, which fixes it;
 * - a per-user resource uses each viewer's own account in an app;
 * - a custom auth flow (login request → token, refreshed once on a 401) works the same way.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, expect, type Page, test } from '@playwright/test'
import { E2E_SECOND_EMAIL } from './global-setup'
import { signIn, trpcMutate } from './helpers'

test.describe.configure({ mode: 'serial' })

/** Each attempt (CI retries once) gets its own slugs. */
const tag = () => Math.random().toString(36).slice(2, 7)

// The provider: authorization server, API and a legacy login-based API in one.
let server: Server
let origin: string
/** Who the provider signs in as at its (instant) consent screen. */
let consentAs = 'ada'
const codes = new Map<string, { who: string; challenge: string | null; redirectUri: string }>()
const accessTokens = new Map<string, string>()
const refreshTokens = new Map<string, string>()
const grants: string[] = []
const legacySessions = new Set<string>()
const legacyCalls: string[] = []
let issued = 0
/** Tokens revoked through /revoke (RFC 7009), by Disconnect. */
const revokedTokens: string[] = []

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    switch (url.pathname) {
      case '/authorize': {
        const code = `code-${++issued}`
        codes.set(code, {
          who: consentAs,
          challenge: url.searchParams.get('code_challenge'),
          redirectUri: url.searchParams.get('redirect_uri')!,
        })
        const back = new URL(url.searchParams.get('redirect_uri')!)
        back.searchParams.set('code', code)
        back.searchParams.set('state', url.searchParams.get('state')!)
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      case '/token': {
        const form = new URLSearchParams(body)
        grants.push(form.get('grant_type')!)
        if (form.get('client_secret') !== 'crm-secret') return send(401, { error: 'invalid_client' })
        let who: string | undefined
        if (form.get('grant_type') === 'authorization_code') {
          const grant = codes.get(form.get('code')!)
          codes.delete(form.get('code')!)
          const verifier = form.get('code_verifier') ?? ''
          const pkce =
            !grant?.challenge || createHash('sha256').update(verifier).digest('base64url') === grant.challenge
          if (grant && pkce && grant.redirectUri === form.get('redirect_uri')) who = grant.who
        } else {
          who = refreshTokens.get(form.get('refresh_token')!)
          refreshTokens.delete(form.get('refresh_token')!)
        }
        if (!who) return send(400, { error: 'invalid_grant' })
        const access = `at-${++issued}`
        accessTokens.set(access, who)
        refreshTokens.set(`rt-${issued}`, who)
        const idToken = `e30.${Buffer.from(JSON.stringify({ email: `${who}@optiply.nl` })).toString('base64url')}.x`
        return send(200, {
          access_token: access,
          refresh_token: `rt-${issued}`,
          expires_in: 3600,
          id_token: idToken,
        })
      }
      case '/revoke': {
        const form = new URLSearchParams(body)
        if (form.get('client_secret') !== 'crm-secret') return send(401, { error: 'invalid_client' })
        revokedTokens.push(form.get('token')!)
        refreshTokens.delete(form.get('token')!)
        return send(200, {})
      }
      case '/api/me': {
        const who = accessTokens.get((req.headers.authorization ?? '').replace('Bearer ', ''))
        return who ? send(200, { who }) : send(401, { error: 'invalid_token' })
      }
      case '/legacy/login': {
        legacyCalls.push('login')
        const { user, password } = JSON.parse(body || '{}')
        if (user !== 'svc' || password !== 'legacy-pw') return send(401, { error: 'bad login' })
        const session = `sess-${++issued}`
        legacySessions.add(session)
        return send(200, { session })
      }
      case '/legacy/refresh': {
        legacyCalls.push('refresh')
        const { session } = JSON.parse(body || '{}')
        if (!session) return send(401, {})
        const renewed = `sess-${++issued}`
        legacySessions.add(renewed)
        return send(200, { session: renewed })
      }
      case '/legacy/orders': {
        legacyCalls.push('orders')
        return legacySessions.has(String(req.headers['x-session']))
          ? send(200, { orders: 3 })
          : send(401, { error: 'session expired' })
      }
      default:
        return send(404, {})
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => new Promise<void>((r) => server.close(() => r())))

async function environmentId(page: Page) {
  const res = await page.request.get('/api/trpc/environments.list')
  return ((await res.json()).result.data.json as { id: string; slug: string }[]).find(
    (e) => e.slug === 'production',
  )!.id
}

/** Runs SQL on the platform's own database through the seeded `shop_db` resource (it connects as the owner). */
async function platformSql(page: Page, sql: string) {
  const list = await page.request.get('/api/trpc/resources.list')
  const shop = (await list.json()).result.data.json.resources.find(
    (r: { slug: string }) => r.slug === 'shop_db',
  )
  const result = await trpcMutate<{ ok: boolean }>(page, 'resources.run', {
    resourceId: shop.id,
    environmentId: await environmentId(page),
    query: { sql },
  })
  expect(result.ok, sql).toBe(true)
}

/** Clicks a button that opens the sign-in popup, and waits for the popup to finish and close. */
async function connectThroughPopup(page: Page, button: string) {
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: button, exact: true }).click()
  await (await popup).waitForEvent('close')
}

async function runPlayground(page: Page, path: string) {
  await page.getByRole('button', { name: 'Query', exact: true }).click()
  await page.getByPlaceholder('/orders/{{ id }}').fill(path)
  await page.getByRole('button', { name: 'Run', exact: true }).click()
}

type RunSummary = { id: string; triggerType: string; workflow: { slug: string } }

/** Waits for the first run `find` picks to finish, and returns it. */
async function waitForRun(page: Page, find: (run: RunSummary) => boolean) {
  let found: { id: string } | undefined
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/v1/runs?limit=50')
        found = (await res.json()).runs.find(find)
        if (!found) return 'none'
        const run = await (await page.request.get(`/api/v1/runs/${found.id}`)).json()
        return run.run.status
      },
      { timeout: 30_000 },
    )
    .toMatch(/succeeded|failed/)
  return (await (await page.request.get(`/api/v1/runs/${found!.id}`)).json()).run
}

test('an OAuth resource in the playground, a draft and a scheduled run, and an app; refresh and reconnect', async ({
  page,
}) => {
  await signIn(page)
  const t = tag()

  // Set up and connect through the UI.
  const crm = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'CRM',
    slug: `crm_${t}`,
  })
  await page.goto(`/resources/${crm.id}`)
  await page.getByRole('textbox', { name: 'Base URL' }).fill(`${origin}/api`)
  await page.getByRole('combobox', { name: 'Authentication' }).selectOption('oauth2AuthorizationCode')
  await page.getByRole('textbox', { name: 'Authorization URL' }).fill(`${origin}/authorize`)
  await page.getByRole('textbox', { name: 'Token URL' }).fill(`${origin}/token`)
  await page.getByRole('textbox', { name: 'Revocation URL' }).fill(`${origin}/revoke`)
  await page.getByRole('textbox', { name: 'Client ID' }).fill('crm-client')
  await page.getByLabel('Client secret', { exact: true }).fill('crm-secret')
  await page.getByRole('textbox', { name: /Scopes/ }).fill('contacts')
  await page.getByText('Allow private network addresses').click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByText('Not connected')).toBeVisible()
  consentAs = 'ada'
  await connectThroughPopup(page, 'Connect account')
  await expect(page.getByText('ada@optiply.nl', { exact: true })).toBeVisible()

  // The playground.
  await runPlayground(page, 'me')
  await expect(page.getByText('"ada"')).toBeVisible()

  // A workflow: a draft run, then a scheduled run of its release (nobody behind it: the shared account).
  const wf = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `crm-sync-${t}`,
    name: 'CRM sync',
  })
  const saved = await trpcMutate<{ revision: number }>(page, 'workflows.saveDraft', {
    id: wf.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [
        { name: 'startTrigger', type: 'startTrigger' },
        { name: 'me', type: 'resourceQuery', config: { resource: `crm_${t}`, query: { path: 'me' } } },
        { name: 'reply', type: 'response', config: { status: '200', body: '{{ me.data }}' } },
      ],
      edges: [
        { from: 'startTrigger', port: 'out', to: 'me' },
        { from: 'me', port: 'out', to: 'reply' },
      ],
      triggers: { schedules: [{ name: 'every-minute', intervalMs: 60_000, enabled: true }] },
    },
  })
  const draft = await page.request.post(`/api/v1/workflows/crm-sync-${t}/runs?environment=production`, {
    data: { input: {} },
  })
  expect(draft.status()).toBe(202)
  const draftId = (await draft.json()).run.id as string
  const draftRun = await waitForRun(page, (r) => r.id === draftId)
  expect(draftRun).toMatchObject({ status: 'succeeded', response: { body: { who: 'ada' } } })

  await trpcMutate(page, 'releases.publish', { workflowId: wf.id, draftRevision: saved.revision })
  // Due now, rather than in a minute.
  await platformSql(page, `update workflow_triggers set next_fire_at = now() where workflow_id = '${wf.id}'`)
  const scheduled = await waitForRun(
    page,
    (r) => r.triggerType === 'schedule' && r.workflow.slug === `crm-sync-${t}`,
  )
  expect(scheduled).toMatchObject({ status: 'succeeded', response: { body: { who: 'ada' } } })

  // An app.
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug: `crm-app-${t}`, name: 'CRM app' })
  const appDraft = await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'who', type: 'text', props: { value: 'Account: {{ me.data?.who ?? "none" }}' } }],
      queries: [{ name: 'me', kind: 'resource', resource: `crm_${t}`, query: { path: 'me' }, run: 'auto' }],
      layout: { who: { x: 0, y: 0, w: 6, h: 2 } },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: appDraft.revision })
  await page.goto(`/apps/crm-app-${t}`)
  await expect(page.getByText('Account: ada')).toBeVisible()

  // The token expires: the next query refreshes it on its own.
  const refreshesBefore = grants.filter((g) => g === 'refresh_token').length
  await platformSql(
    page,
    `update oauth_tokens set expires_at = now() - interval '1 minute' where resource_config_id in (select id from resource_configs where resource_id = '${crm.id}')`,
  )
  await page.goto(`/resources/${crm.id}`)
  await runPlayground(page, 'me')
  await expect(page.getByText('"ada"')).toBeVisible()
  expect(grants.filter((g) => g === 'refresh_token').length).toBe(refreshesBefore + 1)

  // The provider revokes everything: the playground asks for a reconnect; reconnecting fixes it.
  accessTokens.clear()
  refreshTokens.clear()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(
    page.getByText(/must be connected again: the provider no longer accepts it \(invalid_grant\)/),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Open the resource’s settings' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByText('Needs reconnecting')).toBeVisible()
  await connectThroughPopup(page, 'Reconnect')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await runPlayground(page, 'me')
  await expect(page.getByText('"ada"')).toBeVisible()

  // Disconnect revokes the refresh token at the provider (session 40), then forgets the account.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Disconnected, and revoked at the provider.')).toBeVisible()
  await expect(page.getByText('Not connected')).toBeVisible()
  expect(revokedTokens).toEqual([expect.stringMatching(/^rt-\d+$/)])
})

test("a per-user resource uses each viewer's own account in an app", async ({ page, browser }) => {
  await signIn(page)
  const t = tag()
  const prod = await environmentId(page)
  const mail = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Mail',
    slug: `mail_${t}`,
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: mail.id,
    environmentId: prod,
    config: {
      baseUrl: `${origin}/api`,
      allowPrivateNetwork: true,
      auth: {
        type: 'oauth2AuthorizationCode',
        authorizeUrl: `${origin}/authorize`,
        tokenUrl: `${origin}/token`,
        clientId: 'mail-client',
        tokens: 'perUser',
      },
    },
    secrets: { clientSecret: 'crm-secret' },
  })
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug: `inbox-${t}`, name: 'Inbox' })
  const draft = await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'who', type: 'text', props: { value: 'Mailbox: {{ me.data?.who ?? "none" }}' } }],
      queries: [{ name: 'me', kind: 'resource', resource: `mail_${t}`, query: { path: 'me' }, run: 'auto' }],
      layout: { who: { x: 0, y: 0, w: 6, h: 2 } },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: draft.revision })

  async function viewAs(viewer: Page, who: string) {
    await viewer.goto(`/apps/inbox-${t}`)
    await expect(viewer.getByText(/Query me: Connect your account/)).toBeVisible()
    await expect(viewer.getByText('Mailbox: none')).toBeVisible()
    consentAs = who
    await connectThroughPopup(viewer, 'Connect your account')
    await expect(viewer.getByText(`Mailbox: ${who}`)).toBeVisible()
  }
  await viewAs(page, 'ada')
  const second = await newViewer(browser)
  await viewAs(second, 'grace')
  // Each keeps their own.
  await page.reload()
  await expect(page.getByText('Mailbox: ada')).toBeVisible()
  await second.reload()
  await expect(second.getByText('Mailbox: grace')).toBeVisible()
  await second.context().close()
})

async function newViewer(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, E2E_SECOND_EMAIL)
  return page
}

test('a custom auth flow signs in, and refreshes once on a 401', async ({ page }) => {
  await signIn(page)
  const t = tag()
  const legacy = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Legacy ERP',
    slug: `legacy_${t}`,
  })
  await page.goto(`/resources/${legacy.id}`)
  await page.getByRole('textbox', { name: 'Base URL' }).fill(`${origin}/legacy`)
  await page.getByRole('combobox', { name: 'Authentication' }).selectOption('custom')

  // Secret values for the steps.
  for (const [name, value] of [
    ['user', 'svc'],
    ['password', 'legacy-pw'],
  ] as const) {
    await page.getByPlaceholder('password', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Add secret value' }).click()
    await page.getByPlaceholder('Not set').last().fill(value)
  }

  // Sign in: POST login with the secrets, keep the session.
  await page.getByRole('button', { name: 'Sign-in request' }).click()
  await page.getByRole('textbox', { name: 'Sign-in step 1 path' }).fill('login')
  await page
    .getByRole('textbox', { name: 'Sign-in step 1 JSON body' })
    .fill('{"user": {{ secrets.user }}, "password": {{ secrets.password }}}')
  await page.getByRole('button', { name: 'Sign-in variable' }).click()
  await page.getByRole('textbox', { name: 'Sign-in step 2 name' }).fill('session')
  await page.getByRole('textbox', { name: 'Sign-in step 2 value' }).fill('{{ login.data.session }}')

  // Refresh: POST refresh with the current session, keep the new one.
  await page.getByRole('button', { name: 'Refresh request' }).click()
  await page.getByRole('textbox', { name: 'Refresh step 1 name' }).fill('renew')
  await page.getByRole('textbox', { name: 'Refresh step 1 path' }).fill('refresh')
  await page
    .getByRole('textbox', { name: 'Refresh step 1 JSON body' })
    .fill('{"session": {{ auth.session }}}')
  await page.getByRole('button', { name: 'Refresh variable' }).click()
  await page.getByRole('textbox', { name: 'Refresh step 2 name' }).fill('session')
  await page.getByRole('textbox', { name: 'Refresh step 2 value' }).fill('{{ renew.data.session }}')

  // The API takes the session in a header.
  // The resource's own Headers field (its Add button takes the field's label as its name).
  await page.getByRole('button', { name: /^Headers Sent with every request/ }).click()
  await page.getByPlaceholder('Header').first().fill('X-Session')
  await page.getByPlaceholder('Value').first().fill('{{ auth.session }}')
  await page.getByText('Allow private network addresses').click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  // Querying signs in once.
  legacyCalls.length = 0
  await runPlayground(page, 'orders')
  await expect(page.getByText('"orders"')).toBeVisible()
  expect(legacyCalls).toEqual(['login', 'orders'])

  // The API ends the session: one refresh, then the request is retried.
  legacySessions.clear()
  legacyCalls.length = 0
  // (The earlier run's Success badge is still showing: wait for this run's answer.)
  const answered = page.waitForResponse((r) => r.url().includes('/api/trpc/resources.run'))
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await answered
  await expect(page.getByText('"orders"')).toBeVisible()
  expect(legacyCalls).toEqual(['orders', 'refresh', 'orders'])
})
