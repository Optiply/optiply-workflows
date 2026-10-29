import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, Folder, Pencil, Trash2 } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { Button, Card, Dialog, ErrorNote, Field, Input, Select, sectionLabelClass } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { AccessEditor } from '@/pages/resources/shared'

/**
 * Folders for resources, workflows, apps and library queries: each kind has folders of its own (a folder's grants reach what's in
 * it, so it holds one kind only). Whoever can create a kind manages its folders; admins grant access to them.
 */
export type FolderType = 'resource' | 'workflow' | 'app' | 'library_query' | 'module'

const PLURAL: Record<FolderType, string> = {
  resource: 'resources',
  workflow: 'workflows',
  app: 'apps',
  library_query: 'library queries',
  module: 'modules',
}
const appRoute = getRouteApi('/app')

type FolderRow = { id: string; name: string; parentId: string | null }

/** A folder's path from the top, `Finance/Reports` (as Git keeps it, M22); null for none. */
export function folderPath(folders: readonly FolderRow[], id: string | null): string | null {
  const names = folderChain(folders, id).map((f) => f.name)
  return names.length > 0 ? names.join('/') : null
}

/** The folder and those above it, from the top; none for an unknown id. */
function folderChain(folders: readonly FolderRow[], id: string | null): FolderRow[] {
  const chain: FolderRow[] = []
  const seen = new Set<string>()
  for (let at = id; at && !seen.has(at); ) {
    seen.add(at)
    const folder = folders.find((f) => f.id === at)
    if (!folder) break
    chain.unshift(folder)
    at = folder.parentId
  }
  return chain
}

/** The folder and every folder inside it, at any depth. */
export function folderSubtree(folders: readonly FolderRow[], id: string): Set<string> {
  const ids = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id)
        grew = true
      }
    }
  }
  return ids
}

