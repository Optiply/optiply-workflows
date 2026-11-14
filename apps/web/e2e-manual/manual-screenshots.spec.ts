import { fileURLToPath } from 'node:url'
import { type Browser, expect, type Locator, type Page, test } from '@playwright/test'
import { E2E_PASSWORD } from '../e2e/global-setup'
import { block, canvasSettled, openEditorPanel, openRail, trpcMutate, trpcQuery } from '../e2e/helpers'
import { type Demo, dashboardDefinition, PEOPLE, seed, seedDatabase } from './demo-data'

/**
 * The manuals' screenshots (docs/manuals/SCREENSHOTS.md is the contract: the names and what each shows). Fills the
 * e2e's throwaway server with demo data (./demo-data.ts) and saves each screenshot to docs/manuals/images/<name>.png.
 * From apps/web, after a fresh build: `npx playwright test -c playwright.manual.config.ts`.
 * `SHOTS=login,apps-list` takes only those (the demo data is made all the same).
 */

const OUT = fileURLToPath(new URL('../../../docs/manuals/images/', import.meta.url))
const ONLY = process.env.SHOTS?.split(',').filter(Boolean)
const VIEWPORT = { width: 1440, height: 900 }

/** Waits for the page to be still: no pending requests, no spinners, fonts loaded. */
async function settle(page: Page, ms = 500) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await expect(page.locator('.animate-spin'))
    .toHaveCount(0, { timeout: 10_000 })
    .catch(() => {})
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(ms)
}

/** The whole page, an element, or a padded box around an element (kept inside the viewport). */
type Target = Page | Locator | { clip: Locator; to?: Locator; pad?: number }

async function save(page: Page, name: string, target: Target = page) {
  const path = `${OUT}${name}.png`
  if ('clip' in target) {
    const box = await target.clip.boundingBox()
    if (!box) throw new Error(`${name}: nothing to clip`)
    // Down to the bottom of `to` when given (a panel taller than what's worth showing).
    const end = target.to && (await target.to.boundingBox())
    if (end) box.height = end.y + end.height - box.y
    const pad = target.pad ?? 12
    const vp = page.viewportSize() ?? VIEWPORT
    const x = Math.max(0, box.x - pad)
    const y = Math.max(0, box.y - pad)
    await page.screenshot({
      path,
      animations: 'disabled',
      caret: 'hide',
      clip: {
        x,
        y,
        width: Math.min(vp.width - x, box.x + box.width + pad - x),
        height: Math.min(vp.height - y, box.y + box.height + pad - y),
      },
    })
  } else {
    await target.screenshot({ path, animations: 'disabled', caret: 'hide' })
  }
}

const failures: string[] = []

