import { expect, test } from '@playwright/test'
import { signIn } from './helpers'
import { walletZip } from './wallet-zip'

// M38: JDBC drivers under Settings (admins upload and delete them).

test('JDBC drivers: an admin uploads one, sees its SHA-256, and deletes it', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  await page.goto('/settings/jdbc')
  await expect(page.getByRole('link', { name: 'JDBC drivers' })).toBeVisible()
  await page.getByTestId('jdbc-driver-new').click()
  await page.getByTestId('jdbc-driver-name').fill(`Exasol ${stamp}`)
  await page.getByTestId('jdbc-driver-class').fill('com.exasol.jdbc.EXADriver')

  await test.step('a file that isn’t a jar is refused', async () => {
    await page.getByTestId('jdbc-driver-file').setInputFiles({
      name: 'readme.txt',
      mimeType: 'application/java-archive',
      buffer: Buffer.from('not a jar'),
    })
    await page.getByRole('button', { name: 'Upload', exact: true }).click()
    await expect(page.getByTestId('jdbc-driver-problem')).toHaveText("That file isn't a jar")
  })

  await test.step('a jar is kept and listed', async () => {
    await page.getByTestId('jdbc-driver-file').setInputFiles({
      name: 'exajdbc-25.2.jar',
      mimeType: 'application/java-archive',
      buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(stamp)]),
    })
    await page.getByRole('button', { name: 'Upload', exact: true }).click()
    const row = page.getByTestId(`jdbc-driver-Exasol ${stamp}`)
    await expect(row).toContainText('com.exasol.jdbc.EXADriver')
    await expect(row).toContainText('exajdbc-25.2.jar')
    await expect(row.locator('td').nth(2)).toHaveText(/^[0-9a-f]{64}$/)
  })

  await test.step('and deleted', async () => {
    await page.getByTestId(`jdbc-driver-Exasol ${stamp}`).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByTestId(`jdbc-driver-Exasol ${stamp}`)).toHaveCount(0)
  })
})

