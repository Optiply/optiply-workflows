import { expect, test } from '@playwright/test'
import {
  e2eRepo,
  ensureBranch,
  git,
  mergeOpenPulls,
  pushFiles,
  readRepoFile,
  useE2eRepo,
} from './git-helpers'
import { signIn, trpcMutate } from './helpers'

/**
 * M22 in the editors' Git bar: the branch picker puts the branches changing the object first, and Details sets the
 * name, description and folder Git keeps for it on a branch, committed with the next commit.
 */
test('branch picker groups, and name, description and folder on a branch', async ({ page }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  await useE2eRepo(page)
  const { dir: repoDir, github } = e2eRepo()
  ensureBranch(repoDir, 'main')
  const stamp = Date.now()
  const slug = `details-${stamp}`
  const branch = `details/${stamp}`
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: `Details ${stamp}` })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: { schemaVersion: 1, blocks: [{ name: 'startTrigger', type: 'startTrigger' }], edges: [] },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })
  await trpcMutate(page, 'git.protect', { kind: 'workflow', id: flow.id })
  await mergeOpenPulls(github, `protect/workflow-${slug}`)
  await trpcMutate(page, 'folders.create', { name: `Ops ${stamp}`, type: 'workflow' })
  // Someone else's branch changing this workflow, and one that doesn't.
  const json = `workflows/${slug}/workflow.json`
  const theirs = `touch/${stamp}`
  const plain = `plain/${stamp}`
  for (const name of [theirs, plain]) git(repoDir, 'branch', name, 'main')
  pushFiles(repoDir, theirs, {
    [json]: readRepoFile(repoDir, 'main', json).replace(`"Details ${stamp}"`, `"Theirs ${stamp}"`),
  })
  pushFiles(repoDir, plain, { [`docs/${stamp}.md`]: 'hi\n' })

  await page.goto(`/workflows/${flow.id}?branch=${encodeURIComponent(branch)}`)
  const picker = page.getByLabel('Branch', { exact: true })
  await expect(picker.locator('optgroup[label="Changing this workflow"] option')).toContainText([
    branch,
    theirs,
  ])
  await expect(picker.locator('optgroup[label="Other branches"] option', { hasText: plain })).toHaveCount(1)

  await page.getByTestId('branch-details-open').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(`Details renamed ${stamp}`)
  await dialog.getByLabel('Description').fill('Moved and renamed on a branch')
  await dialog.getByLabel('Folder').selectOption(`Ops ${stamp}`)
  await page.getByTestId('branch-details-save').click()
  await expect(dialog).toHaveCount(0)

  await page.getByTestId('commit-open').click()
  await expect(page.getByTestId('commit-files')).toContainText(json)
  await page.getByTestId('commit-confirm').click()
  await expect(page.getByTestId('commit-result')).toBeVisible()
  expect(JSON.parse(readRepoFile(repoDir, branch, json))).toMatchObject({
    name: `Details renamed ${stamp}`,
    description: 'Moved and renamed on a branch',
    folder: `Ops ${stamp}`,
  })
  expect(errors).toEqual([])
})
