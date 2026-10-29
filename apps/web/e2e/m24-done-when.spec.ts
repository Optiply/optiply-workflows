import { expect, type Locator, type Page, test } from '@playwright/test'
import { signIn, trpcMutate, trpcQuery } from './helpers'

/**
 * M24's done-when (architecture §2.27): the app builder's gaps. (1) Tables: a computed column and two filters in the
 * browser, a server-paged table over 10k rows filtered through `sql.where`, a column resized in the editor, two
 * added rows reaching an insert query through `newRows`; (2) the canvas: three components dragged together, one
 * dragged into a container's second view, and undo giving back the exact starting definition; (3) a container's
 * tabs switched by a button's `setView`, folded and unfolded, what's below moving up.
 */

type Def = { components: unknown[]; layout: Record<string, { x: number; y: number }> }

/** A query on the platform's database. */
const q = (name: string, sql: string, run: 'auto' | 'manual' = 'auto', events: object[] = []) => ({
  name,
  kind: 'resource',
  resource: 'optiply_db',
  run,
  query: { sql },
  ...(events.length && { events }),
})

/** The first column's values of a table's rows, as shown (read at once: filtering removes rows). */
const firstCells = (table: Locator) =>
  table
    .locator('[role="row"]')
    .evaluateAll((rows) =>
      rows.slice(1).map((r) => r.querySelector('[role="gridcell"]')?.textContent?.trim() ?? ''),
    )

/** JSON with every object's keys sorted (the shared document keeps them sorted). */
const sorted = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )

async function newApp(page: Page, slug: string, definition: object) {
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: slug })
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  return app.id
}

async function publish(page: Page, appId: string, slug: string) {
  const { draftRevision } = await trpcQuery<{ draftRevision: number }>(page, 'apps.get', { slug })
  await trpcMutate(page, 'apps.publish', { appId, draftRevision })
}

