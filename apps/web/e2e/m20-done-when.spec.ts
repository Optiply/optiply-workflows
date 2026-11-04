import { expect, type Page, test } from '@playwright/test'
import {
  commitDraft,
  draftDefinition,
  e2eRepo,
  editRepoJson,
  git,
  type Json,
  mergeOpenPulls,
  pushFiles,
  readRepoFile,
  saveDraft,
  useE2eRepo,
} from './git-helpers'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M20's done-when (architecture §2.7, §2.23): a branch draft and its branch merge instead of one side losing. A
 * workflow's uncommitted changes and someone's commit merge with no dialog; real conflicts (the same line, the same
 * setting, a block deleted against a change) are resolved in the dialog, also over a save made meanwhile; the same
 * for an app and a library query; Update from main makes a merge commit that lets a second pull request merge and
 * deploy both changes; a conflict outside objects is refused, named. Against the e2e repo and the fake GitHub.
 */

/** Twelve lines of code, `const v<n> = <value>`, some changed (changes kept apart: diff3 joins adjacent ones). */
const code12 = (changes: Record<number, string> = {}) =>
  Array.from({ length: 12 }, (_, i) => `const v${i + 1} = ${changes[i + 1] ?? i + 1}`).join('\n')

const blockOf = (def: Json, name: string) => def.blocks.find((b: { name: string }) => b.name === name)
const componentOf = (def: Json, name: string) => def.components.find((c: { name: string }) => c.name === name)

/** A published workflow, protected, its protect pull request merged. */
async function protectedWorkflow(page: Page, slug: string, blocks: Json[], edges: Json[]) {
  const flow = await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name: slug })
  await trpcMutate(page, 'workflows.saveDraft', {
    id: flow.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
      edges,
    },
  })
  await trpcMutate(page, 'releases.publish', { workflowId: flow.id, draftRevision: 2 })
  await trpcMutate(page, 'git.protect', { kind: 'workflow', id: flow.id })
  await mergeOpenPulls(e2eRepo().github)
  return flow.id
}

const openDraft = async (page: Page, kind: string, id: string, branch: string) =>
  (await trpcMutate<{ id: string }>(page, 'branchDrafts.open', { kind, id, branch, create: true })).id

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await useE2eRepo(page)
})

