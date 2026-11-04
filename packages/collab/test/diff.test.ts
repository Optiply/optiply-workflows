import { describe, expect, it } from 'vitest'
import {
  appRenamer,
  appSpec,
  type CollabSpec,
  type DefinitionDiff,
  diff,
  diffLines,
  equal,
  libraryQuerySpec,
  type Renamer,
  type TextHunk,
  workflowRenamer,
  workflowSpec,
} from '../src'
import { appRun, type Random, type Run, random, workflowRun } from './generate'

const code = (name: string, text: string) => ({ name, type: 'code', config: { code: text } })
const query = (name: string, sql: string) => ({
  name,
  type: 'resourceQuery',
  config: { resource: 'db', query: { sql } },
})

const workflow = <B extends { name: string }>(
  blocks: B[],
  edges: { from: string; port: string; to: string }[] = [],
) => ({
  settings: { timeoutMs: 30_000 },
  blocks,
  edges,
  layout: { blocks: Object.fromEntries(blocks.map((b, i) => [b.name, { x: i * 200, y: 0 }])) },
})

/** A text's sides from its hunks. */
const sides = (hunks: TextHunk[]) => ({
  before: hunks.flatMap((h) => ('same' in h ? h.same : h.removed)).join('\n'),
  after: hunks.flatMap((h) => ('same' in h ? h.same : h.added)).join('\n'),
})

/**
 * `before` with a diff's renames and changes applied, found by `at` (identities, not positions): removals, then
 * values and texts, then additions (items at their index, in order), then orders.
 */
function apply<D>(spec: CollabSpec, before: D, d: DefinitionDiff, renamer?: Renamer<D>): D {
  let root = structuredClone(before) as unknown
  for (const r of d.renames) root = renamer!.rename(root as D, r.group, r.from, r.to)
  const holder = { root }
  /** The container of `at`'s last step, its key (an index for an identity array), and the spec path to it. */
  const locate = (at: string[]) => {
    let node: unknown = holder
    let key: string | number = 'root'
    const path: (string | number)[] = []
    for (const step of at) {
      node = (node as Record<string | number, unknown>)[key]
      if (Array.isArray(node)) {
        const identity = spec.identity(path)!
        const i = node.findIndex((item) => identity(item) === step)
        key = i === -1 ? step : i
      } else key = step
      path.push(key)
    }
    return { parent: node as Record<string | number, unknown>, key, path }
  }
  const of = (kind: string) => d.changes.filter((c) => c.kind === kind)
  for (const c of of('removed')) {
    const { parent, key } = locate(c.at)
    if (Array.isArray(parent)) parent.splice(key as number, 1)
    else delete parent[key]
  }
  for (const c of [...of('value'), ...of('text')]) {
    const { parent, key } = locate(c.at)
    parent[key] = structuredClone((c as { after: unknown }).after)
  }
  for (const c of of('added')) {
    if (c.kind !== 'added') continue
    const { parent, key } = locate(c.at)
    if (Array.isArray(parent)) parent.splice(c.index!, 0, structuredClone(c.after))
    else parent[key] = structuredClone(c.after)
  }
  for (const c of of('order')) {
    if (c.kind !== 'order') continue
    const { parent, key, path } = locate(c.at)
    const list = (c.at.length === 0 ? holder.root : parent[key]) as unknown[]
    const identity = spec.identity(c.at.length === 0 ? [] : path)!
    const byKey = new Map(list.map((item) => [identity(item)!, item]))
    const ordered = c.after.map((k) => byKey.get(k))
    if (c.at.length === 0) holder.root = ordered
    else parent[key] = ordered
  }
  return holder.root as D
}

