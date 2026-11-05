import {
  type AppDefinition,
  addComponent,
  addPage,
  addQuery,
  addTransformer,
  addVariable,
  buildAppGraph,
  COMPONENTS,
} from '@ow/app-definition'
import { ArrowDown, ArrowUp, CaseSensitive, Regex, Search, WholeWord } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Input, sectionLabelClass } from '@/components/ui'
import { cn } from '@/lib/utils'
import { placement } from './canvas'
import {
  entityLinks,
  fuzzyScore,
  type SearchHit,
  type SearchOptions,
  searchApp,
  searchPattern,
} from './navigate-model'
import { PALETTE_GROUPS } from './palette-model'
import { type LeftPanel, specOf, useAppEditor } from './store'

/*
 * Getting around the app in the editor (session 41): the Search panel over every field, the graph of what the
 * selection reads and is read by, and the ⌘K palette. Picking anything selects it everywhere (tree, canvas,
 * inspector, dock), opening its page when it's on another.
 */

/** The app's graph with modules' and custom components' interfaces, as the validator builds it. */
function useGraph() {
  const definition = useAppEditor((s) => s.definition)
  const modules = useAppEditor((s) => s.modules)
  const libraries = useAppEditor((s) => s.componentLibraries)
  return useMemo(
    () => ({
      definition,
      graph: buildAppGraph(definition, { specFor: (c) => specOf(c, modules, libraries) }),
    }),
    [definition, modules, libraries],
  )
}

/** Where an entity is: a component (selected) or code (opened in the dock); its page opened if it has one. */
export function goTo(name: string, path: readonly (string | number)[] = []) {
  const s = useAppEditor.getState()
  const def = s.definition
  const page = pageOf(def, name)
  if (page && def.pages?.length && page !== s.url.page) s.setUrl(page)
  if (def.components.some((c) => c.name === name)) s.select(name)
  else s.openCodeItem(name)
  if (path.length) focusField(path)
}

/** The page an entity is on (a component inside another: its outermost's); null on every page. */
function pageOf(def: AppDefinition, name: string): string | null {
  const byName = new Map(def.components.map((c) => [c.name, c]))
  let component = byName.get(name)
  while (component?.parent && byName.has(component.parent)) component = byName.get(component.parent)
  if (component) return component.page ?? null
  const code = [...def.queries, ...(def.transformers ?? [])].find((c) => c.name === name)
  return code?.page ?? null
}

/**
 * Focuses the editor of a field once it's on screen: the inspector or the dock draws it after the selection, and its
 * Monaco editor starts after that (tried for about a second).
 */
function focusField(path: readonly (string | number)[]) {
  const suffix = `/${path.join('/')}`
  let tries = 0
  const attempt = () => {
    const field = [...document.querySelectorAll<HTMLElement>('[data-testid^="code-"]')].find((el) =>
      el.dataset.testid?.endsWith(suffix),
    )
    // Monaco takes the focus on its edit context (or, in older setups, its input area); plain fields on themselves.
    const target = [
      '.monaco-editor .native-edit-context',
      '.monaco-editor textarea.inputarea',
      'input',
      'textarea',
    ]
      .map((selector) => field?.querySelector<HTMLElement>(selector))
      .find(Boolean)
    if (field && target) {
      if (tries === 0 || document.activeElement !== target) field.scrollIntoView({ block: 'center' })
      target.focus()
    }
    // Again until it holds: a field still starting can lose the focus to its own setup.
    if ((!target || document.activeElement !== target || tries < 3) && ++tries < 25) setTimeout(attempt, 50)
  }
  setTimeout(attempt, 0)
}

