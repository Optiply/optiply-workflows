import { getRouteApi } from '@tanstack/react-router'
import { AuthRequiredNote } from '@/components/auth-required'
import { authRequired } from '@/lib/oauth'
import { cn } from '@/lib/utils'

const appRoute = getRouteApi('/app')

/**
 * A block's (or the run's) error in the editor. A query that needs a connected account (`auth_required`) offers the
 * Connect button, or the link to the resource's settings for a shared account, as the playground does; run the block
 * again once connected.
 */
export function BlockErrorNote({
  error,
  className,
  compact,
}: {
  error: { code?: string; message: string; block?: string; details?: unknown }
  className?: string
  compact?: boolean
}) {
  const { me } = appRoute.useRouteContext()
  const need = authRequired(error)
  const prefix = error.block ? `${error.block}: ` : ''
  if (need) {
    return (
      <AuthRequiredNote need={need} message={`${prefix}${error.message}`} compact={compact} meId={me.id} />
    )
  }
  return (
    <p className={cn('rounded-md bg-danger/10 px-3 py-2 text-danger', className)}>
      {error.block && <span className="font-mono">{error.block}: </span>}
      {error.code && !error.block && <span className="font-mono text-xs">{error.code}</span>} {error.message}
    </p>
  )
}
