import { describe, expect, it } from 'vitest'
import { blockingErrors, runScope, validateDefinition, type WorkflowDefinition } from '../src'
import { code, start, wf } from './helpers'

const def = wf(
  [start, code('a'), code('b', 'return a.data +'), code('c'), code('loose', 'return 2')],
  [
    ['startTrigger', 'a'],
    ['a', 'b'],
    ['a', 'c'],
  ],
) as WorkflowDefinition

describe('runScope', () => {
  it('is the targets and their ancestors', () => {
    expect([...runScope(def, ['c'])].sort()).toEqual(['a', 'c', 'startTrigger'])
    expect([...runScope(def, ['loose'])]).toEqual(['loose'])
  })
})

describe('blockingErrors', () => {
  const { diagnostics } = validateDefinition(def)

  it('stops a whole run on any error', () => {
    expect(blockingErrors(def, diagnostics).map((d) => d.block)).toContain('b')
  })

  it("ignores a broken sibling's error when running one block", () => {
    expect(blockingErrors(def, diagnostics, ['c'])).toEqual([])
    expect(blockingErrors(def, diagnostics, ['loose'])).toEqual([])
    expect(blockingErrors(def, diagnostics, ['b']).map((d) => d.block)).toEqual(['b'])
  })

  it('counts errors in functions the scope calls', () => {
    const withFn = {
      ...def,
      blocks: [...def.blocks, { name: 'call', type: 'function', config: { function: 'helper' } }],
      functions: [{ name: 'helper', blocks: [code('inner', 'return (')], edges: [] }],
    } as unknown as WorkflowDefinition
    const found = validateDefinition(withFn).diagnostics
    expect(blockingErrors(withFn, found, ['call']).some((d) => d.function === 'helper')).toBe(true)
    expect(blockingErrors(withFn, found, ['c']).some((d) => d.function === 'helper')).toBe(false)
  })
})