/** The Search panel: every field and name of the app, with Match case, Whole word and Regex. */
export function SearchPanel() {
  const { definition, graph } = useGraph()
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>({})
  const pattern = searchPattern(query, options)
  const hits = useMemo(() => {
    const found = searchPattern(query, options)
    return found instanceof RegExp ? searchApp(definition, graph, found) : []
  }, [definition, graph, query, options])
  const pageTitle = (page: string | null) =>
    page === null
      ? definition.pages?.length
        ? 'Every page'
        : 'The app'
      : `Page ${definition.pages?.find((p) => p.name === page)?.title || page}`
  const groups = new Map<string | null, Map<string, SearchHit[]>>()
  for (const hit of hits) {
    const byOwner = groups.get(hit.page) ?? new Map<string, SearchHit[]>()
    byOwner.set(hit.owner, [...(byOwner.get(hit.owner) ?? []), hit])
    groups.set(hit.page, byOwner)
  }
  const places = new Set(hits.map((h) => `${h.owner}`)).size
  const toggle = (key: keyof SearchOptions, label: string, icon: ReactNode) => (
    <button
      type="button"
      aria-pressed={!!options[key]}
      title={label}
      aria-label={label}
      onClick={() => setOptions({ ...options, [key]: !options[key] })}
      className={cn(
        'flex size-6 items-center justify-center rounded',
        options[key] ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-canvas hover:text-ink',
      )}
    >
      {icon}
    </button>
  )
  return (
    <div className="flex flex-col gap-2" data-testid="search-panel">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
        <Input
          type="search"
          aria-label="Search the app"
          placeholder="Search names and code"
          className="h-8 pr-20 pl-8"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 gap-0.5">
          {toggle('matchCase', 'Match case', <CaseSensitive className="size-4" />)}
          {toggle('wholeWord', 'Whole word', <WholeWord className="size-4" />)}
          {toggle('regex', 'Regular expression', <Regex className="size-4" />)}
        </div>
      </div>
      {typeof pattern === 'string' && <p className="px-1 text-xs text-danger">{pattern}</p>}
      {pattern instanceof RegExp && (
        <p className="px-1 text-xs text-muted" aria-live="polite">
          {hits.length
            ? `${hits.length} result${hits.length === 1 ? '' : 's'} in ${places} place${places === 1 ? '' : 's'}`
            : 'No results'}
        </p>
      )}
      {[...groups.entries()].map(([page, byOwner]) => (
        <section key={page ?? ''} aria-label={pageTitle(page)}>
          <h3 className="mb-1 px-1 text-[11px] font-medium text-muted">{pageTitle(page)}</h3>
          <ul className="flex flex-col gap-1">
            {[...byOwner.entries()].map(([owner, ownHits]) => (
              <li key={owner}>
                <div className="px-1 font-mono text-xs font-medium">{owner}</div>
                <ul>
                  {ownHits.map((hit) => (
                    <li key={hit.path.join('/') || 'name'}>
                      <button
                        type="button"
                        onClick={() => goTo(hit.owner, hit.path)}
                        className="block w-full rounded px-2 py-1 text-left hover:bg-canvas"
                      >
                        <span className="block text-[11px] text-muted">
                          {owner} → {hit.label}
                        </span>
                        <span className="block truncate font-mono text-[11px]">
                          {hit.before}
                          <mark className="rounded-sm bg-warning-soft px-0.5 text-ink">{hit.match}</mark>
                          {hit.after}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Under the Tree and Code panels: what the selection reads (above) and what reads it (below), one hop. */
export function DependencyGraph() {
  const { graph } = useGraph()
  const selected = useAppEditor((s) =>
    s.focus === 'code' ? (s.openCode ?? s.selected) : (s.selected ?? s.openCode),
  )
  const links = useMemo(() => entityLinks(graph), [graph])
  const focus = selected && links.has(selected) ? selected : null
  const node = (name: string) => (
    <li key={name}>
      <button
        type="button"
        onClick={() => goTo(name)}
        className="w-full truncate rounded px-2 py-0.5 text-left font-mono text-xs text-muted hover:bg-canvas hover:text-ink"
      >
        {name}
      </button>
    </li>
  )
  return (
    <section aria-label="Graph" data-testid="dependency-graph" className="flex flex-col gap-1.5">
      <h2 className={sectionLabelClass}>Graph</h2>
      {!focus ? (
        <p className="text-xs text-muted">
          Select a component or open a query to see what it reads and what reads it.
        </p>
      ) : (
        <>
          <div>
            <h3 className="flex items-center gap-1 text-[11px] text-muted">
              <ArrowUp className="size-3" /> Uses
            </h3>
            <ul aria-label={`${focus} uses`}>
              {links.get(focus)!.uses.map(node)}
              {!links.get(focus)!.uses.length && <li className="px-2 text-xs text-faint">Nothing</li>}
            </ul>
          </div>
          <div className="rounded-md bg-accent-soft px-2 py-1 font-mono text-xs text-ink">{focus}</div>
          <div>
            <h3 className="flex items-center gap-1 text-[11px] text-muted">
              <ArrowDown className="size-3" /> Used by
            </h3>
            <ul aria-label={`${focus} is used by`}>
              {links.get(focus)!.usedBy.map(node)}
              {!links.get(focus)!.usedBy.length && <li className="px-2 text-xs text-faint">Nothing</li>}
            </ul>
          </div>
        </>
      )}
    </section>
  )
}

interface PaletteItem {
  id: string
  label: string
  group: 'Components' | 'Code' | 'Pages' | 'Actions'
  hint?: string
  run: () => void
}

/** The ⌘K palette's actions besides going somewhere. */
export interface CommandActions {
  preview: () => void
  restart: () => void
}

/** ⌘K / Ctrl+K anywhere in the editor: jump to anything, or run an action. */
export function CommandPalette({ actions }: { actions: CommandActions }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setOpen((o) => !o)
      }
    }
    // Capturing: before Monaco, whose ⌘K starts a chord.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  if (!open) return null
  return <PaletteDialog actions={actions} onClose={() => setOpen(false)} />
}

function PaletteDialog({ actions, onClose }: { actions: CommandActions; onClose: () => void }) {
  const definition = useAppEditor((s) => s.definition)
  const readOnly = useAppEditor((s) => s.readOnly)
  const kind = useAppEditor((s) => s.kind)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo((): PaletteItem[] => {
    const s = () => useAppEditor.getState()
    const edit =
      (make: (def: AppDefinition) => { definition: AppDefinition; name: string }, code: boolean) => () => {
        const made = make(s().definition)
        s().update(() => made.definition)
        if (code) s().openCodeItem(made.name)
        else s().select(made.name)
      }
    const page = definition.pages?.length ? s().url.page : null
    const panels: [LeftPanel, string][] = [
      ['components', 'Show the components'],
      ['pages', kind === 'module' ? 'Show the module panel' : 'Show the pages'],
      ['tree', 'Show the component tree'],
      ['code', 'Show the code'],
      ['search', 'Search the app'],
      ['state', 'Show the state'],
      ...(kind === 'app' ? [['settings', 'Show the app settings (theme, CSS)'] as [LeftPanel, string]] : []),
    ]
    const go: PaletteItem[] = [
      ...definition.components.map((c) => ({
        id: `c:${c.name}`,
        label: c.name,
        group: 'Components' as const,
        hint: COMPONENTS[c.type]?.label ?? c.type,
        run: () => goTo(c.name),
      })),
      ...definition.queries.map((q) => ({
        id: `q:${q.name}`,
        label: q.name,
        group: 'Code' as const,
        hint: q.kind === 'js' ? 'JS query' : q.kind === 'library' ? 'Library query' : 'Query',
        run: () => goTo(q.name),
      })),
      ...(definition.transformers ?? []).map((t) => ({
        id: `t:${t.name}`,
        label: t.name,
        group: 'Code' as const,
        hint: 'Transformer',
        run: () => goTo(t.name),
      })),
      ...(definition.variables ?? []).map((v) => ({
        id: `v:${v.name}`,
        label: v.name,
        group: 'Code' as const,
        hint: 'Variable',
        run: () => goTo(v.name),
      })),
      ...(definition.pages ?? []).map((p) => ({
        id: `p:${p.name}`,
        label: p.title || p.name,
        group: 'Pages' as const,
        hint: p.name,
        run: () => {
          s().setUrl(p.name)
          s().select(null)
        },
      })),
    ]
    const adding: PaletteItem[] = readOnly
      ? []
      : [
          ...PALETTE_GROUPS.flatMap((g) => g.types)
            .filter((type) => !(kind === 'module' && type === 'navigation'))
            .map((type) => ({
              id: `add:${type}`,
              label: `Add a ${COMPONENTS[type]!.label.toLowerCase()}`,
              group: 'Actions' as const,
              hint: 'Component',
              run: edit((def) => addComponent(def, type, placement()), false),
            })),
          {
            id: 'add:resource',
            label: 'Add a resource query',
            group: 'Actions',
            run: edit((def) => addQuery(def, 'resource', { page }), true),
          },
          {
            id: 'add:js',
            label: 'Add a JS query',
            group: 'Actions',
            run: edit((def) => addQuery(def, 'js', { page }), true),
          },
          {
            id: 'add:transformer',
            label: 'Add a transformer',
            group: 'Actions',
            run: edit((def) => addTransformer(def, { page }), true),
          },
          { id: 'add:variable', label: 'Add a variable', group: 'Actions', run: edit(addVariable, true) },
          ...(kind === 'app'
            ? [
                {
                  id: 'add:page',
                  label: 'Add a page',
                  group: 'Actions' as const,
                  run: () => {
                    const made = addPage(s().definition)
                    s().update(() => made.definition)
                    s().setUrl(made.name)
                    s().select(null)
                  },
                },
              ]
            : []),
        ]
    const shell: PaletteItem[] = [
      ...panels.map(([panel, label]) => ({
        id: `panel:${panel}`,
        label,
        group: 'Actions' as const,
        run: () => s().setLeftPanel(panel),
      })),
      {
        id: 'inspector',
        label: 'Show or hide the inspector',
        group: 'Actions',
        hint: '⌘U',
        run: () => s().setInspectorOpen(!s().inspectorOpen),
      },
      {
        id: 'problems',
        label: 'Show the problems',
        group: 'Actions',
        run: () => s().setDebugTab('problems'),
      },
      { id: 'console', label: 'Show the console', group: 'Actions', run: () => s().setDebugTab('console') },
      { id: 'preview', label: 'Preview the app', group: 'Actions', run: actions.preview },
      {
        id: 'restart',
        label: 'Reset the app state',
        group: 'Actions',
        hint: 'Restarts the app',
        run: actions.restart,
      },
    ]
    return [...go, ...adding, ...shell]
  }, [definition, readOnly, kind, actions])

  const shown = useMemo(() => {
    // Without a query: everything but the one-per-type "Add a …" component actions (the palette has those).
    if (!query.trim())
      return items.filter((i) => !(i.id.startsWith('add:') && i.hint === 'Component')).slice(0, 80)
    return items
      .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
      .filter((x): x is { item: PaletteItem; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.item)
  }, [items, query])
  // Grouped in a fixed order; with a query, the best match first as the top result.
  const ordered = useMemo(() => {
    if (!shown.length) return []
    const top = query.trim() ? [{ title: 'Top result', items: [shown[0]!] }] : []
    const rest = query.trim() ? shown.slice(1) : shown
    const groups = (['Components', 'Code', 'Pages', 'Actions'] as const)
      .map((title) => ({ title, items: rest.filter((i) => i.group === title) }))
      .filter((g) => g.items.length)
    return [...top, ...groups]
  }, [shown, query])
  const flat = ordered.flatMap((g) => g.items)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the option moved to with the keys scrolls into view
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes the palette; Escape too */}
      <div className="absolute inset-0" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative flex max-h-[70vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-xl bg-surface shadow-menu"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-muted" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette opens to be typed in
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={flat[active] ? `cmd-${flat[active]!.id}` : undefined}
            aria-label="Search components, code, pages and actions"
            placeholder="Jump to a component, query or page, or run an action"
            className="h-12 flex-1 bg-transparent text-sm outline-none"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(flat.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(flat[active])
              }
            }}
          />
          <kbd className="rounded border border-border px-1.5 font-mono text-[11px] text-muted">esc</kbd>
        </div>
        <div
          ref={list}
          id="command-palette-list"
          role="listbox"
          aria-label="Results"
          className="overflow-y-auto p-2"
        >
          {!flat.length && <p className="px-2 py-3 text-sm text-muted">Nothing matches “{query}”.</p>}
          {ordered.map((group) => (
            <div key={group.title}>
              <div aria-hidden className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted">
                {group.title}
              </div>
              {group.items.map((item) => {
                const index = flat.indexOf(item)
                return (
                  <div
                    key={`${group.title}:${item.id}`}
                    id={index === active ? `cmd-${item.id}` : undefined}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    onMouseMove={() => setActive(index)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(item)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') choose(item)
                    }}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                      index === active && 'bg-accent-soft',
                    )}
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        item.group !== 'Actions' && 'font-mono text-xs',
                      )}
                    >
                      {item.label}
                    </span>
                    {item.hint && <span className="shrink-0 text-xs text-muted">{item.hint}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
