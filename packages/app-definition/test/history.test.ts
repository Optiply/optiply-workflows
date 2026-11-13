import { describe, expect, it } from 'vitest'
import {
  type AppDefinition,
  describeChange,
  isEmptySummary,
  mergeChangeSummaries,
  summarizeAppChange,
} from '../src'

const base: AppDefinition = {
  schemaVersion: 1,
  pages: [{ name: 'home' }],
  components: [
    { name: 'title', type: 'text', props: { value: 'Hi' } },
    { name: 'save', type: 'button' },
  ],
  queries: [{ name: 'q1', kind: 'js', code: 'return 1' }],
  layout: { title: { x: 0, y: 0, w: 4, h: 2 }, save: { x: 4, y: 0, w: 2, h: 2 } },
}

describe('what changed in a draft (session 41)', () => {
  it('names what was added, removed and changed, a move included, and the unnamed parts', () => {
    const after: AppDefinition = {
      ...base,
      pages: [{ name: 'home' }, { name: 'detail' }],
      components: [
        { name: 'title', type: 'text', props: { value: 'Hello' } },
        { name: 'more', type: 'text' },
      ],
      queries: base.queries,
      layout: { ...base.layout, title: { x: 1, y: 0, w: 4, h: 2 } },
      theme: { primary: '#7c3aed' },
    }
    expect(summarizeAppChange(base, after)).toEqual({
      added: ['more', 'page detail'],
      removed: ['save'],
      changed: ['title'],
      parts: ['theme'],
    })
    expect(isEmptySummary(summarizeAppChange(base, structuredClone(base)))).toBe(true)
    // A move alone is a change.
    expect(
      summarizeAppChange(base, { ...base, layout: { ...base.layout, save: { x: 6, y: 0, w: 2, h: 2 } } })
        .changed,
    ).toEqual(['save'])
    // A reorder alone is a change (review).
    expect(summarizeAppChange(base, { ...base, components: [...base.components].reverse() }).parts).toEqual([
      'order',
    ])
    // From nothing: everything added.
    expect(summarizeAppChange(null, base).added).toEqual(['title', 'save', 'q1', 'page home'])
  })

  it('merges edits close together into one entry', () => {
    const first = { added: ['a'], removed: ['b'], changed: ['c'], parts: ['css'] }
    const then = { added: ['b'], removed: ['a', 'c'], changed: ['d'], parts: ['theme'] }
    // a added then removed: gone; b removed then added back: changed; c changed then removed: removed.
    expect(mergeChangeSummaries(first, then)).toEqual({
      added: [],
      removed: ['c'],
      changed: ['b', 'd'],
      parts: ['css', 'theme'],
    })
  })

  it('describes a change in a line', () => {
    expect(
      describeChange({ added: ['a', 'b', 'c', 'd', 'e'], removed: [], changed: ['x'], parts: ['theme'] }),
    ).toBe('Added a, b, c and 2 more · Changed x · Changed the theme')
    expect(describeChange({ added: [], removed: [], changed: [], parts: [] })).toBe('No changes')
  })
})
