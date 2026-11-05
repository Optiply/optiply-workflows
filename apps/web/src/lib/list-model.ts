/** Searching, sorting and dating the items of a list page (Workflows, Apps; session 40). Pure, so it's unit-tested. */

export interface Listed {
  name: string
  slug: string
  description?: string | null
  updatedAt: Date | string
}

type When = Date | string | null | undefined

/** Every word of the query appears in the name, slug or description (any case, any order). */
export function matchesSearch(item: Listed, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = `${item.name} ${item.slug} ${item.description ?? ''}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

const time = (value: When) => (value ? new Date(value).getTime() : 0)

/**
 * Name A–Z; `edited` and `recent` newest first (by `updatedAt`, or by what `recentOf` gives: a last run, a release;
 * items without one last), then by name.
 */
export function sortListed<T extends Listed>(
  items: readonly T[],
  by: 'name' | 'edited' | 'recent',
  recentOf: (item: T) => When = () => null,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  const newest = (pick: (item: T) => number) => (a: T, b: T) => pick(b) - pick(a) || byName(a, b)
  const compare =
    by === 'edited'
      ? newest((i) => time(i.updatedAt))
      : by === 'recent'
        ? newest((i) => time(recentOf(i)))
        : byName
  return [...items].sort(compare)
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`, then the date. */
export function timeAgo(value: Date | string, now = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(value).getTime()) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
