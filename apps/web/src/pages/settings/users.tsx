import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Avatar, Badge, Button, ErrorNote, ListSkeleton, Table, Td, Th } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { timeAgo } from '@/lib/utils'
import { AdminOnly } from './layout'

const appRoute = getRouteApi('/app')

export function UsersPage() {
  return (
    <AdminOnly>
      <UsersTable />
    </AdminOnly>
  )
}

function UsersTable() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { me } = appRoute.useRouteContext()
  const { data: users, isLoading, error } = useQuery(trpc.users.list.queryOptions())
  const setDisabled = useMutation(
    trpc.users.setDisabled.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.users.list.queryKey() }),
    }),
  )

  if (isLoading) return <ListSkeleton header={false} rows={4} />
  return (
    <div className="space-y-3">
      <ErrorNote error={error ?? setDisabled.error} />
      <p className="text-sm text-muted">
        People get an account the first time they sign in with Google. Manage access through{' '}
        <Link to="/settings/groups" className="text-accent hover:underline">
          groups
        </Link>
        .
      </p>
      <Table>
        <thead>
          <tr>
            <Th>User</Th>
            <Th>Groups</Th>
            <Th>Sign-in</Th>
            <Th>Last login</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id} className={u.disabledAt ? 'opacity-50' : undefined}>
              <Td>
                <div className="flex items-center gap-3">
                  <Avatar name={u.name} src={u.avatarUrl} />
                  <div>
                    <div className="font-medium">
                      {u.name}{' '}
                      {u.id === me.id && <span className="text-xs font-normal text-muted">(you)</span>}
                    </div>
                    <div className="text-xs text-muted">{u.email}</div>
                  </div>
                </div>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {u.groups.map((g) => (
                    <Badge key={g.id} tone={g.name === 'Admins' ? 'accent' : 'neutral'}>
                      {g.name}
                    </Badge>
                  ))}
                </div>
              </Td>
              <Td className="text-muted">{u.loginMethods.join(', ') || '—'}</Td>
              <Td className="text-muted">{timeAgo(u.lastLoginAt)}</Td>
              <Td className="text-right">
                {u.id !== me.id && (
                  <Button
                    size="sm"
                    variant={u.disabledAt ? 'secondary' : 'danger'}
                    loading={setDisabled.isPending && setDisabled.variables?.userId === u.id}
                    onClick={() => setDisabled.mutate({ userId: u.id, disabled: !u.disabledAt })}
                  >
                    {u.disabledAt ? 'Enable' : 'Disable'}
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}