test('a workflow: changes merge with no dialog; conflicts resolved in it, over a save made meanwhile', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { dir: repo } = e2eRepo()
  const slug = `m20-flow-${Date.now()}`
  const branch = `m20/${slug}`
  const file = (path: string) => `workflows/${slug}/${path}`
  const id = await protectedWorkflow(
    page,
    slug,
    [
      { name: 'step', type: 'code', config: { code: code12() } },
      { name: 'other', type: 'code', config: { code: 'return 1' } },
      {
        name: 'q',
        type: 'resourceQuery',
        config: { resource: 'shop_db', query: { sql: 'select 1' } },
        settings: { timeoutMs: 5000 },
      },
    ],
    [
      { from: 'startTrigger', port: 'out', to: 'step' },
      { from: 'startTrigger', port: 'out', to: 'other' },
      { from: 'startTrigger', port: 'out', to: 'q' },
    ],
  )
  const draft = await openDraft(page, 'workflow', id, branch)
  await commitDraft(
    page,
    draft,
    (d) => {
      blockOf(d, 'step').config.code = code12({ 12: '120' })
      return d
    },
    'First',
  )

  // Uncommitted: a new block, and line 1 of the code. Someone else commits another block and line 7.
  await saveDraft(page, draft, (d) => {
    d.blocks.push({ name: 'added', type: 'code', config: { code: 'return "added"' } })
    d.edges.push({ from: 'startTrigger', port: 'out', to: 'added' })
    blockOf(d, 'step').config.code = code12({ 1: '10', 12: '120' })
    return d
  })
  pushFiles(repo, branch, {
    [file('blocks/other.js')]: 'return 2\n',
    [file('blocks/step.js')]: `${code12({ 7: '70', 12: '120' })}\n`,
  })
  await page.goto(`/workflows/${id}?branch=${encodeURIComponent(branch)}`)
  await expect(page.getByTestId('branch-conflict')).toContainText('updating merges it with your changes')
  await page.getByTestId('update-from-branch').click()
  await expect(page.getByTestId('branch-conflict')).toHaveCount(0)
  await expect(page.getByTestId('merge-dialog')).toHaveCount(0)
  let def = await draftDefinition(page, draft)
  expect(blockOf(def, 'added').config.code).toBe('return "added"')
  expect(blockOf(def, 'step').config.code).toBe(code12({ 1: '10', 7: '70', 12: '120' }))
  expect(blockOf(def, 'other').config.code).toBe('return 2')
  // And it commits.
  await page.getByTestId('commit-open').click()
  await page.getByRole('textbox', { name: 'Message' }).fill('Both')
  await page.getByTestId('commit-confirm').click()
  await expect(page.getByTestId('commit-result')).toContainText(branch)
  await page.getByRole('button', { name: 'Done' }).click()
  expect(readRepoFile(repo, branch, file('blocks/added.js'))).toBe('return "added"')

  // Both change line 4 and q's timeout; mine deletes `other`, theirs changes it.
  await saveDraft(page, draft, (d) => {
    blockOf(d, 'step').config.code = code12({ 1: '10', 4: '40', 7: '70', 12: '120' })
    blockOf(d, 'q').settings.timeoutMs = 6000
    d.blocks = d.blocks.filter((b: { name: string }) => b.name !== 'other')
    d.edges = d.edges.filter((e: { to: string }) => e.to !== 'other')
    return d
  })
  pushFiles(repo, branch, {
    [file('blocks/step.js')]: `${code12({ 1: '10', 4: '400', 7: '70', 12: '120' })}\n`,
    [file('blocks/other.js')]: 'return 3\n',
  })
  editRepoJson(repo, branch, file('workflow.json'), (json) => {
    json.blocks.find((b: { name: string }) => b.name === 'q').settings.timeoutMs = 7000
  })
  await page.reload()
  await expect(page.getByTestId('branch-conflict')).toContainText('updating leaves 3 conflicts to resolve')
  await page.getByTestId('update-from-branch').click()
  await expect(page.getByTestId('merge-progress')).toHaveText('0 of 3 resolved')
  const code = page.getByTestId('conflict-Block step · config.code')
  const timeout = page.getByTestId('conflict-Block q · settings.timeoutMs')
  const other = page.getByTestId('conflict-Block other')
  await expect(code.getByTestId('conflict-chunk')).toContainText('const v4 = 40')
  await expect(timeout).toContainText('6000')
  await expect(timeout).toContainText('7000')
  await expect(other).toContainText('you deleted it')

  // Someone else saves the draft while the dialog is open (a block away from the conflicts).
  await saveDraft(page, draft, (d) => {
    d.blocks.push({ name: 'meanwhile', type: 'code', config: { code: 'return "m"' } })
    return d
  })
  await code.getByTestId('pick-ours').click()
  await timeout.getByTestId('pick-theirs').click()
  await other.getByTestId('pick-ours').click()
  await expect(page.getByTestId('merge-progress')).toHaveText('3 of 3 resolved')
  await page.getByTestId('merge-apply').click()
  await expect(page.getByTestId('merge-dialog')).toHaveCount(0)
  def = await draftDefinition(page, draft)
  expect(blockOf(def, 'step').config.code).toBe(code12({ 1: '10', 4: '40', 7: '70', 12: '120' }))
  expect(blockOf(def, 'q').settings.timeoutMs).toBe(7000)
  expect(blockOf(def, 'other')).toBeUndefined()
  expect(blockOf(def, 'meanwhile').config.code).toBe('return "m"')
  expect(blockOf(def, 'added')).toBeDefined()
})

