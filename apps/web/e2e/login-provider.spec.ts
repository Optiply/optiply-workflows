import { expect, type Page, test } from '@playwright/test'
import { E2E_EMAIL, E2E_PASSWORD } from './global-setup'

/**
 * Production signs in only through the provider (Optiply's Auth0): the sign-in page goes straight there, unless it has
 * something to say (a waiting approval, a failed sign-in). The test server signs in with passwords, so its sign-in
 * settings are faked as production's, and the provider's start is answered here instead of leaving for Auth0.
 */
/** The provider's start, with or without the page to go back to. */
const START = /\/api\/auth\/oidc\/start(\?.*)?$/

async function asProduction(page: Page) {
  await page.route('**/api/trpc/**', async (route) => {
    if (!route.request().url().includes('authConfig')) return route.continue()
    const res = await route.fetch()
    const body = await res.json()
    for (const r of Array.isArray(body) ? body : [body]) {
      if (r.result?.data?.json && 'oidcEnabled' in r.result.data.json) {
        r.result.data.json = {
          ...r.result.data.json,
          oidcEnabled: true,
          oidcProvider: 'Optiply',
          localLoginEnabled: false,
        }
      }
    }
    await route.fulfill({ response: res, json: body })
  })
  await page.route(START, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><h1>Provider sign-in</h1>',
    }),
  )
}

test('signed out, the app goes straight to the provider’s sign-in', async ({ page }) => {
  await asProduction(page)
  await page.goto('/')
  await expect(page).toHaveURL(/\/api\/auth\/oidc\/start$/)
  await expect(page.getByRole('heading', { name: 'Provider sign-in' })).toBeVisible()
  // The sign-in page itself goes on too.
  await page.goto('/login')
  await expect(page).toHaveURL(/\/api\/auth\/oidc\/start$/)
})

test('waiting for approval stays on the page, with Sign in again', async ({ page }) => {
  await asProduction(page)
  await page.goto('/login?pending=1')
  await expect(page.getByTestId('pending-approval')).toContainText("Waiting for an admin's approval")
  const again = page.getByRole('link', { name: 'Sign in again' })
  await expect(again).toHaveAttribute('href', '/api/auth/oidc/start')
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(/\/login\?pending=1$/)
  await again.click()
  await expect(page).toHaveURL(/\/api\/auth\/oidc\/start$/)
})

test('a failed sign-in stays on the page with its reason', async ({ page }) => {
  await asProduction(page)
  const reason = 'Only @optiply.nl accounts or invited people can sign in'
  await page.goto(`/login?error=${encodeURIComponent(reason)}`)
  await expect(page.getByText(reason)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(/\/login\?error=/)
})

test('with password sign-in on, the page stays as it is', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByLabel('Password')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(/\/login$/)
})

test('the page someone opened goes with them to the provider’s sign-in', async ({ page }) => {
  await asProduction(page)
  await page.goto('/workflows?folder=x')
  await expect(page).toHaveURL(/\/api\/auth\/oidc\/start\?next=%2Fworkflows%3Ffolder%3Dx$/)
  // And on a message, Sign in again keeps it.
  await page.goto('/login?pending=1&next=%2Fresources')
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
    'href',
    '/api/auth/oidc/start?next=%2Fresources',
  )
})

test('a password sign-in goes back to the page someone opened', async ({ page }) => {
  await page.goto('/resources')
  await expect(page).toHaveURL(/\/login\?next=%2Fresources$/)
  await page.getByLabel('Email').fill(E2E_EMAIL)
  await page.getByLabel('Password').fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/resources$/)
})
