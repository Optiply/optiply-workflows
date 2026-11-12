/** A problem in user-written template text, with the offending source range for editor diagnostics. */
export class TemplateError extends Error {
  override name = 'TemplateError'
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
    /** How to fix it, shown under the message. */
    readonly hint?: string,
  ) {
    super(message)
  }
}

export type TemplatePart =
  | { type: 'text'; value: string; start: number; end: number }
  /** `code` is the raw text between the braces; `start`/`end` span the whole `{{ … }}`. */
  | { type: 'expression'; code: string; start: number; end: number }

/**
 * Index of the first `}` of the `}}` that closes an expression whose code starts at `from` (just after `{{`), or
 * -1 if it is unterminated. JS-aware, so braces and `}}` inside strings, template literals, regex literals, comments
 * and object literals don't end it early: `{{ {a: {b: 1}} }}`, `{{ "}}" }}` and `{{ s.replace(/'/g, "''") }}` work.
 */
export function findExpressionEnd(src: string, from: number): number {
  // Brace depth per nesting level; a template literal's `${` pushes a level that its `}` pops.
  const stack: ('brace' | 'interp')[] = []
  let i = from
  // Whether a `/` here would start a regex literal (rather than divide): true where an expression can start.
  let regexAllowed = true
  while (i < src.length) {
    const ch = src[i]!
    if (ch === "'" || ch === '"') {
      i = skipQuoted(src, i, ch)
      regexAllowed = false
      continue
    }
    if (ch === '`') {
      const r = skipTemplateLiteral(src, i)
      if (r.interp) {
        stack.push('interp')
        i = r.index
        regexAllowed = true
        continue
      }
      i = r.index
      regexAllowed = false
      continue
    }
    if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && regexAllowed) {
      const end = skipRegex(src, i)
      if (end !== -1) {
        i = end
        regexAllowed = false
        continue
      }
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      // A whole word: after a value it's division, after a keyword like `return` or `typeof` a regex.
      let j = i
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++
      regexAllowed = REGEX_AFTER_WORDS.has(src.slice(i, j))
      i = j
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl + 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close === -1 ? src.length : close + 2
      continue
    }
    if (ch === '{') stack.push('brace')
    else if (ch === '}') {
      const top = stack.pop()
      if (top === undefined) {
        if (src[i + 1] === '}') return i
      } else if (top === 'interp') {
        // Back inside the template literal: continue scanning its text.
        const r = skipTemplateLiteral(src, i)
        if (r.interp) stack.push('interp')
        i = r.index
        regexAllowed = r.interp
        continue
      }
    }
    // After `)`, `]` or `}` a value ends (division follows); after any other punctuation an expression starts.
    regexAllowed = !(ch === ')' || ch === ']' || ch === '}')
    i++
  }
  return -1
}

/** Words after which a `/` starts a regex literal. */
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

/** Index just past a regex literal starting at `start` (its flags included), or -1 if none closes on its line. */
function skipRegex(src: string, start: number): number {
  let i = start + 1
  let inClass = false
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') i += 2
    else if (ch === '\n') return -1
    else if (ch === '[') {
      inClass = true
      i++
    } else if (ch === ']') {
      inClass = false
      i++
    } else if (ch === '/' && !inClass) {
      i++
      while (i < src.length && /[a-z]/.test(src[i]!)) i++
      return i
    } else i++
  }
  return -1
}

/** Returns the index just past the closing quote (or the end of input). */
function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') i += 2
    else if (ch === quote || ch === '\n') return i + 1
    else i++
  }
  return i
}

/**
 * Scans template-literal text starting at the opening backtick (or the `}` closing an interpolation). Stops just
 * past the closing backtick, or just past a `${` (with `interp: true`).
 */
function skipTemplateLiteral(src: string, start: number): { index: number; interp: boolean } {
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') i += 2
    else if (ch === '`') return { index: i + 1, interp: false }
    else if (ch === '$' && src[i + 1] === '{') return { index: i + 2, interp: true }
    else i++
  }
  return { index: i, interp: false }
}

/** Splits `Hello {{ user.name }}!` into text and expression parts. */
export function parseTemplate(src: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let textStart = 0
  let i = src.indexOf('{{')
  while (i !== -1) {
    const end = findExpressionEnd(src, i + 2)
    if (end === -1) throw new TemplateError('Unterminated {{ — missing the closing }}', i, src.length)
    const code = src.slice(i + 2, end)
    if (!code.trim()) throw new TemplateError('Empty {{ }} expression', i, end + 2)
    if (i > textStart) parts.push({ type: 'text', value: src.slice(textStart, i), start: textStart, end: i })
    parts.push({ type: 'expression', code, start: i, end: end + 2 })
    textStart = end + 2
    i = src.indexOf('{{', textStart)
  }
  if (textStart < src.length) {
    parts.push({ type: 'text', value: src.slice(textStart), start: textStart, end: src.length })
  }
  return parts
}

/**
 * The expression code when the template is exactly one `{{ }}` (surrounding whitespace allowed). Such a template
 * evaluates to the expression's value as-is (number, object, …) instead of being stringified into text.
 */
export function singleExpression(parts: readonly TemplatePart[]): string | null {
  const exprs = parts.filter((p) => p.type === 'expression')
  if (exprs.length !== 1) return null
  const onlyWhitespace = parts.every((p) => p.type === 'expression' || !p.value.trim())
  return onlyWhitespace ? exprs[0]!.code : null
}
