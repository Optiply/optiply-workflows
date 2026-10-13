import { Badge } from './ui'

const TONE: Record<string, 'neutral' | 'accent' | 'success' | 'danger'> = {
  queued: 'neutral',
  running: 'accent',
  waiting: 'accent',
  succeeded: 'success',
  errored: 'danger',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
  interrupted: 'neutral',
}

/** A run or block status as a coloured badge. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={TONE[status] ?? 'neutral'} data-testid="run-status">
      {status}
    </Badge>
  )
}
