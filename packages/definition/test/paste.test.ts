import { describe, expect, it } from 'vitest'
import {
  type Block,
  blockClipSchema,
  copyBlocks,
  pasteBlocks,
  referencedNames,
  validateDefinition,
  type WorkflowDefinition,
} from '../src'
import { code, start, wf } from './helpers'

const def = (x: object) => x as WorkflowDefinition
const codeOf = (d: WorkflowDefinition, name: string, fn: string | null = null) => {
  const graph = fn === null ? d : d.functions!.find((f) => f.name === fn)!
  return (graph.blocks.find((b) => b.name === name) as { config: { code: string } } | undefined)?.config.code
}

describe('copyBlocks', () => {
  const source = def(
    wf(
      [start, code('a'), code('b', 'return a.data'), code('c', 'return b.data')],
      [
        ['startTrigger', 'a'],
        ['a', 'b'],
        ['b', 'c'],
      ],
    ),
  )

  it('takes the blocks, the edges between them and their positions, never the start trigger', () => {
    const withLayout = { ...source, layout: { blocks: { a: { x: 10, y: 20 }, b: { x: 300, y: 20 } } } }
    const clip = copyBlocks(withLayout, null, ['startTrigger', 'a', 'b'])!
    expect(clip.blocks.map((b) => b.name)).toEqual(['a', 'b'])
    expect(clip.edges).toEqual([{ from: 'a', port: 'out', to: 'b' }])
    expect(clip.positions).toEqual({ a: { x: 10, y: 20 }, b: { x: 300, y: 20 } })
    expect(blockClipSchema.safeParse(JSON.parse(JSON.stringify(clip))).success).toBe(true)
    expect(copyBlocks(source, null, ['startTrigger'])).toBeNull()
  })

  it('brings the functions the blocks call, and those they call', () => {
    const d = def({
      ...wf([start, { name: 'call', type: 'function', config: { function: 'outer', args: {} } }, code('x')]),
      functions: [
        { name: 'outer', blocks: [code('r', 'return await inner()')], edges: [] },
        { name: 'inner', blocks: [code('r')], edges: [] },
        { name: 'unused', blocks: [code('r')], edges: [] },
      ],
    })
    expect(copyBlocks(d, null, ['call'])!.functions.map((f) => f.name)).toEqual(['outer', 'inner'])
    expect(copyBlocks(d, null, ['x'])!.functions).toEqual([])
  })
})

