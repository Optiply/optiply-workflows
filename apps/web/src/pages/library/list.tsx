import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderPlus, Library, Plus } from 'lucide-react'
import { useState } from 'react'
import { FolderSections, FolderSelect, NewFolderForm, useFolders } from '@/components/folders'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Spinner,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

type LibraryQuerySummary = RouterOutputs['libraryQueries']['list'][number]

const LEVELS = { use: 'Can use', edit: 'Can edit', own: 'Owner' } as const

/** A slug from a name: lowercase words joined by underscores (library slugs read like identifiers). */
export function librarySlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 63)
}

/** The Query Library: queries written once, with parameters, used by many apps. */
export function LibraryPage() {
  const trpc = useTRPC()
  const { data, isLoading, error } = useQuery(trpc.libraryQueries.list.queryOptions())
  const { data: folders } = useFolders('library_query')
  const [panel, setPanel] = useState<'none' | 'query' | 'folder'>('none')

  if (isLoading) return <Spinner />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Query Library"
        description="Queries written once and used by many apps. Apps pass the parameters and pin a version or follow the latest."
        actions={
          <>
            {folders?.canManage && (
              <Button onClick={() => setPanel(panel === 'folder' ? 'none' : 'folder')}>
                <FolderPlus className="size-4" /> New folder
              </Button>
            )}
            <Button variant="primary" onClick={() => setPanel(panel === 'query' ? 'none' : 'query')}>
              <Plus className="size-4" /> New query
            </Button>
          </>
        }
      />
      {panel === 'query' && <NewLibraryQueryForm onCancel={() => setPanel('none')} />}
      {panel === 'folder' && <NewFolderForm type="library_query" onDone={() => setPanel('none')} />}
      {data.length === 0 && !(folders?.canManage && folders.folders.length) ? (
        <EmptyState icon={<Library className="size-6" />} title="No library queries yet">
          Create one to share a query between apps. If you expected to see some here, ask an admin for access.
        </EmptyState>
      ) : (
        <FolderSections type="library_query" items={data} listKey={trpc.libraryQueries.list.queryKey()}>
          {(q) => <LibraryRow key={q.id} query={q} hasFolders={!!folders?.folders.length} />}
        </FolderSections>
      )}
    </>
  )
}

/** A library query; editors open it, owners move it between folders. */
function LibraryRow({ query, hasFolders }: { query: LibraryQuerySummary; hasFolders: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const move = useMutation(
    trpc.libraryQueries.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.libraryQueries.list.queryKey() }),
    }),
  )
  const canEdit = query.level === 'edit' || query.level === 'own'
  const body = (
    <>
      <span className="rounded-md bg-accent-soft p-1.5 text-accent">
        <Library className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{query.name}</div>
        <div className="truncate font-mono text-xs text-muted">{query.slug}</div>
      </div>
    </>
  )
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-canvas" data-testid={`library-${query.slug}`}>
      {canEdit ? (
        <Link
          to="/library/$slug"
          params={{ slug: query.slug }}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
      )}
      {query.liveVersion ? (
        <Badge tone="success">Live v{query.liveVersion}</Badge>
      ) : (
        <Badge>Not published</Badge>
      )}
      <Badge tone="accent">{LEVELS[query.level]}</Badge>
      {hasFolders && query.level === 'own' && (
        <FolderSelect
          type="library_query"
          label={`Folder of ${query.name}`}
          className="w-40"
          value={query.folderId}
          onChange={(folderId) => move.mutate({ id: query.id, folderId })}
        />
      )}
      <ErrorNote error={move.error} />
    </div>
  )
}

function NewLibraryQueryForm({ onCancel }: { onCancel: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [folderId, setFolderId] = useState<string | null>(null)
  const { data: folders } = useFolders('library_query')
  const create = useMutation(
    trpc.libraryQueries.create.mutationOptions({
      onSuccess: async (q) => {
        await queryClient.invalidateQueries({ queryKey: trpc.libraryQueries.list.queryKey() })
        await navigate({ to: '/library/$slug', params: { slug: q.slug } })
      },
    }),
  )
  return (
    <Card className="mb-6 p-5">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate({ name, slug, folderId })
        }}
      >
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugEdited) setSlug(librarySlug(e.target.value))
            }}
            placeholder="Orders by customer"
          />
        </Field>
        <Field label="Slug" hint="How apps refer to it. It can't change later.">
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
            className="font-mono"
            placeholder="orders_by_customer"
          />
        </Field>
        {!!folders?.folders.length && (
          <Field label="Folder">
            <FolderSelect type="library_query" value={folderId} onChange={setFolderId} />
          </Field>
        )}
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name || !slug}>
            Create query
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <ErrorNote error={create.error} />
        </div>
      </form>
    </Card>
  )
}
