// Bundled by esbuild into a single IIFE and baked into the isolate snapshot.
// Everything assigned to globalThis here is available to user code and {{ }} expressions.
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import relativeTime from 'dayjs/plugin/relativeTime'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import _ from 'lodash'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(customParseFormat)
dayjs.extend(relativeTime)

globalThis._ = _
globalThis.dayjs = dayjs

const quoted = (value) => (value === undefined ? 'nothing' : JSON.stringify(value))

// For SQL queries: `ORDER BY {{ sql.column(table1.sort.column, ['name', 'price'], 'id') }} {{ sql.direction(…) }}`
// picks a sort column and direction from a list written in the query. The SQL connectors check the result again
// against that list before it becomes SQL text (see compileSql in @ow/expressions), whoever computed it.
globalThis.sql = Object.freeze({
  column(value, columns, fallback) {
    if (!Array.isArray(columns)) throw new TypeError('sql.column needs the list of columns it may be')
    if (typeof value === 'string' && columns.includes(value)) return value
    if ((value === null || value === undefined || value === '') && fallback !== undefined) return fallback
    throw new Error(`sql.column got ${quoted(value)}: expected one of ${columns.map(quoted).join(', ')}`)
  },
  direction(value) {
    if (value === true || (typeof value === 'string' && /^desc$/i.test(value))) return 'DESC'
    if (
      value === false ||
      value === null ||
      value === undefined ||
      (typeof value === 'string' && /^(asc)?$/i.test(value))
    ) {
      return 'ASC'
    }
    throw new Error(
      `sql.direction got ${quoted(value)}: expected true or "desc" (DESC), false or "asc" (ASC)`,
    )
  },
  // `WHERE {{ sql.where(table1.filters, ['name', 'total']) }}` (M24): a table's filters as a condition. Here it
  // answers with the filters; the SQL connector checks them against the list and binds their values.
  where(filters, columns) {
    if (!Array.isArray(columns))
      throw new TypeError('sql.where needs the list of columns the filters may name')
    if (filters === null || filters === undefined) return []
    if (!Array.isArray(filters))
      throw new Error(`sql.where got ${quoted(filters)}: expected a list of filters`)
    for (const f of filters) {
      if (!f || !columns.includes(f.column)) {
        throw new Error(
          `sql.where got the column ${quoted(f?.column)}: expected one of ${columns.map(quoted).join(', ')}`,
        )
      }
    }
    return filters
  },
})