test('a JDBC resource: each driver’s fields and URL, its sign-ins, an Oracle wallet, and the checks on save', async ({
  page,
}) => {
  await signIn(page)
  const stamp = Date.now().toString(36)
  await page.goto('/resources')
  await page.getByRole('button', { name: 'New resource' }).click()
  const type = page.getByRole('combobox', { name: 'Type' })
  await expect(type.locator('optgroup[label="Databases"] option[value="jdbc"]')).toHaveText('JDBC')
  await type.selectOption('jdbc')
  await page.getByLabel('Name').fill(`Warehouse ${stamp}`)
  await page.getByRole('button', { name: 'Create' }).click()
  const preview = page.getByTestId('jdbc-url-preview')
  const save = async () => page.getByRole('button', { name: 'Save', exact: true }).click()

  await test.step('Oracle by service name: the URL its fields make, then as a URL', async () => {
    await expect(page.getByTestId('jdbc-driver')).toHaveValue('oracle')
    await page.getByTestId('jdbc-host').fill('db.internal')
    await page.getByTestId('jdbc-service').fill('ORCLPDB1')
    await page.getByRole('spinbutton', { name: 'Port' }).fill('1522')
    await expect(preview).toHaveText('jdbc:oracle:thin:@//db.internal:1522/ORCLPDB1')
    await page.getByTestId('jdbc-mode').selectOption('url')
    await expect(page.getByTestId('jdbc-url')).toHaveValue('jdbc:oracle:thin:@//db.internal:1522/ORCLPDB1')
    await page.getByTestId('jdbc-url').fill('jdbc:snowflake://wrong')
    await page.getByTestId('jdbc-user').fill('app')
    await save()
    await expect(page.getByText(/The URL starts with jdbc:oracle:thin:/)).toBeVisible()
    await page.getByTestId('jdbc-mode').selectOption('fields')
  })

  await test.step('Snowflake: a key pair, then OAuth with its redirect URI and the checks on save', async () => {
    await page.getByTestId('jdbc-driver').selectOption('snowflake')
    await page.getByTestId('jdbc-account').fill('acme-prod')
    await page.getByTestId('jdbc-warehouse').fill('WH')
    await page.getByTestId('jdbc-role').fill('ANALYST')
    await expect(preview).toHaveText(
      'jdbc:snowflake://acme-prod.snowflakecomputing.com/?warehouse=WH&role=ANALYST',
    )
    await page.getByTestId('jdbc-auth').selectOption('keyPair')
    await save()
    await expect(page.getByText('Add the private key')).toBeVisible()
    await page
      .getByTestId('jdbc-private-key')
      .fill('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----')
    await save()
    await expect(page.getByText('Saved.')).toBeVisible()

    await page.getByTestId('jdbc-auth').selectOption('oauth')
    await expect(page.getByTestId('jdbc-user')).toHaveCount(0)
    await expect(page.getByText('Redirect URI', { exact: true })).toBeVisible()
    await page.getByTestId('jdbc-oauth-client').fill('snowflake-client')
    await save()
    await expect(page.getByText('Add the OAuth app’s client secret')).toBeVisible()
  })

  await test.step('ClickHouse: HTTPS or not', async () => {
    await page.getByTestId('jdbc-driver').selectOption('clickhouse')
    await expect(page.getByTestId('jdbc-auth')).toHaveCount(0)
    // Oracle's 1521 didn't follow: ClickHouse's own default.
    await page.getByTestId('jdbc-host').fill('ch.example')
    await expect(preview).toHaveText(/:8443\//)
    await page.getByTestId('jdbc-host').fill('ch.example')
    await page.getByTestId('jdbc-database').fill('events')
    await expect(preview).toHaveText('jdbc:clickhouse:https://ch.example:8443/events')
    await page.getByRole('checkbox', { name: /^HTTPS/ }).uncheck()
    await expect(preview).toHaveText('jdbc:clickhouse:http://ch.example:8123/events')
  })

  await test.step('through an SSH tunnel: the hosts to reach, the URL’s own offered', async () => {
    await expect(page.getByTestId('jdbc-tunnel-hosts')).toHaveCount(0)
    await page.getByRole('checkbox', { name: 'Connect through an SSH tunnel' }).check()
    await page.getByTestId('jdbc-tunnel-suggest').click()
    await expect(page.getByTestId('jdbc-tunnel-hosts')).toHaveValue('ch.example:8123')
    await page.getByRole('checkbox', { name: 'Connect through an SSH tunnel' }).uncheck()
  })

  await test.step('Oracle with a wallet: its TNS aliases offered, saved encrypted', async () => {
    await page.getByTestId('jdbc-driver').selectOption('oracle')
    await page.getByTestId('jdbc-oracle-connect').selectOption('tns')
    await page.getByLabel('Connect with a wallet').check()
    await save()
    await expect(page.getByText(/TNS alias is required|Add the wallet zip/).first()).toBeVisible()
    await page.getByTestId('jdbc-wallet-file').setInputFiles({
      name: 'Wallet_mydb.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(
        walletZip({
          'Wallet_mydb/cwallet.sso': 'auto-login',
          'Wallet_mydb/tnsnames.ora': 'mydb_high = (description=(x))\nmydb_low = (description=(y))\n',
        }),
      ),
    })
    await expect(page.getByTestId('jdbc-wallet-aliases')).toHaveText('Aliases: mydb_high, mydb_low')
    await expect(page.getByTestId('jdbc-tns')).toHaveValue('mydb_high')
    await expect(preview).toHaveText('jdbc:oracle:thin:@mydb_high')
    await page.getByTestId('jdbc-user').fill('admin')
    await save()
    await expect(page.getByText('Saved.')).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByTestId('jdbc-tns')).toHaveValue('mydb_high')
    await expect(page.getByText('Stored securely').first()).toBeVisible()
  })
})
