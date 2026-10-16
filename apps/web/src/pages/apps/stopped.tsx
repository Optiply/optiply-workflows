import { Button } from '@/components/ui'
import { useAppHostContext, useAppHostState } from './runtime/react'

/**
 * The app's code stopped responding (an endless loop), so its sandbox was stopped: the page still works, the app
 * shows what it last had. Restart starts it afresh; in the editor, an edit does too.
 */
export function AppStopped({ editing = false }: { editing?: boolean }) {
  const host = useAppHostContext()
  const stopped = useAppHostState((s) => s.status === 'stopped')
  if (!stopped) return null
  return (
    <div
      role="alert"
      className="mb-3 flex items-center gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
    >
      <span className="flex-1">
        The app's code stopped responding (an endless loop?), so it was stopped.{' '}
        {editing ? 'Editing the app restarts it.' : 'Restart it to carry on.'}
      </span>
      <Button size="sm" variant="secondary" onClick={() => host.restart()}>
        Restart
      </Button>
    </div>
  )
}
