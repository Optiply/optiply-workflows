import type { KeyboardEvent } from 'react'
import type { RouterOutputs } from '@/lib/trpc'
import { cn } from '@/lib/utils'

export type TableInfo = RouterOutputs['database']['tables'][number]
export type Column = TableInfo['columns'][number]
export type Row = Record<string, unknown>

export const TYPE_LABELS: Record<Column['type'], string> = {
  text: 'Text',
  integer: 'Integer',
  bigint: 'Big integer',
  decimal: 'Number',
  boolean: 'Checkbox',
  date: 'Date',
  datetime: 'Date + Time',
  json: 'JSON',
  uuid: 'UUID',
  other: 'Other',
}

/** How a column's type reads: its preset where it has one (an enum, a foreign key, an auto-numbered ID). */
export function columnLabel(column: Column): string {
  if (column.primaryKey) return 'key'
  if (column.identity) return 'Auto ID'
  if (column.references) return `→ ${column.references.table}`
  if (column.enumValues) return 'Enum'
  if (
    column.type === 'datetime' &&
    column.default.kind === 'expression' &&
    column.default.expression === 'now()'
  )
    return 'Created time'
  if (column.type === 'other') return column.sqlType
  return TYPE_LABELS[column.type]
}

/** Starting widths, by type; columns can be resized. */
export function defaultWidth(column: Column): number {
  switch (column.type) {
    case 'boolean':
      return 90
    case 'integer':
    case 'bigint':
    case 'decimal':
    case 'date':
      return 130
    case 'datetime':
      return 210
    case 'uuid':
      return 300
    case 'json':
      return 260
    default:
      return 220
  }
}

/** Whether the grid can edit a column's cells: not the key, nor values Postgres fills in itself. */
export function editable(column: Column, table: TableInfo): boolean {
  return table.primaryKey.length === 1 && !column.primaryKey && !column.identity
}

/** A cell as text: JSON compact, booleans as true/false; empty is ''. */
export function cellText(value: unknown, column: Column): string {
  if (value === null || value === undefined) return ''
  if (column.type === 'json') return JSON.stringify(value)
  return String(value)
}

export function CellView({ value, column }: { value: unknown; column: Column }) {
  if (value === null || value === undefined) return <span className="text-muted/50">NULL</span>
  if (column.type === 'boolean') {
    return (
      <span className={cn('font-medium', value ? 'text-success' : 'text-muted')}>
        {value ? 'true' : 'false'}
      </span>
    )
  }
  const text = cellText(value, column)
  const numeric = column.type === 'integer' || column.type === 'bigint' || column.type === 'decimal'
  return (
    <span
      className={cn(
        'block truncate',
        numeric && 'text-right tabular-nums',
        (column.type === 'json' || column.type === 'uuid') && 'font-mono text-xs',
      )}
      title={text.length > 40 ? text : undefined}
    >
      {text}
    </span>
  )
}

/**
 * What an editor's text means as a value to save: empty is NULL (except for text, where it's an empty string);
 * JSON must parse; booleans are true, false or empty. Everything else goes as text and the server converts it.
 */
export function parseCell(
  text: string,
  column: Column,
): { ok: true; value: unknown } | { ok: false; error: string } {
  // An enum's select: empty is NULL, like the other selects.
  if (column.enumValues) return { ok: true, value: text === '' ? null : text }
  if (column.type === 'text') return { ok: true, value: text }
  if (text.trim() === '') return { ok: true, value: null }
  if (column.type === 'json') {
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false, error: 'Not valid JSON' }
    }
  }
  if (column.type === 'boolean') {
    if (text === 'true' || text === 'false') return { ok: true, value: text === 'true' }
    return { ok: false, error: 'Choose true or false' }
  }
  return { ok: true, value: text.trim() }
}

/** Placeholder hints for typing a value, by type. */
export function placeholderFor(column: Column): string {
  switch (column.type) {
    case 'date':
      return 'YYYY-MM-DD'
    case 'datetime':
      return '2026-01-31T09:30:00Z'
    case 'json':
      return '{"key": "value"}'
    case 'integer':
    case 'bigint':
      return '0'
    case 'decimal':
      return '0.00'
    default:
      return ''
  }
}

/** The input for a value of this column's type, used by the grid's cell editor and the add-row form. */
export function ValueInput({
  column,
  value,
  onChange,
  onKeyDown,
  autoFocus,
  className,
  id,
}: {
  column: Column
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => void
  autoFocus?: boolean
  className?: string
  id?: string
}) {
  const base = 'h-full w-full bg-surface px-2 text-sm outline-none'
  if (column.enumValues) {
    return (
      <select
        id={id}
        className={cn(base, className)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose, focused
        autoFocus={autoFocus}
      >
        <option value="">NULL</option>
        {/* A value set in SQL before the enum stays choosable. */}
        {value !== '' && !column.enumValues.includes(value) && <option value={value}>{value}</option>}
        {column.enumValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    )
  }
  if (column.type === 'boolean') {
    return (
      <select
        id={id}
        className={cn(base, className)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose, focused
        autoFocus={autoFocus}
      >
        <option value="">NULL</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  return (
    <input
      id={id}
      className={cn(
        base,
        (column.type === 'json' || column.type === 'uuid') && 'font-mono text-xs',
        className,
      )}
      type={column.type === 'date' ? 'date' : 'text'}
      inputMode={
        column.type === 'integer' || column.type === 'bigint' || column.type === 'decimal'
          ? 'decimal'
          : undefined
      }
      value={value}
      placeholder={placeholderFor(column)}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose, focused
      autoFocus={autoFocus}
    />
  )
}