test('an app: a prop, a query’s SQL and a moved grid item', async ({ page }) => {
  test.setTimeout(120_000)
  const { dir: repo, github } = e2eRepo()
  const slug = `m20-app-${Date.now()}`
  const branch = `m20/${slug}`
  const sql = (l1: string, l3: string) => [l1, 'from customers', l3].join('\n')
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: slug })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        { name: 'text1', type: 'text', props: { value: 'Hello' } },
        { name: 'button1', type: 'button', props: { text: 'Go' } },
      ],
      queries: [
        {
          name: 'list',
          kind: 'resource',
          resource: 'shop_db',
          query: { sql: sql('select id', 'limit 10') },
          run: 'auto',
        },
      ],
      layout: { text1: { x: 0, y: 0, w: 6, h: 1 }, button1: { x: 0, y: 1, w: 3, h: 1 } },
    },
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  await trpcMutate(page, 'git.protect', { kind: 'app', id: app.id })
  await mergeOpenPulls(github)
  const draft = await openDraft(page, 'app', app.id, branch)
  await commitDraft(
    page,
    draft,
    (d) => {
      componentOf(d, 'text1').props.value = 'Hello!'
      return d
    },
    'First',
  )
  // Mine: the text's prop, the SQL's first line, button1 moved right. Theirs: the button's prop, the SQL's last
  // line, button1 moved elsewhere.
  await saveDraft(page, draft, (d) => {
    componentOf(d, 'text1').props.value = 'Hello mine'
    d.queries.find((q: { name: string }) => q.name === 'list').query.sql = sql('select id, email', 'limit 10')
    d.layout.button1 = { x: 6, y: 1, w: 3, h: 1 }
    return d
  })
  pushFiles(repo, branch, { [`apps/${slug}/queries/list.sql`]: `${sql('select id', 'limit 50')}\n` })
  editRepoJson(repo, branch, `apps/${slug}/app.json`, (json) => {
    json.components.find((c: { name: string }) => c.name === 'button1').props.text = 'Go now'
  })
  editRepoJson(repo, branch, `apps/${slug}/layout.json`, (json) => {
    json.button1 = { x: 3, y: 1, w: 3, h: 1 }
  })
  await page.goto(`/apps/${slug}/edit?branch=${encodeURIComponent(branch)}`)
  await page.getByTestId('update-from-branch').click()
  await expect(page.getByTestId('merge-progress')).toHaveText('0 of 1 resolved')
  await page.getByTestId('conflict-Component button1 · position').getByTestId('pick-theirs').click()
  await page.getByTestId('merge-apply').click()
  await expect(page.getByTestId('merge-dialog')).toHaveCount(0)
  const def = await draftDefinition(page, draft)
  const component = (name: string) => def.components.find((c: { name: string }) => c.name === name)
  expect(component('text1').props.value).toBe('Hello mine')
  expect(component('button1').props.text).toBe('Go now')
  expect(def.queries[0].query.sql).toBe(sql('select id, email', 'limit 50'))
  expect(def.layout.button1).toEqual({ x: 3, y: 1, w: 3, h: 1 })
})

test('a library query: SQL line by line, parameters by name', async ({ page }) => {
  test.setTimeout(120_000)
  const { dir: repo, github } = e2eRepo()
  const slug = `m20_lq_${Date.now()}`
  const branch = `m20/${slug}`
  const sql = (l2: string, l5: string) =>
    ['select id, email', l2, 'where id = {{ id }}', 'order by id', l5].join('\n')
  const lq = await trpcMutate<{ id: string }>(page, 'libraryQueries.create', { slug, name: slug })
  await trpcMutate(page, 'libraryQueries.saveDraft', {
    id: lq.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      resource: 'shop_db',
      query: { sql: sql('from customers', 'limit 10') },
      params: [{ name: 'id', testValue: 1 }],
    },
  })
  await trpcMutate(page, 'libraryQueries.publish', { libraryQueryId: lq.id, draftRevision: 2 })
  await trpcMutate(page, 'git.protect', { kind: 'library_query', id: lq.id })
  await mergeOpenPulls(github)
  const draft = await openDraft(page, 'library_query', lq.id, branch)
  await commitDraft(page, draft, (d) => ({ ...d, timeoutMs: 20_000 }), 'First')
  // Mine: line 2. Theirs: line 2 too, line 5, and a parameter.
  await saveDraft(page, draft, (d) => ({ ...d, query: { sql: sql('from customers c', 'limit 10') } }))
  pushFiles(repo, branch, {
    [`library/${slug}/query.sql`]: `${sql('from customers as c', 'limit {{ limit }}')}\n`,
  })
  editRepoJson(repo, branch, `library/${slug}/query.json`, (json) => {
    json.params.push({ name: 'limit', testValue: 5 })
  })
  await page.goto(`/library/${slug}?branch=${encodeURIComponent(branch)}`)
  await page.getByTestId('update-from-branch').click()
  const card = page.getByTestId('conflict-query.sql')
  await expect(card.getByTestId('conflict-chunk')).toContainText('from customers c')
  await expect(card.getByTestId('conflict-chunk')).toContainText('from customers as c')
  await card.getByTestId('pick-ours').click()
  await page.getByTestId('merge-apply').click()
  await expect(page.getByTestId('merge-dialog')).toHaveCount(0)
  const def = await draftDefinition(page, draft)
  expect(def.query.sql).toBe(sql('from customers c', 'limit {{ limit }}'))
  expect(def.params.map((p: { name: string }) => p.name)).toEqual(['id', 'limit'])
  expect(def.timeoutMs).toBe(20_000)
})

