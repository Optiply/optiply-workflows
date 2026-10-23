import { describe, expect, it } from 'vitest'
import { appSpec, composeText, type MergeConflict, merge, mergeText, workflowSpec } from '../src'

const code = (name: string, text: string) => ({ name, type: 'code', config: { code: text } })
const query = (name: string, sql: string, resource = 'db') => ({
  name,
  type: 'resourceQuery',
  config: { resource, query: { sql } },
})

/** A workflow with the given blocks and edges, laid out on one row. */
const workflow = <B extends { name: string }>(
  blocks: B[],
  edges: { from: string; port: string; to: string }[] = [],
) => ({
  settings: { timeoutMs: 30_000 },
  blocks,
  edges,
  layout: { blocks: Object.fromEntries(blocks.map((b, i) => [b.name, { x: i * 200, y: 0 }])) },
})

const lines = (...l: string[]) => l.join('\n')

describe('merge: values', () => {
  const base = workflow([code('a', 'return 1'), query('q', 'select 1')])

  it('takes the side that changed, and either when both changed alike', () => {
    const changed = { ...base, settings: { timeoutMs: 60_000 } }
    expect(merge(workflowSpec, base, base, changed)).toEqual({ merged: changed, conflicts: [] })
    expect(merge(workflowSpec, base, changed, base)).toEqual({ merged: changed, conflicts: [] })
    expect(merge(workflowSpec, base, changed, structuredClone(changed))).toEqual({
      merged: changed,
      conflicts: [],
    })
  })

  it('merges objects key by key', () => {
    const ours = { ...base, settings: { timeoutMs: 60_000 } }
    const theirs = { ...base, settings: { timeoutMs: 30_000, retries: 2 } }
    expect(merge(workflowSpec, base, ours, theirs).merged.settings).toEqual({ timeoutMs: 60_000, retries: 2 })
  })

  it('reports a value both changed differently, ours in the merge until resolved', () => {
    const ours = workflow([code('a', 'return 1'), query('q', 'select 1', 'warehouse')])
    const theirs = workflow([code('a', 'return 1'), query('q', 'select 1', 'replica')])
    const { merged, conflicts } = merge(workflowSpec, base, ours, theirs)
    expect(conflicts).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{28}$/),
        kind: 'value',
        at: ['blocks', 'q', 'config', 'resource'],
        base: 'db',
        ours: 'warehouse',
        theirs: 'replica',
      },
    ])
    expect(merged).toEqual(ours)
    const id = conflicts[0]!.id
    expect(merge(workflowSpec, base, ours, theirs, { [id]: 'theirs' })).toEqual({
      merged: theirs,
      conflicts: [],
    })
    expect(merge(workflowSpec, base, ours, theirs, { [id]: 'ours' })).toEqual({ merged: ours, conflicts: [] })
  })

  it('reports a key deleted on one side and changed on the other', () => {
    const ours = { ...base, settings: {} }
    const theirs = { ...base, settings: { timeoutMs: 1000 } }
    const { conflicts } = merge(workflowSpec, base, ours, theirs)
    expect(conflicts).toMatchObject([
      { kind: 'value', at: ['settings', 'timeoutMs'], ours: undefined, theirs: 1000 },
    ])
    const resolved = merge(workflowSpec, base, ours, theirs, { [conflicts[0]!.id]: 'ours' })
    expect(resolved).toEqual({ merged: ours, conflicts: [] })
  })

  it('keeps an atomic value whole: a position moved on both sides is one conflict', () => {
    const move = (x: number, y: number) => ({
      ...base,
      layout: { blocks: { ...base.layout.blocks, a: { x, y } } },
    })
    const { conflicts } = merge(workflowSpec, base, move(50, 0), move(0, 50))
    expect(conflicts).toMatchObject([{ kind: 'value', at: ['layout', 'blocks', 'a'], ours: { x: 50, y: 0 } }])
  })

  it('merges an array without an identity as a value', () => {
    const app = (options: string[]) => ({
      components: [{ name: 'select1', type: 'select', props: { label: 'Pick' }, options }],
    })
    const b = app(['a', 'b'])
    expect(merge(appSpec, b, app(['a', 'b', 'c']), b).merged).toEqual(app(['a', 'b', 'c']))
    expect(merge(appSpec, b, app(['a']), app(['b'])).conflicts).toMatchObject([
      { kind: 'value', at: ['components', 'select1', 'options'] },
    ])
  })
})