describe('diff: examples', () => {
  const base = workflow([code('a', 'return 1'), query('q', 'select 1\nfrom t')])

  it('finds nothing between equal definitions', () => {
    expect(diff(workflowSpec, base, structuredClone(base))).toEqual({ renames: [], changes: [] })
  })

  it('reports values by path, objects key by key', () => {
    const after = { ...base, settings: { timeoutMs: 60_000, retries: 2 } }
    expect(diff(workflowSpec, base, after).changes).toEqual([
      {
        kind: 'value',
        at: ['settings', 'timeoutMs'],
        path: ['settings', 'timeoutMs'],
        before: 30_000,
        after: 60_000,
      },
      { kind: 'added', at: ['settings', 'retries'], path: ['settings', 'retries'], after: 2 },
    ])
  })

  it('reports identity items added and removed by their identity, with an added item’s position', () => {
    const after = workflow([code('a', 'return 1'), code('b', 'return 2')])
    after.layout = base.layout
    const { changes } = diff(workflowSpec, base, after)
    expect(changes).toEqual([
      { kind: 'removed', at: ['blocks', 'q'], path: ['blocks', 1], before: base.blocks[1] },
      { kind: 'added', at: ['blocks', 'b'], path: ['blocks', 1], after: after.blocks[1], index: 1 },
    ])
  })

  it('reports text as line hunks, and a text that is a value whole', () => {
    const changed = query('q', 'select 1, 2\nfrom t')
    changed.config.resource = 'warehouse'
    const after = workflow([code('a', 'return 1'), changed])
    const { changes } = diff(workflowSpec, base, after)
    expect(changes).toEqual([
      {
        kind: 'value',
        at: ['blocks', 'q', 'config', 'resource'],
        path: ['blocks', 1, 'config', 'resource'],
        before: 'db',
        after: 'warehouse',
      },
      {
        kind: 'text',
        at: ['blocks', 'q', 'config', 'query', 'sql'],
        path: ['blocks', 1, 'config', 'query', 'sql'],
        before: 'select 1\nfrom t',
        after: 'select 1, 2\nfrom t',
        hunks: [{ removed: ['select 1'], added: ['select 1, 2'] }, { same: ['from t'] }],
      },
    ])
  })

  it('reports an atomic object whole, and an item of another type whole', () => {
    const moved = structuredClone(base)
    moved.layout.blocks.a = { x: 10, y: 0 }
    expect(diff(workflowSpec, base, moved).changes).toEqual([
      {
        kind: 'value',
        at: ['layout', 'blocks', 'a'],
        path: ['layout', 'blocks', 'a'],
        before: { x: 0, y: 0 },
        after: { x: 10, y: 0 },
      },
    ])
    const retyped = workflow([query('a', 'select 2'), query('q', 'select 1\nfrom t')])
    expect(diff(workflowSpec, base, retyped).changes).toEqual([
      {
        kind: 'value',
        at: ['blocks', 'a'],
        path: ['blocks', 0],
        before: base.blocks[0],
        after: retyped.blocks[0],
      },
    ])
  })

  it('reports items kept in another order', () => {
    const after = { ...base, blocks: [base.blocks[1]!, base.blocks[0]!] }
    expect(diff(workflowSpec, base, after).changes).toEqual([
      { kind: 'order', at: ['blocks'], path: ['blocks'], before: ['a', 'q'], after: ['q', 'a'] },
    ])
  })

  it('compares an array without an identity whole', () => {
    const before = { resource: 'db', query: { sql: 'select 1' }, params: [{ name: 'id' }], tags: ['a'] }
    const after = { ...before, tags: ['a', 'b'] }
    expect(diff(libraryQuerySpec, before, after).changes).toEqual([
      { kind: 'value', at: ['tags'], path: ['tags'], before: ['a'], after: ['a', 'b'] },
    ])
  })

  it('reports a rename with its references as a rename, other changes under the new name', () => {
    const before = workflow(
      [query('q', 'select 1'), code('a', 'return q.data')],
      [{ from: 'q', port: 'out', to: 'a' }],
    )
    const renamed = workflowRenamer.rename(before as never, 'blocks', 'q', 'orders')!
    const after = structuredClone(renamed) as unknown as typeof before
    ;(after.blocks[0]!.config as { query: { sql: string } }).query.sql = 'select 2'
    // Changed as well as renamed: not recognised (as in a merge), so a removal and an addition.
    expect(diff(workflowSpec, before, after, { renamer: workflowRenamer as never }).renames).toEqual([])
    const only = diff(workflowSpec, before, renamed as never, { renamer: workflowRenamer as never })
    expect(only).toEqual({ renames: [{ group: 'blocks', from: 'q', to: 'orders' }], changes: [] })
    const edited = structuredClone(renamed) as unknown as typeof before
    edited.settings.timeoutMs = 1000
    expect(diff(workflowSpec, before, edited, { renamer: workflowRenamer as never })).toEqual({
      renames: [{ group: 'blocks', from: 'q', to: 'orders' }],
      changes: [
        {
          kind: 'value',
          at: ['settings', 'timeoutMs'],
          path: ['settings', 'timeoutMs'],
          before: 30_000,
          after: 1000,
        },
      ],
    })
  })

  it('diffs lines exactly, line endings and empty texts included', () => {
    for (const [a, b] of [
      ['', 'x'],
      ['x', ''],
      ['a\nb\nc', 'a\nc\nd'],
      ['a\n', 'a'],
      ['same', 'same'],
    ] as const) {
      expect(sides(diffLines(a, b))).toEqual({ before: a, after: b })
    }
  })
})

