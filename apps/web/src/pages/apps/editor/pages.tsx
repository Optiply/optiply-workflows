import {
  type AppFrame,
  addPage,
  movePage,
  onPage,
  pageNameReason,
  removePage,
  renamePage,
  setFrame,
  setPageTitle,
} from '@ow/app-definition'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { Button, Checkbox, Input, Select, sectionLabelClass } from '@/components/ui'
import { cn } from '@/lib/utils'
import { EditorField } from './fields'
import { useAppEditor } from './store'

/**
 * The app's pages (the Pages panel): pick the one to edit, or add one (an app without pages gets two, what it had
 * moving onto the first). The page's settings are in the inspector while no component is selected.
 */
export function PagesPanel() {
  const definition = useAppEditor((s) => s.definition)
  const update = useAppEditor((s) => s.update)
  const current = useAppEditor((s) => s.url.page)
  const readOnly = useAppEditor((s) => s.readOnly)
  const setUrl = useAppEditor((s) => s.setUrl)
  const select = useAppEditor((s) => s.select)
  const pages = definition.pages ?? []
  // The page shows in the inspector: nothing on it stays selected.
  const open = (page: string) => {
    setUrl(page)
    select(null)
  }
  const add = () => {
    const made = addPage(useAppEditor.getState().definition)
    update(() => made.definition)
    open(made.name)
  }
  return (
    <section aria-label="Pages">
      <div className="mb-2 flex items-center gap-1">
        <h2 className={cn('flex-1', sectionLabelClass)}>Pages</h2>
        {!readOnly && (
          <Button size="icon" variant="ghost" title="Add a page" onClick={add}>
            <Plus className="size-3.5" />
          </Button>
        )}
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
                onClick={() => open(p.name)}
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
    </section>
  )
}

/**
 * The app frame (M24): a header bar and/or a sidebar around every page, holding the components on every page (in
 * the header, or the sidebar picked in their Area), with the app's name and the signed-in person if wanted.
 */
export function FrameSettings() {
  const frame = useAppEditor((s) => s.definition.frame) ?? {}
  const update = useAppEditor((s) => s.update)
  const readOnly = useAppEditor((s) => s.readOnly)
  const set = (part: Partial<AppFrame>) => update((def) => setFrame(def, { ...def.frame, ...part }))
  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-2" aria-label="Frame">
      <h2 className={sectionLabelClass}>Frame</h2>
      <Checkbox
        label="Header bar"
        checked={frame.header === true}
        onChange={(e) => set({ header: e.target.checked })}
      />
      <EditorField label="Sidebar">
        <Select
          aria-label="Sidebar"
          value={frame.sidebar ?? ''}
          onChange={(e) => set({ sidebar: (e.target.value || undefined) as AppFrame['sidebar'] })}
        >
          <option value="">None</option>
          <option value="narrow">Narrow</option>
          <option value="medium">Medium</option>
          <option value="wide">Wide</option>
        </Select>
      </EditorField>
      {(frame.header || frame.sidebar) && (
        <>
          <Checkbox
            label="Show the app's name"
            checked={frame.showTitle === true}
            onChange={(e) => set({ showTitle: e.target.checked })}
          />
          {frame.header && (
            <Checkbox
              label="Show who's signed in"
              checked={frame.showUser === true}
              onChange={(e) => set({ showUser: e.target.checked })}
            />
          )}
        </>
      )}
    </fieldset>
  )
}

/** The page being edited: its name (in the URL and in code), title, place in the order, or deletion. */
export function PageSettings({ page }: { page: string }) {
  const definition = useAppEditor((s) => s.definition)
  const readOnly = useAppEditor((s) => s.readOnly)
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
  const remove = async () => {
    const goes = onPage(definition, page).size
    const what =
      goes === 1 ? '1 component, query or transformer' : `${goes} components, queries and transformers`
    if (
      !(await confirmDialog(`Delete page ${page}${goes ? ` and the ${what} on it` : ''}?`, {
        danger: true,
        confirm: 'Delete',
      }))
    )
      return
    update((def) => removePage(def, page))
  }
  if (index === -1) return null
  return (
    // A protected app on main (M22): shown, not edited.
    <fieldset disabled={readOnly} className="flex flex-col gap-2" aria-label="Page">
      <h2 className={sectionLabelClass}>Page</h2>
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
    </fieldset>
  )
}

/**
 * The inspector while no component is selected (session 41, Retool's App and Page inspectors): the page being
 * edited and the app's frame. A module has neither: its inputs, outputs and events are in its panel.
 */
export function AppInspector({ kind }: { kind: 'app' | 'module' }) {
  const page = useAppEditor((s) => (s.definition.pages?.length ? s.url.page : null))
  const title = useAppEditor((s) => s.definition.pages?.find((p) => p.name === page)?.title)
  return (
    <div className="flex flex-col gap-5 p-4" data-testid="inspector-app">
      <div>
        <p className="text-sm font-semibold">
          {kind === 'module' ? 'Module' : page ? `Page ${title || page}` : 'App'}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {kind === 'module'
            ? 'Select a component to edit it. Inputs, outputs and events are in the Module panel.'
            : 'Select a component to edit it.'}
        </p>
      </div>
      {page && <PageSettings key={page} page={page} />}
      {kind === 'app' && <FrameSettings />}
    </div>
  )
}
