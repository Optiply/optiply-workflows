import {
  addPage,
  movePage,
  onPage,
  pageNameReason,
  removePage,
  renamePage,
  setPageTitle,
} from '@ow/app-definition'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { EditorField } from './fields'
import { useAppEditor } from './store'

/**
 * The app's pages: pick the one to edit, add one (an app without pages gets two, what it had moving onto the
 * first), and rename, retitle, reorder or delete the one being edited.
 */
export function PagesPanel() {
  const definition = useAppEditor((s) => s.definition)
  const update = useAppEditor((s) => s.update)
  const current = useAppEditor((s) => s.url.page)
  const setUrl = useAppEditor((s) => s.setUrl)
  const pages = definition.pages ?? []
  const add = () => {
    const made = addPage(useAppEditor.getState().definition)
    update(() => made.definition)
    setUrl(made.name)
  }
  return (
    <section aria-label="Pages">
      <div className="mb-2 flex items-center gap-1">
        <h2 className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">Pages</h2>
        <Button size="icon" variant="ghost" title="Add a page" onClick={add}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      {pages.length === 0 ? (
        <p className="px-1 text-xs text-muted">
          One page. Add a page to give the app several; what's here goes on the first.
        </p>
      ) : (
        <ul className="flex flex-col">
          {pages.map((p) => (
            <li key={p.name}>
              <button
                type="button"
                aria-current={p.name === current ? 'page' : undefined}
                onClick={() => setUrl(p.name)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
                  p.name === current
                    ? 'bg-accent-soft text-ink'
                    : 'text-muted hover:bg-canvas hover:text-ink',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{p.title || p.name}</span>
                {p.title && <span className="font-mono text-[10px] text-muted">{p.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && pages.length > 0 && <PageSettings key={current} page={current} />}
    </section>
  )
}

/** The page being edited: its name (in the URL and in code), title, place in the order, or deletion. */
function PageSettings({ page }: { page: string }) {
  const definition = useAppEditor((s) => s.definition)
  const update = useAppEditor((s) => s.update)
  const setUrl = useAppEditor((s) => s.setUrl)
  const pages = definition.pages ?? []
  const index = pages.findIndex((p) => p.name === page)
  const [name, setName] = useState(page)
  useEffect(() => setName(page), [page])
  const reason = name === page ? null : pageNameReason(definition, name, page)
  const rename = () => {
    if (name === page || reason) return
    update((def) => renamePage(def, page, name))
    setUrl(name)
  }
  const remove = () => {
    const goes = onPage(definition, page).size
    const what =
      goes === 1 ? '1 component, query or transformer' : `${goes} components, queries and transformers`
    if (!confirm(`Delete page ${page}${goes ? ` and the ${what} on it` : ''}?`)) return
    update((def) => removePage(def, page))
  }
  if (index === -1) return null
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2">
      <EditorField label="Page name">
        <Input
          aria-label="Page name"
          aria-invalid={!!reason}
          className="font-mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename()
            if (e.key === 'Escape') setName(page)
          }}
        />
        {reason && <p className="mt-1 text-xs text-danger">{reason}</p>}
      </EditorField>
      <EditorField label="Page title">
        <Input
          aria-label="Page title"
          placeholder={page}
          value={pages[index]!.title ?? ''}
          onChange={(e) => update((def) => setPageTitle(def, page, e.target.value))}
        />
      </EditorField>
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          title="Move the page up"
          disabled={index === 0}
          onClick={() => update((def) => movePage(def, page, -1))}
        >
          <ArrowUp className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Move the page down"
          disabled={index === pages.length - 1}
          onClick={() => update((def) => movePage(def, page, 1))}
        >
          <ArrowDown className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto"
          title="Delete the page"
          disabled={pages.length < 2}
          onClick={remove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
