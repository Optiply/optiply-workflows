import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Blocks, FolderPlus, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { FolderBrowser, FolderSelect, NewFolderDialog, useFolders, useOpenFolder } from '@/components/folders'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  ListSkeleton,
  PageHeader,
} from '@/components/ui'
import { useCanCreate } from '@/lib/capabilities'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

type LibrarySummary = RouterOutputs['componentLibraries']['list'][number]

const LEVELS = { use: 'Can use', edit: 'Can edit', own: 'Owner' } as const

/** A slug from a name: lowercase words joined by hyphens. */
export function componentLibrarySlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 63)
}

/** Component libraries (M25): React components written here, built on the server, placed in apps and modules. */
export function ComponentLibrariesPage() {
  const canCreate = useCanCreate('componentLibraries')
  const trpc = useTRPC()
  const { data, isLoading, error } = useQuery(trpc.componentLibraries.list.queryOptions())
  const { data: folders } = useFolders('component_library')
  const [panel, setPanel] = useState<'none' | 'library' | 'folder'>('none')

  if (isLoading) return <ListSkeleton />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Components"
        description="Libraries of React components written here and built on the server, for apps and modules. Apps pin a version or follow the latest."
        actions={
          <>
            {folders?.canManage && (
              <Button onClick={() => setPanel('folder')}>
                <FolderPlus className="size-4" /> New folder
              </Button>
            )}
            {canCreate && (
              <Button variant="primary" onClick={() => setPanel('library')}>
                <Plus className="size-4" /> New library
              </Button>
            )}
          </>
        }
      />
      {panel === 'library' && <NewLibraryDialog onClose={() => setPanel('none')} />}
      {panel === 'folder' && <NewFolderDialog type="component_library" onDone={() => setPanel('none')} />}
      {data.length === 0 && !(folders?.canManage && folders.folders.length) ? (
        <EmptyState icon={<Blocks className="size-6" />} title="No component libraries yet">
          Create one to write components of your own for apps. If you expected to see some here, ask an admin
          for access.
        </EmptyState>
      ) : (
        <FolderBrowser
          type="component_library"
          items={data}
          listKey={trpc.componentLibraries.list.queryKey()}
        >
          {(l) => <LibraryRow key={l.id} library={l} hasFolders={!!folders?.folders.length} />}
        </FolderBrowser>
      )}
    </>
  )
}

/** A library; editors open it, owners move it between folders. */
function LibraryRow({ library: query, hasFolders }: { library: LibrarySummary; hasFolders: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const move = useMutation(
    trpc.componentLibraries.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.componentLibraries.list.queryKey() }),
    }),
  )
  const canEdit = query.level === 'edit' || query.level === 'own'
  const body = (
    <>
      <span className="rounded-md bg-accent-soft p-1.5 text-accent">
        <Blocks className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{query.name}</div>
        <div className="truncate font-mono text-xs text-muted">{query.slug}</div>
      </div>
    </>
  )
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-canvas"
      data-testid={`component-library-${query.slug}`}
    >
      {canEdit ? (
        <Link
          to="/component-libraries/$slug"
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
          type="component_library"
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

function NewLibraryDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  // In the folder open in the list, to begin with.
  const [folderId, setFolderId] = useState<string | null>(useOpenFolder('component_library').id)
  const { data: folders } = useFolders('component_library')
  const create = useMutation(
    trpc.componentLibraries.create.mutationOptions({
      onSuccess: async (q) => {
        await queryClient.invalidateQueries({ queryKey: trpc.componentLibraries.list.queryKey() })
        await navigate({ to: '/component-libraries/$slug', params: { slug: q.slug } })
      },
    }),
  )
  const id = useId()
  return (
    <Dialog
      title="New component library"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={id}
            variant="primary"
            loading={create.isPending}
            disabled={!name || !slug}
          >
            Create library
          </Button>
        </>
      }
    >
      <form
        id={id}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (name && slug) create.mutate({ name, slug, folderId })
        }}
      >
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugEdited) setSlug(componentLibrarySlug(e.target.value))
            }}
            placeholder="Charts"
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
            placeholder="charts"
          />
        </Field>
        {!!folders?.folders.length && (
          <Field label="Folder">
            <FolderSelect type="component_library" value={folderId} onChange={setFolderId} />
          </Field>
        )}
        <ErrorNote error={create.error} />
      </form>
    </Dialog>
  )
}
