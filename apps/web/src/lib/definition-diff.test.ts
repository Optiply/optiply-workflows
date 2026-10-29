import { describe, expect, it } from 'vitest'
import { compareDefinitions, diffSummary, groupDiff } from './definition-diff'

const app = (components: object[], queries: object[] = [], layout: object = {}) => ({
  schemaVersion: 1,
  components,
  queries,
  transformers: [],
  variables: [],
  layout,
})

describe('groupDiff', () => {
  it('groups an app’s changes by collection, items whole when added or removed', () => {
    const before = app(
      [
        { name: 'title', type: 'text', props: { value: 'Orders' } },
        { name: 'old', type: 'button' },
      ],
      [{ name: 'orders', kind: 'resource', resource: 'db', query: { sql: 'select 1' }, run: 'auto' }],
      { title: { x: 0, y: 0, w: 4, h: 2 } },
    )
    const after = app(
      [
        { name: 'title', type: 'text', props: { value: 'All orders' } },
        { name: 'save', type: 'button', props: { text: 'Save' } },
      ],
      [{ name: 'orders', kind: 'resource', resource: 'db', query: { sql: 'select 2' }, run: 'auto' }],
      { title: { x: 2, y: 0, w: 4, h: 2 } },
    )
    const groups = groupDiff('app', compareDefinitions('app', before, after))
    expect(
      groups.map((g) => [g.label, g.items.map((i) => [i.name, i.status, i.changes.map((c) => c.label)])]),
    ).toEqual([
      [
        'Components',
        [
          ['old', 'removed', []],
          ['title', 'changed', ['props.value']],
          ['save', 'added', []],
        ],
      ],
      ['Queries', [['orders', 'changed', ['query.sql']]]],
      ['Layout', [['title', 'changed', ['']]]],
    ])
    const components = groups[0]!
    expect(components.items[2]!.value).toEqual({ name: 'save', type: 'button', props: { text: 'Save' } })
    expect(groups[1]!.items[0]!.changes[0]!.change).toMatchObject({
      kind: 'text',
      before: 'select 1',
      after: 'select 2',
    })
    expect(diffSummary(groups)).toEqual({ added: 1, removed: 1, changed: 3, renamed: 0 })
  })

  it('shows a rename as one item under its new name, with its other changes', () => {
    const before = app(
      [{ name: 'label', type: 'text', props: { value: '{{ orders.data.length }}' } }],
      [{ name: 'orders', kind: 'js', code: 'return [1]' }],
    )
    const after = app(
      [{ name: 'label', type: 'text', props: { value: '{{ allOrders.data.length }}' } }],
      [{ name: 'allOrders', kind: 'js', code: 'return [1]' }],
    )
    const groups = groupDiff('app', compareDefinitions('app', before, after))
    expect(groups).toEqual([
      {
        key: 'queries',
        label: 'Queries',
        reordered: false,
        items: [
          { key: 'allOrders', name: 'allOrders', status: 'renamed', renamedFrom: 'orders', changes: [] },
        ],
      },
    ])
  })

  it('names edges by their ends, and marks a reordered collection', () => {
    const code = (name: string) => ({ name, type: 'code', config: { code: 'return 1' } })
    const before = {
      settings: { timeoutMs: 1000 },
      blocks: [code('a'), code('b')],
      edges: [],
      layout: { blocks: {} },
    }
    const after = {
      settings: { timeoutMs: 2000 },
      blocks: [code('b'), code('a')],
      edges: [{ from: 'a', port: 'out', to: 'b' }],
      layout: { blocks: {} },
    }
    const groups = groupDiff('workflow', compareDefinitions('workflow', before, after))
    expect(groups.map((g) => [g.label, g.reordered, g.items.map((i) => [i.name, i.status])])).toEqual([
      ['Settings', false, [['timeoutMs', 'changed']]],
      ['Blocks', true, []],
      ['Connections', false, [['a → b', 'added']]],
    ])
  })

  it('lists a library query’s changes by where they are', () => {
    const before = { resource: 'db', query: { sql: 'select 1' }, params: [{ name: 'id' }] }
    const after = {
      resource: 'warehouse',
      query: { sql: 'select 1' },
      params: [{ name: 'id' }, { name: 'status' }],
    }
    const groups = groupDiff('library', compareDefinitions('library', before, after))
    expect(groups.map((g) => [g.label, g.items.map((i) => [i.name, i.status])])).toEqual([
      ['Resource', [['Resource', 'changed']]],
      ['Parameters', [['status', 'added']]],
    ])
  })

  it('is empty when nothing changed', () => {
    const def = app([{ name: 'x', type: 'text' }])
    expect(groupDiff('app', compareDefinitions('app', def, structuredClone(def)))).toEqual([])
  })
})