describe('merge: text', () => {
  const base = lines('const a = 1', 'const b = 2', 'const c = 3', 'return a + b + c')

  it('applies changes to different lines from both sides', () => {
    const ours = base.replace('const a = 1', 'const a = 10')
    const theirs = base.replace('const c = 3', 'const c = 30')
    const w = (text: string) => workflow([code('a', text)])
    const { merged, conflicts } = merge(workflowSpec, w(base), w(ours), w(theirs))
    expect(conflicts).toEqual([])
    expect(merged.blocks[0]!.config.code).toBe(
      lines('const a = 10', 'const b = 2', 'const c = 30', 'return a + b + c'),
    )
  })

  it('keeps trailing newlines and empty texts exactly', () => {
    expect(mergeText('a\n', 'a\nb\n', 'z\na\n')).toEqual({
      chunks: [{ ok: ['z', 'a', 'b', ''] }],
      clean: true,
    })
    expect(composeText(mergeText('', '', 'x').chunks, [])).toBe('x')
  })

  it('reports lines both changed, with each chunk', () => {
    const ours = base.replace('const b = 2', 'const b = 20')
    const theirs = base.replace('const b = 2', 'const b = 200')
    const w = (text: string) => workflow([code('a', text)])
    const { conflicts } = merge(workflowSpec, w(base), w(ours), w(theirs))
    expect(conflicts).toHaveLength(1)
    const conflict = conflicts[0] as Extract<MergeConflict, { kind: 'text' }>
    expect(conflict).toMatchObject({
      kind: 'text',
      at: ['blocks', 'a', 'config', 'code'],
      base,
      ours,
      theirs,
    })
    expect(conflict.chunks).toEqual([
      { ok: ['const a = 1'] },
      { conflict: { base: ['const b = 2'], ours: ['const b = 20'], theirs: ['const b = 200'] } },
      { ok: ['const c = 3', 'return a + b + c'] },
    ])

    const resolve = (r: Parameters<typeof merge>[4]) => merge(workflowSpec, w(base), w(ours), w(theirs), r)
    expect(resolve({ [conflict.id]: { chunks: ['theirs'] } }).merged.blocks[0]!.config.code).toBe(theirs)
    expect(resolve({ [conflict.id]: { chunks: ['both'] } }).merged.blocks[0]!.config.code).toBe(
      lines('const a = 1', 'const b = 20', 'const b = 200', 'const c = 3', 'return a + b + c'),
    )
    expect(resolve({ [conflict.id]: { text: 'return 0' } })).toEqual({ merged: w('return 0'), conflicts: [] })
    // Choices that don't fit the chunks resolve nothing.
    expect(resolve({ [conflict.id]: { chunks: ['ours', 'theirs'] } }).conflicts).toHaveLength(1)
  })

  it('merges only the spec’s text fields line by line', () => {
    const w = (name: string) => workflow([{ ...code('a', 'x'), config: { code: 'x', note: name } }])
    // `config.note` isn't text: a one-line change on each side is a value conflict, not a text one.
    expect(merge(workflowSpec, w('a\nb'), w('A\nb'), w('a\nB')).conflicts).toMatchObject([{ kind: 'value' }])
  })

  it('merges a query’s SQL in an app', () => {
    const app = (sql: string) => ({ queries: [{ name: 'list', type: 'resource', query: { sql } }] })
    const base = lines('select *', 'from orders', 'limit 10')
    const { merged } = merge(
      appSpec,
      app(base),
      app(base.replace('select *', 'select id')),
      app(base.replace('limit 10', 'limit 50')),
    )
    expect(merged.queries[0]!.query.sql).toBe(lines('select id', 'from orders', 'limit 50'))
  })
})

