import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { type AccessType, AccessTypePicker } from '@/components/access-type'
import { confirmDialog } from '@/components/confirm'
import { SubjectAccess } from '@/components/subject-access'
import { Avatar, Badge, ErrorNote, SectionLabel, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { timeAgo } from '@/lib/utils'
import { AdminOnly } from './layout'

const route = getRouteApi('/app/settings/users/$userId')
const appRoute = getRouteApi('/app')

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
            {user.access === 'apps_only' && <Badge tone="warning">Apps only</Badge>}
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
      <AccessTypeSection user={user} admin={admin} />
      <SubjectAccess
        subject={{ userId: user.id }}
        name={user.name}
        everything={admin}
        appsOnly={user.access === 'apps_only'}
      />
      {!admin && (
        <p className="text-xs text-muted">
          {user.access === 'apps_only'
            ? `Only grants on apps count for ${user.name}, as Use, from here and from their groups (not All Users).`
            : `Grants to ${user.name}'s groups apply as well; the highest level wins.`}
        </p>
      )}
    </div>
  )
}

/**
 * The whole platform or only the apps shared with them, switched at any time (it counts from their next click). Not
 * for admins (they always have everything) nor for yourself.
 */
function AccessTypeSection({
  user,
  admin,
}: {
  user: { id: string; name: string; access: AccessType }
  admin: boolean
}) {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const setAccess = useMutation(
    trpc.users.setAccess.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.users.list.queryKey() }),
    }),
  )
  const self = user.id === me.id
  const why = admin
    ? 'Admins always have the whole platform: take them out of Admins first.'
    : self
      ? "You can't change your own access."
      : null
  return (
    <section aria-label="Access type" className="space-y-2">
      <SectionLabel>Access type</SectionLabel>
      <AccessTypePicker
        legend={`What ${user.name} can reach`}
        value={setAccess.isPending && setAccess.variables ? setAccess.variables.access : user.access}
        disabled={!!why || setAccess.isPending}
        onChange={async (access) => {
          if (
            access === 'apps_only' &&
            !(await confirmDialog(
              `Give ${user.name} access to apps only? They lose the rest of the platform from their next click; the apps shared with them stay.`,
              { confirm: 'Apps only' },
            ))
          )
            return
          setAccess.mutate({ userId: user.id, access })
        }}
      />
      {why && <p className="text-xs text-muted">{why}</p>}
      <ErrorNote error={setAccess.error} />
    </section>
  )
}
