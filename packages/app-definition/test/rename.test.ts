import { describe, expect, it } from 'vitest'
import { renameAppEntity, validateApp } from '../src'
import { app, comp, sqlQuery } from './helpers'

describe('renameAppEntity', () => {
  const def = app({
    components: [
      comp('box', 'container'),
      comp('table1', 'table', {
        data: '{{ q.data }}',
        columns: [{ key: 'id', label: '{{ q.data.length }} ids' }],
      }),
      comp(
        'btn',
        'button',
        { text: '{{ ({ q }).q.isFetching ? "…" : "Save" }}' },
        {
          parent: 'box',
          events: [
            { id: 'a', event: 'click', action: { type: 'controlQuery', query: 'q', method: 'trigger' } },
            {
              id: 'b',
              event: 'click',
              action: { type: 'runScript', code: 'const x = q.data; await q.trigger()' },
            },
          ],
        },
      ),
    ],
    queries: [
      sqlQuery('q', "select * from t where note = 'q' and id = {{ table1.selectedRow.q }}", 'manual', {
        transform: 'return data.map(q => q.id)',
      }),
    ],
    layout: { box: { x: 0, y: 0, w: 6, h: 6 }, btn: { x: 0, y: 0, w: 2, h: 2 } },
  })

  it('rewrites references, handlers, parents and the layout', () => {
    const result = renameAppEntity(def, 'q', 'customers')
    if (!result.ok) throw new Error(result.error)
    const next = result.definition
    expect(next.queries[0]!.name).toBe('customers')
    expect(next.components[1]!.props).toEqual({
      data: '{{ customers.data }}',
      columns: [{ key: 'id', label: '{{ customers.data.length }} ids' }],
    })
    // The shorthand keeps its key; a property named q and the transform's own q are left alone.
    expect(next.components[2]!.props!.text).toBe('{{ ({ q: customers }).q.isFetching ? "…" : "Save" }}')
    expect(next.queries[0]).toMatchObject({
      query: { sql: "select * from t where note = 'q' and id = {{ table1.selectedRow.q }}" },
      transform: 'return data.map(q => q.id)',
    })
    expect(next.components[2]!.events![0]!.action).toEqual({
      type: 'controlQuery',
      query: 'customers',
      method: 'trigger',
    })
    expect(next.components[2]!.events![1]!.action).toMatchObject({
      code: 'const x = customers.data; await customers.trigger()',
    })
    expect(result.changed).toHaveLength(4)
    expect(validateApp(next).ok).toBe(true)

    const moved = renameAppEntity(def, 'box', 'panel')
    if (!moved.ok) throw new Error(moved.error)
    expect(moved.definition.components[2]!.parent).toBe('panel')
    expect(Object.keys(moved.definition.layout!)).toEqual(['panel', 'btn'])
    // The original is untouched.
    expect(def.components[0]!.name).toBe('box')
  })

  it('refuses names that are taken, invalid, or captured by a local', () => {
    expect(renameAppEntity(def, 'nope', 'x')).toEqual({ ok: false, error: 'Nothing is named "nope"' })
    expect(renameAppEntity(def, 'q', 'btn')).toEqual({
      ok: false,
      error: 'Something else is already named "btn"',
    })
    expect(renameAppEntity(def, 'q', 'utils')).toMatchObject({ ok: false })
    expect(renameAppEntity(def, 'q', '1x')).toMatchObject({ ok: false })
    expect(renameAppEntity(def, 'q', 'x')).toEqual({
      ok: false,
      error: '"x" is already a variable in the code of "btn"; pick another name',
    })
  })
})
