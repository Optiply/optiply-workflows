import { Badge, type BadgeTone } from './ui'

const TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  running: 'accent',
  waiting: 'warning',
  succeeded: 'success',
  errored: 'danger',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
  interrupted: 'neutral',
  open: 'accent',
  completed: 'success',
  expired: 'danger',
}

/** A run or block status as a coloured badge. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={TONE[status] ?? 'neutral'} data-testid="run-status">
      {status}
    </Badge>
  )
}
