import { AlertCircle, CheckCircle2, CloudOff, Loader2 } from 'lucide-react'
import type { SaveStatus } from '@/lib/collab-session'
import { cn } from '@/lib/utils'

const TEXT: Record<SaveStatus, string> = {
  connecting: 'Connecting…',
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Offline: changes will sync',
  error: 'Not saved',
  closed: 'Disconnected: reload',
}

/** An editor's save state (workflows, apps, modules): an icon and a word, quiet while all is saved. */
export function SaveStatusIndicator({
  status,
  error,
  className,
}: {
  status: SaveStatus
  /** Why saving failed: the title. */
  error?: string | null
  className?: string
}) {
  return (
    <span
      data-testid="save-status"
      title={error ?? undefined}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs',
        status === 'error' || status === 'closed'
          ? 'text-danger'
          : status === 'offline'
            ? 'text-warning-strong'
            : 'text-muted',
        className,
      )}
    >
      {(status === 'saving' || status === 'connecting') && <Loader2 className="size-3 animate-spin" />}
      {status === 'saved' && <CheckCircle2 className="size-3 text-success" />}
      {status === 'offline' && <CloudOff className="size-3" />}
      {(status === 'error' || status === 'closed') && <AlertCircle className="size-3" />}
      {TEXT[status]}
    </span>
  )
}
