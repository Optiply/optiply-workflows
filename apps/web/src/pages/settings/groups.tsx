import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Lock } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Badge, Button, Card, ErrorNote, Input, ListSkeleton } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AdminOnly } from './layout'

export function GroupsPage() {
  return (
    <AdminOnly>
      <GroupsList />
    </AdminOnly>
  )
}

function GroupsList() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: groups, isLoading, error } = useQuery(trpc.groups.list.queryOptions())
  const [name, setName] = useState('')
  const create = useMutation(
    trpc.groups.create.mutationOptions({
      onSuccess: () => {
        setName('')
        return queryClient.invalidateQueries({ queryKey: trpc.groups.list.queryKey() })
      },
    }),
  )

  const onCreate = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) create.mutate({ name: name.trim() })
  }

  if (isLoading) return <ListSkeleton header={false} rows={4} />
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      <form onSubmit={onCreate} className="flex max-w-md gap-2">
        <Input
          placeholder="New group name, e.g. Operations"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create
        </Button>
      </form>
      <ErrorNote error={create.error} />

      <Card className="divide-y divide-border">
        {groups?.map((g) => (
          <Link
            key={g.id}
            to="/settings/groups/$groupId"
            params={{ groupId: g.id }}
            className="flex items-center gap-3 px-4 py-3 hover:bg-canvas"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2 font-medium">
                {g.name}
                {g.systemKind && (
                  <Badge>
                    <Lock className="mr-1 size-3" /> built-in
                  </Badge>
                )}
              </div>
              {g.description && <div className="text-sm text-muted">{g.description}</div>}
            </div>
            <span className="text-sm text-muted">
              {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
            </span>
            <ChevronRight className="size-4 text-muted" />
          </Link>
        ))}
      </Card>
    </div>
  )
}