test('M24 done-when (1): computed columns, filters, sql.where over 10k rows, resizing, new rows', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const stamp = Date.now()
  const slug = `m24-tables-${stamp}`
  const big = `m24_big_${stamp}`
  const parts = `m24_parts_${stamp}`
  const where = `{{ sql.where(remote.filters, ['id', 'qty']) }}`
  const definition = {
    schemaVersion: 1,
    components: [
      {
        name: 'local',
        type: 'table',
        props: {
          showFilters: true,
          data: [
            { name: 'Apples', qty: 2, price: 3 },
            { name: 'Pears', qty: 5, price: 1 },
            { name: 'Plums', qty: 9, price: 2 },
            { name: 'Plantains', qty: 1, price: 4 },
            { name: 'Peaches', qty: 4, price: 2 },
          ],
          columns: [
            { key: 'name' },
            { key: 'qty' },
            { key: 'total', type: 'number', value: '{{ currentRow.qty * currentRow.price }}' },
          ],
        },
      },
      {
        name: 'remote',
        type: 'table',
        props: {
          showFilters: true,
          data: '{{ onePage.data }}',
          paging: 'server',
          pageSize: 10,
          totalRowCount: '{{ counted.data?.[0]?.n }}',
        },
      },
      {
        name: 'items',
        type: 'table',
        props: {
          data: '{{ everything.data }}',
          allowAddRow: true,
          columns: [{ key: 'id' }, { key: 'name' }, { key: 'qty', type: 'number' }],
        },
        events: [
          { id: 's', event: 'save', action: { type: 'controlQuery', query: 'insert', method: 'trigger' } },
        ],
      },
    ],
    queries: [
      q(
        'setup',
        `create table ${big} as select g as id, g as qty from generate_series(1, 10000) g`,
        'manual',
      ),
      q(
        'onePage',
        `select id, qty from ${big} where ${where} order by id limit {{ remote.pagination.pageSize }} offset {{ remote.pagination.offset }}`,
      ),
      q('counted', `select count(*)::int as n from ${big} where ${where}`),
      q('everything', `select id, name, qty from ${parts} order by id`),
      q(
        'insert',
        `insert into ${parts} (name, qty) select name, qty from jsonb_to_recordset({{ items.newRows }}::jsonb) as x(name text, qty int)`,
        'manual',
        [
          {
            id: 'r',
            event: 'success',
            action: { type: 'controlQuery', query: 'everything', method: 'trigger' },
          },
        ],
      ),
    ],
    layout: {
      local: { x: 0, y: 0, w: 6, h: 16 },
      remote: { x: 6, y: 0, w: 6, h: 24 },
      items: { x: 0, y: 16, w: 6, h: 16 },
    },
  }
  const appId = await newApp(page, slug, definition)
  const envs = await trpcQuery<{ id: string; slug: string }[]>(page, 'environments.list', undefined)
  const prod = envs.find((e) => e.slug === 'production')!
  const runSetup = () =>
    trpcMutate(page, 'apps.runQuery', {
      appId,
      releaseId: null,
      query: 'setup',
      environmentId: prod.id,
      values: {},
    })
  await runSetup()
  definition.queries[0] = q(
    'setup',
    `create table ${parts} (id serial primary key, name text not null, qty int)`,
    'manual',
  )
  await trpcMutate(page, 'apps.saveDraft', { id: appId, revision: 2, definition })
  await runSetup()

  await test.step('in the editor, resizing a column saves its width', async () => {
    await page.goto(`/apps/${slug}/edit`)
    const items = page.locator('[data-component="items"]')
    await items.evaluate((e) => e.scrollIntoView({ block: 'center' }))
    const header = items.getByRole('columnheader').filter({ hasText: 'name' })
    const before = (await header.boundingBox())!.width
    const edge = (await items.getByRole('separator', { name: 'Resize name' }).boundingBox())!
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
    await page.mouse.down()
    await page.mouse.move(edge.x + 40, edge.y + edge.height / 2, { steps: 4 })
    await page.mouse.move(edge.x + 80, edge.y + edge.height / 2, { steps: 4 })
    await page.mouse.up()
    await expect
      .poll(async () => {
        const got = await trpcQuery<{
          draftDefinition: { components: { name: string; props: { columns?: { width?: number }[] } }[] }
        }>(page, 'apps.get', { slug })
        return got.draftDefinition.components.find((c) => c.name === 'items')!.props.columns![1]!.width ?? 0
      })
      .toBeGreaterThan(before + 60)
  })

  await publish(page, appId, slug)
  await page.goto(`/apps/${slug}`)

  await test.step('a computed column and two filters, in the browser', async () => {
    const local = page.locator('[data-component="local"]')
    await expect.poll(() => firstCells(local)).toEqual(['Apples', 'Pears', 'Plums', 'Plantains', 'Peaches'])
    await local.getByRole('button', { name: 'Filter total' }).click()
    const bar = local.getByTestId('filter-bar')
    await bar.getByLabel('Operator').selectOption({ label: '≥' })
    await bar.getByLabel('Value').fill('6')
    await bar.getByRole('button', { name: 'Apply' }).click()
    await expect.poll(() => firstCells(local)).toEqual(['Apples', 'Plums', 'Peaches'])
    await local.getByRole('button', { name: 'Filter name' }).click()
    await local.getByTestId('filter-bar').getByLabel('Value').fill('PL')
    await local.getByTestId('filter-bar').getByLabel('Value').press('Enter')
    await expect.poll(() => firstCells(local)).toEqual(['Apples', 'Plums'])
    await expect(local).toContainText('2 of 5 rows')
  })

  await test.step('a server-paged table over 10k rows, filtered through sql.where', async () => {
    const remote = page.locator('[data-component="remote"]')
    await expect(remote).toContainText('10000 rows')
    await expect(remote).toContainText('Page 1 of 1000')
    await remote.getByRole('button', { name: 'Filter qty' }).click()
    const bar = remote.getByTestId('filter-bar')
    await bar.getByLabel('Operator').selectOption({ label: 'between' })
    await bar.getByLabel('From', { exact: true }).fill('9990')
    await bar.getByLabel('To', { exact: true }).fill('10000')
    await bar.getByRole('button', { name: 'Apply' }).click()
    await expect(remote).toContainText('11 rows')
    await expect(remote).toContainText('Page 1 of 2')
    await expect
      .poll(() => firstCells(remote))
      .toEqual(['9990', '9991', '9992', '9993', '9994', '9995', '9996', '9997', '9998', '9999'])
  })

  await test.step('two added rows reach an insert query through newRows', async () => {
    const items = page.locator('[data-component="items"]')
    await expect(items).toContainText('0 rows')
    await items.getByRole('button', { name: 'Add row' }).click()
    await items.getByRole('button', { name: 'Add row' }).click()
    const rows = items.getByTestId('new-rows')
    await rows.getByLabel('New name').first().fill('Bolts')
    await rows.getByLabel('New qty').first().fill('12')
    await rows.getByLabel('New name').nth(1).fill('Nuts')
    await rows.getByLabel('New qty').nth(1).fill('7')
    await items.getByRole('button', { name: 'Save changes' }).click()
    await expect(items.getByTestId('new-rows')).toHaveCount(0)
    // Read back from the table by the query the insert re-runs.
    await expect(items).toContainText('2 rows')
    await expect(items).toContainText('Bolts')
    await expect(items).toContainText('Nuts')
  })
  expect(errors).toEqual([])
})

