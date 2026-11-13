import type { BlockView, RunLog } from '@/lib/runs-api'

/** One line in a run's log view: a logged message, or a block starting, finishing, failing or being skipped. */
export interface LogLine {
  id: string
  at: string
  block: string | null
  kind: 'success' | 'error' | 'warn' | 'info'
  message: string
}

/**
 * A run's logs with each block's start and end as Retool shows them (`--- Running query: x ---`), in time order.
 * `block` narrows it to one block's lines.
 */
export function logLines(logs: RunLog[], blocks: BlockView[], block?: string): LogLine[] {
  const lines: LogLine[] = logs.map((log) => ({
    id: `log-${log.id}`,
    at: log.at,
    block: log.blockKey,
    kind: log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : 'info',
    message: log.message,
  }))
  for (const b of blocks) {
    // Loop iterations are `loop1[3]`: their lines are the loop's own.
    if (b.startedAt && b.status !== 'skipped') {
      lines.push({
        id: `start-${b.key}`,
        at: b.startedAt,
        block: b.key,
        kind: 'info',
        message: `--- Running query: ${b.key} ---`,
      })
    }
    const end = b.finishedAt ?? (b.status === 'skipped' ? b.startedAt : null)
    if (b.status === 'skipped') {
      lines.push({
        id: `end-${b.key}`,
        at: end ?? '',
        block: b.key,
        kind: 'info',
        message: `--- Skipped query: ${b.key} ---`,
      })
    } else if (end && b.status === 'succeeded') {
      lines.push({
        id: `end-${b.key}`,
        at: end,
        block: b.key,
        kind: 'success',
        message: `--- Successfully finished running query: ${b.key} ---`,
      })
    } else if (end && (b.status === 'failed' || b.status === 'errored')) {
      lines.push({
        id: `end-${b.key}`,
        at: end,
        block: b.key,
        kind: 'error',
        message: `--- Query ${b.key} failed${b.error ? `: ${b.error.message}` : ''} ---`,
      })
    }
  }
  // Skipped blocks may have no time: they go last.
  const time = (l: LogLine) => (l.at ? Date.parse(l.at) : Number.POSITIVE_INFINITY)
  return lines
    .filter((l) => block === undefined || l.block === block)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => time(a.l) - time(b.l) || a.i - b.i)
    .map(({ l }) => l)
}

export type LevelFilter = 'all' | LogLine['kind']

/** Lines matching a text (any case) and a level. */
export function filterLines(lines: LogLine[], text: string, level: LevelFilter): LogLine[] {
  const needle = text.trim().toLowerCase()
  return lines.filter(
    (l) =>
      (level === 'all' || l.kind === level) &&
      (!needle || l.message.toLowerCase().includes(needle) || l.block?.toLowerCase().includes(needle)),
  )
}

/** How many lines of each kind there are, for the counts over the log. */
export function countKinds(lines: LogLine[]): Record<LogLine['kind'], number> {
  const counts = { success: 0, error: 0, warn: 0, info: 0 }
  for (const l of lines) counts[l.kind]++
  return counts
}
