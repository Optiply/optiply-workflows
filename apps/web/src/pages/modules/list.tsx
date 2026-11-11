import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderPlus, Plus, Puzzle } from 'lucide-react'
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
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { librarySlug } from '../library/list'

type ModuleSummary = RouterOutputs['modules']['list'][number]

const LEVELS = { use: 'Can use', edit: 'Can edit', own: 'Owner' } as const

/** Modules (M14): pieces of app built once, with inputs, outputs and events, placed in many apps. */
export function ModulesPage() {
  const trpc = useTRPC()
  const { data, isLoading, error } = useQuery(trpc.modules.list.queryOptions())
  const { data: folders } = useFolders('module')
  const [panel, setPanel] = useState<'none' | 'module' | 'folder'>('none')

  if (isLoading) return <ListSkeleton />
  if (!data) return <ErrorNote error={error} />

  return (
    <>
      <PageHeader
        title="Modules"
        description="Pieces of app built once and placed in many apps. Apps pass the inputs, read the outputs, handle the events, and pin a version or follow the latest."
        actions={
          <>
            {folders?.canManage && (
              <Button onClick={() => setPanel('folder')}>
                <FolderPlus className="size-4" /> New folder
              </Button>
            )}
            <Button variant="primary" onClick={() => setPanel('module')}>
              <Plus className="size-4" /> New module
            </Button>
          </>
        }
      />
      {panel === 'module' && <NewModuleDialog onClose={() => setPanel('none')} />}
      {panel === 'folder' && <NewFolderDialog type="module" onDone={() => setPanel('none')} />}
      {data.length === 0 && !(folders?.canManage && folders.folders.length) ? (
        <EmptyState icon={<Puzzle className="size-6" />} title="No modules yet">
          Create one to share a piece of app between apps. If you expected to see some here, ask an admin for
          access.
        </EmptyState>
      ) : (
        <FolderBrowser type="module" items={data} listKey={trpc.modules.list.queryKey()}>
          {(m) => <ModuleRow key={m.id} module={m} hasFolders={!!folders?.folders.length} />}
        </FolderBrowser>
      )}
    </>
  )
}

/** A module; editors open it, owners move it between folders. */
function ModuleRow({ module, hasFolders }: { module: ModuleSummary; hasFolders: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const move = useMutation(
    trpc.modules.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.modules.list.queryKey() }),
    }),
  )
  const canEdit = module.level === 'edit' || module.level === 'own'
  const body = (
    <>
      <span className="rounded-md bg-accent-soft p-1.5 text-accent">
        <Puzzle className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{module.name}</div>
        <div className="truncate font-mono text-xs text-muted">{module.slug}</div>
      </div>
    </>
  )
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-canvas" data-testid={`module-${module.slug}`}>
      {canEdit ? (
        <Link
          to="/modules/$slug"
          params={{ slug: module.slug }}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
      )}
      {module.liveVersion ? (
        <Badge tone="success">Live v{module.liveVersion}</Badge>
      ) : (
        <Badge>Not published</Badge>
      )}
      <Badge tone="accent">{LEVELS[module.level]}</Badge>
      {hasFolders && module.level === 'own' && (
        <FolderSelect
          type="module"
          label={`Folder of ${module.name}`}
          className="w-40"
          value={module.folderId}
          onChange={(folderId) => move.mutate({ id: module.id, folderId })}
        />
      )}
      <ErrorNote error={move.error} />
    </div>
  )
}

function NewModuleDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  // In the folder open in the list, to begin with.
  const [folderId, setFolderId] = useState<string | null>(useOpenFolder('module').id)
  const { data: folders } = useFolders('module')
  const create = useMutation(
    trpc.modules.create.mutationOptions({
      onSuccess: async (q) => {
        await queryClient.invalidateQueries({ queryKey: trpc.modules.list.queryKey() })
        await navigate({ to: '/modules/$slug', params: { slug: q.slug } })
      },
    }),
  )
  const id = useId()
  return (
    <Dialog
      title="New module"
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
            Create module
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
              if (!slugEdited) setSlug(librarySlug(e.target.value))
            }}
            placeholder="Customer picker"
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
            placeholder="customer_picker"
          />
        </Field>
        {!!folders?.folders.length && (
          <Field label="Folder">
            <FolderSelect type="module" value={folderId} onChange={setFolderId} />
          </Field>
        )}
        <ErrorNote error={create.error} />
      </form>
    </Dialog>
  )
}
