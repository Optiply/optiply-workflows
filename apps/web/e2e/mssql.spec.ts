import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

// M38 step 1c: a SQL Server resource's settings: the picker, each sign-in's own fields, the checks on save, and the
// playground's placeholder hint. (Its queries are tested against a real SQL Server in the connector and server tests.)

test('a SQL Server resource: the picker, each sign-in’s fields, and the checks on save', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  await page.goto('/resources')
  await page.getByRole('button', { name: 'New resource' }).click()
  const type = page.getByRole('combobox', { name: 'Type' })
  await expect(type.locator('optgroup[label="Databases"] option[value="mssql"]')).toHaveText(
    'Microsoft SQL Server',
  )
  await type.selectOption('mssql')
  await page.getByLabel('Name').fill(`SQL Server ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()

  const auth = page.getByTestId('mssql-auth')
  await test.step('a SQL login by default: login and password', async () => {
    await expect(auth).toHaveValue('sql')
    await expect(page.getByTestId('mssql-user')).toBeVisible()
    await expect(page.getByText('Password', { exact: true })).toBeVisible()
    await expect(page.getByTestId('mssql-domain')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Encryption' })).toHaveValue('require')
  })

  await test.step('Windows: its domain is checked on save', async () => {
    await page.getByPlaceholder('db.internal.optiply.nl').fill('sql.corp.example')
    await page.getByRole('textbox', { name: 'Database' }).fill('shop')
    await auth.selectOption('ntlm')
    await page.getByTestId('mssql-user').fill('svc-reports')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/The Windows domain is required/)).toBeVisible()
    await page.getByTestId('mssql-domain').fill('CORP')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Add the password')).toBeVisible()
    await page.getByRole('textbox', { name: 'Password' }).fill('windows-pw')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
  })

  await test.step('an Entra app: client id, tenant and client secret, no login', async () => {
    await auth.selectOption('entra-service-principal')
    await expect(page.getByTestId('mssql-user')).toHaveCount(0)
    await expect(page.getByTestId('mssql-client-id')).toBeVisible()
    await expect(page.getByTestId('mssql-tenant-id')).toBeVisible()
    await expect(page.getByText('Client secret', { exact: true })).toBeVisible()
    await page.getByTestId('mssql-client-id').fill('11111111-2222-3333-4444-555555555555')
    await page.getByTestId('mssql-tenant-id').fill('contoso.onmicrosoft.com')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Add the app’s client secret')).toBeVisible()
    await expect(page.getByText('Saved.')).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Client secret' }).fill('entra-secret')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
  })

  await test.step('a named instance', async () => {
    await page.getByTestId('mssql-instance').fill('SQLEXPRESS')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.reload()
    // The page opens on its playground: T-SQL's first query and placeholders.
    await expect(page.getByRole('textbox', { name: /^SQL/ })).toHaveValue(
      'SELECT TOP 10 * FROM INFORMATION_SCHEMA.TABLES',
    )
    await expect(page.getByText(/becomes a bind parameter \(@p1, @p2…\)/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByTestId('mssql-instance')).toHaveValue('SQLEXPRESS')
    await expect(auth).toHaveValue('entra-service-principal')
  })
})
