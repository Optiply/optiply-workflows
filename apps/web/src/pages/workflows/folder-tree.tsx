import { ChevronDown, ChevronRight, Folder, FolderOpen, Layers } from 'lucide-react'
import { type DragEvent, useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

/** What a dragged workflow row carries (its id), so only workflow rows drop on the tree. */
export const WORKFLOW_DRAG_TYPE = 'application/x-ow-workflow'

type FolderRow = { id: string; name: string; parentId: string | null }

/**
 * The Workflows page's folder tree (session 40): every folder, nested and expandable, with how many workflows each
 * holds (its subfolders' included); a click opens one, and a dragged workflow row drops on a folder (or on "All
 * workflows": out of any folder) to move there. Folders with nothing visible are hidden from people who can't manage
 * folders, as in the list.
 */
export function FolderTree({
  folders,
  items,
  openId,
  canManage,
  onOpen,
  onDropWorkflow,
}: {
  folders: readonly FolderRow[]
  items: readonly { folderId: string | null }[]
  /** The open folder (null: the top); undefined highlights nothing (search results). */
  openId: string | null | undefined
  canManage: boolean
  onOpen: (id: string | null) => void
  onDropWorkflow: (workflowId: string, folderId: string | null) => void
}) {
  const { children, counts } = useMemo(() => {
    const known = new Set(folders.map((f) => f.id))
    const children = new Map<string | null, FolderRow[]>()
    for (const f of [...folders].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )) {
      const parent = f.parentId && known.has(f.parentId) ? f.parentId : null
      children.set(parent, [...(children.get(parent) ?? []), f])
    }
    const direct = new Map<string, number>()
    for (const i of items)
      if (i.folderId && known.has(i.folderId)) direct.set(i.folderId, (direct.get(i.folderId) ?? 0) + 1)
    const counts = new Map<string, number>()
    const count = (id: string): number => {
      const total = (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((n, c) => n + count(c.id), 0)
      counts.set(id, total)
      return total
    }
    for (const f of children.get(null) ?? []) count(f.id)
    return { children, counts }
  }, [folders, items])

  // The open folder and its parents expand, so it's in view with what's inside.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!openId) return
    const byId = new Map(folders.map((f) => [f.id, f]))
    // The open folder too, so its subfolders show.
    const chain: string[] = [openId]
    for (let f = byId.get(openId); f?.parentId; f = byId.get(f.parentId)) chain.push(f.parentId)
    if (chain.some((id) => !expanded.has(id))) setExpanded((e) => new Set([...e, ...chain]))
  }, [openId, folders, expanded])
  const toggle = (id: string) =>
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const [over, setOver] = useState<string | undefined>(undefined)
  const dropProps = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(WORKFLOW_DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOver(target ?? '')
    },
    onDragLeave: () => setOver(undefined),
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(WORKFLOW_DRAG_TYPE)
      setOver(undefined)
      if (!id) return
      e.preventDefault()
      onDropWorkflow(id, target)
    },
  })

  const node = (f: FolderRow, depth: number) => {
    const kids = (children.get(f.id) ?? []).filter((c) => canManage || (counts.get(c.id) ?? 0) > 0)
    const isOpen = expanded.has(f.id)
    const current = openId !== undefined && f.id === openId
    return (
      <li key={f.id}>
        <div
          className={cn(
            'group flex items-center gap-1 rounded-md pr-2 text-sm',
            current ? 'bg-accent-soft font-medium text-ink' : 'text-muted hover:bg-canvas hover:text-ink',
            over === f.id && 'ring-2 ring-accent',
          )}
          style={{ paddingLeft: `${depth * 0.875 + 0.25}rem` }}
          data-testid={`tree-folder-${f.name}`}
          {...dropProps(f.id)}
        >
          {kids.length ? (
            <button
              type="button"
              className="rounded p-0.5 hover:bg-subtle"
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${f.name}`}
              aria-expanded={isOpen}
              onClick={() => toggle(f.id)}
            >
              {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : (
            <span className="w-4.5 shrink-0" />
          )}
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            aria-current={current ? 'page' : undefined}
            onClick={() => onOpen(f.id)}
          >
            {current ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
            <span className="truncate">{f.name}</span>
          </button>
          <span className="text-xs tabular-nums text-muted">{counts.get(f.id) ?? 0}</span>
        </div>
        {kids.length > 0 && isOpen && <ul>{kids.map((c) => node(c, depth + 1))}</ul>}
      </li>
    )
  }

  const top = (children.get(null) ?? []).filter((f) => canManage || (counts.get(f.id) ?? 0) > 0)
  return (
    <nav aria-label="Folders" className="space-y-1">
      <div
        className={cn(
          'flex items-center gap-2 rounded-md px-2 text-sm',
          openId === null
            ? 'bg-accent-soft font-medium text-ink'
            : 'text-muted hover:bg-canvas hover:text-ink',
          over === '' && 'ring-2 ring-accent',
        )}
        data-testid="tree-all"
        title="Drop a workflow here to take it out of its folder"
        {...dropProps(null)}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          aria-current={openId === null ? 'page' : undefined}
          onClick={() => onOpen(null)}
        >
          <Layers className="size-4 shrink-0" />
          <span className="truncate">All workflows</span>
        </button>
        <span className="text-xs tabular-nums text-muted">{items.length}</span>
      </div>
      <ul aria-label="Folder tree">{top.map((f) => node(f, 0))}</ul>
    </nav>
  )
}
