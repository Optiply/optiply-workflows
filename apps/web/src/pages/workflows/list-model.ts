/** The Workflows page's sorts and trigger names (session 40); search and dates are the list pages' (`@/lib/list-model`). */
import { type Listed, sortListed } from '@/lib/list-model'

export { matchesSearch, timeAgo } from '@/lib/list-model'

export interface ListedWorkflow extends Listed {
  lastRun: { createdAt: Date | string } | null
}

export type SortKey = 'name' | 'edited' | 'lastRun'

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'edited', label: 'Last edited' },
  { key: 'lastRun', label: 'Last run' },
]

export const isSortKey = (value: unknown): value is SortKey => SORTS.some((s) => s.key === value)

/** Name A–Z; last edited and last run newest first (never run last), then by name. */
export function sortWorkflows<T extends ListedWorkflow>(items: readonly T[], key: SortKey): T[] {
  return sortListed(items, key === 'lastRun' ? 'recent' : key, (w) => w.lastRun?.createdAt)
}

const TRIGGER_NAMES: Record<string, [string, string]> = {
  schedule: ['schedule', 'schedules'],
  webhook: ['webhook', 'webhooks'],
}

/** `2 schedules`, `1 webhook`. */
export function triggerLabel(kind: string, count: number): string {
  const [one, many] = TRIGGER_NAMES[kind] ?? [kind, kind]
  return `${count} ${count === 1 ? one : many}`
}
