import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Folder, Trash2 } from 'lucide-react'
import { Badge, Button, Card, ErrorNote, SectionLabel, Select, Spinner } from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

type Grant = RouterOutputs['permissions']['forSubject'][number]
type Level = 'use' | 'edit' | 'own'
type Kind = 'workflow' | 'app' | 'library_query' | 'module' | 'component_library' | 'resource'

/** Each kind of thing, and what each level of a grant on all of them means. */
const KINDS: { kind: Kind; label: string; one: string }[] = [
  { kind: 'workflow', label: 'Workflows', one: 'workflow' },
  { kind: 'app', label: 'Apps', one: 'app' },
  { kind: 'library_query', label: 'Library queries', one: 'library query' },
  { kind: 'module', label: 'Modules', one: 'module' },
  { kind: 'component_library', label: 'Component libraries', one: 'component library' },
  { kind: 'resource', label: 'Resources', one: 'resource' },
]
const ALL_LEVELS: { value: Level; label: string }[] = [
  { value: 'use', label: 'Use all' },
  { value: 'edit', label: 'Edit all, and create' },
  { value: 'own', label: 'Own all' },
]
const LEVEL_LABEL: Record<Level, string> = { use: 'Can use', edit: 'Can edit', own: 'Owner' }
const FOLDER_KIND: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.kind, k.label]))

/** Where a granted object opens. */
function TargetLink({ grant }: { grant: Grant }) {
  const name = ('name' in grant && grant.name) || 'Deleted'
  const slug = 'slug' in grant ? grant.slug : null
  const id = grant.objectId!
  const cls = 'font-medium text-accent hover:underline'
  switch (grant.objectType) {
    case 'workflow':
      return (
        <Link to="/workflows/$workflowId" params={{ workflowId: id }} className={cls}>
          {name}
        </Link>
      )
    case 'app':
      return slug ? (
        <Link to="/apps/$slug/{-$page}" params={{ slug }} className={cls}>
          {name}
        </Link>
      ) : (
        <span>{name}</span>
      )
    case 'resource':
      return (
        <Link to="/resources/$resourceId" params={{ resourceId: id }} className={cls}>
          {name}
        </Link>
      )
    case 'library_query':
      return slug ? (
        <Link to="/library/$slug" params={{ slug }} className={cls}>
          {name}
        </Link>
      ) : (
        <span>{name}</span>
      )
    case 'module':
      return slug ? (
        <Link to="/modules/$slug" params={{ slug }} className={cls}>
          {name}
        </Link>
      ) : (
        <span>{name}</span>
      )
    case 'component_library':
      return slug ? (
        <Link to="/component-libraries/$slug" params={{ slug }} className={cls}>
          {name}
        </Link>
      ) : (
        <span>{name}</span>
      )
    default:
      return (
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Folder className="size-3.5 text-muted" /> {name}
        </span>
      )
  }
}

/**
 * What one group or one person is granted (not counting a person's groups): a level on all of each kind (which with
 * Edit also lets them create), and the single workflows, apps, folders… shared with them. Admins only.
 */
export function SubjectAccess({
  subject,
  name,
  everything = false,
}: {
  subject: { groupId: string } | { userId: string }
  name: string
  /** Admins: they can do everything, so grants don't matter. */
  everything?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: grants, isLoading, error } = useQuery(trpc.permissions.forSubject.queryOptions(subject))
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const set = useMutation(
    trpc.permissions.set.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.permissions.forSubject.queryKey(subject) }),
    }),
  )

  if (everything) {
    return (
      <section aria-label="Access" className="space-y-2">
        <SectionLabel>Access</SectionLabel>
        <p className="text-sm text-muted">
          Admins can see, change and manage everything; grants don't apply to them.
        </p>
      </section>
    )
  }
  if (isLoading) return <Spinner />
  if (!grants) return <ErrorNote error={error} />

  const typeWide = (kind: Kind) =>
    grants.find((g) => g.objectType === kind && g.objectId === null && g.environmentId === null)?.level ?? ''
  const typeWideByEnv = (kind: Kind) =>
    grants.filter((g) => g.objectType === kind && g.objectId === null && g.environmentId !== null)
  const specific = grants.filter((g) => g.objectId !== null)
  const envName = (id: string | null) =>
    id === null ? null : (environments?.find((e) => e.id === id)?.name ?? 'an environment')

  return (
    <section aria-label="Access" className="space-y-4">
      <div>
        <SectionLabel>Access</SectionLabel>
        <p className="mt-1 text-sm text-muted">
          What {name} can do with every workflow, app… (Edit also lets them create new ones), and the single
          ones shared with them.
        </p>
      </div>
      <ErrorNote error={set.error} />
      <Card className="divide-y divide-border/70">
        {KINDS.map(({ kind, label, one }) => (
          <div key={kind} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-40 flex-1 font-medium">{label}</span>
            {typeWideByEnv(kind).map((g) => (
              <Badge key={g.id} title="Set on a resource's settings, for one environment">
                {LEVEL_LABEL[g.level as Level]} in {envName(g.environmentId)}
              </Badge>
            ))}
            <Select
              aria-label={`${label} for ${name}`}
              className="w-52"
              value={typeWide(kind)}
              onChange={(e) =>
                set.mutate({
                  ...subject,
                  objectType: kind,
                  objectId: null,
                  environmentId: null,
                  level: (e.target.value || null) as Level | null,
                })
              }
            >
              <option value="">Only what's shared</option>
              {ALL_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
            <span className="sr-only">Every {one}</span>
          </div>
        ))}
      </Card>

      <div className="space-y-2">
        <div className="text-sm font-medium">Shared with {name}</div>
        <Card className="divide-y divide-border/70">
          {specific.length === 0 && (
            <p className="px-4 py-5 text-center text-sm text-muted">
              Nothing yet. Share a single workflow, app or folder from its Access button.
            </p>
          )}
          {specific.map((g) => (
            <div
              key={g.id}
              className="flex items-center gap-3 px-4 py-2.5 text-sm"
              data-testid="subject-grant"
            >
              <span className="w-36 shrink-0 text-xs text-muted">
                {g.objectType === 'folder'
                  ? `Folder · ${FOLDER_KIND[('folderType' in g && g.folderType) || ''] ?? ''}`
                  : KINDS.find((k) => k.kind === g.objectType)
                      ?.label.replace(/ies$/, 'y')
                      .replace(/s$/, '')}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <TargetLink grant={g} />
                {g.environmentId && (
                  <span className="ml-2 text-xs text-muted">in {envName(g.environmentId)}</span>
                )}
              </span>
              <Select
                aria-label={`Level on ${('name' in g && g.name) || 'it'}`}
                value={g.level}
                onChange={(e) =>
                  set.mutate({
                    ...subject,
                    objectType: g.objectType,
                    objectId: g.objectId,
                    environmentId: g.environmentId,
                    level: e.target.value as Level,
                  })
                }
              >
                {(['use', 'edit', 'own'] as const).map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </option>
                ))}
              </Select>
              <Button
                size="icon"
                variant="ghost"
                title="Remove"
                onClick={() =>
                  set.mutate({
                    ...subject,
                    objectType: g.objectType,
                    objectId: g.objectId,
                    environmentId: g.environmentId,
                    level: null,
                  })
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </Card>
      </div>
    </section>
  )
}
