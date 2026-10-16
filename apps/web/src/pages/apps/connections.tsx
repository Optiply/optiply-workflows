import { AuthRequiredNote } from '@/components/auth-required'
import { useAppHostContext, useAppHostState } from './runtime/react'

/**
 * Queries that failed for want of a connected account: each resource's note says which, and on per-user resources
 * lets the person connect their own; the automatic queries then run again.
 */
export function NeededConnections() {
  const host = useAppHostContext()
  const connections = useAppHostState((s) => s.connections)
  if (!connections.length) return null
  return (
    <div className="mb-3 space-y-2">
      {connections.map((c) => (
        <AuthRequiredNote
          key={`${c.need.resourceId}:${c.need.environmentId}`}
          compact
          need={c.need}
          message={`${c.queries.length === 1 ? 'Query' : 'Queries'} ${c.queries.join(', ')}: ${c.message}`}
          appId={host.appId}
          onConnected={() => host.accountConnected(c.need.resourceId)}
        />
      ))}
    </div>
  )
}
