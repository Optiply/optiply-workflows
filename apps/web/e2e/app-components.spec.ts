import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

const q = (name: string, sql: string, run: 'auto' | 'manual' = 'manual', extra: object = {}) => ({
  name,
  kind: 'resource',
  resource: 'optiply_db',
  query: { sql },
  run,
  ...extra,
})
const on = (id: string, event: string, action: object) => ({ id, event, action })

/**
 * A published CRUD app on a managed table, used the way people will: a search box filtering the table through an
 * automatic query, cells edited and saved with one query over the changeset, a form adding a row (its required
 * field checked first), and a row selected and deleted after a confirmation.
 */
test('a CRUD app: search, edit cells and save, add with a form, delete', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  const slug = `crud-${Date.now()}`
  const table = `people_${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'People' })
  const definition = {
    schemaVersion: 1,
    components: [
      { name: 'search', type: 'textInput', props: { label: 'Search', placeholder: 'Name contains…' } },
      {
        name: 'people',
        type: 'table',
        props: {
          data: '{{ list.data }}',
          columns: [
            { key: 'id' },
            { key: 'name', editable: true },
            { key: 'city', editable: true },
            { key: 'vip', editable: true },
          ],
        },
        events: [on('a', 'save', { type: 'controlQuery', query: 'save', method: 'trigger' })],
      },
      {
        name: 'picked',
        type: 'text',
        props: { value: 'Selected: {{ people.selectedRow?.name ?? "nobody" }}' },
      },
      {
        name: 'remove',
        type: 'button',
        props: { text: 'Delete selected', variant: 'danger', disabled: '{{ !people.selectedRow }}' },
        events: [on('b', 'click', { type: 'controlQuery', query: 'del', method: 'trigger' })],
      },
      {
        name: 'addForm',
        type: 'form',
        props: { title: 'New person', submitText: 'Add' },
        events: [on('c', 'submit', { type: 'controlQuery', query: 'insert', method: 'trigger' })],
      },
      {
        name: 'newName',
        type: 'textInput',
        parent: 'addForm',
        props: { label: 'Name', required: true, formDataKey: 'name' },
      },
      {
        name: 'newCity',
        type: 'select',
        parent: 'addForm',
        props: { label: 'City', options: ['Amsterdam', 'Utrecht', 'Delft'], formDataKey: 'city' },
      },
      { name: 'newVip', type: 'checkbox', parent: 'addForm', props: { label: 'VIP', formDataKey: 'vip' } },
    ],
    queries: [
      q(
        'list',
        `select id, name, city, vip from ${table} where name ilike {{ '%' + (search.value ?? '') + '%' }} order by id`,
        'auto',
      ),
      q(
        'save',
        `update ${table} t set name = coalesce(x.name, t.name), city = coalesce(x.city, t.city), vip = coalesce(x.vip, t.vip)
         from jsonb_to_recordset({{ people.changesetArray }}::jsonb) as x(id bigint, name text, city text, vip boolean)
         where t.id = x.id`,
        'manual',
        { events: [on('d', 'success', { type: 'controlQuery', query: 'list', method: 'trigger' })] },
      ),
      q(
        'insert',
        `insert into ${table} (name, city, vip) values ({{ addForm.data.name }}, {{ addForm.data.city }}, {{ addForm.data.vip }})`,
        'manual',
        {
          events: [on('e', 'success', { type: 'controlQuery', query: 'list', method: 'trigger' })],
        },
      ),
      q('del', `delete from ${table} where id = {{ people.selectedRow.id }}`, 'manual', {
        confirm: 'Delete {{ people.selectedRow.name }}?',
        events: [on('f', 'success', { type: 'controlQuery', query: 'list', method: 'trigger' })],
      }),
      q('setup', 'select 1'),
    ],
    layout: {
      search: { x: 0, y: 0, w: 4, h: 3 },
      picked: { x: 4, y: 1, w: 4, h: 2 },
      remove: { x: 9, y: 1, w: 3, h: 2 },
      people: { x: 0, y: 3, w: 8, h: 16 },
      addForm: { x: 8, y: 3, w: 4, h: 16 },
      newName: { x: 0, y: 0, w: 12, h: 3 },
      newCity: { x: 0, y: 3, w: 12, h: 3 },
      newVip: { x: 0, y: 6, w: 12, h: 2 },
    },
  }
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  const envs = await page.request.get('/api/trpc/environments.list')
  const prod = (await envs.json()).result.data.json.find((e: { slug: string }) => e.slug === 'production')
  // The table is made and filled through the draft's `setup` query, one statement at a time.
  definition.queries[4] = q(
    'setup',
    `create table ${table} (id bigint generated always as identity primary key, name text not null, city text, vip boolean not null default false)`,
  )
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 2, definition })
  await trpcMutate(page, 'apps.runQuery', {
    appId: app.id,
    releaseId: null,
    query: 'setup',
    environmentId: prod.id,
    values: {},
  })
  definition.queries[4] = q(
    'setup',
    `insert into ${table} (name, city) values ('Ada', 'Amsterdam'), ('Grace', 'Utrecht'), ('Alan', 'Delft')`,
  )
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 3, definition })
  await trpcMutate(page, 'apps.runQuery', {
    appId: app.id,
    releaseId: null,
    query: 'setup',
    environmentId: prod.id,
    values: {},
  })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 4 })

  await page.goto(`/apps/${slug}`)
  const grid = page.getByRole('grid', { name: 'people' })
  await expect(grid.getByRole('row')).toHaveCount(4)
  await page.getByLabel('Search').fill('a')
  await expect(grid.getByRole('row')).toHaveCount(4) // Ada, Grace, Alan all contain an "a"
  await page.getByLabel('Search').fill('gr')
  await expect(grid.getByRole('row')).toHaveCount(2)
  await page.getByLabel('Search').fill('')
  await expect(grid.getByRole('row')).toHaveCount(4)

  // Edit two cells, then save.
  await grid.locator('[data-row="0"] [data-column="name"]').dblclick()
  await page.getByLabel('Cell value').fill('Ada Lovelace')
  await page.getByLabel('Cell value').press('Enter')
  await grid.locator('[data-row="1"] [data-column="city"]').dblclick()
  await page.getByLabel('Cell value').fill('Rotterdam')
  await page.getByLabel('Cell value').press('Escape') // cancelled
  await grid.locator('[data-row="2"] [data-column="vip"] input').check()
  await expect(page.getByText('2 changed rows')).toBeVisible()
  await expect(grid.locator('[data-row="0"] [data-column="id"]')).not.toHaveClass(/bg-warning-soft/)
  await expect(grid.locator('[data-row="0"] [data-column="name"]')).toHaveClass(/bg-warning-soft/)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('2 changed rows')).toBeHidden()
  await expect(grid.locator('[data-row="0"] [data-column="name"]')).toHaveText('Ada Lovelace')
  await expect(grid.locator('[data-row="1"] [data-column="city"]')).toHaveText('Utrecht')
  await expect(grid.locator('[data-row="2"] [data-column="vip"] input')).toBeChecked()

  // Add through the form.
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Fill in Name' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Barbara')
  await page.getByLabel('City', { exact: true }).selectOption('Delft')
  await page.getByRole('checkbox', { name: 'VIP', exact: true }).check()
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(grid.getByRole('row')).toHaveCount(5)
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('')

  // Select and delete, after confirming.
  await grid.locator('[data-row="3"] [data-column="name"]').click()
  await expect(page.locator('[data-component="picked"]')).toHaveText('Selected: Barbara')
  await page.getByRole('button', { name: 'Delete selected' }).click()
  await expect(page.getByRole('dialog')).toContainText('Delete Barbara?')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(grid.getByRole('row')).toHaveCount(4)
  expect(errors).toEqual([])
})
