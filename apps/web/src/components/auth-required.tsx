import { Link } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui'
import { type AuthRequired, connectAccount } from '@/lib/oauth'

/**
 * A query needs a connected account. On per-user resources the person can connect their own right here (a
 * popup), and `onConnected` runs once they have; the shared account is connected in the resource's settings.
 */
export function AuthRequiredNote({
  need,
  message,
  onConnected,
  compact,
  appId,
}: {
  need: AuthRequired
  message: string
  onConnected?: () => void
  /** The app the query belongs to: its viewers may connect their own account without access to the resource. */
  appId?: string
  /** One line, for banners. */
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const reconnect = need.reason !== 'not_connected' && need.reason !== 'no_user'
  const connect = async () => {
    setBusy(true)
    setProblem(null)
    const outcome = await connectAccount({
      resourceId: need.resourceId,
      environmentId: need.environmentId,
      account: 'mine',
      ...(appId && { appId }),
    })
    setBusy(false)
    if (outcome.ok) onConnected?.()
    else setProblem(outcome.message)
  }
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-accent/30 bg-accent-soft px-3 py-2.5 text-sm text-ink"
    >
      <div className={compact ? 'flex flex-wrap items-center gap-x-3 gap-y-2' : 'space-y-2'}>
        <p className="flex items-start gap-2">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>{message}</span>
        </p>
        {need.account === 'user' && need.reason !== 'no_user' ? (
          <Button size="sm" variant="primary" loading={busy} onClick={connect}>
            {reconnect ? 'Reconnect your account' : 'Connect your account'}
          </Button>
        ) : (
          <Link
            to="/resources/$resourceId"
            params={{ resourceId: need.resourceId }}
            className="inline-flex text-sm font-medium text-accent hover:underline"
          >
            Open the resource’s settings
          </Link>
        )}
      </div>
      {problem && <p className="text-danger">{problem}</p>}
    </div>
  )
}
