import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, X } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { SubjectAccess } from '@/components/subject-access'
import { Avatar, Badge, Button, Card, ErrorNote, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AdminOnly } from './layout'

const route = getRouteApi('/app/settings/groups/$groupId')
const appRoute = getRouteApi('/app')

export function GroupDetailPage() {
  return (
    <AdminOnly>
      <GroupDetail />
    </AdminOnly>
  )
}

function GroupDetail() {
  const { groupId } = route.useParams()
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: group, isLoading, error } = useQuery(trpc.groups.get.queryOptions({ id: groupId }))
  const { data: users } = useQuery(trpc.users.list.queryOptions())
  const [selectedUser, setSelectedUser] = useState('')

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.groups.get.queryKey({ id: groupId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.groups.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.users.list.queryKey() }),
    ])
  const addMember = useMutation(
    trpc.groups.addMember.mutationOptions({
      onSuccess: () => {
        setSelectedUser('')
        return refresh()
      },
    }),
  )
  const removeMember = useMutation(trpc.groups.removeMember.mutationOptions({ onSuccess: refresh }))
  const remove = useMutation(
    trpc.groups.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.groups.list.queryKey() })
        await navigate({ to: '/settings/groups' })
      },
    }),
  )

  if (isLoading) return <Spinner />
  if (!group) return <ErrorNote error={error} />

  const memberIds = new Set(group.members.map((m) => m.id))
  // People who are in, or invited (their groups wait for them); not those waiting for approval or turned down.
  const candidates =
    users?.filter(
      (u) => !memberIds.has(u.id) && !u.disabledAt && (u.status === 'active' || u.status === 'invited'),
    ) ?? []
  const editable = group.systemKind !== 'all_users'
  const isAdmins = group.systemKind === 'admins'
  const removeFromGroup = async (m: { id: string; name: string }) => {
    if (
      isAdmins &&
      !(await confirmDialog(
        `Remove ${m.name} from Admins? They lose access to everything grants don't give them.`,
        {
          danger: true,
          confirm: 'Remove',
        },
      ))
    )
      return
    removeMember.mutate({ groupId: group.id, userId: m.id })
  }

  return (
    <div className="space-y-4">
      <Link
        to="/settings/groups"
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" /> All groups
      </Link>
      <div className="flex items-start justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {group.name} {group.systemKind && <Badge>built-in</Badge>}
          </h2>
          {group.description && <p className="text-sm text-muted">{group.description}</p>}
        </div>
        {!group.systemKind && (
          <Button
            variant="danger"
            size="sm"
            loading={remove.isPending}
            onClick={async () => {
              if (await confirmDialog(`Delete group "${group.name}"?`, { danger: true, confirm: 'Delete' }))
                remove.mutate({ id: group.id })
            }}
          >
            Delete group
          </Button>
        )}
      </div>

      <ErrorNote error={addMember.error ?? removeMember.error ?? remove.error} />

      {editable ? (
        <div className="flex max-w-md gap-2">
          <Select className="flex-1" value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
            <option value="">Add a member…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            disabled={!selectedUser}
            loading={addMember.isPending}
            onClick={() => addMember.mutate({ groupId: group.id, userId: selectedUser })}
          >
            Add
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted">Every user is automatically a member of this group.</p>
      )}

      <Card className="divide-y divide-border">
        {group.members.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted">No members yet.</p>
        )}
        {group.members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={m.name} src={m.avatarUrl} />
            <div className="flex-1">
              <div className="text-sm font-medium">
                {m.name} {m.id === me.id && <span className="text-xs font-normal text-muted">(you)</span>}
              </div>
              <div className="text-xs text-muted">{m.email}</div>
            </div>
            {editable && isAdmins && m.id === me.id && (
              <span className="text-xs text-muted">Another admin can remove you</span>
            )}
            {editable && !(isAdmins && m.id === me.id) && (
              <Button
                variant="ghost"
                size="icon"
                title="Remove from group"
                onClick={() => removeFromGroup(m)}
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        ))}
      </Card>

      <div className="pt-4">
        <SubjectAccess
          subject={{ groupId: group.id }}
          name={group.name}
          everything={group.systemKind === 'admins'}
        />
      </div>
    </div>
  )
}
