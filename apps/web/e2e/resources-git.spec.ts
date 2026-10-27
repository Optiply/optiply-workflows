import { expect, test } from '@playwright/test'
import { e2eRepo, mergeOpenPulls, readRepoFile, useE2eRepo } from './git-helpers'
import { signIn, trpcMutate } from './helpers'

/**
 * M22 in the browser: a resource protected from its page, its settings read-only on main apart from secrets, a
 * change saved to a branch with its diff and pull request, and unprotected again.
 */
test('protect a resource and save its settings to a branch', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  await useE2eRepo(page)
  const { dir: repoDir, github } = e2eRepo()
  const stamp = Date.now()
  const slug = `orders_${stamp}`
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'postgres',
    name: `Orders ${stamp}`,
    slug,
  })
  const environments = await (await page.request.get('/api/trpc/environments.list')).json()
  const production = (environments.result.data.json as { id: string; slug: string }[]).find(
    (e) => e.slug === 'production',
  )!
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId: production.id,
    config: { host: 'db.internal', port: 5432, database: 'orders', user: 'app' },
  })

  await page.goto(`/resources/${resource.id}`)
  await page.getByTestId('protect-resource').click()
  await page.getByTestId('protect-confirm').click()
  await expect(page.getByTestId('protect-result')).toContainText(`protect/resource-${slug}`)
  await expect(page.getByTestId('pull-request-link')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByText('In Git', { exact: true })).toBeVisible()
  expect(
    JSON.parse(readRepoFile(repoDir, `protect/resource-${slug}`, `resources/${slug}/resource.json`)),
  ).toMatchObject({ type: 'postgres', environments: { production: { config: { host: 'db.internal' } } } })
  await mergeOpenPulls(github, `protect/resource-${slug}`)

  // On main: the settings are Git's; secrets alone are saved here, and the environment can't be removed.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByTestId('settings-from-git')).toContainText('come from Git')
  await expect(page.getByRole('button', { name: 'Save secrets' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove from this environment' })).toHaveCount(0)
  await expect(page.getByTestId('save-to-branch')).toBeDisabled()

  // A changed host goes onto a branch, with its diff, then its pull request.
  await page.getByRole('textbox', { name: 'Host' }).fill('db2.internal')
  await page.getByTestId('save-to-branch').click()
  const branch = `settings/resource-${slug}`
  await expect(page.getByTestId('save-to-branch-branch')).toHaveValue(branch)
  const files = page.getByTestId('save-to-branch-files')
  await expect(files).toContainText(`resources/${slug}/resource.json`)
  await files.getByRole('button').first().click()
  await expect(page.getByTestId('file-diff')).toContainText('db2.internal')
  await page.getByTestId('save-to-branch-confirm').click()
  await expect(page.getByTestId('save-to-branch-result')).toContainText(branch)
  await page.getByTestId('open-pull-request').click()
  await expect(page.getByTestId('pull-request-link')).toContainText('Open')
  expect(JSON.parse(readRepoFile(repoDir, branch, `resources/${slug}/resource.json`))).toMatchObject({
    environments: { production: { config: { host: 'db2.internal' } } },
  })
  await page.getByRole('button', { name: 'Done' }).click()

  // The name too goes through a branch.
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Orders renamed ${stamp}`)
  await page.getByRole('button', { name: 'Save to branch…' }).first().click()
  await expect(page.getByTestId('save-to-branch-files')).toContainText(`resources/${slug}/resource.json`)
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Unprotected: saved here again.
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Unprotect' }).click()
  await expect(page.getByText('In Git', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

/** M22: overrides of single settings on a protected resource, in their own card. */
test('override single settings of a protected resource on this instance', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  await useE2eRepo(page)
  const stamp = Date.now()
  const resource = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'postgres',
    name: `Warehouse ${stamp}`,
    slug: `warehouse_${stamp}`,
  })
  const environments = await (await page.request.get('/api/trpc/environments.list')).json()
  const production = (environments.result.data.json as { id: string; slug: string }[]).find(
    (e) => e.slug === 'production',
  )!
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: resource.id,
    environmentId: production.id,
    config: { host: 'db.internal', port: 5432, database: 'orders', user: 'app' },
  })
  await trpcMutate(page, 'git.protectSettings', { kind: 'resource', id: resource.id })
  const overridesNow = async () => {
    const res = await page.request.get(
      `/api/trpc/resources.get?input=${encodeURIComponent(JSON.stringify({ json: { id: resource.id } }))}`,
    )
    const view = (await res.json()).result.data.json as {
      environments: { environmentId: string; overrides: Record<string, unknown> | null }[]
    }
    return view.environments.find((e) => e.environmentId === production.id)!.overrides
  }

  await page.goto(`/resources/${resource.id}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const card = page.getByTestId('overrides')
  await card.getByLabel('Setting to override').fill('host')
  await card.getByRole('button', { name: 'Override', exact: true }).click()
  await expect(card.getByLabel('Override of host')).toHaveValue('db.internal')
  await expect(card).toContainText('Git: "db.internal"')
  await card.getByLabel('Override of host').fill('host.docker.internal')
  await card.getByLabel('Setting to override').fill('port')
  await card.getByRole('button', { name: 'Override', exact: true }).click()
  // Typed as Git's value is: a number.
  await card.getByLabel('Override of port').fill('next door')
  await expect(card).toContainText('Expected a number')
  await expect(card.getByRole('button', { name: 'Save overrides' })).toBeDisabled()
  await card.getByLabel('Override of port').fill('6543')
  await card.getByRole('button', { name: 'Save overrides' }).click()
  await expect(card).toContainText('Saved.')
  expect(await overridesNow()).toEqual({ host: 'host.docker.internal', port: 6543 })

  // A setting the resource doesn't have is refused by the server.
  await card.getByLabel('Setting to override').fill('nothing_here')
  await card.getByRole('button', { name: 'Override', exact: true }).click()
  await card.getByLabel('Override of nothing_here').fill('"x"')
  await card.getByRole('button', { name: 'Save overrides' }).click()
  await expect(card).toContainText("isn't a setting of this resource")
  await card.getByTitle('Remove the override of nothing_here').click()

  // Kept across a reload; one removed.
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(card.getByLabel('Override of host')).toHaveValue('host.docker.internal')
  await card.getByTitle('Remove the override of host').click()
  await card.getByRole('button', { name: 'Save overrides' }).click()
  await expect(card).toContainText('Saved.')
  expect(await overridesNow()).toEqual({ port: 6543 })
  expect(errors).toEqual([])
})