describe('pasteBlocks', () => {
  it('gives taken names fresh ones, and references between pasted blocks follow', () => {
    const target = def(wf([start, code('query1'), code('code1')], [['startTrigger', 'query1']]))
    const clip = copyBlocks(
      def(
        wf(
          [start, code('query1'), code('code1', 'return query1.data + other.data'), code('other')],
          [['query1', 'code1']],
        ),
      ),
      null,
      ['query1', 'code1'],
    )!
    const result = pasteBlocks(target, null, clip)
    expect(result.added).toEqual(['query2', 'code2'])
    expect(result.renamed).toEqual({ query1: 'query2', code1: 'code2' })
    expect(codeOf(result.definition, 'code2')).toBe('return query2.data + other.data')
    expect(result.definition.edges).toContainEqual({ from: 'query2', port: 'out', to: 'code2' })
    // `other` wasn't copied: the reference stays, and is listed (the target has no `other`).
    expect(result.outside).toEqual([{ name: 'other', inTarget: false }])
    // What was there is unchanged.
    expect(result.definition.blocks.slice(0, 3)).toEqual(target.blocks)
    expect(result.definition.edges[0]).toEqual(target.edges[0])
  })

  it('says when a reference to a block that wasn’t copied now reads one of the target’s', () => {
    const target = def(wf([start, code('rows')]))
    const clip = copyBlocks(def(wf([start, code('rows'), code('use', 'return rows.data')])), null, ['use'])!
    expect(pasteBlocks(target, null, clip).outside).toEqual([{ name: 'rows', inTarget: true }])
  })

  it('never chains renames, and skips a name a local would capture', () => {
    // code1 is taken; renaming it to code2 would be captured by code3's local `code2`; code3 is pasted too.
    const target = def(wf([start, code('code1')]))
    const clip = copyBlocks(
      def(wf([start, code('code1'), code('code3', 'const code2 = 1; return code1.data + code2')])),
      null,
      ['code1', 'code3'],
    )!
    const result = pasteBlocks(target, null, clip)
    expect(result.renamed).toEqual({ code1: 'code4' })
    expect(codeOf(result.definition, 'code3')).toBe('const code2 = 1; return code4.data + code2')
  })

  it('connects the selected block to the pasted roots, unless it branches', () => {
    const target = def(
      wf(
        [start, code('x'), { name: 'branch1', type: 'branch', config: { conditions: [] } }],
        [['startTrigger', 'x']],
      ),
    )
    const clip = copyBlocks(def(wf([start, code('p'), code('q', 'return p.data')], [['p', 'q']])), null, [
      'p',
      'q',
    ])!
    expect(pasteBlocks(target, null, clip, { connectFrom: 'x' }).definition.edges).toEqual([
      { from: 'startTrigger', port: 'out', to: 'x' },
      { from: 'p', port: 'out', to: 'q' },
      { from: 'x', port: 'out', to: 'p' },
    ])
    expect(pasteBlocks(target, null, clip, { connectFrom: 'branch1' }).definition.edges).toHaveLength(2)
  })

  it('skips what the target can’t hold: a start trigger, a second error handler, a response in a function', () => {
    const errorTrigger = { name: 'onError', type: 'errorTrigger' }
    const response = { name: 'reply', type: 'response', config: { status: '200', body: '{}' } }
    const crafted = blockClipSchema.parse({
      ow: 'workflow-blocks',
      v: 1,
      blocks: [start, errorTrigger, response, code('ok')],
      edges: [
        { from: 'onError', port: 'out', to: 'ok' },
        { from: 'ok', port: 'out', to: 'reply' },
      ],
      positions: {},
      functions: [],
    })
    const withHandler = def(wf([start, { name: 'handler', type: 'errorTrigger' }]))
    const main = pasteBlocks(withHandler, null, crafted)
    expect(main.added).toEqual(['reply', 'ok'])
    expect(main.skipped.map((s) => s.name)).toEqual(['startTrigger', 'onError'])
    // Edges to what was skipped go too.
    expect(main.definition.edges).toEqual([{ from: 'ok', port: 'out', to: 'reply' }])

    const withFn = def({ ...wf([start]), functions: [{ name: 'fn', blocks: [code('r')], edges: [] }] })
    const inFn = pasteBlocks(withFn, 'fn', crafted)
    expect(inFn.added).toEqual(['ok'])
    expect(inFn.skipped.map((s) => s.name)).toEqual(['startTrigger', 'onError', 'reply'])
    expect(inFn.definition.functions![0]!.blocks.map((b) => b.name)).toEqual(['r', 'ok'])
    expect(inFn.definition.functions![0]!.edges).toEqual([])
  })

  it('adds missing functions, reuses identical ones, keeps the target’s when they differ', () => {
    const fn = (name: string, src = 'return 1', layout?: object) => ({
      name,
      blocks: [code('r', src)],
      edges: [],
      ...(layout && { layout }),
    })
    const source = def({
      ...wf([start, code('c', 'return await same() + await other() + await fresh()')]),
      functions: [
        fn('same', 'return 1', { blocks: { r: { x: 1, y: 1 } } }),
        fn('other', 'return 2'),
        fn('fresh'),
      ],
    })
    const target = def({
      ...wf([start, code('fresh_not')]),
      functions: [fn('same'), fn('other', 'return 3')],
    })
    const result = pasteBlocks(target, null, copyBlocks(source, null, ['c'])!)
    expect(result.functions).toEqual({ added: ['fresh'], reused: ['same'], kept: ['other'], conflicts: [] })
    expect(result.definition.functions!.map((f) => f.name)).toEqual(['same', 'other', 'fresh'])
    expect(codeOf(result.definition, 'r', 'other')).toBe('return 3')

    // A function named like one of the target's blocks isn't added.
    const clash = def({ ...wf([start, code('fresh')]) })
    expect(pasteBlocks(clash, null, copyBlocks(source, null, ['c'])!).functions.conflicts).toEqual(['fresh'])
  })

  it('places the blocks at `at`, keeping their arrangement, or moves them by `offset`', () => {
    const source = def({
      ...wf([start, code('a'), code('b'), code('c')]),
      layout: { blocks: { a: { x: 100, y: 50 }, b: { x: 400, y: 90 } } },
    })
    const clip = copyBlocks(source, null, ['a', 'b', 'c'])!
    const target = def(wf([start]))
    expect(pasteBlocks(target, null, clip, { at: { x: 1000, y: 0 } }).definition.layout!.blocks).toEqual({
      a: { x: 1000, y: 0 },
      b: { x: 1300, y: 40 },
      c: { x: 1000, y: 160 }, // no position: below the others
    })
    expect(
      pasteBlocks(target, null, clip, { offset: { x: 40, y: 40 } }).definition.layout!.blocks!.a,
    ).toEqual({
      x: 140,
      y: 90,
    })
  })

  it('duplicates in place: a copy of a selection pasted into its own graph', () => {
    const source = def(
      wf(
        [start, code('a'), code('b', 'return a.data')],
        [
          ['startTrigger', 'a'],
          ['a', 'b'],
        ],
      ),
    )
    const result = pasteBlocks(source, null, copyBlocks(source, null, ['a', 'b'])!, {
      offset: { x: 40, y: 40 },
    })
    expect(result.added).toEqual(['a1', 'b1'])
    expect(codeOf(result.definition, 'b1')).toBe('return a1.data')
    expect(
      validateDefinition(result.definition).diagnostics.filter((d) => d.code === 'duplicate_name'),
    ).toEqual([])
  })

  it('rejects clipboard text that isn’t blocks', () => {
    expect(blockClipSchema.safeParse({ ow: 'workflow-blocks', v: 1, blocks: [] }).success).toBe(false)
    expect(blockClipSchema.safeParse({ ow: 'app-components', v: 1 }).success).toBe(false)
    expect(
      blockClipSchema.safeParse({
        ow: 'workflow-blocks',
        v: 1,
        blocks: [{ name: 'x', type: 'code', config: { code: 'return 1' }, extra: true }],
        edges: [],
        positions: {},
        functions: [],
      }).success,
    ).toBe(false)
  })
})

