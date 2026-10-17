import { type AppDefinition, canonicalizeApp } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { APP_FILE, APP_LAYOUT_FILE, decodeApp, encodeApp, type Files } from '../src'

const definition: AppDefinition = {
  schemaVersion: 1,
  pages: [{ name: 'list' }, { name: 'detail', title: 'Order' }],
  components: [
    { name: 'table1', type: 'table', page: 'list', props: { data: '{{ listOrders.data }}' } },
    {
      name: 'save',
      type: 'button',
      page: 'detail',
      events: [{ id: 'a', event: 'click', action: { type: 'runScript', code: 'saveOrder.trigger()' } }],
    },
  ],
  queries: [
    {
      name: 'listOrders',
      kind: 'resource',
      resource: 'shop',
      query: { sql: 'select * from orders order by {{ sql.column(table1.sort.column) }}' },
      run: 'auto',
      transform: 'return data.slice(0, 10)',
      page: 'list',
    },
    { name: 'saveOrder', kind: 'js', code: 'await listOrders.trigger()\n' },
    {
      name: 'callCrm',
      kind: 'resource',
      resource: 'crm',
      query: { method: 'POST', body: '{}' },
      run: 'manual',
    },
  ],
  transformers: [{ name: 'rows', code: 'return listOrders.data ?? []' }],
  variables: [{ name: 'picked', initialValue: null }],
  layout: { table1: { x: 0, y: 0, w: 12, h: 8 }, save: { x: 0, y: 0, w: 2, h: 1 } },
}

const app = { name: 'Order admin', description: null, definition }

describe('encodeApp', () => {
  const { files } = encodeApp(app)

  it('moves SQL, JS queries, transforms and transformers into files', () => {
    expect(Object.keys(files)).toEqual([
      APP_FILE,
      APP_LAYOUT_FILE,
      'queries/listOrders.sql',
      'queries/listOrders.transform.js',
      'queries/saveOrder.js',
      'transformers/rows.js',
    ])
    expect(files['queries/listOrders.sql']).toBe(
      'select * from orders order by {{ sql.column(table1.sort.column) }}\n',
    )
    expect(files['queries/saveOrder.js']).toBe('await listOrders.trigger()\n\n')
  })

  it('keeps props, handlers and REST queries in the JSON, and the layout apart', () => {
    const json = JSON.parse(files[APP_FILE]!)
    expect(json.name).toBe('Order admin')
    expect('description' in json).toBe(false)
    expect(json.layout).toBeUndefined()
    const queries = Object.fromEntries(json.queries.map((q: { name: string }) => [q.name, q]))
    expect(queries.listOrders).toEqual({
      name: 'listOrders',
      kind: 'resource',
      resource: 'shop',
      query: {},
      run: 'auto',
      page: 'list',
    })
    expect(queries.saveOrder).toEqual({ name: 'saveOrder', kind: 'js' })
    expect(queries.callCrm.query).toEqual({ method: 'POST', body: '{}' })
    expect(json.transformers).toEqual([{ name: 'rows' }])
    expect(json.components.find((c: { name: string }) => c.name === 'save').events[0].action.code).toBe(
      'saveOrder.trigger()',
    )
    expect(JSON.parse(files[APP_LAYOUT_FILE]!)).toEqual(definition.layout)
  })

  it('keeps an empty layout, which counts in the hash', () => {
    const empty = encodeApp({ ...app, definition: { ...definition, layout: {} } })
    expect(empty.files[APP_LAYOUT_FILE]).toBe('{}\n')
    const none = encodeApp({ ...app, definition: { ...definition, layout: undefined } })
    expect(none.files[APP_LAYOUT_FILE]).toBeUndefined()
  })
})

describe('decodeApp', () => {
  const { files } = encodeApp(app)

  it('reads the files back into the same canonical app', () => {
    expect(decodeApp(files)).toEqual({ ok: true, value: { ...app, definition: canonicalizeApp(definition) } })
    const empty = { ...definition, layout: {} }
    expect(decodeApp(encodeApp({ ...app, definition: empty }).files)).toMatchObject({
      ok: true,
      value: { definition: { layout: {} } },
    })
  })

  const problems = (changed: Files) => {
    const decoded = decodeApp(changed)
    if (decoded.ok) throw new Error('expected problems')
    return decoded.problems.map((p) => [p.path, p.code])
  }

  it('reports missing and stray files', () => {
    const { 'queries/saveOrder.js': _js, 'transformers/rows.js': _rows, ...rest } = files
    expect(problems({ ...rest, 'queries/callCrm.js': 'x', 'queries/variables.sql': 'x' })).toEqual([
      ['queries/saveOrder.js', 'missing_file'],
      ['transformers/rows.js', 'missing_file'],
      ['queries/callCrm.js', 'unexpected_file'],
      ['queries/variables.sql', 'unexpected_file'],
    ])
  })

  it('reports layout problems in layout.json', () => {
    expect(
      problems({ ...files, [APP_LAYOUT_FILE]: JSON.stringify({ table1: { x: 11, y: 0, w: 4, h: 1 } }) }),
    ).toEqual([[APP_LAYOUT_FILE, 'invalid_definition']])
  })
})
