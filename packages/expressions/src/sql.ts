import { type Node, parseExpressionAt } from 'acorn'
import type * as ESTree from 'estree'
import { findExpressionEnd, TemplateError } from './template'

export type SqlDialect = 'postgres' | 'mysql' | 'bigquery'

export interface SqlParam {
  /** Expression source between the braces; evaluated in the sandbox to produce the bound value. */
  code: string
  /**
   * Set for a value a fragment binds itself (`sql.where`'s filter values, M24): `value` is what's bound, `code` the
   * fragment's, for errors.
   */
  bound?: true
  value?: unknown
  /** Offsets of the whole `{{ … }}` in the original SQL. */
  start: number
  end: number
}

/**
 * What a `{{ sql.column(…) }}` or `{{ sql.direction(…) }}` may become: SQL text, not a bound value, so a sort
 * column can be chosen at run time. Only from a list written in the query itself (see `sqlFragment`).
 */
export type SqlFragmentSpec =
  /** `sql.column(value, ['name', 'price'], 'id')`: one of the listed columns (or the fallback), quoted. */
  | { kind: 'column'; columns: string[]; fallback?: string }
  /** `sql.direction(value)`: `ASC` or `DESC`. */
  | { kind: 'direction' }
  /**
   * `sql.where(table1.filters, ['name', 'total'])` (M24): a table's filters as a condition on the listed columns,
   * their values bound (`TRUE` when there are none).
   */
  | { kind: 'where'; columns: string[] }

/** A fragment's SQL: text with `FRAGMENT_PLACEHOLDER` where each of `values` is bound, in order. */
export interface FragmentSql {
  text: string
  values: unknown[]
}

/** Marks a bound value's place in a fragment's text; `withFragments` puts the dialect's placeholder there. */
export const FRAGMENT_PLACEHOLDER = '\u0000'

export interface SqlFragment {
  /** The whole expression, evaluated like a parameter's (the `sql` helpers pick the column). */
  code: string
  spec: SqlFragmentSpec
  /** Offsets of the whole `{{ … }}` in the original SQL. */
  start: number
  end: number
  /** Where its text goes in `text` (before the placeholders' offsets are shifted by it). */
  at: number
}

export interface CompiledSql {
  /** The dialect it was compiled for: its placeholders' form. */
  dialect: SqlDialect
  /** SQL with each `{{ }}` replaced by a placeholder: `$1`, `$2`, … (Postgres), `?` (MySQL), `@p1`, … (BigQuery). */
  text: string
  /** One per placeholder, in order: `params[0]` binds `$1`. */
  params: SqlParam[]
  /** Where each placeholder starts in `text`, so a connector can expand one (MySQL arrays become `?, ?, ?`). */
  offsets: number[]
  /**
   * The `{{ sql.column(…) }}` and `{{ sql.direction(…) }}` in order: they have no placeholder; their text goes in
   * with `withFragments` once their values are known and checked (`fragmentText`).
   */
  fragments: SqlFragment[]
}

