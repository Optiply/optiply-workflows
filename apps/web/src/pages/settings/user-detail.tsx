import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { SubjectAccess } from '@/components/subject-access'
import { Avatar, Badge, ErrorNote, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { timeAgo } from '@/lib/utils'
import { AdminOnly } from './layout'

const route = getRouteApi('/app/settings/users/$userId')

export function UserDetailPage() {
  return (
    <AdminOnly>
      <UserDetail />
    </AdminOnly>
  )
}

/** One person: their groups and sign-in, and what they're granted themselves (their groups' grants apply too). */
function UserDetail() {
  const { userId } = route.useParams()
  const trpc = useTRPC()
  const { data: users, isLoading, error } = useQuery(trpc.users.list.queryOptions())
  if (isLoading) return <Spinner />
  const user = users?.find((u) => u.id === userId)
  if (!user)
    return error ? <ErrorNote error={error} /> : <p className="text-sm text-muted">No such person.</p>
  const admin = user.groups.some((g) => g.name === 'Admins')

  return (
    <div className="space-y-5">
      <Link to="/settings/users" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> All users
      </Link>
      <div className="flex items-center gap-3">
        <Avatar name={user.name} src={user.avatarUrl} className="size-10" />
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {user.name} {user.disabledAt && <Badge tone="danger">Disabled</Badge>}
            {user.status === 'pending' && <Badge tone="warning">Waiting for approval</Badge>}
            {user.status === 'invited' && <Badge tone="accent">Invited</Badge>}
            {user.status === 'rejected' && <Badge tone="danger">Not approved</Badge>}
          </h2>
          <p className="text-sm text-muted">
            {user.email} · {user.loginMethods.join(', ') || 'no sign-in yet'} · last login{' '}
            {timeAgo(user.lastLoginAt)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="mr-1 text-muted">Groups:</span>
        {user.groups.map((g) => (
          <Link key={g.id} to="/settings/groups/$groupId" params={{ groupId: g.id }}>
            <Badge tone={g.name === 'Admins' ? 'accent' : 'neutral'}>{g.name}</Badge>
          </Link>
        ))}
      </div>
      <SubjectAccess subject={{ userId: user.id }} name={user.name} everything={admin} />
      {!admin && (
        <p className="text-xs text-muted">
          Grants to {user.name}'s groups apply as well; the highest level wins.
        </p>
      )}
    </div>
  )
}
