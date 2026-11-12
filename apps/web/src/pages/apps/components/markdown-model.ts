/**
 * A small Markdown reader for the Text component's `markdown` prop (M36: Retool's Text is Markdown): headings, bold,
 * italic, inline code, links, lists, quotes, code blocks and rules. It returns a tree that the renderer turns into
 * React elements, so nothing is ever HTML: tags in the text show as text, and links only go to http(s) and mailto.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'br' }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }

const SAFE_HREF = /^(https?:\/\/|mailto:)/i

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', children: inlineLines(paragraph) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!)
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1, children: parseInline(heading[2]!) })
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }
    const item = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[1]!)
      const items: Inline[][] = [parseInline(item[2]!)]
      while (i + 1 < lines.length) {
        const next = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]!)
        if (!next || /\d/.test(next[1]!) !== ordered) break
        items.push(parseInline(next[2]!))
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      const quoted = [quote[1]!]
      while (i + 1 < lines.length && /^\s{0,3}>/.test(lines[i + 1]!))
        quoted.push(lines[++i]!.replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ kind: 'quote', children: inlineLines(quoted) })
      continue
    }
    if (!line.trim()) flush()
    else paragraph.push(line)
  }
  flush()
  return blocks
}

/** Lines of one paragraph: joined with breaks, as the text was written. */
function inlineLines(lines: string[]): Inline[] {
  return lines.flatMap((line, i) => [...(i ? [{ kind: 'br' } as const] : []), ...parseInline(line)])
}

/** Inline marks, left to right; an unmatched mark is plain text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let plain = ''
  const push = (node: Inline) => {
    if (plain) out.push({ kind: 'text', text: plain })
    plain = ''
    out.push(node)
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    if (rest[0] === '\\' && rest.length > 1 && /[\\`*_[\]()#~>-]/.test(rest[1]!)) {
      plain += rest[1]
      i += 2
      continue
    }
    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      push({ kind: 'code', text: code[1]! })
      i += code[0].length
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link) {
      const href = link[2]!
      if (SAFE_HREF.test(href)) push({ kind: 'link', href, children: parseInline(link[1]!) })
      else plain += link[1]
      i += link[0].length
      continue
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (strong) {
      push({ kind: 'strong', children: parseInline(strong[2]!) })
      i += strong[0].length
      continue
    }
    const del = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest)
    if (del) {
      push({ kind: 'del', children: parseInline(del[1]!) })
      i += del[0].length
      continue
    }
    const em = /^([*_])(?=\S)([\s\S]*?\S)\1(?![*_])/.exec(rest)
    // `_` inside a word (snake_case) isn't emphasis.
    if (em && !(em[1] === '_' && /\w/.test(text[i - 1] ?? ''))) {
      push({ kind: 'em', children: parseInline(em[2]!) })
      i += em[0].length
      continue
    }
    plain += rest[0]
    i++
  }
  if (plain) out.push({ kind: 'text', text: plain })
  return out
}