/** A definition after `n` random edits (each one schema-valid, as the editors make them). */
function evolve<T>(run: Run<T>, r: Random, def: T, n: number): T {
  let d = def
  for (let i = 0; i < n; i++) d = run.edit(r, d) ?? d
  return d
}

function properties<D>(run: Run<D>, renamer: Renamer<D>, seed: number): void {
  const r = random(seed)
  const before = evolve(run, r, run.start, r.int(6))
  const after = evolve(run, r, before, 1 + r.int(10))
  const msg = (what: string) => `seed ${seed}: ${what}`

  expect(diff(run.spec, before, before), msg('no change')).toEqual({ renames: [], changes: [] })
  for (const opts of [{}, { renamer }]) {
    const d = diff(run.spec, before, after, opts)
    expect(equal(apply(run.spec, before, d, renamer), after), msg(`applies (${'renamer' in opts})`)).toBe(
      true,
    )
    for (const c of d.changes) {
      if (c.kind === 'text')
        expect(sides(c.hunks), msg('hunks')).toEqual({ before: c.before, after: c.after })
      if (c.kind === 'value') expect(equal(c.before, c.after), msg('a value change changes')).toBe(false)
    }
    if (equal(before, after)) expect(d.changes, msg('equal')).toEqual([])
  }
  // Without a renamer, the diff of the reverse is the diff with the sides swapped (as many changes of each kind).
  const count = (d: DefinitionDiff, kind: string) => d.changes.filter((c) => c.kind === kind).length
  const there = diff(run.spec, before, after)
  const back = diff(run.spec, after, before)
  expect([count(back, 'added'), count(back, 'removed')], msg('reverse')).toEqual([
    count(there, 'removed'),
    count(there, 'added'),
  ])
}

describe('diff: properties', () => {
  it('workflows: applying the diff gives the other side', () => {
    for (let seed = 1; seed <= 300; seed++) properties(workflowRun, workflowRenamer, seed)
  })

  it('apps: applying the diff gives the other side', () => {
    for (let seed = 1; seed <= 300; seed++) properties(appRun, appRenamer, seed)
  })

  it('finds the renames the edits made', () => {
    let found = 0
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed)
      const before = evolve(appRun, r, appRun.start, 3)
      const after = evolve(appRun, r, before, 4)
      found += diff(appSpec, before, after, { renamer: appRenamer }).renames.length
    }
    expect(found).toBeGreaterThan(0)
  })
})
