import { findExpressionEnd, TemplateError } from './template'

/** MySQL (`?`, array expansion) and BigQuery (`@pN`) arrive with their connectors in M6. */
export type SqlDialect = 'postgres'

export interface SqlParam {
  /** Expression source between the braces; evaluated in the sandbox to produce the bound value. */
  code: string
  /** Offsets of the whole `{{ … }}` in the original SQL. */
  start: number
  end: number
}

export interface CompiledSql {
  /** SQL with each `{{ }}` replaced by a placeholder (`$1`, `$2`, … for Postgres). */
  text: string
  /** One per placeholder, in order: `params[0]` binds `$1`. */
  params: SqlParam[]
}

const IDENT = /[A-Za-z0-9_$\u0080-￿]/

/**
 * Turns `{{ }}` in SQL into bind parameters, so values never become SQL text (no injection, and a value can't be
 * a table or column name). Quote- and comment-aware for Postgres: `'…'` (with `''`), `E'…'` (backslash escapes),
 * `"identifiers"`, `$tag$ dollar quotes $tag$`, `-- line` and nested `/* block *\/` comments.
 *
 * A `{{ }}` inside a string literal or quoted identifier is an error with a fix-it hint; inside a comment it's
 * left as text. Hand-written `$1` placeholders are rejected so numbering can't collide.
 */
export function compileSql(src: string, _dialect: SqlDialect = 'postgres'): CompiledSql {
  const params: SqlParam[] = []
  let out = ''
  let i = 0

  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]
    const prev = i > 0 ? src[i - 1]! : ''

    if (ch === '{' && next === '{') {
      const end = findExpressionEnd(src, i + 2)
      if (end === -1) throw new TemplateError('Unterminated {{ — missing the closing }}', i, src.length)
      const code = src.slice(i + 2, end)
      if (!code.trim()) throw new TemplateError('Empty {{ }} expression', i, end + 2)
      params.push({ code, start: i, end: end + 2 })
      // Keep the placeholder a separate token: `x{{a}}` must not become the identifier `x$1`.
      const placeholder = `$${params.length}`
      const before = out.length && IDENT.test(out.at(-1)!) ? ' ' : ''
      const after = IDENT.test(src[end + 2] ?? '') ? ' ' : ''
      out += before + placeholder + after
      i = end + 2
      continue
    }

    if (ch === '-' && next === '-') {
      const nl = src.indexOf('\n', i)
      const stop = nl === -1 ? src.length : nl
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === '/' && next === '*') {
      const stop = skipBlockComment(src, i)
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === "'") {
      const backslashes = (prev === 'E' || prev === 'e') && !IDENT.test(src[i - 2] ?? '')
      const stop = skipQuoted(src, i, "'", backslashes)
      rejectExpressionsIn(src, i, stop, 'string')
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === '"') {
      const stop = skipQuoted(src, i, '"', false)
      rejectExpressionsIn(src, i, stop, 'identifier')
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === '$' && !IDENT.test(prev)) {
      if (/\d/.test(next ?? '')) {
        const m = /^\$\d+/.exec(src.slice(i))!
        throw new TemplateError(
          `Positional parameter ${m[0]} isn't supported`,
          i,
          i + m[0].length,
          'Write the value as {{ expression }}; it becomes a bind parameter automatically.',
        )
      }
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i))
      if (tag) {
        const close = src.indexOf(tag[0], i + tag[0].length)
        const stop = close === -1 ? src.length : close + tag[0].length
        if (close === -1)
          throw new TemplateError(`Unterminated dollar-quoted string ${tag[0]}`, i, src.length)
        rejectExpressionsIn(src, i, stop, 'string')
        out += src.slice(i, stop)
        i = stop
        continue
      }
    }

    out += ch
    i++
  }

  return { text: out, params }
}

/** Index just past the closing quote. A doubled quote is an escaped quote; so is a backslash escape in E-strings. */
function skipQuoted(src: string, start: number, quote: string, backslashes: boolean): number {
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (backslashes && ch === '\\') i += 2
    else if (ch === quote && src[i + 1] === quote) i += 2
    else if (ch === quote) return i + 1
    else i++
  }
  throw new TemplateError(
    quote === "'" ? 'Unterminated string literal' : 'Unterminated quoted identifier',
    start,
    src.length,
  )
}

/** Postgres block comments nest. Index just past the final `*\/` (or the end of input). */
function skipBlockComment(src: string, start: number): number {
  let depth = 0
  let i = start
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      depth++
      i += 2
    } else if (src[i] === '*' && src[i + 1] === '/') {
      depth--
      i += 2
      if (depth === 0) return i
    } else i++
  }
  return i
}

/** `{{ }}` inside a quoted region would be sent as literal text (or, if substituted, be an injection). */
function rejectExpressionsIn(src: string, start: number, stop: number, kind: 'string' | 'identifier'): void {
  const at = src.indexOf('{{', start)
  if (at === -1 || at >= stop) return
  if (kind === 'identifier') {
    throw new TemplateError(
      "{{ }} can't be used inside a quoted identifier",
      at,
      stop,
      'Table and column names can’t be parameters. Write the name directly in the SQL.',
    )
  }
  const end = findExpressionEnd(src, at + 2)
  const wholeLiteral = at === start + 1 && end !== -1 && end + 2 === stop - 1
  throw new TemplateError(
    "{{ }} can't be used inside a SQL string literal",
    at,
    stop,
    wholeLiteral
      ? 'Remove the quotes: {{ x }} is already sent as a bound value.'
      : "Build the whole string in the expression instead, e.g. LIKE {{ '%' + search + '%' }}.",
  )
}