describe('merge: items', () => {
  const base = workflow([code('a', 'return 1'), code('b', 'return 2')], [{ from: 'a', port: 'out', to: 'b' }])

  it('keeps items added on both sides, theirs after the one before it there', () => {
    const ours = workflow([code('a', 'return 1'), code('x', 'x'), code('b', 'return 2')], base.edges)
    const theirs = workflow(
      [code('a', 'return 1'), code('b', 'return 2'), code('y', 'y')],
      [...base.edges, { from: 'b', port: 'out', to: 'y' }],
    )
    const { merged, conflicts } = merge(workflowSpec, base, ours, theirs)
    expect(conflicts).toEqual([])
    expect(merged.blocks.map((b) => b.name)).toEqual(['a', 'x', 'b', 'y'])
    expect(merged.edges).toEqual([
      { from: 'a', port: 'out', to: 'b' },
      { from: 'b', port: 'out', to: 'y' },
    ])
    expect(Object.keys(merged.layout.blocks)).toEqual(['a', 'x', 'b', 'y'])
  })

  it('deletes an item deleted on one side and unchanged on the other', () => {
    const ours = workflow([code('a', 'return 1')])
    const theirs = workflow([code('a', 'return 10'), code('b', 'return 2')], base.edges)
    const { merged, conflicts } = merge(workflowSpec, base, ours, theirs)
    expect(conflicts).toEqual([])
    expect(merged).toEqual(workflow([code('a', 'return 10')]))
  })

  it('reports an item deleted on one side and changed on the other, whole', () => {
    const ours = workflow([code('a', 'return 1')])
    const theirs = workflow([code('a', 'return 1'), code('b', 'return 20')], base.edges)
    const { conflicts } = merge(workflowSpec, base, ours, theirs)
    // The block, and its canvas position (deleted with it, unchanged there): one conflict on the block.
    expect(conflicts).toMatchObject([
      {
        kind: 'item',
        at: ['blocks', 'b'],
        base: code('b', 'return 2'),
        ours: undefined,
        theirs: code('b', 'return 20'),
      },
    ])
    const id = conflicts[0]!.id
    expect(merge(workflowSpec, base, ours, theirs, { [id]: 'ours' })).toEqual({ merged: ours, conflicts: [] })
    // Theirs brings the block back where it was; the edge and position ours deleted with it stay deleted.
    const back = merge(workflowSpec, base, ours, theirs, { [id]: 'theirs' })
    expect(back.conflicts).toEqual([])
    expect(back.merged.blocks).toEqual(theirs.blocks)
    expect(back.merged.edges).toEqual([])
  })

  it('brings back a deleted item where base had it', () => {
    const b3 = workflow([code('a', '1'), code('b', '2'), code('c', '3')])
    const ours = workflow([code('a', '1'), code('c', '3')])
    const theirs = workflow([code('a', '1'), code('b', '20'), code('c', '3')])
    const { conflicts } = merge(workflowSpec, b3, ours, theirs)
    const { merged } = merge(workflowSpec, b3, ours, theirs, { [conflicts[0]!.id]: 'theirs' })
    expect(merged.blocks.map((b) => b.name)).toEqual(['a', 'b', 'c'])
  })

  it('merges an item added on both sides as two changes from nothing', () => {
    const empty = workflow([])
    const same = merge(workflowSpec, empty, workflow([code('n', 'x')]), workflow([code('n', 'x')]))
    expect(same).toEqual({ merged: workflow([code('n', 'x')]), conflicts: [] })
    const { conflicts } = merge(workflowSpec, empty, workflow([code('n', 'x')]), workflow([code('n', 'y')]))
    expect(conflicts).toMatchObject([{ kind: 'text', at: ['blocks', 'n', 'config', 'code'], base: '' }])
  })

  it('merges an item whose type changed whole', () => {
    const ours = workflow([code('a', 'return 1'), query('b', 'select 2')], base.edges)
    const theirs = workflow([code('a', 'return 1'), code('b', 'return 3')], base.edges)
    expect(merge(workflowSpec, base, ours, theirs).conflicts).toMatchObject([
      { kind: 'item', at: ['blocks', 'b'] },
    ])
    // A type change on one side alone is just taken.
    expect(merge(workflowSpec, base, ours, base).merged).toEqual(ours)
  })

  it('merges a repeated identity as a value', () => {
    const twice = workflow([code('a', 'one'), code('a', 'two')])
    expect(merge(workflowSpec, base, twice, workflow([code('a', 'three')])).conflicts).toMatchObject([
      { kind: 'value', at: ['blocks'] },
    ])
  })

  it('merges an app’s components, their props and event handlers', () => {
    const app = (label: string, handlers: { id: string; event: string }[]) => ({
      components: [{ name: 'button1', type: 'button', props: { label }, events: handlers }],
    })
    const base = app('Save', [{ id: 'h1', event: 'click' }])
    const ours = app('Save now', [{ id: 'h1', event: 'click' }])
    const theirs = app('Save', [
      { id: 'h1', event: 'click' },
      { id: 'h2', event: 'click' },
    ])
    expect(merge(appSpec, base, ours, theirs)).toEqual({
      merged: app('Save now', theirs.components[0]!.events),
      conflicts: [],
    })
  })
})

describe('merge: resolutions', () => {
  const base = workflow([code('a', 'return 1')])
  const ours = workflow([code('a', 'return 2')])
  const theirs = workflow([code('a', 'return 3')])

  it('gives a conflict the same id when merged again, and another when a side changed', () => {
    const [first] = merge(workflowSpec, base, ours, theirs).conflicts
    const [again] = merge(
      workflowSpec,
      structuredClone(base),
      structuredClone(ours),
      structuredClone(theirs),
    ).conflicts
    expect(again!.id).toBe(first!.id)
    // Ours changed again meanwhile: the earlier resolution no longer applies.
    const later = workflow([code('a', 'return 4')])
    const { conflicts } = merge(workflowSpec, base, later, theirs, { [first!.id]: 'theirs' })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.id).not.toBe(first!.id)
  })

  it('resolves only the conflicts it names, and ignores unknown ids', () => {
    const two = (a: string, b: string) => workflow([code('a', a), code('b', b)])
    const { conflicts } = merge(workflowSpec, two('1', '1'), two('2', '2'), two('3', '3'))
    expect(conflicts).toHaveLength(2)
    const left = merge(workflowSpec, two('1', '1'), two('2', '2'), two('3', '3'), {
      [conflicts[1]!.id]: 'theirs',
      nope: 'theirs',
    })
    expect(left.conflicts.map((c) => c.id)).toEqual([conflicts[0]!.id])
    expect(left.merged).toEqual(two('2', '3'))
  })

  it('has the same conflicts with the sides swapped', () => {
    const a = merge(workflowSpec, base, ours, theirs).conflicts[0]!
    const b = merge(workflowSpec, base, theirs, ours).conflicts[0]!
    expect([b.kind, b.at, b.ours, b.theirs]).toEqual([a.kind, a.at, a.theirs, a.ours])
  })
})
