import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * A multipage app: a global header and note on every page, a list page whose rows open a detail page with the id in
 * the URL (`utils.openPage`), Back and Forward moving between them without restarting the app, page queries running
 * only when their page is open, and the URL of a page opening it directly.
 */
test('pages: URLs with parameters, Back and Forward, page-scoped queries', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `pages-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Pages' })
  const q = (name: string, sql: string, extra: object = {}) => ({
    name,
    kind: 'resource',
    resource: 'optiply_db',
    run: 'auto',
    query: { sql },
    ...extra,
  })
  const definition = {
    schemaVersion: 1,
    pages: [
      { name: 'list', title: 'People' },
      { name: 'detail', title: 'Person' },
    ],
    components: [
      { name: 'header', type: 'text', props: { value: 'Header on {{ url.page }}' } },
      { name: 'note', type: 'textInput', props: { label: 'Note' } },
      {
        name: 'people',
        type: 'table',
        page: 'list',
        props: { data: '{{ everyone.data }}' },
        events: [
          {
            id: 'open',
            event: 'rowSelect',
            action: {
              type: 'runScript',
              code: "utils.openPage('detail', { params: { id: people.selectedRow.id } })",
            },
          },
        ],
      },
      { name: 'who', type: 'text', page: 'detail', props: { value: 'Showing {{ person.data?.[0]?.name }}' } },
    ],
    queries: [
      q('everyone', "select g as id, 'person ' || g as name from generate_series(1, 5) g", { page: 'list' }),
      q('person', "select 'person ' || {{ url.params.id }}::text as name", { page: 'detail' }),
    ],
    layout: {
      header: { x: 0, y: 0, w: 6, h: 3 },
      note: { x: 6, y: 0, w: 6, h: 4 },
      people: { x: 0, y: 0, w: 12, h: 16 },
      who: { x: 0, y: 0, w: 12, h: 3 },
    },
  }
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })

  // Which queries the app runs, and with what.
  const runs: { query: string; values: Record<string, unknown> }[] = []
  page.on('request', (r) => {
    if (!r.url().includes('apps.runQuery')) return
    for (const call of Object.values(r.postDataJSON() ?? {}) as { json?: (typeof runs)[number] }[]) {
      if (call.json) runs.push({ query: call.json.query, values: call.json.values })
    }
  })
  const ran = (query: string) => runs.filter((r) => r.query === query)
  const workers: string[] = []
  page.on('worker', (w) => {
    workers.push(w.url())
  })

  // The first page, without a page in the URL: the detail page's query doesn't run.
  await page.goto(`/apps/${slug}`)
  const header = page.locator('[data-component="header"]')
  await expect(header).toContainText('Header on list')
  await expect(page.getByRole('grid', { name: 'people' })).toContainText('person 5')
  await expect(page.locator('[data-component="who"]')).toHaveCount(0)
  expect(ran('everyone')).toHaveLength(1)
  expect(ran('person')).toHaveLength(0)
  await page.getByRole('textbox', { name: 'Note' }).fill('kept')

  // A row opens the detail page with its id in the URL.
  await page.getByRole('grid', { name: 'people' }).getByRole('gridcell', { name: 'person 3' }).click()
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}/detail\\?id=3$`))
  await expect(page.locator('[data-component="who"]')).toContainText('Showing person 3')
  await expect(header).toContainText('Header on detail')
  await expect(page.getByRole('grid', { name: 'people' })).toHaveCount(0)
  expect(ran('person').map((r) => r.values[' url.params.id '])).toEqual(['3'])

  // Back and Forward: the same app (one sandbox, the note still typed), nothing run again needlessly.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}$`))
  await expect(header).toContainText('Header on list')
  await expect(page.getByRole('grid', { name: 'people' })).toContainText('person 5')
  await page.goForward()
  await expect(page.locator('[data-component="who"]')).toContainText('Showing person 3')
  await expect(page.getByRole('textbox', { name: 'Note' })).toHaveValue('kept')
  expect(ran('everyone')).toHaveLength(1)
  expect(ran('person')).toHaveLength(1)
  expect(workers).toHaveLength(1)

  // A page's URL opens it directly; an unknown page opens the first.
  await page.goto(`/apps/${slug}/detail?id=4`)
  await expect(page.locator('[data-component="who"]')).toContainText('Showing person 4')
  await page.goto(`/apps/${slug}/nowhere`)
  await expect(header).toContainText('Header on list')
  expect(errors).toEqual([])
})
