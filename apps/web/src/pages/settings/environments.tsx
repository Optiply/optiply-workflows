import { useQuery } from '@tanstack/react-query'
import { Badge, Card, ErrorNote, ListSkeleton } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'

export function EnvironmentsPage() {
  const trpc = useTRPC()
  const { data: environments, isLoading, error } = useQuery(trpc.environments.list.queryOptions())

  if (isLoading) return <ListSkeleton header={false} rows={4} />
  return (
    <div className="space-y-3">
      <ErrorNote error={error} />
      <p className="text-sm text-muted">
        Each resource gets separate credentials per environment. Workflows pick the environment per run.
      </p>
      <Card className="divide-y divide-border">
        {environments?.map((env) => (
          <div key={env.id} className="flex items-center gap-3 px-4 py-3">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: env.color }} />
            <span className="font-medium">{env.name}</span>
            <code className="text-xs text-muted">{env.slug}</code>
            {env.isDefault && <Badge tone="accent">default</Badge>}
          </div>
        ))}
      </Card>
    </div>
  )
}
