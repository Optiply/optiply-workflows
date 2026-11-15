import { type AppDefinition, appDefinitionSchema, emptyApp } from '@ow/app-definition'
import { type Block, type WorkflowDefinition, workflowDefinitionSchema } from '@ow/definition'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { appSpec, type CollabSpec, commonSubsequence, equal, SharedDefinition, workflowSpec } from '../src'

const code = (name: string, src = 'return 1'): Block => ({ name, type: 'code', config: { code: src } })

const workflow = (blocks: Block[], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
  workflowDefinitionSchema.parse({
    schemaVersion: 1,
    blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
    edges: blocks.map((b, i) => ({
      from: i === 0 ? 'startTrigger' : blocks[i - 1]?.name,
      port: 'out',
      to: b.name,
    })),
    layout: { blocks: Object.fromEntries(blocks.map((b, i) => [b.name, { x: 0, y: i * 100 }])) },
    ...extra,
  })

/** A replica: its own document and view, starting from `from`'s state when given. */
function replica<T>(spec: CollabSpec, from?: SharedDefinition<T>): SharedDefinition<T> {
  const doc = new Y.Doc()
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from.doc))
  return new SharedDefinition<T>(doc, spec)
}

/** Exchanges what each side is missing. */
function sync(...replicas: SharedDefinition<unknown>[]): void {
  for (const a of replicas) {
    for (const b of replicas)
      if (a !== b) Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)))
  }
}

const updateSize = (shared: SharedDefinition<unknown>, edit: () => void): number => {
  let size = 0
  const count = (update: Uint8Array) => {
    size += update.length
  }
  shared.doc.on('update', count)
  edit()
  shared.doc.off('update', count)
  return size
}

