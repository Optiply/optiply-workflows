import { type MergeConflict, merge, workflowSpec } from '@ow/collab'
import { describe, expect, it } from 'vitest'
import {
  chooseChunk,
  conflictLabel,
  conflictLanguage,
  isResolved,
  resolutionOf,
  resolvedCount,
  showValue,
  textOf,
} from './merge-choices'

/** A real text conflict: two chunks, both sides changed lines 1 and 3. */
function textConflict(): Extract<MergeConflict, { kind: 'text' }> {
  const def = (code: string) => ({ blocks: [{ name: 'step', type: 'code', config: { code } }] })
  const base = 'a\nb\nc\nd'
  const { conflicts } = merge(workflowSpec, def(base), def('A1\nb\nC1\nd'), def('A2\nb\nC2\nd'))
  return conflicts[0] as Extract<MergeConflict, { kind: 'text' }>
}

describe('conflictLabel', () => {
  it('names the item and what’s inside it', () => {
    expect(conflictLabel(['definition', 'blocks', 'fetchOrders', 'config', 'query', 'sql'])).toBe(
      'Block fetchOrders · config.query.sql',
    )
    expect(conflictLabel(['definition', 'components', 'table1', 'props', 'data'])).toBe(
      'Component table1 · props.data',
    )
    expect(conflictLabel(['definition', 'blocks', 'gone'])).toBe('Block gone')
    expect(conflictLabel(['definition', 'functions', 'notify', 'blocks', 'send', 'config', 'code'])).toBe(
      'Function notify › Block send · config.code',
    )
    expect(conflictLabel(['definition', 'components', 'button1', 'events', 'h1', 'action', 'code'])).toBe(
      'Component button1 › Event handler h1 · action.code',
    )
  })

  it('names the object’s own fields and the rest by path', () => {
    expect(conflictLabel(['name'])).toBe('Name')
    expect(conflictLabel(['description'])).toBe('Description')
    expect(conflictLabel(['definition', 'settings', 'timeoutMs'])).toBe('settings.timeoutMs')
    expect(conflictLabel(['definition', 'layout', 'blocks', 'a'])).toBe('Block a · position')
    expect(conflictLabel(['definition', 'layout', 'table1'])).toBe('Component table1 · position')
    expect(conflictLabel(['definition'])).toBe('The whole definition')
  })
})

describe('choices', () => {
  it('settles a text conflict per chunk, once every chunk is chosen', () => {
    const conflict = textConflict()
    expect(conflict.chunks.filter((c) => 'conflict' in c)).toHaveLength(2)
    const half = chooseChunk(undefined, 0, 2, 'ours')
    expect(isResolved(conflict, half)).toBe(false)
    expect(resolutionOf(conflict, half)).toBeUndefined()
    const both = chooseChunk(half, 1, 2, 'both')
    expect(isResolved(conflict, both)).toBe(true)
    expect(resolutionOf(conflict, both)).toEqual({ chunks: ['ours', 'both'] })
    expect(textOf(conflict, both)).toBe('A1\nb\nC1\nC2\nd')
  })

  it('starts editing by hand from both sides of the chunks not chosen yet', () => {
    const conflict = textConflict()
    expect(textOf(conflict, chooseChunk(undefined, 1, 2, 'theirs'))).toBe('A1\nA2\nb\nC2\nd')
    expect(textOf(conflict, { side: 'theirs' })).toBe('A2\nb\nC2\nd')
    expect(resolutionOf(conflict, { text: 'x' })).toEqual({ text: 'x' })
  })

  it('settles any conflict with a side, and counts what’s settled', () => {
    const value: MergeConflict = { id: 'v', kind: 'value', at: ['name'], base: 'a', ours: 'b', theirs: 'c' }
    expect(resolutionOf(value, { side: 'theirs' })).toBe('theirs')
    expect(isResolved(value, { chunks: ['ours'] })).toBe(false)
    expect(resolvedCount([value, textConflict()], { v: { side: 'ours' } })).toBe(1)
  })

  it('shows values for people', () => {
    expect(showValue(undefined)).toBe('(deleted)')
    expect(showValue('select 1')).toBe('select 1')
    expect(showValue({ x: 1 })).toBe('{\n  "x": 1\n}')
    expect(conflictLanguage(['definition', 'queries', 'q', 'query', 'sql'])).toBe('sql')
    expect(conflictLanguage(['definition', 'blocks', 'b', 'config', 'code'])).toBe('javascript')
  })
})
