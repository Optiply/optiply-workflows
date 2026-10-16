import { describe, expect, it } from 'vitest'
import { lineDiff, MAX_DIFF_LINES, withContext } from './diff'

const kinds = (before: string, after: string) =>
  lineDiff(before, after)!.map((l) => `${l.kind === 'same' ? ' ' : l.kind === 'added' ? '+' : '-'}${l.text}`)

describe('lineDiff', () => {
  it('marks changed lines, removals before additions, with line numbers', () => {
    expect(kinds('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c'])
    expect(lineDiff('a\nb', 'a\nb\nc')).toEqual([
      { kind: 'same', text: 'a', before: 1, after: 1 },
      { kind: 'same', text: 'b', before: 2, after: 2 },
      { kind: 'added', text: 'c', before: null, after: 3 },
    ])
  })

  it('handles empty texts, insertions in the middle and moved lines', () => {
    expect(kinds('', 'x\ny')).toEqual(['+x', '+y'])
    expect(kinds('x\ny', '')).toEqual(['-x', '-y'])
    expect(kinds('1\n2\n3\n4', '1\n2\nnew\n3\n4')).toEqual([' 1', ' 2', '+new', ' 3', ' 4'])
    expect(kinds('a\nb\nc', 'c\na\nb')).toEqual(['+c', ' a', ' b', '-c'])
  })

  it('keeps every line of both texts, in order', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i % 7}`).join('\n')
    const after = Array.from({ length: 220 }, (_, i) => `line ${(i * 3) % 11}`).join('\n')
    const diff = lineDiff(before, after)!
    expect(diff.filter((l) => l.kind !== 'added').map((l) => l.text)).toEqual(before.split('\n'))
    expect(diff.filter((l) => l.kind !== 'removed').map((l) => l.text)).toEqual(after.split('\n'))
  })

  it('gives up on very long texts', () => {
    expect(lineDiff('x\n'.repeat(MAX_DIFF_LINES + 1), 'y')).toBeNull()
  })
})

describe('withContext', () => {
  it('folds long unchanged stretches', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const after = before.replace('l10', 'changed')
    const folded = withContext(lineDiff(before, after)!, 2)
    expect(folded.map((l) => (l ? l.text : '…'))).toEqual([
      '…',
      'l8',
      'l9',
      'l10',
      'changed',
      'l11',
      'l12',
      '…',
    ])
  })
})