/** A small seeded random generator (mulberry32), so failures repeat. */
function random(seed: number) {
  let a = seed
  return {
    next() {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    int(n: number) {
      return Math.floor(this.next() * n)
    },
  }
}

/** A chain of code blocks reading earlier ones, named so that pasting into a copy of it collides. */
function randomWorkflow(r: ReturnType<typeof random>): WorkflowDefinition {
  const blocks: Block[] = [start as Block]
  const edges: [string, string][] = []
  const count = 2 + r.int(8)
  for (let i = 0; i < count; i++) {
    const name = ['code', 'query', 'step'][r.int(3)]! + (r.int(3) + 1) + (i ? `_${i}` : '')
    const earlier = blocks.slice(1).map((b) => b.name)
    const reads = earlier.length && r.int(2) ? earlier[r.int(earlier.length)]! : null
    blocks.push(code(name, reads ? `const local = 1; return ${reads}.data + local` : 'return 1') as Block)
    edges.push([blocks[blocks.length - 2]!.name, name])
  }
  return def(wf(blocks, edges))
}

describe('pasteBlocks, on random workflows', () => {
  it('keeps the target as it was, and the pasted blocks wired and named as they were copied', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed)
      const source = randomWorkflow(r)
      const target = r.int(2) ? source : randomWorkflow(r)
      const names = source.blocks
        .slice(1)
        .filter(() => r.int(3) > 0)
        .map((b) => b.name)
      const clip = copyBlocks(source, null, names)
      if (!clip) continue
      const result = pasteBlocks(target, null, clip)
      const mapped = (n: string) => result.renamed[n] ?? n

      // The target's blocks and edges are untouched and come first.
      expect(result.definition.blocks.slice(0, target.blocks.length)).toEqual(target.blocks)
      expect(result.definition.edges.slice(0, target.edges.length)).toEqual(target.edges)
      // Every pasted name is new to the target, and they're all different.
      const targetNames = new Set(target.blocks.map((b) => b.name))
      expect(result.added.every((n) => !targetNames.has(n))).toBe(true)
      expect(new Set(result.added).size).toBe(result.added.length)
      // Edges and references among the pasted blocks are the copied ones, renamed.
      const pastedEdges = result.definition.edges.slice(target.edges.length)
      expect(pastedEdges).toEqual(clip.edges.map((e) => ({ ...e, from: mapped(e.from), to: mapped(e.to) })))
      const copied = new Set(clip.blocks.map((b) => b.name))
      for (const original of clip.blocks) {
        const pasted = result.definition.blocks.find((b) => b.name === mapped(original.name))!
        const expected = [...referencedNames(original)].map((n) => (copied.has(n) ? mapped(n) : n)).sort()
        expect([...referencedNames(pasted)].sort()).toEqual(expected)
      }
      expect(
        validateDefinition(result.definition).diagnostics.filter((d) => d.code === 'duplicate_name'),
        `seed ${seed}`,
      ).toEqual([])
    }
  })
})
