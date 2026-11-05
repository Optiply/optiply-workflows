import {
  Braces,
  Code2,
  Files,
  ListTree,
  Loader2,
  type LucideIcon,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
  Plus,
  Puzzle,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { Button, sectionLabelClass } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAppHostState } from '../runtime/react'
import { AppSettingsPanel } from './app-settings'
import { ComponentTree, Palette } from './canvas'
import { CodeList, ConsoleList, OpenCode, ProblemsList, StatePanel } from './code-panel'
import { AddCustomComponent } from './custom'
import { ModulePanel } from './module-panel'
import { AddModule } from './modules'
import { DependencyGraph, SearchPanel } from './navigate'
import { PagesPanel } from './pages'
import { type DebugTab, type LeftPanel, useAppEditor } from './store'

/*
 * The editor's frame around the canvas (session 41, after Retool's): an icon rail picking one left panel at a time,
 * the open code item docked beside it, a debug drawer and a status bar under everything.
 */

interface RailItem {
  id: LeftPanel
  label: string
  icon: LucideIcon
}

function railItems(kind: 'app' | 'module'): RailItem[] {
  return [
    { id: 'components', label: 'Add components', icon: Plus },
    kind === 'module'
      ? { id: 'pages', label: 'Module', icon: Puzzle }
      : { id: 'pages', label: 'Pages', icon: Files },
    { id: 'tree', label: 'Component tree', icon: ListTree },
    { id: 'code', label: 'Code', icon: Code2 },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'state', label: 'State', icon: Braces },
    // A module takes the look of the app it's placed in.
    ...(kind === 'app' ? [{ id: 'settings' as const, label: 'App settings', icon: Settings }] : []),
  ]
}

/** The rail: a panel's icon opens it; the open one's closes it. */
export function Rail({ kind }: { kind: 'app' | 'module' }) {
  const open = useAppEditor((s) => s.leftPanel)
  const setOpen = useAppEditor((s) => s.setLeftPanel)
  const codeProblems = useAppEditor((s) => {
    const code = new Set([
      ...s.definition.queries.map((q) => q.name),
      ...(s.definition.transformers ?? []).map((t) => t.name),
      ...(s.definition.variables ?? []).map((v) => v.name),
    ])
    return s.diagnostics.some((d) => d.severity === 'error' && !!d.entity && code.has(d.entity))
  })
  return (
    <div
      role="tablist"
      aria-label="Editor panels"
      aria-orientation="vertical"
      className="flex w-11 shrink-0 flex-col items-center gap-1 rounded-lg bg-surface py-2"
    >
      {railItems(kind).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={open === id}
          aria-label={label}
          title={label}
          onClick={() => setOpen(open === id ? null : id)}
          className={cn(
            'relative flex size-8 items-center justify-center rounded-md',
            open === id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-canvas hover:text-ink',
          )}
        >
          <Icon className="size-4" />
          {id === 'code' && codeProblems && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-danger" />
          )}
        </button>
      ))}
    </div>
  )
}

