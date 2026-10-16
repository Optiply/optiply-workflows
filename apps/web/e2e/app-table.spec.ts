import { expect, type Locator, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * Table paging, sorting and search on 120 rows of a managed table: one table pages, sorts and searches them in the
 * browser; the other fetches each page with its query (`pagination`, `sql.column`/`sql.direction` for the sort,
 * `searchText`), so the browser only ever holds ten rows.
 */
test('tables page, sort and search, in the browser and on the server', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const stamp = Date.now()
  const slug = `paging-${stamp}`
  const table = `items_${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Paging' })
  const q = (name: string, sql: string, run: 'auto' | 'manual' = 'auto') => ({
    name,
    kind: 'resource',
    resource: 'optiply_db',
    run,
    query: { sql },
  })
  const where = `name ilike {{ '%' + remote.searchText + '%' }}`
  const definition = {
    schemaVersion: 1,
    components: [
      {
        name: 'local',
        type: 'table',
        props: { data: '{{ everything.data }}', paging: 'pages', pageSize: 10, search: true },
      },
      {
        name: 'remote',
        type: 'table',
        props: {
          data: '{{ onePage.data }}',
          paging: 'server',
          pageSize: 10,
          search: true,
          totalRowCount: '{{ counted.data?.[0]?.n }}',
        },
      },
    ],
    queries: [
      q('setup', `create table ${table} (id int primary key, name text not null)`, 'manual'),
      q('everything', `select id, name from ${table} order by id`),
      q(
        'onePage',
        `select id, name from ${table} where ${where}
         order by {{ sql.column(remote.sort?.column, ['id', 'name'], 'id') }} {{ sql.direction(remote.sort?.desc) }}
         limit {{ remote.pagination.pageSize }} offset {{ remote.pagination.offset }}`,
      ),
      q('counted', `select count(*)::int as n from ${table} where ${where}`),
    ],
    layout: { local: { x: 0, y: 0, w: 6, h: 24 }, remote: { x: 6, y: 0, w: 6, h: 24 } },
  }
  const envs = await page.request.get('/api/trpc/environments.list')
  const prod = (await envs.json()).result.data.json.find((e: { slug: string }) => e.slug === 'production')
  const runSetup = (revision: number) =>
    trpcMutate(page, 'apps.runQuery', {
      appId: app.id,
      releaseId: null,
      query: 'setup',
      environmentId: prod.id,
      values: {},
    }).then(() => revision)
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  await runSetup(2)
  definition.queries[0] = q(
    'setup',
    `insert into ${table} select g, 'item ' || g from generate_series(1, 120) g`,
    'manual',
  )
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 2, definition })
  await runSetup(3)
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 3 })

  // The server's queries, to see that the remote table asks for one page at a time.
  const pages: number[] = []
  page.on('request', (r) => {
    if (!r.url().includes('apps.runQuery')) return
    // Batched: `{ "0": { json: input }, … }`.
    for (const call of Object.values(r.postDataJSON() ?? {}) as {
      json?: { query: string; values: object }
    }[]) {
      if (call.json?.query === 'onePage') {
        pages.push((call.json.values as Record<string, number>)[' remote.pagination.offset ']!)
      }
    }
  })

  await page.goto(`/apps/${slug}`)
  const local = page.locator('[data-component="local"]')
  const remote = page.locator('[data-component="remote"]')

  // In the browser: 120 rows in pages of 10.
  await expect(local).toContainText('120 rows')
  await expect(local).toContainText('Page 1 of 12')
  await expect.poll(() => ids(local)).toEqual(range(1, 10))
  await local.getByRole('button', { name: 'Next page' }).click()
  await expect(local).toContainText('Page 2 of 12')
  await expect.poll(() => ids(local)).toEqual(range(11, 20))
  await expect(local.getByRole('button', { name: 'Previous page' })).toBeEnabled()
  // Sorting goes back to the first page.
  await header(local, 'id').click()
  await header(local, 'id').click()
  await expect(local.getByRole('columnheader', { name: 'id' })).toHaveAttribute('aria-sort', 'descending')
  await expect(local).toContainText('Page 1 of 12')
  await expect.poll(() => ids(local)).toEqual(range(111, 120).reverse())
  // Search, on what the cells show.
  await local.getByRole('searchbox', { name: 'Search local' }).fill('item 11')
  await expect(local).toContainText('11 of 120 rows')
  await expect(local).toContainText('Page 1 of 2')
  await expect.poll(() => ids(local)).toEqual([119, 118, 117, 116, 115, 114, 113, 112, 111, 110])
  await local.getByRole('button', { name: 'Next page' }).click()
  await expect.poll(() => ids(local)).toEqual([11])
  await expect(local.getByRole('button', { name: 'Next page' })).toBeDisabled()

  // On the server: the query fetches each page; the count comes from its own query.
  await expect(remote).toContainText('120 rows')
  await expect(remote).toContainText('Page 1 of 12')
  await expect.poll(() => ids(remote)).toEqual(range(1, 10))
  await remote.getByRole('button', { name: 'Next page' }).click()
  await expect(remote).toContainText('Page 2 of 12')
  await expect.poll(() => ids(remote)).toEqual(range(11, 20))
  expect(pages).toContain(10)
  await header(remote, 'id').click()
  await header(remote, 'id').click()
  await expect(remote).toContainText('Page 1 of 12')
  await expect.poll(() => ids(remote)).toEqual(range(111, 120).reverse())
  await remote.getByRole('searchbox', { name: 'Search remote' }).fill('item 4')
  await expect(remote).toContainText('11 rows')
  await expect(remote).toContainText('Page 1 of 2')
  await expect.poll(() => ids(remote)).toEqual([49, 48, 47, 46, 45, 44, 43, 42, 41, 40])
  await remote.getByRole('button', { name: 'Next page' }).click()
  await expect.poll(() => ids(remote)).toEqual([4])
  // The browser never held more than a page.
  expect(await remote.locator('[role="row"][data-row]').count()).toBeLessThanOrEqual(10)
  expect(errors).toEqual([])
})

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

async function ids(table: Locator): Promise<number[]> {
  const cells = await table.locator('[role="gridcell"][data-column="id"]').allInnerTexts()
  return cells.map(Number)
}

function header(table: Locator, column: string): Locator {
  return table.getByRole('columnheader', { name: column }).getByRole('button')
}