test('Update from main lets a second pull request merge and deploy both; a README conflict is refused', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { dir: repo, github } = e2eRepo()
  const slug = `m20-main-${Date.now()}`
  const [first, second, third] = ['a', 'b', 'c'].map((x) => `m20/${slug}-${x}`) as [string, string, string]
  const id = await protectedWorkflow(
    page,
    slug,
    [{ name: 'step', type: 'code', config: { code: code12() } }],
    [{ from: 'startTrigger', port: 'out', to: 'step' }],
  )
  // Two branches, each adding a block and changing a line of the same code.
  const change = (block: string, line: number, value: string) => (d: Json) => {
    d.blocks.push({ name: block, type: 'code', config: { code: `return "${block}"` } })
    const step = blockOf(d, 'step')
    step.config.code = step.config.code
      .split('\n')
      .map((l: string, i: number) => (i === line - 1 ? `const v${line} = ${value}` : l))
      .join('\n')
    return d
  }
  await commitDraft(page, await openDraft(page, 'workflow', id, first), change('fromA', 1, '"A"'), 'A')
  const secondDraft = await openDraft(page, 'workflow', id, second)
  await commitDraft(page, secondDraft, change('fromB', 7, '"B"'), 'B')
  for (const branch of [first, second]) {
    await trpcMutate(page, 'git.openPullRequest', { branch, title: `Change ${branch}` })
  }
  const live = async () => {
    const flow = await trpcQuery<{ liveRelease: { id: string } | null }>(page, 'workflows.get', { id })
    return (
      await trpcQuery<{ definition: Json }>(page, 'releases.get', {
        workflowId: id,
        id: flow.liveRelease!.id,
      })
    ).definition
  }

  // The first merges and deploys.
  await mergeOpenPulls(github, first)
  await trpcMutate(page, 'git.deployNow', {})
  await expect.poll(async () => blockOf(await live(), 'fromA') !== undefined, { timeout: 30_000 }).toBe(true)
  // The second now conflicts with main for git (both added a block to workflow.json).
  const mergeTreeClean = (a: string, b: string) => {
    try {
      git(repo, 'merge-tree', '--write-tree', a, b)
      return true
    } catch {
      return false
    }
  }
  expect(mergeTreeClean('main', second)).toBe(false)

  // Update from main in the second's editor: a merge commit with two parents, and then it merges cleanly.
  await page.goto(`/workflows/${id}?branch=${encodeURIComponent(second)}`)
  await expect(page.getByTestId('main-ahead')).toContainText('main changed this workflow')
  await page.getByTestId('update-from-main').click()
  await expect(page.getByTestId('main-ahead')).toHaveCount(0)
  const tip = git(repo, 'rev-parse', `refs/heads/${second}`)
  expect(git(repo, 'rev-list', '--parents', '-n', '1', tip).split(' ')).toHaveLength(3)
  expect(mergeTreeClean('main', second)).toBe(true)
  await mergeOpenPulls(github, second)
  await trpcMutate(page, 'git.deployNow', {})
  await expect.poll(async () => blockOf(await live(), 'fromB') !== undefined, { timeout: 30_000 }).toBe(true)
  const deployed = await live()
  expect(blockOf(deployed, 'fromA')).toBeDefined()
  expect(blockOf(deployed, 'step').config.code).toBe(code12({ 1: '"A"', 7: '"B"' }))

  // A README changed on both a branch and main (main also changing the workflow) is refused, named.
  const thirdDraft = await openDraft(page, 'workflow', id, third)
  await commitDraft(page, thirdDraft, change('fromC', 4, '"C"'), 'C')
  pushFiles(repo, third, { 'README.md': 'branch\n' })
  pushFiles(repo, 'main', {
    'README.md': 'main\n',
    [`workflows/${slug}/blocks/step.js`]: `${code12({ 1: '"A"', 7: '"B"', 10: '"main"' })}\n`,
  })
  await page.goto(`/workflows/${id}?branch=${encodeURIComponent(third)}`)
  await page.getByTestId('update-from-main').click()
  await expect(page.getByText(/README\.md changed on both/)).toBeVisible()
  expect(git(repo, 'rev-list', '--parents', '-n', '1', `refs/heads/${third}`).split(' ')).toHaveLength(2)
})