/** The rail's open panel, as wide as it was left. */
export function LeftPanelArea({ kind }: { kind: 'app' | 'module' }) {
  const panel = useAppEditor((s) => s.leftPanel)
  const readOnly = useAppEditor((s) => s.readOnly)
  // After an undo or redo, panels start again from the definition (some read it once).
  const epoch = useAppEditor((s) => s.epoch)
  const [width, handle] = useStoredWidth('ow.appEditor.leftWidth', 272, 220, 520)
  if (!panel) return null
  const titled = (title: string, body: ReactNode) => (
    <>
      <h2 className={cn('mb-2', sectionLabelClass)}>{title}</h2>
      {body}
    </>
  )
  return (
    <aside
      aria-label="Left panel"
      style={{ width }}
      className="relative flex shrink-0 flex-col overflow-hidden rounded-lg bg-surface"
    >
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
        {panel === 'components' &&
          titled(
            'Components',
            readOnly ? (
              <p className="text-xs text-muted">This draft is read-only.</p>
            ) : (
              <>
                <Palette />
                <section aria-label="Reusable" className="mt-3">
                  <h3 className="mb-1.5 px-0.5 text-[11px] font-medium text-muted">Reusable</h3>
                  {/* Modules inside modules too (M21), as deep as the limit allows. */}
                  <AddModule />
                  <div className="mt-1.5">
                    <AddCustomComponent />
                  </div>
                  <p className="mt-2 px-0.5 text-[11px] text-muted">
                    Can’t find what you need? Build your own React components in a component library.
                  </p>
                </section>
              </>
            ),
          )}
        {panel === 'pages' && (kind === 'app' ? <PagesPanel key={epoch} /> : <ModulePanel key={epoch} />)}
        {panel === 'tree' && titled('Component tree', <ComponentTree />)}
        {panel === 'code' && <CodeList key={epoch} />}
        {panel === 'search' && titled('Search', <SearchPanel />)}
        {panel === 'state' && titled('State', <StatePanel />)}
        {panel === 'settings' && kind === 'app' && titled('App settings', <AppSettingsPanel />)}
      </div>
      {/* What the selection reads and is read by (Retool docks it under these two). */}
      {(panel === 'tree' || panel === 'code') && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border p-3">
          <DependencyGraph />
        </div>
      )}
      <ResizeHandle {...handle} side="right" label="Resize the panel" />
    </aside>
  )
}

/** The open query, transformer or variable, docked between the left panel and the canvas. */
export function CodeDock() {
  const open = useAppEditor((s) => s.openCode)
  const close = useAppEditor((s) => s.openCodeItem)
  const epoch = useAppEditor((s) => s.epoch)
  const [width, handle] = useStoredWidth('ow.appEditor.codeWidth', 560, 380, 960)
  if (!open) return null
  return (
    <section
      aria-label="Code editor"
      style={{ width }}
      className="relative flex shrink-0 flex-col overflow-hidden rounded-lg bg-surface"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
        <Code2 className="size-3.5 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{open}</span>
        <Button size="icon" variant="ghost" title="Close the code editor" onClick={() => close(null)}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <OpenCode key={epoch} />
      </div>
      <ResizeHandle {...handle} side="right" label="Resize the code editor" />
    </section>
  )
}

/** Problems and the console, in a drawer above the status bar. */
export function DebugDrawer() {
  const tab = useAppEditor((s) => s.debugTab)
  const setTab = useAppEditor((s) => s.setDebugTab)
  const counts = useDebugCounts()
  const [height, handle] = useStoredWidth('ow.appEditor.debugHeight', 240, 120, 640)
  if (!tab) return null
  const tabs: { id: DebugTab; label: string }[] = [
    { id: 'problems', label: counts.problems ? `Problems (${counts.problems})` : 'Problems' },
    { id: 'console', label: counts.logs ? `Console (${counts.logs})` : 'Console' },
  ]
  return (
    <section
      aria-label="Debug"
      style={{ height }}
      className="relative flex shrink-0 flex-col overflow-hidden rounded-lg bg-surface"
    >
      <ResizeHandle {...handle} side="top" label="Resize the debug drawer" />
      <div className="flex shrink-0 items-center border-b border-border pr-1 pl-2">
        <div role="tablist" aria-label="Debug" className="flex flex-1 gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-xs font-medium',
                tab === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Button size="icon" variant="ghost" title="Close the debug drawer" onClick={() => setTab(null)}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'problems' ? <ProblemsList /> : <ConsoleList />}
      </div>
    </section>
  )
}

function useDebugCounts() {
  const problems = useAppEditor((s) => s.diagnostics.filter((d) => d.severity === 'error').length)
  const logs = useAppHostState((s) => s.logs.length)
  return { problems, logs }
}

