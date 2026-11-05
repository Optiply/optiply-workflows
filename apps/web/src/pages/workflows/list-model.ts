/** What the Workflows page needs to search, sort and describe workflows (session 40). Pure, so it's unit-tested. */

export interface ListedWorkflow {
  name: string
  slug: string
  description?: string | null
  updatedAt: Date | string
  lastRun: { createdAt: Date | string } | null
}

export type SortKey = 'name' | 'edited' | 'lastRun'

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'edited', label: 'Last edited' },
  { key: 'lastRun', label: 'Last run' },
]

export const isSortKey = (value: unknown): value is SortKey => SORTS.some((s) => s.key === value)

/** Every word of the query appears in the name, slug or description (any case, any order). */
export function matchesSearch(workflow: ListedWorkflow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = `${workflow.name} ${workflow.slug} ${workflow.description ?? ''}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

const time = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : 0)

/** Name A–Z; last edited and last run newest first (never run last), then by name. */
export function sortWorkflows<T extends ListedWorkflow>(items: readonly T[], key: SortKey): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  const newest = (pick: (w: T) => number) => (a: T, b: T) => pick(b) - pick(a) || byName(a, b)
  const compare =
    key === 'edited'
      ? newest((w) => time(w.updatedAt))
      : key === 'lastRun'
        ? newest((w) => time(w.lastRun?.createdAt))
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

const TRIGGER_NAMES: Record<string, [string, string]> = {
  schedule: ['schedule', 'schedules'],
  webhook: ['webhook', 'webhooks'],
  pubsub: ['Pub/Sub subscription', 'Pub/Sub subscriptions'],
  sqs: ['SQS queue', 'SQS queues'],
  kafka: ['Kafka topic', 'Kafka topics'],
  rabbitmq: ['RabbitMQ queue', 'RabbitMQ queues'],
  kinesis: ['Kinesis stream', 'Kinesis streams'],
}

/** `2 schedules`, `1 webhook`, `1 Kafka topic`. */
export function triggerLabel(kind: string, count: number): string {
  const [one, many] = TRIGGER_NAMES[kind] ?? [kind, kind]
  return `${count} ${count === 1 ? one : many}`
}
