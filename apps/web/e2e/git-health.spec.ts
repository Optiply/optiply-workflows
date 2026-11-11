import { expect, test } from '@playwright/test'
import { e2eRepo, ensureBranch, git, pushFiles, useE2eRepo } from './git-helpers'
import { signIn, trpcMutate } from './helpers'

/**
 * M22 on Settings → Git: the notify workflow picked, a deploy with problems shown as a banner (dismissed until the
 * problems change) and a badge, and Promote opening a pull request into another branch. Cleans up after itself:
 * the other specs share the repo and the instance.
 */
test('deploy problems reach admins, and Promote opens a pull request', async ({ page }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  await useE2eRepo(page)
  const { dir: repoDir } = e2eRepo()
  ensureBranch(repoDir, 'main')
  const stamp = Date.now()
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', {
    slug: `tell-ops-${stamp}`,
    name: `Tell ops ${stamp}`,
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: { schemaVersion: 1, blocks: [{ name: 'startTrigger', type: 'startTrigger' }], edges: [] },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })
  const deployNow = async () => {
    await page.getByRole('button', { name: 'Deploy now' }).click()
    await expect(page.getByTestId('deploy-outcome')).toBeVisible()
  }

  try {
    await page.goto('/settings/git')
    await page.getByTestId('git-notify').getByLabel('Notify workflow').selectOption(flow.id)
    await expect(page.getByTestId('git-notify').getByLabel('Notify workflow')).toHaveValue(flow.id)

    // A broken directory on main: the deploy has problems.
    const broken = `workflows/broken-${stamp}`
    pushFiles(repoDir, 'main', { [`${broken}/workflow.json`]: '{ not json' })
    await deployNow()
    await expect(page.getByTestId(`git-object-workflow-broken-${stamp}`)).toContainText('Problems')
    await page.reload()
    const banner = page.getByTestId('git-health-banner')
    await expect(banner).toContainText('Git sync:')
    await expect(page.getByTestId('git-problems-badge').first()).toBeVisible()

    // Dismissed: gone, also after a reload, until the problems change.
    await banner.getByTitle('Dismiss until the problems change').click()
    await expect(banner).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('git-deploys')).toBeVisible()
    await expect(banner).toHaveCount(0)
    pushFiles(repoDir, 'main', { [`${broken}-2/workflow.json`]: '{ not json either' })
    await deployNow()
    // The deploy runs after the request returns: wait for its problems before reading the banner afresh.
    await expect(page.getByTestId(`git-object-workflow-broken-${stamp}-2`)).toContainText('Problems')
    await page.reload()
    await expect(banner).toBeVisible()
    await banner.getByRole('link', { name: 'See deploys' }).click()
    await expect(page).toHaveURL(/\/settings\/git$/)

    // Promote into a branch behind main.
    const target = `promote-target-${stamp}`
    git(repoDir, 'branch', target, 'main~2')
    const promote = page.getByTestId('git-promote')
    await promote.getByLabel('Into branch').fill(target)
    await promote.getByRole('button', { name: 'Open pull request' }).click()
    await expect(promote.getByTestId('pull-request-link')).toContainText('Open')
    await expect(promote.getByTestId('promote-result')).toContainText(broken)
    await promote.getByLabel('Into branch').fill('main')
    await expect(promote.getByRole('button', { name: 'Open pull request' })).toBeDisabled()
  } finally {
    // Leave the repo and the instance as the other specs expect them.
    pushFiles(repoDir, 'main', {
      [`workflows/broken-${stamp}/workflow.json`]: null,
      [`workflows/broken-${stamp}-2/workflow.json`]: null,
    })
    await trpcMutate(page, 'git.setNotifyWorkflow', { workflowId: null })
    await trpcMutate(page, 'git.deployNow', {})
  }
  // The notify workflow ran for the changed problems.
  const runs = await page.request.get(`/api/v1/workflows/tell-ops-${stamp}/runs?limit=20`)
  expect(runs.ok()).toBe(true)
  const { runs: list } = (await runs.json()) as { runs: { triggerType: string }[] }
  expect(list.length).toBeGreaterThan(0)
  expect(list.every((r) => r.triggerType === 'git')).toBe(true)
  expect(errors).toEqual([])
})
