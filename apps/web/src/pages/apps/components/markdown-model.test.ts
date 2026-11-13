import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown-model'

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, lists, quotes, code and rules', () => {
    expect(
      parseMarkdown('### Orders\nOpen ones\nonly\n\n- a\n- b\n1. one\n> note\n---\n```\nx < 1\n```'),
    ).toEqual([
      { kind: 'heading', level: 3, children: [{ kind: 'text', text: 'Orders' }] },
      {
        kind: 'paragraph',
        children: [{ kind: 'text', text: 'Open ones' }, { kind: 'br' }, { kind: 'text', text: 'only' }],
      },
      { kind: 'list', ordered: false, items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]] },
      { kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'one' }]] },
      { kind: 'quote', children: [{ kind: 'text', text: 'note' }] },
      { kind: 'rule' },
      { kind: 'code', text: 'x < 1' },
    ])
  })

  it('reads inline marks, and leaves unmatched ones and snake_case alone', () => {
    expect(parseInline('**Total**: `42` _items_ ~~old~~ a_b_c 2 * 3')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'Total' }] },
      { kind: 'text', text: ': ' },
      { kind: 'code', text: '42' },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'items' }] },
      { kind: 'text', text: ' ' },
      { kind: 'del', children: [{ kind: 'text', text: 'old' }] },
      { kind: 'text', text: ' a_b_c 2 * 3' },
    ])
  })

  it('links only to http(s) and mailto; HTML stays text', () => {
    expect(parseInline('[docs](https://example.com) [x](javascript:alert(1)) <b>hi</b>')).toEqual([
      { kind: 'link', href: 'https://example.com', children: [{ kind: 'text', text: 'docs' }] },
      { kind: 'text', text: ' x) <b>hi</b>' },
    ])
  })
})