/** Under everything: the environment, the queries running, and the debug drawer's buttons. */
export function StatusBar({ environment, branch }: { environment: string; branch: string | null }) {
  const values = useAppHostState((s) => s.values)
  const running = useMemo(
    () =>
      Object.entries(values)
        .filter(([key, value]) => key.endsWith('.isFetching') && value === true)
        .map(([key]) => key.slice(0, -'.isFetching'.length)),
    [values],
  )
  const tab = useAppEditor((s) => s.debugTab)
  const setTab = useAppEditor((s) => s.setDebugTab)
  const counts = useDebugCounts()
  const toggle = (to: DebugTab) => setTab(tab === to ? null : to)
  return (
    <footer
      data-testid="status-bar"
      className="flex h-8 shrink-0 items-center gap-4 rounded-lg bg-surface px-3 text-xs text-muted"
    >
      <span className="flex items-center gap-1.5" title="The environment the draft runs against">
        <PanelsTopLeft className="size-3.5" />
        {environment}
      </span>
      {branch && <span className="font-mono">{branch}</span>}
      <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5" aria-live="polite">
        {running.length ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            <span className="truncate">
              Running {running.length === 1 ? running[0] : `${running.length} queries`}
            </span>
          </>
        ) : (
          'No queries running'
        )}
      </span>
      <button
        type="button"
        aria-pressed={tab === 'problems'}
        onClick={() => toggle('problems')}
        className={cn(
          'flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-canvas hover:text-ink',
          counts.problems > 0 && 'text-danger',
        )}
      >
        <span className={cn('size-1.5 rounded-full', counts.problems ? 'bg-danger' : 'bg-success')} />
        {counts.problems ? `${counts.problems} problem${counts.problems === 1 ? '' : 's'}` : 'No problems'}
      </button>
      <InspectorToggle />
      <button
        type="button"
        aria-pressed={tab === 'console'}
        onClick={() => toggle('console')}
        className="rounded px-1.5 py-0.5 hover:bg-canvas hover:text-ink"
      >
        Console{counts.logs ? ` (${counts.logs})` : ''}
      </button>
    </footer>
  )
}

/** Shows and hides the inspector (⌘U). */
function InspectorToggle() {
  const open = useAppEditor((s) => s.inspectorOpen)
  const setOpen = useAppEditor((s) => s.setInspectorOpen)
  return (
    <button
      type="button"
      aria-pressed={open}
      title={open ? 'Hide the inspector (⌘U)' : 'Show the inspector (⌘U)'}
      onClick={() => setOpen(!open)}
      className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-canvas hover:text-ink"
    >
      {open ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
      Inspector
    </button>
  )
}

/** A width (or height) the person drags, remembered per browser. */
function useStoredWidth(key: string, fallback: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key))
      return stored >= min && stored <= max ? stored : fallback
    } catch {
      return fallback
    }
  })
  const latest = useRef(size)
  latest.current = size
  const onResize = useCallback(
    (next: number, done: boolean) => {
      const clamped = Math.min(max, Math.max(min, Math.round(next)))
      setSize(clamped)
      if (done)
        try {
          localStorage.setItem(key, String(clamped))
        } catch {
          // Not remembered: private windows may refuse storage.
        }
    },
    [key, min, max],
  )
  return [size, { size: latest, onResize }] as const
}

/** A drag handle on a panel's edge. */
function ResizeHandle({
  size,
  onResize,
  side,
  label,
}: {
  size: { current: number }
  onResize: (next: number, done: boolean) => void
  side: 'right' | 'top'
  label: string
}) {
  const horizontal = side === 'right'
  return (
    <div
      title={label}
      onPointerDown={(e) => {
        e.preventDefault()
        const target = e.currentTarget
        target.setPointerCapture(e.pointerId)
        const start = horizontal ? e.clientX : e.clientY
        const from = size.current
        const at = (ev: PointerEvent) => {
          const delta = (horizontal ? ev.clientX : ev.clientY) - start
          return horizontal ? from + delta : from - delta
        }
        const move = (ev: PointerEvent) => onResize(at(ev), false)
        const up = (ev: PointerEvent) => {
          onResize(at(ev), true)
          target.removeEventListener('pointermove', move)
          target.removeEventListener('pointerup', up)
        }
        target.addEventListener('pointermove', move)
        target.addEventListener('pointerup', up)
      }}
      className={cn(
        'absolute z-10 hover:bg-accent/40',
        horizontal
          ? 'top-0 right-0 h-full w-1.5 cursor-col-resize'
          : 'top-0 left-0 h-1.5 w-full cursor-row-resize',
      )}
    />
  )
}