const IDENT = /[A-Za-z0-9_$\u0080-￿]/
const AFTER_FRAGMENT = /[A-Za-z0-9_$\u0080-￿{"'`]/
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
  const fragments: SqlFragment[] = []
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
      const spec = sqlFragment(code, i, end + 2)
      if (spec) {
        // Keep it a separate token too: `order by{{ … }}` must not become `order by"name"` glued to a keyword.
        if (out.length && IDENT.test(out.at(-1)!)) out += ' '
        fragments.push({ code, spec, start: i, end: end + 2, at: out.length })
        // Its text goes in later: whatever follows straight away (a word, a quote, another {{ }}) needs the space now.
        if (AFTER_FRAGMENT.test(src[end + 2] ?? '')) out += ' '
        i = end + 2
        continue
      }
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

  return { dialect, text: out, params, offsets, fragments }
}

const MENTIONS_HELPER = /\bsql\s*\??\.\s*(column|direction|where)\b/
const MISPLACED =
  "sql.column(…) and sql.direction(…) must be the whole {{ }}: {{ sql.column(table1.sort.column, ['name', 'price']) }}"
/** Room for qualified names (`p.name`); quotes and control characters never. */
const COLUMN = /^[^"`\\\p{Cc}]{1,128}$/u
const MAX_COLUMNS = 200

/**
 * Whether one `{{ }}` of a SQL query is a `sql.column(…)` or `sql.direction(…)`, and what it may become. The
 * columns must be written in the query as a list of strings (the stored query is what the server trusts, not the
 * value a browser sends), and the call must be the whole expression. Throws `TemplateError` when the helpers are
 * used any other way. `start` and `end` locate the `{{ }}` for errors.
 */
export function sqlFragment(code: string, start = 0, end = code.length): SqlFragmentSpec | null {
  if (!MENTIONS_HELPER.test(code)) return null
  const fail = (message: string): never => {
    throw new TemplateError(message, start, end)
  }
  let node: Node
  try {
    node = parseExpressionAt(code, 0, { ecmaVersion: 'latest' })
  } catch {
    return null // a syntax error: reported as one by whoever evaluates it
  }
  if (code.slice(node.end).trim()) return null
  const call = node as unknown as ESTree.Expression
  if (!readsHelper(call)) return null
  if (
    call.type !== 'CallExpression' ||
    call.optional ||
    call.callee.type !== 'MemberExpression' ||
    call.callee.computed ||
    call.callee.optional ||
    call.callee.object.type !== 'Identifier' ||
    call.callee.object.name !== 'sql' ||
    call.callee.property.type !== 'Identifier'
  ) {
    return fail(MISPLACED)
  }
  const args = call.arguments
  if (args.some((a) => a.type === 'SpreadElement')) return fail(MISPLACED)
  const literal = (n: ESTree.Node | undefined) =>
    n?.type === 'Literal' && typeof n.value === 'string' ? n.value : null

  if (call.callee.property.name === 'direction') {
    if (args.length !== 1) return fail('sql.direction takes one value: true or "desc" for DESC, else ASC')
    return { kind: 'direction' }
  }
  if (call.callee.property.name === 'where') {
    const list = args[1]
    const columns =
      list?.type === 'ArrayExpression' ? list.elements.map((e) => literal(e ?? undefined)) : [null]
    if (args.length !== 2 || !columns.length || columns.includes(null)) {
      return fail(
        "sql.where takes the filters and the columns they may name, written as a list of strings: sql.where(table1.filters, ['name', 'total'])",
      )
    }
    if (columns.length > MAX_COLUMNS) return fail(`sql.where takes at most ${MAX_COLUMNS} columns`)
    for (const c of columns as string[]) {
      if (!COLUMN.test(c) || c.split('.').some((part) => !part.trim())) {
        return fail(`"${c}" can't be a column for sql.where (no quotes, no empty parts)`)
      }
    }
    return { kind: 'where', columns: columns as string[] }
  }
  if (call.callee.property.name !== 'column') return fail(MISPLACED)
  if (args.length < 2 || args.length > 3) {
    return fail(
      "sql.column takes a value, the list of columns it may be, and optionally a fallback: sql.column(table1.sort.column, ['name', 'price'], 'id')",
    )
  }
  const list = args[1]!
  const columns = list.type === 'ArrayExpression' ? list.elements.map((e) => literal(e ?? undefined)) : [null]
  if (!columns.length || columns.includes(null)) {
    return fail("sql.column needs its columns written as a list of strings: ['name', 'price']")
  }
  if (columns.length > MAX_COLUMNS) return fail(`sql.column takes at most ${MAX_COLUMNS} columns`)
  const fallback = args[2] ? literal(args[2]) : undefined
  if (fallback === null) return fail('The fallback of sql.column must be a string')
  for (const c of [...(columns as string[]), ...(fallback === undefined ? [] : [fallback])]) {
    if (!COLUMN.test(c) || c.split('.').some((part) => !part.trim())) {
      return fail(`"${c}" can't be a column for sql.column (no quotes, no empty parts)`)
    }
  }
  return { kind: 'column', columns: columns as string[], ...(fallback !== undefined && { fallback }) }
}

/** Whether the expression reads `sql.column` or `sql.direction` anywhere (not just mentions the words). */
function readsHelper(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(readsHelper)
  const n = node as ESTree.Node
  if (
    n.type === 'MemberExpression' &&
    !n.computed &&
    n.object.type === 'Identifier' &&
    n.object.name === 'sql' &&
    n.property.type === 'Identifier' &&
    (n.property.name === 'column' || n.property.name === 'direction' || n.property.name === 'where')
  ) {
    return true
  }
  return Object.entries(n).some(
    ([key, value]) => key !== 'loc' && typeof value === 'object' && readsHelper(value),
  )
}

/** A `sql.column` or `sql.direction` value that isn't one the query allows. */
export class SqlFragmentError extends Error {
  override name = 'SqlFragmentError'
}

/**
 * The SQL text for a fragment's value, after checking it against the query's own list: a column is quoted as an
 * identifier for the dialect (`"p"."name"`, `` `p`.`name` ``), a direction is `ASC` or `DESC`. An empty column value
 * takes the fallback, when there is one.
 */
export function fragmentText(
  spec: SqlFragmentSpec,
  value: unknown,
  dialect: SqlDialect = 'postgres',
): string {
  if (spec.kind === 'where') throw new Error('sql.where binds values: use fragmentSql')
  if (spec.kind === 'direction') {
    if (value === true || (typeof value === 'string' && /^desc$/i.test(value))) return 'DESC'
    if (
      value === false ||
      value === null ||
      value === undefined ||
      (typeof value === 'string' && /^(asc)?$/i.test(value))
    ) {
      return 'ASC'
    }
    throw new SqlFragmentError(
      `sql.direction got ${describe(value)}: expected true or "desc" (DESC), false or "asc" (ASC)`,
    )
  }
  let column: string
  // The helper itself answers with the fallback when nothing is sorted; an empty value means the same.
  if (typeof value === 'string' && (spec.columns.includes(value) || value === spec.fallback)) column = value
  else if ((value === null || value === undefined || value === '') && spec.fallback !== undefined)
    column = spec.fallback
  else {
    const allowed = [...new Set([...spec.columns, ...(spec.fallback === undefined ? [] : [spec.fallback])])]
    throw new SqlFragmentError(
      `sql.column got ${describe(value)}: expected one of ${allowed.map((c) => JSON.stringify(c)).join(', ')}`,
    )
  }
  return quoteColumn(column, dialect)
}

/** A checked column as an identifier for the dialect: `"p"."name"`, `` `p`.`name` ``. */
function quoteColumn(column: string, dialect: SqlDialect): string {
  const quote = dialect === 'postgres' ? '"' : '`'
  return column
    .split('.')
    .map((part) => quote + part + quote)
    .join('.')
}

/** What a fragment becomes: `sql.where`'s condition with its values, or another helper's text. */
export function fragmentSql(
  spec: SqlFragmentSpec,
  value: unknown,
  dialect: SqlDialect = 'postgres',
): FragmentSql {
  return spec.kind === 'where'
    ? whereSql(spec.columns, value, dialect)
    : { text: fragmentText(spec, value, dialect), values: [] }
}

/** The operators a filter may use (M24); `between` takes `[from, to]`, `empty` and `notEmpty` no value. */
export const FILTER_OPS = [
  'contains',
  'equals',
  'notEquals',
  'empty',
  'notEmpty',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
] as const
export type FilterOp = (typeof FILTER_OPS)[number]

/** Filters `sql.where` takes at most. */
export const MAX_FILTERS = 50

const COMPARE: Partial<Record<FilterOp, string>> = {
  equals: '=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
}

/**
 * A table's filters (`[{ column, op, value?, type? }]`) as a condition, ANDed, each column checked against the
 * query's list and each value bound. `type` (a table column's: `number`, `date`, `datetime`…) turns a number typed
 * as text into a number, and in BigQuery casts the value to the column's kind (its parameters are typed).
 */
function whereSql(columns: readonly string[], value: unknown, dialect: SqlDialect): FragmentSql {
  const fail = (message: string): never => {
    throw new SqlFragmentError(`sql.where ${message}`)
  }
  if (value === null || value === undefined) return { text: 'TRUE', values: [] }
  if (!Array.isArray(value)) fail(`got ${describe(value)}: expected a list of filters`)
  const filters = value as unknown[]
  if (filters.length > MAX_FILTERS) fail(`takes at most ${MAX_FILTERS} filters`)
  if (!filters.length) return { text: 'TRUE', values: [] }
  const P = FRAGMENT_PLACEHOLDER
  const values: unknown[] = []
  const parts = filters.map((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      return fail(`got ${describe(filter)}: each filter is { column, op, value }`)
    }
    const { column, op, value: raw, type } = filter as Record<string, unknown>
    if (typeof column !== 'string' || !columns.includes(column)) {
      return fail(
        `got the column ${describe(column)}: expected one of ${columns.map((c) => JSON.stringify(c)).join(', ')}`,
      )
    }
    if (typeof op !== 'string' || !(FILTER_OPS as readonly string[]).includes(op)) {
      return fail(`got the operator ${describe(op)}: expected one of ${FILTER_OPS.join(', ')}`)
    }
    const q = quoteColumn(column, dialect)
    const scalar = (v: unknown): unknown => {
      if (v !== null && typeof v === 'object')
        return fail(`got ${describe(v)} for ${column}: expected a single value`)
      if (type === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
        return Number(v)
      return v ?? null
    }
    // BigQuery compares only like with like: a date or datetime filter casts both sides, so DATE, DATETIME and
    // TIMESTAMP columns all compare (a DATETIME column against a TIMESTAMP value is an error there).
    const cast =
      dialect === 'bigquery' && type === 'date'
        ? 'DATE'
        : dialect === 'bigquery' && type === 'datetime'
          ? 'TIMESTAMP'
          : null
    const qc = cast ? `CAST(${q} AS ${cast})` : q
    const bind = (v: unknown) => {
      values.push(v)
      return cast ? `CAST(${P} AS ${cast})` : P
    }
    const asText =
      dialect === 'postgres'
        ? `${q}::text`
        : dialect === 'mysql'
          ? `CAST(${q} AS CHAR)`
          : `CAST(${q} AS STRING)`
    switch (op as FilterOp) {
      case 'contains': {
        const needle = scalar(raw)
        values.push(needle === null ? '' : String(needle))
        if (dialect === 'postgres') return `position(lower(${P}) in lower(${asText})) > 0`
        if (dialect === 'mysql') return `LOCATE(LOWER(${P}), LOWER(${asText})) > 0`
        return `STRPOS(LOWER(${asText}), LOWER(${P})) > 0`
      }
      case 'empty':
        return `${q} IS NULL OR ${asText} = ''`
      case 'notEmpty':
        return `NOT (${q} IS NULL OR ${asText} = '')`
      case 'notEquals':
        return `${qc} <> ${bind(scalar(raw))} OR ${q} IS NULL`
      case 'between': {
        if (!Array.isArray(raw) || raw.length !== 2) {
          return fail(`between on ${column} takes [from, to], got ${describe(raw)}`)
        }
        return `${qc} BETWEEN ${bind(scalar(raw[0]))} AND ${bind(scalar(raw[1]))}`
      }
      default:
        return `${qc} ${COMPARE[op as FilterOp]} ${bind(scalar(raw))}`
    }
  })
  return { text: parts.map((p) => `(${p})`).join(' AND '), values }
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing'
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

/**
 * The plan with each fragment's SQL in place (`pieces[i]` for `fragments[i]`: text, or text with the values it binds)
 * and every placeholder numbered again in order for the dialect, so a fragment's values bind where they stand.
 */
export function withFragments(plan: CompiledSql, pieces: readonly (string | FragmentSql)[]): CompiledSql {
  if (!plan.fragments.length) return plan
  const { dialect } = plan
  const placeholder = (n: number) => (dialect === 'mysql' ? '?' : dialect === 'bigquery' ? `@p${n}` : `$${n}`)
  // What sits in the text, in order: the plan's placeholders (each its param) and the fragments.
  type Slot =
    | { at: number; length: number; param: SqlParam }
    | { at: number; length: 0; piece: FragmentSql; fragment: SqlFragment }
  const slots: Slot[] = [
    ...plan.params.map((param, i) => ({ at: plan.offsets[i]!, length: placeholder(i + 1).length, param })),
    ...plan.fragments.map((fragment, i) => {
      const piece = pieces[i]!
      return {
        at: fragment.at,
        length: 0 as const,
        piece: typeof piece === 'string' ? { text: piece, values: [] } : piece,
        fragment,
      }
    }),
  ].sort((a, b) => a.at - b.at)
  let text = ''
  let from = 0
  const params: SqlParam[] = []
  const offsets: number[] = []
  const bindHere = (param: SqlParam) => {
    params.push(param)
    offsets.push(text.length)
    text += placeholder(params.length)
  }
  for (const slot of slots) {
    text += plan.text.slice(from, slot.at)
    from = slot.at + slot.length
    if ('param' in slot) {
      bindHere(slot.param)
      continue
    }
    const { piece, fragment } = slot
    const chunks = piece.text.split(FRAGMENT_PLACEHOLDER)
    if (chunks.length !== piece.values.length + 1)
      throw new Error('A fragment binds as many values as it has places')
    for (const [k, chunk] of chunks.entries()) {
      text += chunk
      if (k < piece.values.length) {
        bindHere({
          code: fragment.code,
          start: fragment.start,
          end: fragment.end,
          bound: true,
          value: piece.values[k],
        })
      }
    }
  }
  text += plan.text.slice(from)
  return { dialect, text, params, offsets, fragments: [] }
}

/** A param's value: bound by a fragment, or its code evaluated. */
export async function paramValue(param: SqlParam, evaluate: (code: string) => unknown): Promise<unknown> {
  return param.bound ? param.value : await evaluate(param.code)
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
