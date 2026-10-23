import { expect, type Page, test } from '@playwright/test'
import { git, pushFiles } from './git-helpers'
import { E2E_GITHUB_TOKEN } from './global-setup'
import { signIn, trpcMutate, typeInto } from './helpers'

const query = async <T>(page: Page, path: string, input: unknown): Promise<T> => {
  const res = await page.request.get(
    `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
  )
  return (await res.json()).result.data.json
}

/** Twelve lines of code, `const v<n> = <value>`, with some values changed (changes kept apart, as diff3 needs). */
const code12 = (changes: Record<number, string> = {}) =>
  Array.from({ length: 12 }, (_, i) => `const v${i + 1} = ${changes[i + 1] ?? i + 1}`).join('\n')

/**
 * M20 in the editor: Update from branch merges the draft's uncommitted changes with the branch's, a conflict picked
 * in the merge dialog; Commit leads through it; Update from main makes a merge commit, its conflict edited by hand.
 */
test('merge a branch draft with its branch and with main', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const repoUrl = process.env.E2E_GIT_REPO_URL!
  const repoDir = process.env.E2E_GIT_REPO_DIR ?? new URL(repoUrl).pathname
  const github = process.env.E2E_FAKE_GITHUB!
  const stamp = Date.now()
  const slug = `merge-${stamp}`
  const branch = `merge/${stamp}`
  const stepFile = `workflows/${slug}/blocks/step.js`
  await trpcMutate(page, 'git.saveSettings', { repoUrl, token: E2E_GITHUB_TOKEN })

  // A published, protected workflow; its protect pull request merged.
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: `Merge ${stamp}` })
  const definition = (code: string) => ({
    schemaVersion: 1,
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      { name: 'step', type: 'code', config: { code } },
    ],
    edges: [{ from: 'startTrigger', port: 'out', to: 'step' }],
  })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: definition(code12()),
  })
  await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })
  await trpcMutate(page, 'git.protect', { kind: 'workflow', id: flow.id })
  const pulls = (await (await fetch(`${github}/_test/pulls`)).json()) as { number: number; state: string }[]
  for (const pull of pulls.filter((p) => p.state === 'open')) {
    expect((await fetch(`${github}/_test/pulls/${pull.number}/merge`, { method: 'POST' })).ok).toBe(true)
  }

  // A branch with a first commit; then an uncommitted change in the draft (lines 1 and 2)…
  const draft = await trpcMutate<{ id: string }>(page, 'branchDrafts.open', {
    kind: 'workflow',
    id: flow.id,
    branch,
    create: true,
  })
  const save = async (code: string) => {
    const { revision } = await query<{ revision: number }>(page, 'branchDrafts.get', { id: draft.id })
    await trpcMutate(page, 'branchDrafts.save', { id: draft.id, revision, definition: definition(code) })
  }
  const code = async () =>
    (
      await query<{ definition: { blocks: { name: string; config?: { code?: string } }[] } }>(
        page,
        'branchDrafts.get',
        { id: draft.id },
      )
    ).definition.blocks.find((b) => b.name === 'step')!.config!.code
  // A branch whose first commit changes line 12; then an uncommitted change in the draft (lines 1 and 4)…
  await save(code12({ 12: '120' }))
  const { revision } = await query<{ revision: number }>(page, 'branchDrafts.get', { id: draft.id })
  await trpcMutate(page, 'branchDrafts.commit', { id: draft.id, revision, message: 'First' })
  await save(code12({ 1: '10', 4: '40', 12: '120' }))
  // …while someone else commits lines 4 and 7 on the branch.
  pushFiles(repoDir, branch, { [stepFile]: `${code12({ 4: '400', 7: '70', 12: '120' })}\n` })

  // The editor says what updating would do; Commit leads through the update.
  await page.goto(`/workflows/${flow.id}?branch=${encodeURIComponent(branch)}`)
  await expect(page.getByTestId('branch-conflict')).toContainText('updating leaves 1 conflict to resolve')
  await expect(page.getByTestId('commit-open')).toHaveText('Update, then commit')
  await page.getByTestId('commit-open').click()
  await expect(page.getByTestId('merge-dialog')).toBeVisible()
  await expect(page.getByTestId('merge-progress')).toHaveText('0 of 1 resolved')
  await expect(page.getByTestId('merge-apply')).toBeDisabled()
  const card = page.getByTestId('conflict-Block step · config.code')
  await expect(card.getByTestId('conflict-chunk')).toHaveCount(1)
  await expect(card.getByTestId('conflict-chunk')).toContainText('const v4 = 40')
  await expect(card.getByTestId('conflict-chunk')).toContainText('const v4 = 400')
  await card.getByTestId('pick-theirs').click()
  await expect(page.getByTestId('merge-progress')).toHaveText('1 of 1 resolved')
  await page.getByTestId('merge-apply').click()
  // Merged (mine on line 1, theirs on 4, the branch's 7 and 12), and on to the commit.
  await expect(page.getByTestId('commit-confirm')).toBeVisible()
  expect(await code()).toBe(code12({ 1: '10', 4: '400', 7: '70', 12: '120' }))
  await page.getByRole('textbox', { name: 'Message' }).fill('Merged')
  await page.getByTestId('commit-confirm').click()
  await expect(page.getByTestId('commit-result')).toContainText(branch)
  await page.getByRole('button', { name: 'Done' }).click()
  expect(git(repoDir, 'show', `refs/heads/${branch}:${stepFile}`)).toContain('const v1 = 10')

  // Main changes line 9: Update from main makes a merge commit, with no dialog.
  pushFiles(repoDir, 'main', { [stepFile]: `${code12({ 9: '90' })}\n` })
  await page.reload()
  await expect(page.getByTestId('main-ahead')).toContainText('main changed this workflow')
  await page.getByTestId('update-from-main').click()
  await expect(page.getByTestId('main-ahead')).toHaveCount(0)
  const tip = git(repoDir, 'rev-parse', `refs/heads/${branch}`)
  expect(git(repoDir, 'rev-list', '--parents', '-n', '1', tip).split(' ')).toHaveLength(3)
  expect(await code()).toBe(code12({ 1: '10', 4: '400', 7: '70', 9: '90', 12: '120' }))

  // Main and the branch both change line 1 again: the dialog, the code edited by hand.
  pushFiles(repoDir, 'main', { [stepFile]: `${code12({ 1: '"main"', 9: '90' })}\n` })
  pushFiles(repoDir, branch, {
    [stepFile]: `${code12({ 1: '"branch"', 4: '400', 7: '70', 9: '90', 12: '120' })}\n`,
  })
  await page.reload()
  await page.getByTestId('update-from-main').click()
  await expect(page.getByRole('dialog', { name: 'Update from main' })).toBeVisible()
  await page.getByTestId('edit-by-hand').click()
  await typeInto(page, page.getByTestId('conflict-Block step · config.code'), 'return "by hand"')
  await expect(page.getByTestId('merge-progress')).toHaveText('1 of 1 resolved')
  await page.getByTestId('merge-apply').click()
  await expect(page.getByTestId('merge-dialog')).toHaveCount(0)
  expect(git(repoDir, 'show', `refs/heads/${branch}:${stepFile}`)).toBe('return "by hand"')
  // The draft took the merge commit too (updated from the branch right after).
  await expect.poll(code).toBe('return "by hand"')
  // Into main now, git's own merge is clean.
  const merged = git(repoDir, 'rev-parse', `refs/heads/${branch}`)
  expect(() => git(repoDir, 'merge-tree', '--write-tree', 'main', merged)).not.toThrow()

  expect(errors).toEqual([])
})