/** One screenshot as a step: a failure is noted and the tour goes on (the test fails at the end, naming them). */
async function shot(page: Page, name: string, take: () => Promise<void>) {
  if (ONLY && !ONLY.includes(name)) return
  await test.step(name, async () => {
    try {
      await take()
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message.split('\n')[0]}`)
      await page.screenshot({ path: test.info().outputPath(`failed-${name}.png`) }).catch(() => {})
    } finally {
      await page.keyboard.press('Escape').catch(() => {})
      await page.setViewportSize(VIEWPORT)
    }
  })
}

async function signInAs(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** A fresh, signed-out browser at the tour's size. */
async function freshPage(browser: Browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' })
  return { p: await ctx.newPage(), close: () => ctx.close() }
}

/**
 * The test server's address (http://127.0.0.1:<port>) shown as a production one would be, in the page's text and
 * fields: the manuals shouldn't show a developer's machine.
 */
async function publicUrls(page: Page) {
  await page.evaluate((origin) => {
    const shown = 'https://workflows.example.com'
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue?.includes(origin)) n.nodeValue = n.nodeValue.replaceAll(origin, shown)
    }
    for (const input of document.querySelectorAll('input, textarea')) {
      const el = input as HTMLInputElement
      if (el.value.includes(origin)) el.value = el.value.replaceAll(origin, shown)
    }
  }, new URL(page.url()).origin)
}

/** A button-like tab by its label (the app's Tabs are buttons). */
const tabButton = (scope: Page | Locator, name: string) => scope.getByRole('button', { name, exact: true })

test('manual screenshots', async ({ page, browser }) => {
  let demo!: Demo
  await test.step('demo data', async () => {
    await seedDatabase()
    await signInAs(page, PEOPLE.admin.email)
    demo = await seed(page)
  })

  /** The workflow editor, fitted, with no rail panel open (the editor remembers the last one). */
  const editor = async (id: string, search = '') => {
    await page.setViewportSize(VIEWPORT)
    await page.goto(`/workflows/${id}${search}`)
    await expect(page.getByTestId('canvas')).toBeVisible()
    const open = page.locator('[data-testid^="rail-"][aria-pressed="true"]')
    if (await open.count()) await open.first().click()
    await page
      .locator('.react-flow__controls-fitview')
      .click()
      .catch(() => {})
    await canvasSettled(page)
    await settle(page)
  }
  /** One block, centred at 100 % with the panels closed (in a tall window, so a long block fits). */
  const focusBlock = async (name: string) => {
    await page.setViewportSize({ width: VIEWPORT.width, height: 2400 })
    const outline = await openRail(page, 'outline')
    await outline.getByRole('button', { name, exact: true }).click()
    await page.getByTestId('rail-outline').click()
    await canvasSettled(page)
    await page.getByTestId('zoom-level').click()
    await canvasSettled(page)
    await block(page, name).click({ position: { x: 60, y: 10 } })
    await settle(page, 300)
    return block(page, name)
  }
  /** Puts the Supplier dashboard's draft back (or to `definition`). */
  const resetDashboard = async (definition: object = dashboardDefinition()) => {
    const app = await trpcQuery<{ id: string; draftRevision: number }>(page, 'apps.get', {
      slug: 'supplier-dashboard',
    })
    await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: app.draftRevision, definition })
  }
  /** The app editor, its canvas loaded. */
  const appEditor = async (slug: string) => {
    await page.goto(`/apps/${slug}/edit`)
    await expect(page.getByTestId('frame-stockTable')).toBeVisible()
    await settle(page, 800)
  }

  // ── Getting started ─────────────────────────────────────────────────────────────────────────────────────────────
  await shot(page, 'login', async () => {
    const { p, close } = await freshPage(browser)
    // Production signs in with Google only (no local login): the page as it shows there.
    await p.route('**/api/trpc/**', async (route) => {
      if (!route.request().url().includes('authConfig')) return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      const patch = (r: { result?: { data?: { json?: Record<string, unknown> } } }) => {
        if (r.result?.data?.json && 'oidcEnabled' in r.result.data.json) {
          r.result.data.json = { ...r.result.data.json, oidcEnabled: true, localLoginEnabled: false }
        }
      }
      if (Array.isArray(body)) body.forEach(patch)
      else patch(body)
      await route.fulfill({ response: res, json: body })
    })
    await p.goto('/login')
    await expect(p.getByText('Continue with Google')).toBeVisible()
    await settle(p)
    await save(p, 'login', p)
    await close()
  })
  await shot(page, 'waiting-approval', async () => {
    const { p, close } = await freshPage(browser)
    await p.route('**/api/trpc/**', async (route) => {
      if (!route.request().url().includes('authConfig')) return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      for (const r of Array.isArray(body) ? body : [body]) {
        if (r.result?.data?.json && 'oidcEnabled' in r.result.data.json) {
          r.result.data.json = { ...r.result.data.json, oidcEnabled: true, localLoginEnabled: false }
        }
      }
      await route.fulfill({ response: res, json: body })
    })
    // Where a first Google sign-in lands someone new.
    await p.goto('/login?pending=1')
    await expect(p.getByTestId('pending-approval')).toBeVisible()
    await settle(p)
    await save(p, 'waiting-approval', p)
    await close()
  })
  await shot(page, 'home-sidebar', async () => {
    await page.goto('/workflows')
    await settle(page)
    await save(page, 'home-sidebar')
  })
  await shot(page, 'command-palette', async () => {
    await page.goto('/workflows')
    await settle(page)
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('overstock')
    await settle(page, 400)
    await save(page, 'command-palette')
  })

  // ── Workflows ───────────────────────────────────────────────────────────────────────────────────────────────────
  await shot(page, 'workflows-list', async () => {
    await page.goto('/workflows')
    await settle(page)
    await save(page, 'workflows-list')
  })
  await shot(page, 'workflow-new', async () => {
    await page.goto('/workflows')
    await settle(page)
    await page.getByRole('button', { name: 'New workflow' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('Sync orders').fill('Notify late deliveries')
    await settle(page, 400)
    await save(page, 'workflow-new', { clip: dialog })
  })
  await shot(page, 'workflow-import', async () => {
    await page.goto('/workflows')
    await settle(page)
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    await settle(page, 400)
    await save(page, 'workflow-import', { clip: page.getByRole('dialog') })
  })
  await shot(page, 'workflow-editor', async () => {
    await editor(demo.workflows.overstock)
    await save(page, 'workflow-editor')
  })
  await shot(page, 'workflow-add-block', async () => {
    await editor(demo.workflows.overstock)
    await block(page, 'reply').click({ position: { x: 60, y: 10 } })
    await openRail(page, 'blocks')
    await settle(page)
    await save(page, 'workflow-add-block')
  })
  await shot(page, 'workflow-block-code', async () => {
    await editor(demo.workflows.overstock)
    await save(page, 'workflow-block-code', { clip: await focusBlock('formatMessage'), pad: 24 })
  })
  await shot(page, 'workflow-block-query', async () => {
    await editor(demo.workflows.overstock)
    await save(page, 'workflow-block-query', { clip: await focusBlock('getStock'), pad: 24 })
  })
  await shot(page, 'workflow-block-branch', async () => {
    await editor(demo.workflows.overstock)
    await save(page, 'workflow-block-branch', { clip: await focusBlock('anyOverstock'), pad: 24 })
  })
  await shot(page, 'workflow-block-python', async () => {
    await editor(demo.workflows.report)
    await save(page, 'workflow-block-python', { clip: await focusBlock('summarise'), pad: 24 })
  })
  await shot(page, 'workflow-block-loop', async () => {
    await editor(demo.workflows.report)
    await save(page, 'workflow-block-loop', { clip: await focusBlock('perSupplier'), pad: 24 })
  })
  await shot(page, 'workflow-block-task', async () => {
    await editor(demo.workflows.approve)
    await save(page, 'workflow-block-task', { clip: await focusBlock('approval'), pad: 24 })
  })
  /** The Triggers panel in a tall window (webhook and schedules both in view). */
  const triggersPanel = async () => {
    await editor(demo.workflows.overstock)
    await page.setViewportSize({ width: VIEWPORT.width, height: 2400 })
    await openRail(page, 'triggers')
    await expect(page.getByTestId('schedule-triggers')).toBeVisible()
    await settle(page)
    await publicUrls(page)
    return page.getByTestId('rail-panel')
  }
  await shot(page, 'workflow-triggers', async () => {
    const panel = await triggersPanel()
    await save(page, 'workflow-triggers', { clip: panel, to: page.getByTestId('schedule-triggers'), pad: 12 })
  })
  await shot(page, 'workflow-webhook', async () => {
    await triggersPanel()
    await save(page, 'workflow-webhook', { clip: page.getByTestId('webhook-trigger'), pad: 16 })
  })
  await shot(page, 'workflow-schedule', async () => {
    await triggersPanel()
    await save(page, 'workflow-schedule', { clip: page.getByTestId('schedule-triggers'), pad: 16 })
  })
  await shot(page, 'workflow-run-panel', async () => {
    await editor(demo.workflows.overstock)
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 60_000 })
    await page
      .getByTestId('run-blocks')
      .getByRole('button', { name: /getStock/ })
      .click()
    await settle(page)
    await save(page, 'workflow-run-panel')
  })
  await shot(page, 'workflow-run-logs', async () => {
    const panel = page.getByTestId('run-panel')
    if (!(await panel.isVisible())) {
      await editor(demo.workflows.overstock)
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded', { timeout: 60_000 })
    }
    await page
      .getByTestId('run-blocks')
      .getByRole('button', { name: /formatMessage/ })
      .click()
    await panel.getByRole('button', { name: 'logs', exact: true }).click()
    await expect(panel.getByTestId('run-logs')).toBeVisible()
    await settle(page)
    await save(page, 'workflow-run-logs')
  })
  await shot(page, 'workflow-publish', async () => {
    await editor(demo.workflows.overstock)
    await page.getByRole('button', { name: 'Release actions' }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await settle(page, 300)
    await save(page, 'workflow-publish')
  })
  await shot(page, 'workflow-access', async () => {
    await editor(demo.workflows.overstock)
    await page.getByRole('banner').getByTitle('Access').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await settle(page)
    await save(page, 'workflow-access', { clip: dialog })
  })
  await shot(page, 'workflow-settings', async () => {
    await editor(demo.workflows.overstock)
    await openRail(page, 'settings')
    await settle(page)
    await save(page, 'workflow-settings')
  })
  await shot(page, 'runs-list', async () => {
    await page.goto('/runs')
    await expect(page.getByTestId('runs-table')).toBeVisible()
    await settle(page)
    await save(page, 'runs-list')
  })
  await shot(page, 'run-detail', async () => {
    await page.goto('/runs')
    const row = page.getByTestId('runs-table').locator('tr', { hasText: 'Match supplier invoices' })
    await row.filter({ hasText: 'failed' }).first().getByRole('link').first().click()
    const panel = page.getByTestId('run-panel')
    await expect(panel).toBeVisible()
    await canvasSettled(page)
    await page.getByTestId('run-blocks').getByRole('button', { name: /match/ }).click()
    await settle(page)
    await save(page, 'run-detail')
  })
  await shot(page, 'inbox', async () => {
    await page.goto('/inbox')
    await expect(page.getByTestId('inbox-table')).toBeVisible()
    await settle(page)
    await save(page, 'inbox')
  })
  await shot(page, 'inbox-task', async () => {
    await page.goto('/inbox')
    await page.getByRole('link', { name: /Approve PO-2026-0412/ }).click()
    await expect(page.getByTestId('task-title')).toBeVisible()
    await page.getByLabel(/Note for the supplier/).fill('Please deliver before 1 December.')
    await settle(page)
    await save(page, 'inbox-task')
  })

  // ── Apps ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await shot(page, 'apps-list', async () => {
    await page.goto('/apps')
    await settle(page)
    await save(page, 'apps-list')
  })
  await shot(page, 'app-new', async () => {
    await page.goto('/apps')
    await settle(page)
    await page.getByRole('button', { name: 'New app' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').first().fill('Returns overview')
    await settle(page, 400)
    await save(page, 'app-new', { clip: dialog })
  })
  await shot(page, 'app-editor', async () => {
    await appEditor('supplier-dashboard')
    await page.getByTestId('frame-stockTable').click({ position: { x: 20, y: 8 } })
    await settle(page)
    await save(page, 'app-editor')
  })
  await shot(page, 'app-components', async () => {
    await appEditor('supplier-dashboard')
    await openEditorPanel(page, 'Add components')
    await settle(page)
    await save(page, 'app-components')
  })
  await shot(page, 'app-inspector', async () => {
    await appEditor('supplier-dashboard')
    await page.getByTestId('frame-stockTable').click({ position: { x: 20, y: 8 } })
    const inspector = page.getByTestId('inspector-stockTable')
    await expect(inspector).toBeVisible()
    await settle(page)
    await save(page, 'app-inspector')
  })
  await shot(page, 'app-query', async () => {
    await appEditor('supplier-dashboard')
    await openEditorPanel(page, 'Code')
    await page
      .getByRole('navigation', { name: 'Code' })
      .getByRole('button', { name: /^stockLevels/ })
      .click()
    await page.getByLabel('Code editor').getByRole('button', { name: 'Run', exact: true }).click()
    await settle(page, 1000)
    await save(page, 'app-query')
  })
  await shot(page, 'app-expressions', async () => {
    await appEditor('supplier-dashboard')
    await page.getByTestId('frame-summary').click({ position: { x: 20, y: 8 } })
    const field = page.getByTestId('inspector-summary').locator('[data-testid$="/props/value"]')
    await field.locator('.view-lines').click()
    await page.keyboard.press('ControlOrMeta+End')
    // An empty {{ }} and Ctrl+Space: everything an expression can read.
    await page.keyboard.type(' · {{ ')
    await page.keyboard.press('Control+Space')
    await expect(page.locator('.suggest-widget.visible')).toBeVisible()
    await settle(page, 400)
    await save(page, 'app-expressions')
    // The half-typed expression autosaves: the draft goes back as it was.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    await resetDashboard()
  })
  await shot(page, 'app-events', async () => {
    await appEditor('supplier-dashboard')
    // Its frame below the button: a click on the button itself would run its handlers.
    const frame = page.getByTestId('frame-refreshButton')
    const box = (await frame.boundingBox())!
    await frame.click({ position: { x: 8, y: box.height - 4 } })
    const inspector = page.getByTestId('inspector-refreshButton')
    const handler = inspector.getByTestId('handler-click-0')
    await handler.getByRole('button', { name: /on click/i }).click()
    await handler.scrollIntoViewIfNeeded()
    await settle(page)
    await save(page, 'app-events')
  })
  await shot(page, 'app-pages', async () => {
    await appEditor('supplier-dashboard')
    await openEditorPanel(page, 'Pages')
    await settle(page)
    await save(page, 'app-pages')
  })
  await shot(page, 'app-publish', async () => {
    // Something to publish: a line under the orders table.
    const def = dashboardDefinition()
    def.components.push({
      name: 'ordersNote',
      type: 'text',
      page: 'orders',
      props: { value: 'Orders above € 2,500 wait for a buyer in the Inbox.' },
    })
    Object.assign(def.layout, { ordersNote: { x: 0, y: 14, w: 12, h: 2 } })
    await resetDashboard(def)
    await appEditor('supplier-dashboard')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('textarea').fill('A note on the purchase orders page')
    await settle(page)
    await save(page, 'app-publish', { clip: dialog })
  })
  await shot(page, 'app-access', async () => {
    await appEditor('supplier-dashboard')
    await page.getByTitle('Access', { exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await settle(page)
    await save(page, 'app-access', { clip: dialog })
  })
  await shot(page, 'app-view', async () => {
    await page.goto('/apps/supplier-dashboard')
    await expect(page.getByRole('grid', { name: 'stockTable' })).toContainText('Bloom & Co')
    await settle(page, 800)
    await save(page, 'app-view')
  })

  // ── Reuse ───────────────────────────────────────────────────────────────────────────────────────────────────────
  await shot(page, 'library', async () => {
    await page.goto('/library/stock_by_supplier')
    await page.getByLabel('supplier test value').fill('Bloom & Co')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.getByText('Desk lamp, brass')).toBeVisible()
    await settle(page, 800)
    await save(page, 'library')
  })
  await shot(page, 'modules', async () => {
    await page.goto('/modules/supplier_picker')
    await expect(page.locator('[data-component="supplier"]')).toBeVisible()
    await settle(page, 1000)
    await save(page, 'modules')
  })
  await shot(page, 'component-libraries', async () => {
    await page.goto('/component-libraries')
    await settle(page)
    await save(page, 'component-libraries')
  })

  // ── Resources ───────────────────────────────────────────────────────────────────────────────────────────────────
  await shot(page, 'resources-list', async () => {
    await page.goto('/resources')
    await settle(page)
    await save(page, 'resources-list')
  })
  await shot(page, 'resource-new', async () => {
    await page.goto('/resources')
    await settle(page)
    await page.getByRole('button', { name: 'New resource' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill('Returns database')
    await settle(page, 400)
    await save(page, 'resource-new', { clip: dialog })
  })
  await shot(page, 'resource-postgres', async () => {
    await page.goto(`/resources/${demo.resources.warehouse}`)
    await page.getByRole('button', { name: /^Staging/ }).click()
    await tabButton(page, 'Settings').click()
    await expect(page.getByLabel('Host', { exact: true }).first()).toHaveValue(
      'warehouse-staging.db.example.com',
    )
    await settle(page)
    await save(page, 'resource-postgres')
  })
  await shot(page, 'resource-rest', async () => {
    await page.goto(`/resources/${demo.resources.supplierApi}`)
    await tabButton(page, 'Settings').click()
    await settle(page)
    await save(page, 'resource-rest')
  })
  await shot(page, 'resource-ssh', async () => {
    await page.goto(`/resources/${demo.resources.warehouse}`)
    await page.getByRole('button', { name: /^Staging/ }).click()
    await tabButton(page, 'Settings').click()
    const tunnel = page.getByTestId('ssh-tunnel')
    await tunnel.getByLabel('Connect through an SSH tunnel').check()
    const server = tunnel.locator('fieldset').first()
    await server.getByLabel('Host', { exact: true }).fill('bastion.warehouse.example.com')
    await server.getByLabel('User', { exact: true }).fill('workflows')
    await tunnel.scrollIntoViewIfNeeded()
    await settle(page)
    await save(page, 'resource-ssh', { clip: tunnel })
  })
  await shot(page, 'resource-playground', async () => {
    await page.goto(`/resources/${demo.resources.warehouse}`)
    await tabButton(page, 'Query').click()
    await page
      .locator('textarea')
      .first()
      .fill(
        'select supplier, count(*) as products, sum(stock) as units\n  from stock_levels\n group by supplier\n order by units desc',
      )
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.getByText('Lumen Glas').last()).toBeVisible()
    await settle(page)
    await save(page, 'resource-playground')
  })

  // ── Database ────────────────────────────────────────────────────────────────────────────────────────────────────
  await shot(page, 'database-tables', async () => {
    await page.goto('/database')
    await settle(page)
    await save(page, 'database-tables')
  })
  await shot(page, 'database-table', async () => {
    await page.goto('/database')
    await page.getByRole('navigation', { name: 'Tables' }).getByText('suppliers', { exact: true }).click()
    await expect(page.getByText('Nordhout').first()).toBeVisible()
    await settle(page)
    await save(page, 'database-table')
  })

  // ── Account ─────────────────────────────────────────────────────────────────────────────────────────────────────
  await shot(page, 'account-menu', async () => {
    await page.goto('/workflows')
    await settle(page)
    await page.getByRole('button', { name: 'Account' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await settle(page, 300)
    await save(page, 'account-menu')
  })

  // ── Settings (admins) ───────────────────────────────────────────────────────────────────────────────────────────
  for (const [name, path] of [
    ['settings-users', '/settings/users'],
    ['settings-user', `/settings/users/${demo.users.member}`],
    ['settings-groups', '/settings/groups'],
    ['settings-group', `/settings/groups/${demo.groups.operations}`],
    ['settings-api-keys', '/settings/api-keys'],
    ['settings-access-tokens', '/settings/access-tokens'],
    ['settings-environments', '/settings/environments'],
    ['settings-config-vars', '/settings/config-vars'],
    ['settings-git', '/settings/git'],
    ['settings-python', '/settings/python'],
    ['settings-npm', '/settings/npm'],
    ['settings-jdbc', '/settings/jdbc'],
    ['settings-audit', '/settings/audit'],
  ] as const) {
    await shot(page, name, async () => {
      // A person's and a group's pages run long: a taller window shows what's shared too.
      if (name === 'settings-user' || name === 'settings-group') {
        await page.setViewportSize({ width: VIEWPORT.width, height: 1300 })
      }
      await page.goto(path)
      await settle(page, 700)
      if (name === 'settings-git') {
        // Not connected in the test copy: the form filled in as an admin would.
        const repo = page.getByLabel(/Repository/).first()
        if (await repo.isVisible().catch(() => false)) {
          await repo.fill('https://github.com/optiply/workflows.git')
          await repo.blur()
          await settle(page, 300)
        }
      }
      await save(page, name)
    })
  }

  expect(failures, failures.join('\n')).toEqual([])
})