test('M24 done-when (2): three components dragged together, one into a second view, all undone', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `m24-canvas-${Date.now()}`
  const text = (name: string) => ({ name, type: 'text', props: { value: `Text ${name}` } })
  const start = {
    schemaVersion: 1,
    components: [
      text('a'),
      text('b'),
      text('c'),
      {
        name: 'box',
        type: 'container',
        props: {
          views: [
            { name: 'list', label: 'List' },
            { name: 'details', label: 'Details' },
          ],
        },
      },
      { name: 'inBox', type: 'text', parent: 'box', slot: 'list', props: { value: 'In the list' } },
    ],
    queries: [],
    transformers: [],
    variables: [],
    // Already compact, as the editor keeps it.
    layout: {
      a: { x: 0, y: 0, w: 3, h: 2 },
      b: { x: 3, y: 0, w: 3, h: 2 },
      c: { x: 6, y: 0, w: 3, h: 2 },
      box: { x: 0, y: 2, w: 12, h: 14 },
      inBox: { x: 0, y: 0, w: 6, h: 2 },
    },
  }
  await newApp(page, slug, start)
  const draft = async () =>
    (await trpcQuery<{ draftDefinition: Def }>(page, 'apps.get', { slug })).draftDefinition
  await page.goto(`/apps/${slug}/edit`)

  await test.step('three selected, dragged together by one offset', async () => {
    await page.getByTestId('frame-a').click()
    await page.getByTestId('frame-b').click({ modifiers: ['Shift'] })
    await page.getByTestId('frame-c').click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('inspector-selection')).toContainText('3 components selected')
    await page.getByTestId('frame-a').evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await page.getByTestId('frame-a').hover()
    const handle = (await page.getByTestId('frame-a').getByTitle('Drag to move').boundingBox())!
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 50, from.y, { steps: 5 })
    await page.mouse.move(from.x + 100, from.y, { steps: 5 })
    await page.mouse.up()
    await expect
      .poll(async () => {
        const { layout } = await draft()
        const moved = ['a', 'b', 'c'].map((n, i) => layout[n]!.x - i * 3)
        return moved.every((x) => x === moved[0]) && moved[0]! > 0
      })
      .toBe(true)
  })

  await test.step('one dragged into the container’s second view', async () => {
    await page.keyboard.press('Escape')
    const box = page.locator('[data-component="box"]')
    await box.getByRole('tab', { name: 'Details' }).click()
    await expect(page.getByTestId('grid-box-details')).toBeVisible()
    await page.getByTestId('frame-a').evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await page.getByTestId('frame-a').hover()
    const data = await page.evaluateHandle(() => new DataTransfer())
    const grip = page.getByTestId('move-a')
    await grip.dispatchEvent('dragstart', { dataTransfer: data })
    const target = page.getByTestId('grid-box-details').locator('.react-grid-layout').first()
    const area = (await target.boundingBox())!
    const at = { dataTransfer: data, clientX: area.x + 20, clientY: area.y + 10 }
    for (const type of ['dragenter', 'dragover', 'dragover', 'drop']) await target.dispatchEvent(type, at)
    await grip.dispatchEvent('dragend', { dataTransfer: data })
    await expect
      .poll(async () => {
        const c = (await draft()).components.find((x) => (x as { name: string }).name === 'a') as {
          parent?: string
          slot?: string
        }
        return [c.parent, c.slot]
      })
      .toEqual(['box', 'details'])
    await expect(page.getByTestId('grid-box-details')).toContainText('Text a')
  })

  await test.step('undoing all of it: the exact starting definition', async () => {
    await page.locator('body').click({ position: { x: 5, y: 300 } })
    for (let i = 0; i < 2; i++) await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(async () => {
        const def = await draft()
        return sorted({ components: def.components, layout: def.layout })
      })
      .toBe(sorted({ components: start.components, layout: start.layout }))
  })
  expect(errors).toEqual([])
})

