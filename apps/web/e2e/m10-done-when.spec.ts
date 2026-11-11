import { expect, type Locator, test } from '@playwright/test'
import { E2E_MEMBER_EMAIL } from './global-setup'
import { signIn, trpcMutate } from './helpers'

/**
 * M10's done-when: a two-page app. Its list page pages, sorts and searches a 100k-row table server-side; a row opens
 * the detail page with the id in the URL; the app sits in a folder granting a group Use, through which someone who
 * isn't an admin opens it; an endless loop in its code is stopped and the tab stays responsive.
 */
test('M10 done-when: a two-page app over 100k rows, shared through a folder, surviving an endless loop', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000)
  await signIn(page)
  const stamp = Date.now()
  const slug = `m10-${stamp}`
  const table = `m10_items_${stamp}`
  const folderName = `M10 apps ${stamp}`
  const groupName = `M10 viewers ${stamp}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: `Items ${stamp}` })

  const q = (name: string, sql: string, extra: object = {}) => ({
    name,
    kind: 'resource',
    resource: 'optiply_db',
    run: 'auto',
    query: { sql },
    ...extra,
  })
  const where = `name ilike {{ '%' + items.searchText + '%' }}`
  const definition = {
    schemaVersion: 1,
    pages: [
      { name: 'list', title: 'Items' },
      { name: 'item', title: 'Item' },
    ],
    components: [
      { name: 'nav', type: 'navigation', props: {} },
      {
        name: 'items',
        type: 'table',
        page: 'list',
        props: {
          data: '{{ onePage.data }}',
          columns: [{ key: 'id' }, { key: 'name' }, { key: 'price' }],
          paging: 'server',
          pageSize: 25,
          search: true,
          totalRowCount: '{{ counted.data?.[0]?.n }}',
        },
        events: [
          {
            id: 'open',
            event: 'rowSelect',
            action: {
              type: 'runScript',
              code: "utils.openPage('item', { params: { id: items.selectedRow.id } })",
            },
          },
        ],
      },
      {
        name: 'detail',
        type: 'text',
        page: 'item',
        props: { value: '{{ oneItem.data?.[0]?.name }} costs {{ oneItem.data?.[0]?.price }}' },
      },
      {
        name: 'recalculate',
        type: 'button',
        page: 'item',
        props: { text: 'Recalculate' },
        events: [
          { id: 'spin', event: 'click', action: { type: 'controlQuery', query: 'spin', method: 'trigger' } },
        ],
      },
    ],
    queries: [
      q('setup', `create table ${table} (id int primary key, name text not null, price int not null)`, {
        run: 'manual',
      }),
      q(
        'onePage',
        `select id, name, price from ${table} where ${where}
         order by {{ sql.column(items.sort?.column, ['id', 'name', 'price'], 'id') }} {{ sql.direction(items.sort?.desc) }}
         limit {{ items.pagination.pageSize }} offset {{ items.pagination.offset }}`,
        { page: 'list' },
      ),
      q('counted', `select count(*)::int as n from ${table} where ${where}`, { page: 'list' }),
      q('oneItem', `select name, price from ${table} where id = {{ url.params.id }}::int`, { page: 'item' }),
      { name: 'spin', kind: 'js', page: 'item', code: 'while (true) {}' },
    ],
    layout: {
      nav: { x: 0, y: 0, w: 12, h: 3 },
      items: { x: 0, y: 0, w: 12, h: 60 },
      detail: { x: 0, y: 0, w: 9, h: 3 },
      recalculate: { x: 9, y: 0, w: 3, h: 3 },
    },
  }
  const envs = await page.request.get('/api/trpc/environments.list')
  const prod = (await envs.json()).result.data.json.find((e: { slug: string }) => e.slug === 'production')
  const setup = () =>
    trpcMutate(page, 'apps.runQuery', {
      appId: app.id,
      releaseId: null,
      query: 'setup',
      environmentId: prod.id,
      values: {},
    })
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  await setup()
  definition.queries[0] = q(
    'setup',
    `insert into ${table} select g, 'item ' || g, g % 997 from generate_series(1, 100000) g`,
    { run: 'manual' },
  )
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 2, definition })
  await setup()
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 3 })

  // A group with the member in it, and nothing granted to it but the folder below.
  const users = await (await page.request.get('/api/trpc/users.list')).json()
  const member = users.result.data.json.find((u: { email: string }) => u.email === E2E_MEMBER_EMAIL)
  const group = await trpcMutate<{ id: string }>(page, 'groups.create', { name: groupName })
  await trpcMutate(page, 'groups.addMember', { groupId: group.id, userId: member.id })

  // The admin makes an app folder.
  await page.goto('/apps')
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill(folderName)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const folderRow = page.getByRole('listitem', { name: `Subfolder ${folderName}` })
  await expect(folderRow).toBeVisible()

  // The member isn't an admin: before the folder's grant, the app isn't theirs to see or open.
  const context = await browser.newContext()
  const viewer = await context.newPage()
  const errors: string[] = []
  viewer.on('pageerror', (e) => errors.push(e.message))
  const offsets: number[] = []
  viewer.on('request', (r) => {
    if (!r.url().includes('apps.runQuery')) return
    for (const call of Object.values(r.postDataJSON() ?? {}) as {
      json?: { query: string; values: Record<string, number> }
    }[]) {
      if (call.json?.query === 'onePage') offsets.push(call.json.values[' items.pagination.offset ']!)
    }
  })
  await signIn(viewer, E2E_MEMBER_EMAIL)
  await viewer.goto('/apps')
  await expect(viewer.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
  await expect(viewer.getByTestId(`app-${slug}`)).toHaveCount(0)
  // Folders exist, but none they manage and nothing in them for them: the empty state, not a blank page.
  await expect(viewer.getByText('No apps yet')).toBeVisible()
  await viewer.goto(`/apps/${slug}`)
  await expect(viewer.getByRole('link', { name: 'Open the editor' })).toBeVisible()

  // The admin moves the app into the folder and grants the group Use on it.
  await page.getByTitle(`Actions for Items ${stamp}`).click()
  await page.getByTitle(`Move Items ${stamp} to a folder`).click()
  await page.getByLabel(`Folder of Items ${stamp}`).selectOption({ label: folderName })
  await page.getByTestId('move-confirm').click()
  await expect(folderRow).toContainText('1 app')
  await folderRow.getByRole('link', { name: folderName }).click()
  const folder = page.getByRole('region', { name: `Folder ${folderName}` })
  await expect(folder.getByTestId(`app-${slug}`)).toBeVisible()
  // Open, its Access sits beside its path.
  await page.getByRole('button', { name: 'Access' }).click()
  const access = page.getByRole('dialog', { name: `Access to ${folderName}` })
  await access.getByLabel('Group').selectOption({ label: groupName })
  await expect(access.getByLabel('Environment')).toHaveCount(0)
  await access.getByRole('button', { name: 'Grant' }).click()
  await expect(access).toContainText(groupName)
  await page.keyboard.press('Escape')

  // Through the folder, the app is theirs to use.
  await viewer.goto('/apps')
  await viewer
    .getByRole('listitem', { name: `Subfolder ${folderName}` })
    .getByRole('link', { name: folderName })
    .click()
  const viewerFolder = viewer.getByRole('region', { name: `Folder ${folderName}` })
  await expect(viewerFolder.getByTestId(`app-${slug}`)).toBeVisible()
  await viewerFolder.getByText(`Items ${stamp}`).click()
  await expect(viewer).toHaveURL(new RegExp(`/apps/${slug}$`))

  // The list page: 100,000 rows, fetched 25 at a time.
  const grid = viewer.locator('[data-component="items"]')
  await expect(grid).toContainText('100000 rows')
  await expect(grid).toContainText('Page 1 of 4000')
  await expect.poll(() => ids(grid)).toEqual(range(1, 25))
  await grid.getByRole('button', { name: 'Next page' }).click()
  await expect(grid).toContainText('Page 2 of 4000')
  await expect.poll(() => ids(grid)).toEqual(range(26, 50))
  expect(offsets).toContain(25)
  expect(await grid.locator('[role="row"][data-row]').count()).toBeLessThanOrEqual(25)

  // Sorted by id, descending, on the server: back to the first page.
  const idHeader = grid.getByRole('columnheader', { name: 'id' }).getByRole('button')
  await idHeader.click()
  await idHeader.click()
  await expect(grid).toContainText('Page 1 of 4000')
  await expect.poll(() => ids(grid)).toEqual(range(99976, 100000).reverse())

  // Searched on the server: "item 4242" is 4242 and 42420–42429.
  await grid.getByRole('searchbox', { name: 'Search items' }).fill('item 4242')
  await expect(grid).toContainText('11 rows')
  await expect(grid).toContainText('Page 1 of 1')
  await expect
    .poll(() => ids(grid))
    .toEqual([42429, 42428, 42427, 42426, 42425, 42424, 42423, 42422, 42421, 42420, 4242])

  // A row opens the detail page with its id in the URL.
  await grid.getByRole('gridcell', { name: 'item 42425', exact: true }).click()
  await expect(viewer).toHaveURL(new RegExp(`/apps/${slug}/item\\?id=42425$`))
  const detail = viewer.locator('[data-component="detail"]')
  await expect(detail).toContainText(`item 42425 costs ${42425 % 997}`)
  await expect(viewer).toHaveTitle(`Item · Items ${stamp}`)

  // Back to the list through the navigation: the search is still there.
  await viewer.getByRole('navigation', { name: 'nav' }).getByRole('link', { name: 'Items' }).click()
  await expect(grid.getByRole('searchbox', { name: 'Search items' })).toHaveValue('item 4242')
  await viewer.goBack()
  await expect(detail).toContainText(`item 42425 costs ${42425 % 997}`)

  // An endless loop in the app's code: the tab keeps drawing, the app is stopped, Restart brings it back.
  await viewer.getByRole('button', { name: 'Recalculate' }).click()
  const frames = await viewer.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0
        const start = performance.now()
        const tick = () => {
          count++
          if (performance.now() - start < 1000) requestAnimationFrame(tick)
          else resolve(count)
        }
        requestAnimationFrame(tick)
      }),
  )
  expect(frames).toBeGreaterThan(20)
  const stopped = viewer.getByRole('alert').filter({ hasText: 'stopped responding' })
  await expect(stopped).toBeVisible({ timeout: 10_000 })
  await stopped.getByRole('button', { name: 'Restart' }).click()
  await expect(stopped).toBeHidden()
  await expect(detail).toContainText(`item 42425 costs ${42425 % 997}`)
  expect(errors).toEqual([])
  await context.close()
})

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

async function ids(table: Locator): Promise<number[]> {
  return (await table.locator('[role="gridcell"][data-column="id"]').allInnerTexts()).map(Number)
}
