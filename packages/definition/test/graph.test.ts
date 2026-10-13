import { describe, expect, it } from 'vitest'
import { buildGraph, workflowDefinitionSchema } from '../src'
import { code, start, wf } from './helpers'

const graphOf = (blocks: object[], edges: [string, string, string?][]) =>
  buildGraph(workflowDefinitionSchema.parse(wf(blocks, edges)))

describe('buildGraph', () => {
  // startTrigger → a → (b, c) → d, plus an unconnected e.
  const diamond = graphOf(
    [start, code('a'), code('b'), code('c'), code('d'), code('e')],
    [
      ['startTrigger', 'a'],
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ],
  )

  it('orders blocks parents-first, keeping definition order for ties', () => {
    expect(diamond.order).toEqual(['startTrigger', 'e', 'a', 'b', 'c', 'd'])
    expect(diamond.cycle).toBeNull()
    expect(diamond.start).toBe('startTrigger')
  })

  it('computes ancestors and descendants through every path', () => {
    expect([...diamond.ancestors('d')].sort()).toEqual(['a', 'b', 'c', 'startTrigger'])
    expect([...diamond.ancestors('b')].sort()).toEqual(['a', 'startTrigger'])
    expect([...diamond.ancestors('e')]).toEqual([])
    expect([...diamond.descendants('a')].sort()).toEqual(['b', 'c', 'd'])
  })

  it('indexes edges both ways', () => {
    expect(diamond.incoming.get('d')!.map((e) => e.from)).toEqual(['b', 'c'])
    expect(diamond.outgoing.get('a')!.map((e) => e.to)).toEqual(['b', 'c'])
  })

  it('finds a cycle and has no order', () => {
    const g = graphOf(
      [start, code('a'), code('b'), code('c')],
      [
        ['startTrigger', 'a'],
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    )
    expect(g.order).toBeNull()
    expect(g.cycle).toEqual(['a', 'b', 'c'])
    expect(g.ancestors('a').has('a')).toBe(true)
  })

  it('treats a self-edge as a cycle', () => {
    const g = graphOf([start, code('a')], [['a', 'a']])
    expect(g.cycle).toEqual(['a'])
  })

  it('ignores edges to unknown blocks', () => {
    const g = graphOf([start], [['startTrigger', 'ghost']])
    expect(g.outgoing.get('startTrigger')).toEqual([])
    expect(g.order).toEqual(['startTrigger'])
  })
})