test('M24 done-when (3): tabs switched by setView, folded and unfolded, what’s below moving up', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `m24-tabs-${Date.now()}`
  const appId = await newApp(page, slug, {
    schemaVersion: 1,
    components: [
      {
        name: 'box',
        type: 'container',
        props: {
          title: 'Orders',
          collapsible: true,
          views: [
            { name: 'list', label: 'List' },
            { name: 'details', label: 'Details' },
          ],
        },
      },
      { name: 'inList', type: 'text', parent: 'box', slot: 'list', props: { value: 'The order list' } },
      { name: 'inDetails', type: 'text', parent: 'box', slot: 'details', props: { value: 'One order' } },
      {
        name: 'show',
        type: 'button',
        props: { text: 'Show details' },
        events: [
          { id: 's', event: 'click', action: { type: 'runScript', code: "await box.setView('details')" } },
        ],
      },
      { name: 'after', type: 'text', props: { value: 'Below the box' } },
    ],
    queries: [],
    transformers: [],
    variables: [],
    layout: {
      box: { x: 0, y: 0, w: 8, h: 14 },
      inList: { x: 0, y: 0, w: 6, h: 2 },
      inDetails: { x: 0, y: 0, w: 6, h: 2 },
      show: { x: 8, y: 0, w: 3, h: 2 },
      after: { x: 0, y: 14, w: 8, h: 2 },
    },
  })
  await publish(page, appId, slug)
  await page.goto(`/apps/${slug}`)
  const box = page.locator('[data-component="box"]')
  const top = async () => (await page.locator('[data-component="after"]').boundingBox())!.y

  await test.step('a button’s setView switches the tab', async () => {
    await expect(box.getByRole('tab', { name: 'List' })).toHaveAttribute('aria-selected', 'true')
    await expect(box).toContainText('The order list')
    await page.locator('[data-component="show"]').getByRole('button').click()
    await expect(box.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    await expect(box).toContainText('One order')
    await expect(box).not.toContainText('The order list')
  })

  await test.step('folded, what’s below moves up; unfolded, back', async () => {
    const before = await top()
    await box.getByRole('button', { name: 'Fold Orders' }).click()
    await expect(box).not.toContainText('One order')
    await expect.poll(top).toBeLessThan(before - 100)
    await box.getByRole('button', { name: 'Unfold Orders' }).click()
    await expect(box).toContainText('One order')
    await expect.poll(top).toBe(before)
  })
  expect(errors).toEqual([])
})
