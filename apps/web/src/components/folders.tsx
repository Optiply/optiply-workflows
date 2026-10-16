import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { Folder, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button, Card, ErrorNote, Input, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AccessEditor } from '@/pages/resources/shared'

/**
 * Folders for resources, workflows and apps: each kind has folders of its own (a folder's grants reach what's in
 * it, so it holds one kind only). Whoever can create a kind manages its folders; admins grant access to them.
 */
export type FolderType = 'resource' | 'workflow' | 'app'

const PLURAL: Record<FolderType, string> = { resource: 'resources', workflow: 'workflows', app: 'apps' }
const appRoute = getRouteApi('/app')

/** A kind's folders and whether the person may manage them. */
export function useFolders(type: FolderType) {
  const trpc = useTRPC()
  return useQuery(trpc.folders.list.queryOptions({ type }))
}

/** Refreshes every kind's folders and, with `also`, the list of what's in them. */
function useRefresh(also?: readonly unknown[]) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.folders.list.pathKey() }),
      also && queryClient.invalidateQueries({ queryKey: also }),
    ])
}

export function NewFolderForm({ type, onDone }: { type: FolderType; onDone: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefresh()
  const [name, setName] = useState('')
  const create = useMutation(
    trpc.folders.create.mutationOptions({
      onSuccess: async () => {
        await refresh()
        onDone()
      },
    }),
  )
  return (
    <Card className="mb-6 space-y-3 p-5">
      <h2 className="font-semibold">New folder</h2>
      <div className="flex max-w-md gap-2">
        <Input
          autoFocus
          aria-label="Folder name"
          value={name}
          placeholder="Finance"
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          variant="primary"
          disabled={!name.trim()}
          loading={create.isPending}
          onClick={() => create.mutate({ name, type })}
        >
          Create
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorNote error={create.error} />
    </Card>
  )
}

/**
 * Items grouped by folder, folder by folder, then those in none. Each folder's header offers Access (admins) and
 * Delete (whoever manages the kind's folders; what's inside moves out). Empty folders show to those who manage
 * them only.
 */
export function FolderSections<T extends { id: string; folderId: string | null }>({
  type,
  items,
  listKey,
  children,
}: {
  type: FolderType
  items: T[]
  /** The query key of the items' list, refreshed when a folder is deleted. */
  listKey: readonly unknown[]
  /** One item's row. */
  children: (item: T) => ReactNode
}) {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const { data } = useFolders(type)
  const refresh = useRefresh(listKey)
  const [access, setAccess] = useState<string | null>(null)
  const remove = useMutation(trpc.folders.delete.mutationOptions({ onSuccess: () => refresh() }))
  const folders = data?.folders ?? []
  const canManage = data?.canManage ?? false
  const groups = [
    ...folders.map((f) => ({ folder: f, items: items.filter((i) => i.folderId === f.id) })),
    { folder: null, items: items.filter((i) => !i.folderId || !folders.some((f) => f.id === i.folderId)) },
  ].filter((g) => g.items.length > 0 || (g.folder && canManage))

  return (
    <div className="space-y-6">
      <ErrorNote error={remove.error} />
      {groups.map(({ folder, items: inside }) => (
        <section key={folder?.id ?? 'none'} aria-label={folder ? `Folder ${folder.name}` : undefined}>
          {(folder || folders.length > 0) && (
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted">
              <Folder className="size-4" /> {folder?.name ?? 'Not in a folder'}
              {folder && me.isAdmin && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAccess(access === folder.id ? null : folder.id)}
                >
                  Access
                </Button>
              )}
              {folder && canManage && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Delete folder"
                  onClick={() => {
                    if (confirm(`Delete folder "${folder.name}"? Its ${PLURAL[type]} move out of it.`)) {
                      remove.mutate({ id: folder.id })
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          )}
          {folder && access === folder.id && (
            <Card className="mb-3 p-4">
              <p className="mb-3 text-sm text-muted">
                Grants on this folder apply to every {type} inside it.
              </p>
              <AccessEditor target={{ objectType: 'folder', objectId: folder.id }} />
            </Card>
          )}
          <Card className="divide-y divide-border">
            {inside.length === 0 && <p className="px-4 py-4 text-sm text-muted">Empty folder.</p>}
            {inside.map((item) => children(item))}
          </Card>
        </section>
      ))}
    </div>
  )
}

/** Picks a folder of a kind, or none. */
export function FolderSelect({
  type,
  value,
  onChange,
  label = 'Folder',
  className,
}: {
  type: FolderType
  value: string | null
  onChange: (folderId: string | null) => void
  label?: string
  className?: string
}) {
  const { data } = useFolders(type)
  return (
    <Select
      aria-label={label}
      className={className}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">Not in a folder</option>
      {data?.folders.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </Select>
  )
}
