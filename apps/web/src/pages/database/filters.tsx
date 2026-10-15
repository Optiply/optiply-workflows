import { Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Input, Select } from '@/components/ui'
import type { Column } from './cells'

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'is_empty'
  | 'is_not_empty'

export interface Filter {
  column: string
  op: FilterOp
  value: string
}

export interface Selection {
  filters: Filter[]
  match: 'all' | 'any'
  sort: { column: string; desc: boolean }[]
}

const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is greater than',
  gte: 'is at least',
  contains: 'contains',
  not_contains: "doesn't contain",
  starts_with: 'starts with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
}

/** The comparisons that make sense for a column's type. */
export function opsFor(column: Column | undefined): FilterOp[] {
  const empty: FilterOp[] = ['is_empty', 'is_not_empty']
  switch (column?.type) {
    case 'boolean':
      return ['eq', 'neq', ...empty]
    case 'integer':
    case 'bigint':
    case 'decimal':
    case 'date':
    case 'datetime':
      return ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', ...empty]
    case 'uuid':
      return ['eq', 'neq', ...empty]
    default:
      return ['contains', 'not_contains', 'eq', 'neq', 'starts_with', ...empty]
  }
}

export const needsValue = (op: FilterOp) => op !== 'is_empty' && op !== 'is_not_empty'

/** Filters only count once they're complete: a value where one is needed. */
export function activeFilters(filters: Filter[]): Filter[] {
  return filters.filter((f) => !needsValue(f.op) || f.value !== '')
}

/**
 * The filter bar: one line per filter (column, comparison, value) and whether all or any must match. Typing is
 * applied after a pause, so each keystroke doesn't fetch.
 */
export function FilterBar({
  columns,
  filters,
  match,
  onChange,
}: {
  columns: Column[]
  filters: Filter[]
  match: 'all' | 'any'
  onChange: (filters: Filter[], match: 'all' | 'any') => void
}) {
  const [draft, setDraft] = useState(filters)
  useEffect(() => setDraft(filters), [filters])
  useEffect(() => {
    if (draft === filters) return
    const timer = setTimeout(() => onChange(draft, match), 350)
    return () => clearTimeout(timer)
  }, [draft, filters, match, onChange])

  const update = (i: number, patch: Partial<Filter>) =>
    setDraft(draft.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const add = () => {
    const column = columns.find((c) => !c.primaryKey) ?? columns[0]
    if (!column) return
    setDraft([...draft, { column: column.name, op: opsFor(column)[0]!, value: '' }])
  }

  return (
    <div
      className="flex flex-col gap-2 border-b border-border bg-canvas px-4 py-2.5"
      data-testid="filter-bar"
    >
      {draft.map((f, i) => {
        const column = columns.find((c) => c.name === f.column)
        const ops = opsFor(column)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: filters have no identity beyond their position
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="w-12 text-right text-xs text-muted">
              {i === 0 ? (
                'Where'
              ) : (
                <button
                  type="button"
                  className="cursor-pointer underline decoration-dotted"
                  title="Switch between all and any"
                  onClick={() => onChange(draft, match === 'all' ? 'any' : 'all')}
                >
                  {match === 'all' ? 'and' : 'or'}
                </button>
              )}
            </span>
            <Select
              aria-label="Filter column"
              className="h-8 w-44"
              value={f.column}
              onChange={(e) => {
                const next = columns.find((c) => c.name === e.target.value)
                const nextOps = opsFor(next)
                update(i, { column: e.target.value, op: nextOps.includes(f.op) ? f.op : nextOps[0]! })
              }}
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter comparison"
              className="h-8 w-40"
              value={f.op}
              onChange={(e) => update(i, { op: e.target.value as FilterOp })}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </Select>
            {needsValue(f.op) &&
              (column?.type === 'boolean' ? (
                <Select
                  aria-label="Filter value"
                  className="h-8 w-56"
                  value={f.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                >
                  <option value="">Choose…</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              ) : (
                <Input
                  aria-label="Filter value"
                  className="h-8 w-56"
                  type={column?.type === 'date' ? 'date' : 'text'}
                  value={f.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              ))}
            <Button
              size="icon"
              variant="ghost"
              title="Remove filter"
              onClick={() =>
                onChange(
                  draft.filter((_, j) => j !== i),
                  match,
                )
              }
            >
              <X className="size-4" />
            </Button>
          </div>
        )
      })}
      <div className="pl-14">
        <Button size="sm" variant="ghost" onClick={add}>
          <Plus className="size-4" /> Add filter
        </Button>
      </div>
    </div>
  )
}