/** Every folder as `{ id, path }`, by path; without `exclude`'s folder and what's inside it. */
function folderOptions(folders: readonly FolderRow[], exclude?: string) {
  const left = exclude ? folderSubtree(folders, exclude) : new Set<string>()
  return folders
    .filter((f) => !left.has(f.id))
    .map((f) => ({ id: f.id, path: folderPath(folders, f.id)! }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** A kind's folders and whether the person may manage them. */
export function useFolders(type: FolderType) {
  const trpc = useTRPC()
  return useQuery(trpc.folders.list.queryOptions({ type }))
}

/**
 * The folder open in a list (the address's `?folder=`): its id when it's one of the kind's folders, else null (the
 * top), and a way to open another.
 */
export function useOpenFolder(type: FolderType) {
  const { folder } = useSearch({ strict: false }) as { folder?: string }
  const navigate = useNavigate()
  const { data } = useFolders(type)
  const id = folder && data?.folders.some((f) => f.id === folder) ? folder : null
  const open = (next: string | null) =>
    navigate({ to: '.', search: (s: Record<string, unknown>) => ({ ...s, folder: next ?? undefined }) })
  return { id, open }
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

/** A new folder inside the one open (or at the top). */
export function NewFolderForm({ type, onDone }: { type: FolderType; onDone: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefresh()
  const { data } = useFolders(type)
  const { id: parentId } = useOpenFolder(type)
  const [name, setName] = useState('')
  const create = useMutation(
    trpc.folders.create.mutationOptions({
      onSuccess: async () => {
        await refresh()
        onDone()
      },
    }),
  )
  const parent = parentId && folderPath(data?.folders ?? [], parentId)
  return (
    <Card className="mb-6 space-y-3 p-5">
      <h2 className="font-semibold">{parent ? `New folder in ${parent}` : 'New folder'}</h2>
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
          onClick={() => create.mutate({ name, type, parentId })}
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
 * A kind's list one folder at a time: the path to the open folder (links back up), its subfolders, then what's in
 * it; at the top the top-level folders and what's in none. A folder shows to those who manage the kind's folders,
 * or when something inside it, at any depth, is the person's to see. Each folder offers Access (admins), Edit
 * (rename and move) and Delete (whoever manages the kind's folders; what's inside moves to the top).
 */
export function FolderBrowser<T extends { id: string; folderId: string | null }>({
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
  const { data } = useFolders(type)
  const { id: openId } = useOpenFolder(type)
  const folders = data?.folders ?? []
  const canManage = data?.canManage ?? false
  const known = new Set(folders.map((f) => f.id))
  const placeOf = (item: T) => (item.folderId && known.has(item.folderId) ? item.folderId : null)
  const holdsItems = (id: string) => {
    const inside = folderSubtree(folders, id)
    return items.some((i) => i.folderId !== null && inside.has(i.folderId))
  }
  const subfolders = folders.filter((f) => f.parentId === openId && (canManage || holdsItems(f.id)))
  const inside = items.filter((i) => placeOf(i) === openId)
  const open = openId ? folders.find((f) => f.id === openId)! : null
  const chain = folderChain(folders, openId)

  return (
    <div className="space-y-4">
      {folders.length > 0 && (
        <div className="flex min-h-8 flex-wrap items-center gap-2">
          <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            <FolderLink id={null} current={!open}>
              All {PLURAL[type]}
            </FolderLink>
            {chain.map((f) => (
              <Fragment key={f.id}>
                <ChevronRight className="size-4 text-muted" />
                <FolderLink id={f.id} current={f.id === openId}>
                  {f.name}
                </FolderLink>
              </Fragment>
            ))}
          </nav>
          {open && (
            <FolderActions
              type={type}
              folder={open}
              folders={folders}
              listKey={listKey}
              canManage={canManage}
            />
          )}
        </div>
      )}
      {subfolders.length > 0 && (
        <Card>
          <ul aria-label="Subfolders" className="divide-y divide-border">
            {subfolders.map((f) => (
              <li
                key={f.id}
                aria-label={`Subfolder ${f.name}`}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-canvas"
              >
                <FolderLink id={f.id} className="flex min-w-0 flex-1 items-center gap-3 font-medium">
                  <span className="rounded-md bg-subtle p-1.5 text-muted">
                    <Folder className="size-4" />
                  </span>
                  <span className="truncate">{f.name}</span>
                  <span className="text-xs font-normal text-muted">
                    {countLabel(
                      folders.filter((c) => c.parentId === f.id && (canManage || holdsItems(c.id))).length,
                      items.filter((i) => placeOf(i) === f.id).length,
                      type,
                    )}
                  </span>
                </FolderLink>
                <FolderActions
                  type={type}
                  folder={f}
                  folders={folders}
                  listKey={listKey}
                  canManage={canManage}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <section aria-label={open ? `Folder ${folderPath(folders, open.id)}` : undefined}>
        {open && folders.length > 0 && <h2 className={`mb-2 ${sectionLabelClass}`}>In {open.name}</h2>}
        {!open && subfolders.length > 0 && inside.length > 0 && (
          <h2 className={`mb-2 ${sectionLabelClass}`}>Not in a folder</h2>
        )}
        {(inside.length > 0 || (open && subfolders.length === 0)) && (
          <Card className="divide-y divide-border">
            {inside.length === 0 && <p className="px-4 py-4 text-sm text-muted">Empty folder.</p>}
            {inside.map((item) => children(item))}
          </Card>
        )}
      </section>
    </div>
  )
}

/** "2 folders · 3 apps", leaving out what's none; "Empty" for neither. */
function countLabel(subfolders: number, items: number, type: FolderType): string {
  const parts = [
    subfolders > 0 && `${subfolders} ${subfolders === 1 ? 'folder' : 'folders'}`,
    items > 0 && `${items} ${items === 1 ? type.replace('_', ' ') : PLURAL[type]}`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Empty'
}

/** A link opening a folder in the list (null: the top), keeping the rest of the address. */
function FolderLink({
  id,
  current,
  className,
  children,
}: {
  id: string | null
  current?: boolean
  className?: string
  children: ReactNode
}) {
  if (current) {
    return (
      <span aria-current="page" className="font-medium text-ink">
        {children}
      </span>
    )
  }
  return (
    <Link
      to="."
      search={(s: Record<string, unknown>) => ({ ...s, folder: id ?? undefined })}
      className={className ?? 'text-muted hover:text-ink hover:underline'}
    >
      {children}
    </Link>
  )
}

/** A folder's Access (admins), Edit and Delete (who manages the kind's folders). */
function FolderActions({
  type,
  folder,
  folders,
  listKey,
  canManage,
}: {
  type: FolderType
  folder: FolderRow
  folders: readonly FolderRow[]
  listKey: readonly unknown[]
  canManage: boolean
}) {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const refresh = useRefresh(listKey)
  const { id: openId, open } = useOpenFolder(type)
  const [panel, setPanel] = useState<'none' | 'access' | 'edit'>('none')
  const remove = useMutation(
    trpc.folders.delete.mutationOptions({
      onSuccess: async () => {
        // Deleting the open folder goes up to where it was.
        if (openId === folder.id) await open(folder.parentId)
        await refresh()
      },
    }),
  )
  const hasSubfolders = folders.some((f) => f.parentId === folder.id)
  return (
    <div className="flex items-center gap-1">
      {me.isAdmin && (
        <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'access' ? 'none' : 'access')}>
          Access
        </Button>
      )}
      {canManage && (
        <>
          <Button
            size="icon"
            variant="ghost"
            title={`Edit folder ${folder.name}`}
            onClick={() => setPanel('edit')}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={hasSubfolders}
            title={hasSubfolders ? 'Delete or move its subfolders first' : `Delete folder ${folder.name}`}
            onClick={async () => {
              if (
                await confirmDialog(
                  `Delete folder "${folder.name}"? Its ${PLURAL[type]} move to the top level.`,
                  { danger: true, confirm: 'Delete' },
                )
              ) {
                remove.mutate({ id: folder.id })
              }
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
      <ErrorNote error={remove.error} />
      {panel === 'access' && (
        <Dialog title={`Access to ${folder.name}`} onClose={() => setPanel('none')}>
          <p className="mb-3 text-muted">
            Grants on this folder apply to every {type.replace('_', ' ')} inside it and in its subfolders.
          </p>
          <AccessEditor
            target={{ objectType: 'folder', objectId: folder.id }}
            perEnvironment={type === 'resource'}
          />
        </Dialog>
      )}
      {panel === 'edit' && (
        <EditFolderDialog
          type={type}
          folder={folder}
          folders={folders}
          listKey={listKey}
          onClose={() => setPanel('none')}
        />
      )}
    </div>
  )
}

/** Renames a folder and moves it into another (never into itself or one inside it) or to the top. */
function EditFolderDialog({
  type,
  folder,
  folders,
  listKey,
  onClose,
}: {
  type: FolderType
  folder: FolderRow
  folders: readonly FolderRow[]
  listKey: readonly unknown[]
  onClose: () => void
}) {
  const trpc = useTRPC()
  const refresh = useRefresh(listKey)
  const [name, setName] = useState(folder.name)
  const [parentId, setParentId] = useState(folder.parentId)
  const rename = useMutation(trpc.folders.rename.mutationOptions())
  const move = useMutation(trpc.folders.move.mutationOptions())
  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() !== folder.name) await rename.mutateAsync({ id: folder.id, name })
      if (parentId !== folder.parentId) await move.mutateAsync({ id: folder.id, parentId })
    },
    onSettled: () => refresh(),
    onSuccess: onClose,
  })
  return (
    <Dialog
      title={`Edit folder ${folder.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Inside" hint={`Grants on the folders above it reach its ${PLURAL[type]} too.`}>
          <Select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
            <option value="">The top level</option>
            {folderOptions(folders, folder.id).map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  )
}

/** Picks a folder of a kind (by its path), or none. */
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
      {folderOptions(data?.folders ?? []).map((f) => (
        <option key={f.id} value={f.id}>
          {f.path}
        </option>
      ))}
    </Select>
  )
}
