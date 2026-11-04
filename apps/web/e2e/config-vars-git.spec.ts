import { expect, test } from '@playwright/test'
import { e2eRepo, readRepoFile, useE2eRepo } from './git-helpers'
import { acceptConfirms, signIn, trpcMutate } from './helpers'

/**
 * M22: a config var protected from Settings → Config vars; a value set here only (local, kept by deploys), one saved
 * to a branch, the local one cleared, and unprotected again.
 */
test('protect a config var, set a local value and save one to a branch', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  await useE2eRepo(page)
  const { dir: repoDir } = e2eRepo()
  const name = `API_BASE_${Date.now()}`
  const variable = await trpcMutate<{ id: string }>(page, 'configVars.create', {
    name,
    description: 'Where the API is',
    isSecret: false,
  })
  const environments = (await (await page.request.get('/api/trpc/environments.list')).json()).result.data
    .json as { id: string; slug: string }[]
  const production = environments.find((e) => e.slug === 'production')!
  const staging = environments.find((e) => e.slug !== 'production')!
  await trpcMutate(page, 'configVars.setValue', {
    configVarId: variable.id,
    environmentId: production.id,
    value: 'https://api.optiply.com/',
  })
  const listed = async () =>
    (
      (await (await page.request.get('/api/trpc/configVars.list')).json()).result.data.json as {
        id: string
        gitProtected: boolean
        values: Record<string, { value?: string; local?: true }>
      }[]
    ).find((v) => v.id === variable.id)!

  await page.goto('/settings/config-vars')
  const row = page.getByRole('row').filter({ hasText: name })
  await row.getByTitle(`Protect ${name} in Git`).click()
  await page.getByTestId('protect-confirm').click()
  await expect(page.getByTestId('protect-result')).toContainText(`protect/config-var-${name}`)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(row.getByText('In Git', { exact: true })).toBeVisible()
  await expect(row.getByTitle('Delete variable')).toHaveCount(0)
  expect(
    JSON.parse(readRepoFile(repoDir, `protect/config-var-${name}`, `config-vars/${name}/config-var.json`)),
  ).toMatchObject({ values: { production: 'https://api.optiply.com/' } })

  // A value set here only: local, marked so.
  await row.getByRole('button', { name: 'Edit' }).click()
  await row.getByRole('textbox').fill('http://host.docker.internal:8080/')
  await row.getByRole('button', { name: 'Save here only' }).click()
  await expect(row.getByText('local', { exact: true })).toBeVisible()
  expect((await listed()).values[production.id]).toEqual({
    value: 'http://host.docker.internal:8080/',
    local: true,
  })

  // Another environment's value goes onto a branch.
  await row.getByRole('button', { name: 'Set' }).click()
  await row.getByRole('textbox').fill('https://staging.optiply.com/')
  await row.getByRole('button', { name: 'Save to branch…' }).click()
  const branch = `settings/config-var-${name}`.toLowerCase()
  await expect(page.getByTestId('save-to-branch-files')).toContainText(`config-vars/${name}/config-var.json`)
  await page.getByTestId('save-to-branch-confirm').click()
  await expect(page.getByTestId('save-to-branch-result')).toContainText(branch)
  await page.getByRole('button', { name: 'Done' }).click()
  expect(JSON.parse(readRepoFile(repoDir, branch, `config-vars/${name}/config-var.json`))).toMatchObject({
    values: { [staging.slug]: 'https://staging.optiply.com/' },
  })
  // Nothing changes here until it's merged.
  expect((await listed()).values[staging.id]).toBeUndefined()

  // The local value cleared.
  await row.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(row.getByText('local', { exact: true })).toHaveCount(0)

  await acceptConfirms(page)
  await row.getByTitle(`Unprotect ${name}`).click()
  await expect(row.getByText('In Git', { exact: true })).toHaveCount(0)
  expect((await listed()).gitProtected).toBe(false)
  expect(errors).toEqual([])
})
