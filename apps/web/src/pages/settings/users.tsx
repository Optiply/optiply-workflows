import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Check, Mail, UserPlus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  ErrorNote,
  Field,
  Input,
  ListSkeleton,
  SectionLabel,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { timeAgo } from '@/lib/utils'
import { AdminOnly } from './layout'

const appRoute = getRouteApi('/app')

type User = RouterOutputs['users']['list'][number]

export function UsersPage() {
  return (
    <AdminOnly>
      <UsersTable />
    </AdminOnly>
  )
}

function useRefreshUsers() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.users.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.users.pendingCount.queryKey() }),
    ])
}

function UsersTable() {
  const trpc = useTRPC()
  const { me } = appRoute.useRouteContext()
  const refresh = useRefreshUsers()
  const { data: users, isLoading, error } = useQuery(trpc.users.list.queryOptions())
  const setDisabled = useMutation(trpc.users.setDisabled.mutationOptions({ onSuccess: refresh }))
  const cancelInvite = useMutation(trpc.users.cancelInvite.mutationOptions({ onSuccess: refresh }))
  const [approving, setApproving] = useState<User | null>(null)
  const [inviting, setInviting] = useState(false)

  if (isLoading) return <ListSkeleton header={false} rows={4} />
  const pending = users?.filter((u) => u.status === 'pending') ?? []
  const others = users?.filter((u) => u.status !== 'pending') ?? []

  return (
    <div className="space-y-5">
      <ErrorNote error={error ?? setDisabled.error ?? cancelInvite.error} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          New people ask to get in the first time they sign in with Google, and wait here for an admin. People
          outside Optiply come in only when invited. Open someone to see and change their access, or manage it
          through{' '}
          <Link to="/settings/groups" className="text-accent hover:underline">
            groups
          </Link>
          .
        </p>
        <Button variant="primary" onClick={() => setInviting(true)}>
          <UserPlus className="size-4" /> Invite people
        </Button>
      </div>

      {pending.length > 0 && (
        <section aria-label="Waiting for approval" className="space-y-2">
          <SectionLabel>Waiting for approval ({pending.length})</SectionLabel>
          <Card className="divide-y divide-border/70 border-accent/30">
            {pending.map((u) => (
              <PendingRow key={u.id} user={u} onApprove={() => setApproving(u)} />
            ))}
          </Card>
        </section>
      )}

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
          {others.map((u) => (
            <tr key={u.id} className={u.disabledAt || u.status === 'rejected' ? 'opacity-60' : undefined}>
              <Td>
                <div className="flex items-center gap-3">
                  <Avatar name={u.name} src={u.avatarUrl} />
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <Link
                        to="/settings/users/$userId"
                        params={{ userId: u.id }}
                        className="hover:text-accent hover:underline"
                      >
                        {u.name}
                      </Link>
                      {u.id === me.id && <span className="text-xs font-normal text-muted">(you)</span>}
                      {u.status === 'invited' && <Badge tone="accent">Invited</Badge>}
                      {u.status === 'rejected' && <Badge tone="danger">Not approved</Badge>}
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
              <Td className="text-muted">{u.status === 'invited' ? 'Not yet' : timeAgo(u.lastLoginAt)}</Td>
              <Td className="text-right">
                {u.status === 'invited' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    title={`Cancel the invitation of ${u.email}`}
                    loading={cancelInvite.isPending && cancelInvite.variables?.userId === u.id}
                    onClick={async () => {
                      if (
                        await confirmDialog(`Cancel the invitation of ${u.email}?`, {
                          confirm: 'Cancel invitation',
                        })
                      )
                        cancelInvite.mutate({ userId: u.id })
                    }}
                  >
                    Cancel invitation
                  </Button>
                ) : u.status === 'rejected' ? (
                  <Button size="sm" variant="secondary" onClick={() => setApproving(u)}>
                    Approve
                  </Button>
                ) : (
                  u.id !== me.id && (
                    <Button
                      size="sm"
                      variant={u.disabledAt ? 'secondary' : 'danger'}
                      loading={setDisabled.isPending && setDisabled.variables?.userId === u.id}
                      onClick={() => setDisabled.mutate({ userId: u.id, disabled: !u.disabledAt })}
                    >
                      {u.disabledAt ? 'Enable' : 'Disable'}
                    </Button>
                  )
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {approving && <ApproveDialog user={approving} onClose={() => setApproving(null)} />}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </div>
  )
}

/** One person waiting: who they are, since when, and Approve (into groups) or Reject. */
function PendingRow({ user, onApprove }: { user: User; onApprove: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefreshUsers()
  const reject = useMutation(trpc.users.reject.mutationOptions({ onSuccess: refresh }))
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`pending-${user.email}`}>
      <Avatar name={user.name} src={user.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{user.name}</div>
        <div className="text-xs text-muted">
          {user.email} · asked {timeAgo(user.requestedAt ?? user.createdAt)}
        </div>
      </div>
      <ErrorNote error={reject.error} />
      <Button
        size="sm"
        variant="ghost"
        loading={reject.isPending}
        onClick={async () => {
          if (
            await confirmDialog(
              `Turn down ${user.email}? They won't be able to sign in (you can approve them later).`,
              {
                danger: true,
                confirm: 'Reject',
              },
            )
          )
            reject.mutate({ userId: user.id })
        }}
      >
        <X className="size-4" /> Reject
      </Button>
      <Button size="sm" variant="primary" onClick={onApprove}>
        <Check className="size-4" /> Approve…
      </Button>
    </div>
  )
}

/** The groups a person goes into (All Users always): the access they start with. */
function GroupPicker({ chosen, onChange }: { chosen: string[]; onChange: (ids: string[]) => void }) {
  const trpc = useTRPC()
  const { data: groups } = useQuery(trpc.groups.list.queryOptions())
  const pickable = groups?.filter((g) => g.systemKind !== 'all_users') ?? []
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium">Groups</legend>
      <Checkbox label="All Users" checked disabled />
      {pickable.map((g) => (
        <div key={g.id}>
          <Checkbox
            label={g.systemKind === 'admins' ? `${g.name} (can do everything)` : g.name}
            checked={chosen.includes(g.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...chosen, g.id] : chosen.filter((id) => id !== g.id))
            }
          />
        </div>
      ))}
      {pickable.length === 0 && (
        <p className="text-xs text-muted">
          No groups yet: give them access afterwards on their page, or make a group in Groups.
        </p>
      )}
    </fieldset>
  )
}

function ApproveDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefreshUsers()
  const [groupIds, setGroupIds] = useState<string[]>([])
  const approve = useMutation(
    trpc.users.approve.mutationOptions({
      onSuccess: async () => {
        await refresh()
        onClose()
      },
    }),
  )
  return (
    <Dialog
      title={`Let ${user.name} in`}
      onClose={onClose}
      className="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={approve.isPending}
            onClick={() => approve.mutate({ userId: user.id, groupIds })}
          >
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {user.email} can sign in once approved. What they can see comes from their groups and anything
          shared with them.
        </p>
        <GroupPicker chosen={groupIds} onChange={setGroupIds} />
        <ErrorNote error={approve.error} />
      </div>
    </Dialog>
  )
}

/** Invites someone by email, from any domain: they sign in with Google as that address and are in at once. */
function InviteDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefreshUsers()
  const formId = useId()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [groupIds, setGroupIds] = useState<string[]>([])
  const invite = useMutation(
    trpc.users.invite.mutationOptions({
      onSuccess: async () => {
        await refresh()
        onClose()
      },
    }),
  )
  return (
    <Dialog
      title="Invite people"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={invite.isPending}
            disabled={!email.trim()}
          >
            <Mail className="size-4" /> Invite
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (email.trim()) invite.mutate({ email, name: name || undefined, groupIds })
        }}
      >
        <p className="text-sm text-muted">
          Anyone, inside Optiply or not. They sign in with the Google account of this address; no approval
          needed. (No email is sent yet: let them know yourself.)
        </p>
        <Field label="Email">
          <Input
            autoFocus
            type="email"
            value={email}
            placeholder="someone@partner.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Name" hint="Optional: their Google name replaces it when they sign in.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <GroupPicker chosen={groupIds} onChange={setGroupIds} />
        <ErrorNote error={invite.error} />
      </form>
    </Dialog>
  )
}
