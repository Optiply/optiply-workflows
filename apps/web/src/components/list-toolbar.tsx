import { ArrowUpDown, Search } from 'lucide-react'
import { useState } from 'react'
import { Input, Select } from '@/components/ui'

/**
 * A choice kept per browser (a list page's sort): localStorage, guarded, since it can be missing or throw (private
 * windows); the choice then lasts the visit.
 */
export function useStoredChoice<T extends string>(
  key: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return isValid(stored) ? stored : fallback
    } catch {
      return fallback
    }
  })
  const choose = (next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // Private windows: the choice lasts this visit.
    }
  }
  return [value, choose]
}

/** A list page's search box (every folder) and sort menu (session 40: Workflows, Apps). */
export function ListToolbar<T extends string>({
  noun,
  query,
  onQuery,
  sort,
  sorts,
  onSort,
}: {
  /** Plural, as in "Search workflows". */
  noun: string
  query: string
  onQuery: (query: string) => void
  sort: T
  sorts: readonly { key: T; label: string }[]
  onSort: (key: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-60 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <Input
          type="search"
          aria-label={`Search ${noun}`}
          placeholder="Search every folder by name, slug or description"
          className="pl-9"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2 text-sm text-muted">
        <ArrowUpDown className="size-4" />
        <span>Sort by</span>
        <Select
          aria-label={`Sort ${noun}`}
          className="w-36"
          value={sort}
          onChange={(e) => onSort(e.target.value as T)}
        >
          {sorts.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  )
}
