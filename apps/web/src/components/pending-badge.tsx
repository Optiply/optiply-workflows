import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

/** For admins: how many people wait for approval (Settings in the sidebar, the Users tab); nothing at zero. */
export function PendingUsersBadge({ className }: { className?: string }) {
  const trpc = useTRPC()
  const { data } = useQuery({ ...trpc.users.pendingCount.queryOptions(), refetchInterval: 60_000 })
  if (!data) return null
  return (
    <span
      className={cn(
        'flex h-4 min-w-4 items-center justify-center rounded bg-accent px-1 text-[10px] font-semibold text-on-accent',
        className,
      )}
      title={`${data} waiting for approval`}
      data-testid="pending-users-badge"
    >
      {data}
    </span>
  )
}
