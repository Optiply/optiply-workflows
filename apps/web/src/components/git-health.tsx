import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

const appRoute = getRouteApi('/app')

/** Where a dismissed banner's problems are remembered, so it comes back only for new ones. */
const DISMISSED_KEY = 'ow.gitBannerDismissed'

/**
 * How Git sync is doing (M22), for admins: the last deploy's problems and whether the deploy branch could be read.
 * `trouble` is a key for what's wrong now, '' when nothing is.
 */
export function useGitHealth() {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const health = useQuery({
    ...trpc.git.health.queryOptions(),
    enabled: me.isAdmin,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const h = health.data?.configured ? health.data : null
  const count = h?.problems.length ?? 0
  const trouble = h && (count > 0 || h.lastError) ? `${h.key}|${h.lastError ?? ''}` : ''
  return { health: h, count, trouble }
}

function dismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

/** Shown to admins at the top of every page while objects in Git can't deploy, until dismissed for these problems. */
export function GitHealthBanner() {
  const { health, count, trouble } = useGitHealth()
  const [hidden, setHidden] = useState(dismissed)
  if (!health || !trouble || hidden === trouble) return null
  const first = health.problems[0]
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, trouble)
    } catch {
      // Storage blocked: hidden until the page reloads.
    }
    setHidden(trouble)
  }
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 rounded-lg bg-warning-soft px-4 py-2 text-sm text-warning-strong"
      data-testid="git-health-banner"
    >
      <TriangleAlert className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 truncate">
        {health.lastError ? (
          <>Git sync can’t read the deploy branch: {health.lastError}</>
        ) : (
          <>
            Git sync: {count} {count === 1 ? 'problem keeps' : 'problems keep'} objects from deploying
            {first && (
              <>
                {' '}
                ({!first.message.includes(first.path) && <span className="font-mono">{first.path}: </span>}
                {first.message})
              </>
            )}
          </>
        )}
      </p>
      <Link to="/settings/git" className="shrink-0 font-medium underline">
        See deploys
      </Link>
      <Button size="icon" variant="ghost" title="Dismiss until the problems change" onClick={dismiss}>
        <X className="size-4" />
      </Button>
    </div>
  )
}

/** A small count beside Settings → Git while there are problems. */
export function GitProblemsBadge({ className }: { className?: string }) {
  const { count, trouble } = useGitHealth()
  if (!trouble) return null
  return (
    <span
      className={cn(
        'flex h-4 min-w-4 items-center justify-center rounded bg-danger px-1 text-[10px] font-semibold text-on-accent',
        className,
      )}
      title="Git sync has problems"
      data-testid="git-problems-badge"
    >
      {count || '!'}
    </span>
  )
}
