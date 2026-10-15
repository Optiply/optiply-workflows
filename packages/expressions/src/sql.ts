import { findExpressionEnd, TemplateError } from './template'

export type SqlDialect = 'postgres' | 'mysql' | 'bigquery'

export interface SqlParam {
  /** Expression source between the braces; evaluated in the sandbox to produce the bound value. */
  code: string
  /** Offsets of the whole `{{ … }}` in the original SQL. */
  start: number
  end: number
}

export interface CompiledSql {
  /** SQL with each `{{ }}` replaced by a placeholder: `$1`, `$2`, … (Postgres), `?` (MySQL), `@p1`, … (BigQuery). */
  text: string
  /** One per placeholder, in order: `params[0]` binds `$1`. */
  params: SqlParam[]
  /** Where each placeholder starts in `text`, so a connector can expand one (MySQL arrays become `?, ?, ?`). */
  offsets: number[]
}

const IDENT = /[A-Za-z0-9_$\u0080-￿]/
const HINT = 'Write the value as {{ expression }}; it becomes a bind parameter automatically.'

/**
 * Turns `{{ }}` in SQL into bind parameters, so values never become SQL text (no injection, and a value can't be
 * a table or column name). Quote- and comment-aware per dialect:
 * - Postgres: `'…'` (with `''`), `E'…'` (backslash escapes), `"identifiers"`, `$tag$ dollar quotes $tag$`,
 *   `-- line` and nested `/* block *\/` comments; placeholders `$1`, `$2`, ….
 * - MySQL: `'…'` and `"…"` strings (backslash escapes, as in the default SQL mode), `` `identifiers` ``,
 *   `# line`, `-- line` (the dashes followed by a space) and non-nesting `/* block *\/` comments; placeholders `?`.
 * - BigQuery (GoogleSQL): `'…'`, `"…"`, `'''…'''` and `"""…"""` strings, optionally raw or bytes (`r'…'`,
 *   `b"…"`, `rb'''…'''`), all with backslash escapes; `` `identifiers` ``; `# line`, `-- line` and non-nesting
 *   `/* block *\/` comments; placeholders `@p1`, `@p2`, ….
 *
 * A `{{ }}` inside a string literal or quoted identifier is an error with a fix-it hint; inside a comment it's
 * left as text. Hand-written placeholders (`$1`, `?`, `@name`) are rejected so they can't collide.
 */
export function compileSql(src: string, dialect: SqlDialect = 'postgres'): CompiledSql {
  const pg = dialect === 'postgres'
  const mysql = dialect === 'mysql'
  const bq = dialect === 'bigquery'
  const params: SqlParam[] = []
  const offsets: number[] = []
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
      const placeholder = mysql ? '?' : bq ? `@p${params.length}` : `$${params.length}`
      const before = out.length && IDENT.test(out.at(-1)!) ? ' ' : ''
      const after = IDENT.test(src[end + 2] ?? '') ? ' ' : ''
      offsets.push(out.length + before.length)
      out += before + placeholder + after
      i = end + 2
      continue
    }

    if (
      (ch === '-' && next === '-' && (!mysql || isMysqlDashCommentEnd(src[i + 2]))) ||
      (!pg && ch === '#')
    ) {
      const nl = src.indexOf('\n', i)
      const stop = nl === -1 ? src.length : nl
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === '/' && next === '*') {
      const stop = skipBlockComment(src, i, pg)
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === "'" || (!pg && ch === '"')) {
      const backslashes = !pg || ((prev === 'E' || prev === 'e') && !IDENT.test(src[i - 2] ?? ''))
      const triple = bq && src.startsWith(ch.repeat(3), i)
      const stop = triple ? skipTripleQuoted(src, i, ch) : skipQuoted(src, i, ch, backslashes)
      rejectExpressionsIn(src, i, stop, 'string', triple ? 3 : 1)
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === (pg ? '"' : '`')) {
      const stop = skipQuoted(src, i, ch, bq, 'identifier')
      rejectExpressionsIn(src, i, stop, 'identifier')
      out += src.slice(i, stop)
      i = stop
      continue
    }

    if (!pg && ch === '?') {
      throw new TemplateError("Positional parameter ? isn't supported", i, i + 1, HINT)
    }

    // `@@system_variables` are fine; a hand-written `@name` would be an unbound (or colliding) parameter.
    if (bq && ch === '@' && next !== '@' && prev !== '@' && /[A-Za-z_]/.test(next ?? '')) {
      const m = /^@[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      throw new TemplateError(`Named parameter ${m[0]} isn't supported`, i, i + m[0].length, HINT)
    }

    if (pg && ch === '$' && !IDENT.test(prev)) {
      if (/\d/.test(next ?? '')) {
        const m = /^\$\d+/.exec(src.slice(i))!
        throw new TemplateError(`Positional parameter ${m[0]} isn't supported`, i, i + m[0].length, HINT)
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

  return { text: out, params, offsets }
}

/** In MySQL `--` starts a comment only when followed by whitespace, a control character or the end of input. */
function isMysqlDashCommentEnd(ch: string | undefined): boolean {
  return ch === undefined || ch <= ' '
}

/** BigQuery `'''…'''` and `"""…"""`: index just past the closing triple quote. Backslashes escape. */
function skipTripleQuoted(src: string, start: number, quote: string): number {
  const close = quote.repeat(3)
  let i = start + 3
  while (i < src.length) {
    if (src[i] === '\\') i += 2
    else if (src.startsWith(close, i)) return i + 3
    else i++
  }
  throw new TemplateError('Unterminated string literal', start, src.length)
}

/** Index just past the closing quote. A doubled quote is an escaped quote; so is a backslash escape in E-strings. */
function skipQuoted(
  src: string,
  start: number,
  quote: string,
  backslashes: boolean,
  kind: 'string' | 'identifier' = 'string',
): number {
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (backslashes && ch === '\\') i += 2
    else if (ch === quote && src[i + 1] === quote) i += 2
    else if (ch === quote) return i + 1
    else i++
  }
  throw new TemplateError(
    kind === 'string' ? 'Unterminated string literal' : 'Unterminated quoted identifier',
    start,
    src.length,
  )
}

/** Index just past the final `*\/` (or the end of input). Postgres block comments nest; MySQL's don't. */
function skipBlockComment(src: string, start: number, nested: boolean): number {
  let depth = 0
  let i = start
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*' && (nested || depth === 0)) {
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
function rejectExpressionsIn(
  src: string,
  start: number,
  stop: number,
  kind: 'string' | 'identifier',
  quoteWidth = 1,
): void {
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
  const wholeLiteral = at === start + quoteWidth && end !== -1 && end + 2 === stop - quoteWidth
  throw new TemplateError(
    "{{ }} can't be used inside a SQL string literal",
    at,
    stop,
    wholeLiteral
      ? 'Remove the quotes: {{ x }} is already sent as a bound value.'
      : "Build the whole string in the expression instead, e.g. LIKE {{ '%' + search + '%' }}.",
  )
}