describe('SharedDefinition', () => {
  const def = workflow([code('code1'), code('code2', 'return 2')], {
    functions: [
      {
        name: 'double',
        params: [{ name: 'n' }],
        blocks: [{ name: 'calc', type: 'code', config: { code: 'return params.n * 2' } }],
        edges: [],
      },
    ],
  })

  it('reads back what was set, as the same objects', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(def)
    expect(a.value).toBe(def)
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    expect(b.value).toEqual(def)
    expect(b.value).toBe(b.value)
  })

  it('keeps text fields as Y.Text and names, types and numbers as values', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(def)
    const blocks = a.root.get('blocks') as Y.Array<Y.Map<unknown>>
    const block = blocks.get(1)
    expect(block.get('name')).toBe('code1')
    expect(block.get('type')).toBe('code')
    expect((block.get('config') as Y.Map<unknown>).get('code')).toBeInstanceOf(Y.Text)
    const fn = (a.root.get('functions') as Y.Array<Y.Map<unknown>>).get(0)
    const calc = (fn.get('blocks') as Y.Array<Y.Map<unknown>>).get(0)
    expect((calc.get('config') as Y.Map<unknown>).get('code')).toBeInstanceOf(Y.Text)
    // A position is one value: x and y from different people never mix.
    const layout = (a.root.get('layout') as Y.Map<Y.Map<unknown>>).get('blocks')?.get('code2')
    expect(layout).toEqual({ x: 0, y: 100 })
  })

  it('shares unchanged parts after a remote change', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(def)
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    const before = b.value
    const blocks = [...def.blocks]
    blocks[2] = code('code2', 'return 3')
    a.set({ ...def, blocks })
    sync(a, b)
    const after = b.value
    expect(after).toEqual({ ...def, blocks })
    expect(after.blocks[1]).toBe(before.blocks[1])
    expect(after.blocks[2]).not.toBe(before.blocks[2])
    expect(after.edges).toBe(before.edges)
    expect(after.functions).toBe(before.functions)
  })

  it('writes an edit as a small change', () => {
    const big = workflow(Array.from({ length: 200 }, (_, i) => code(`code${i}`, `return ${'x'.repeat(200)}`)))
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(big)
    const blockMap = (a.root.get('blocks') as Y.Array<unknown>).get(50)
    const blocks = [...big.blocks]
    blocks[50] = code('code49', `return ${'x'.repeat(200)}y`)
    const size = updateSize(a, () => a.set({ ...big, blocks }))
    expect(size).toBeLessThan(40)
    expect((a.root.get('blocks') as Y.Array<unknown>).get(50)).toBe(blockMap)
    expect(a.value.blocks[50]).toBe(blocks[50])
  })

  it('does nothing for an unchanged definition', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(def)
    expect(updateSize(a, () => a.set(def))).toBe(0)
    expect(updateSize(a, () => a.set(structuredClone(def)))).toBe(0)
  })

  it('merges typing in one code field from two people', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([code('code1', 'const a = 1\nreturn a')]))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    const typed = (s: SharedDefinition<WorkflowDefinition>, src: string) => {
      const blocks = [...s.value.blocks]
      blocks[1] = code('code1', src)
      s.set({ ...s.value, blocks })
    }
    typed(a, 'const a = 10\nreturn a')
    typed(b, 'const a = 1\nreturn a + 1')
    sync(a, b)
    expect(a.value).toEqual(b.value)
    expect((a.value.blocks[1] as Extract<Block, { type: 'code' }>).config.code).toBe(
      'const a = 10\nreturn a + 1',
    )
  })

  it("keeps someone's edits inside a block another renames", () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([code('code1', 'return 1')]))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    // a renames code1 (block, edge and layout), b edits its code.
    const v = a.value
    a.set({
      ...v,
      blocks: [v.blocks[0] as Block, code('fetch', 'return 1')],
      edges: [{ from: 'startTrigger', port: 'out', to: 'fetch' }],
      layout: { blocks: { fetch: { x: 0, y: 0 } } },
    })
    const w = b.value
    b.set({ ...w, blocks: [w.blocks[0] as Block, code('code1', 'return 12')] })
    sync(a, b)
    expect(a.value).toEqual(b.value)
    expect(a.value.blocks[1]).toEqual(code('fetch', 'return 12'))
    expect(a.value.edges).toEqual([{ from: 'startTrigger', port: 'out', to: 'fetch' }])
  })

  it("matches schedules by name, so two people's edits to one schedule land, wherever it moved", () => {
    const nightly = { name: 'nightly', enabled: true, cron: '0 3 * * *' }
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([], { triggers: { schedules: [nightly] } }))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    const hourly = { ...nightly, name: 'hourly', cron: '0 * * * *' }
    // a adds a schedule before it and lets fires overlap; b moves it to another hour.
    a.set({ ...a.value, triggers: { schedules: [hourly, { ...nightly, overlap: 'allow' as const }] } })
    b.set({ ...b.value, triggers: { schedules: [{ ...nightly, cron: '0 4 * * *' }] } })
    sync(a, b)
    expect(a.value).toEqual(b.value)
    expect(a.value.triggers?.schedules).toEqual([hourly, { ...nightly, overlap: 'allow', cron: '0 4 * * *' }])
  })

  it('keeps the first of two blocks added with one name, everywhere, and drops the other on the next edit', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([]))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    a.set({ ...a.value, blocks: [...a.value.blocks, code('code1', 'return "a"')] })
    b.set({ ...b.value, blocks: [...b.value.blocks, code('code1', 'return "b"')] })
    sync(a, b)
    expect(a.value).toEqual(b.value)
    expect(a.value.blocks).toHaveLength(2)
    expect((a.root.get('blocks') as Y.Array<unknown>).length).toBe(3)
    a.set({ ...a.value, blocks: [...a.value.blocks, code('code2')] })
    sync(a, b)
    expect((b.root.get('blocks') as Y.Array<unknown>).length).toBe(3)
    expect(b.value.blocks.map((x) => x.name)).toEqual(['startTrigger', expect.any(String), 'code2'])
    expect(b.value).toEqual(a.value)
  })

  it('merges adds and deletes of edges by their ends', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([code('x'), code('y'), code('z')]))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    a.set({ ...a.value, edges: a.value.edges.filter((e) => e.to !== 'y') })
    b.set({ ...b.value, edges: [...b.value.edges, { from: 'x', port: 'out', to: 'z' }] })
    sync(a, b)
    expect(a.value.edges).toEqual([
      { from: 'startTrigger', port: 'out', to: 'x' },
      { from: 'y', port: 'out', to: 'z' },
      { from: 'x', port: 'out', to: 'z' },
    ])
    expect(b.value).toEqual(a.value)
  })

  it('matches positional arrays by content, so deleting one keeps the others in place', () => {
    const headers = [
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
      { key: 'c', value: '3' },
    ]
    const response = (h: typeof headers): Block => ({ name: 'res', type: 'response', config: { headers: h } })
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([response(headers)]))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    a.set({
      ...a.value,
      blocks: [a.value.blocks[0] as Block, response([headers[0], headers[2]] as typeof headers)],
    })
    b.set({
      ...b.value,
      blocks: [b.value.blocks[0] as Block, response([...headers.slice(0, 2), { key: 'c', value: '33' }])],
    })
    sync(a, b)
    expect(a.value.blocks[1]).toEqual(response([headers[0], { key: 'c', value: '33' }] as typeof headers))
    expect(b.value).toEqual(a.value)
  })

  it('removes keys that become undefined or go missing', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([{ ...code('code1'), description: 'hi' }]))
    a.set(workflow([{ ...code('code1'), description: undefined }]))
    expect(a.value.blocks[1]).toEqual(code('code1'))
    expect(
      ((a.root.get('blocks') as Y.Array<Y.Map<unknown>>).get(1) as Y.Map<unknown>).has('description'),
    ).toBe(false)
  })

  it("doesn't split a surrogate pair when text changes inside one", () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([code('code1', 'return "😀"')]))
    a.set(workflow([code('code1', 'return "😃"')]))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    expect((b.value.blocks[1] as Extract<Block, { type: 'code' }>).config.code).toBe('return "😃"')
  })

  it('turns a value into something else at the same place', () => {
    const a = replica<AppDefinition>(appSpec)
    const app = (initialValue: unknown): AppDefinition =>
      appDefinitionSchema.parse({ ...emptyApp(), variables: [{ name: 'v', initialValue }] })
    for (const v of ['text', 3, { rows: [1, 2] }, [1, 'two'], 'again', null]) {
      a.set(app(v))
      expect(replica<AppDefinition>(appSpec, a).value).toEqual(app(v))
    }
  })

  it('replaces an object whose variant changes, so a field set meanwhile in the old one goes with it', () => {
    const wait = (config: Extract<Block, { type: 'wait' }>['config']): Block => ({
      name: 'wait1',
      type: 'wait',
      config,
    })
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([wait({ kind: 'duration', amount: '1', unit: 'minutes' })]))
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    a.set(workflow([wait({ kind: 'until', until: '2030-01-01' })]))
    b.set(workflow([wait({ kind: 'duration', amount: '1', unit: 'hours' })]))
    sync(a, b)
    expect(a.value).toEqual(b.value)
    expect(() => workflowDefinitionSchema.parse(a.value)).not.toThrow()
  })

  it('keeps a grid position whole, so x and w from two people never mix', () => {
    const app = (position: { x: number; w: number }): AppDefinition =>
      appDefinitionSchema.parse({
        ...emptyApp(),
        components: [{ name: 'button1', type: 'button' }],
        layout: { button1: { y: 0, h: 1, ...position } },
      })
    const a = replica<AppDefinition>(appSpec)
    a.set(app({ x: 0, w: 4 }))
    const b = replica<AppDefinition>(appSpec, a)
    a.set(app({ x: 8, w: 4 }))
    b.set(app({ x: 0, w: 10 }))
    sync(a, b)
    expect(a.value).toEqual(b.value)
    expect([app({ x: 8, w: 4 }), app({ x: 0, w: 10 })]).toContainEqual(a.value)
  })

  it('stores half an emoji as U+FFFD, as every other replica will read it', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    const split = workflow([code('code1', 'return "\ud83d"')])
    a.set(split)
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    expect(a.value).not.toBe(split)
    expect(a.value).toEqual(workflow([code('code1', 'return "�"')]))
    expect(b.value).toEqual(a.value)
  })

  it('keeps a large definition quick: an edit and its read in a few milliseconds', () => {
    // As big as the schema lets a workflow get: 500 blocks with code, a chain of edges, a position each.
    const blocks = Array.from({ length: 499 }, (_, i) =>
      code(`code${i}`, `return ${'x'.repeat(300)} // ${i}`),
    )
    const big = workflow(blocks)
    const a = replica<WorkflowDefinition>(workflowSpec)
    let t = performance.now()
    a.set(big)
    const loaded = performance.now() - t
    const b = replica<WorkflowDefinition>(workflowSpec, a)
    t = performance.now()
    expect(b.value.blocks).toHaveLength(500)
    const firstRead = performance.now() - t

    // Typing a character in one block's code, a hundred times: the write and the other side's read.
    const times: number[] = []
    for (let i = 0; i < 100; i++) {
      const v = a.value
      const next = [...v.blocks]
      const at = 1 + (i % 499)
      const block = next[at] as Extract<Block, { type: 'code' }>
      next[at] = code(block.name, `${block.config.code}y`)
      t = performance.now()
      a.set({ ...v, blocks: next })
      sync(a, b)
      expect(b.value.blocks[at]).toEqual(next[at])
      times.push(performance.now() - t)
    }
    times.sort((x, y) => x - y)
    const median = times[50] ?? 0
    // On this Mac (2026-10-21) the median was 1.8 ms, the load 11 ms, the first read 4. A GitHub runner, sharing its
    // CPUs with every other package's suite under `pnpm test`, measured 40 ms (2026-11-03), so CI gets more room:
    // the bound is there to catch a quadratic (a 500-block edit taking seconds), not to time the runner.
    expect(median).toBeLessThan(process.env.CI ? 150 : 20)
    // A busy runner took 604 ms to load (2026-11-15): seconds there still tell a quadratic apart.
    expect(loaded).toBeLessThan(process.env.CI ? 3000 : 500)
    expect(firstRead).toBeLessThan(process.env.CI ? 3000 : 500)
  })

  it('finds a text field by its path in the definition', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(def)
    expect(a.textAt(['blocks', 2, 'config', 'code'])?.toString()).toBe('return 2')
    expect(a.textAt(['functions', 0, 'blocks', 0, 'config', 'code'])?.toString()).toBe('return params.n * 2')
    expect(a.textAt(['blocks', 2, 'name'])).toBeNull()
    expect(a.textAt(['blocks', 9, 'config', 'code'])).toBeNull()
    expect(a.textAt(['blocks', 'x', 'config'])).toBeNull()
  })

  it('stores text fields with \\n line ends (Monaco is bound in one end-of-line character)', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    // A draft from Git or REST with CRLF (and a lone CR): made, then changed in place.
    a.set(workflow([code('code1', 'const a = 1\r\nreturn a')]))
    expect(a.textAt(['blocks', 1, 'config', 'code'])?.toString()).toBe('const a = 1\nreturn a')
    expect(a.value.blocks[1]).toMatchObject({ config: { code: 'const a = 1\nreturn a' } })
    a.set(workflow([code('code1', 'const a = 2\r\nreturn a\r')]))
    expect(a.textAt(['blocks', 1, 'config', 'code'])?.toString()).toBe('const a = 2\nreturn a\n')
    expect(a.value).toEqual(replica<WorkflowDefinition>(workflowSpec, a).value)
    // Names and other values are kept as they are.
    a.set(workflow([{ ...code('code1'), description: 'one\r\ntwo' }]))
    expect(a.value.blocks[1]).toMatchObject({ description: 'one\r\ntwo' })
  })

  it('deletes a field by its path', () => {
    const a = replica<WorkflowDefinition>(workflowSpec)
    a.set(workflow([{ ...code('code1'), description: 'hi' }]))
    a.delete(['blocks', 1, 'description'])
    a.delete(['blocks', 7, 'description'])
    expect(a.value.blocks[1]).toEqual(code('code1'))
  })

  it('maps app props, handler templates and query code to text', () => {
    const a = replica<AppDefinition>(appSpec)
    a.set(
      appDefinitionSchema.parse({
        ...emptyApp(),
        components: [
          {
            name: 'button1',
            type: 'button',
            props: { text: 'Hi {{ user.name }}', disabled: false },
            events: [{ id: 'h1', event: 'click', action: { type: 'runScript', code: 'go()' } }],
          },
        ],
        queries: [{ name: 'q1', kind: 'resource', resource: 'pg', query: { sql: 'select 1' }, run: 'auto' }],
      }),
    )
    const component = (a.root.get('components') as Y.Array<Y.Map<unknown>>).get(0)
    const props = component.get('props') as Y.Map<unknown>
    expect(props.get('text')).toBeInstanceOf(Y.Text)
    expect(props.get('disabled')).toBe(false)
    const handler = (component.get('events') as Y.Array<Y.Map<unknown>>).get(0)
    expect((handler.get('action') as Y.Map<unknown>).get('code')).toBeInstanceOf(Y.Text)
    expect((handler.get('action') as Y.Map<unknown>).get('type')).toBe('runScript')
    const query = (a.root.get('queries') as Y.Array<Y.Map<unknown>>).get(0)
    expect((query.get('query') as Y.Map<unknown>).get('sql')).toBeInstanceOf(Y.Text)
    expect(query.get('resource')).toBe('pg')
  })
})

describe('commonSubsequence', () => {
  it('pairs the longest common subsequence', () => {
    expect(commonSubsequence([1, 2, 3, 4, 5], [1, 3, 9, 4, 5], equal)).toEqual([
      [0, 0],
      [2, 1],
      [3, 3],
      [4, 4],
    ])
    expect(commonSubsequence(['a', 'b'], ['b', 'a'], equal)).toHaveLength(1)
    expect(commonSubsequence([], [1], equal)).toEqual([])
  })
})
