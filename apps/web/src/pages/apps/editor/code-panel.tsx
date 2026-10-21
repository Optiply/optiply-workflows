import {
  type AppQuery,
  addQuery,
  addTransformer,
  addVariable,
  type JsonValue,
  type LibraryAppQuery,
  removeCode,
  setEntityPage,
  setHandlers,
  updateQuery,
  updateTransformer,
  updateVariable,
} from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import {
  Braces,
  Code2,
  Database,
  Library,
  Loader2,
  Play,
  Trash2,
  Variable as VariableIcon,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button, Checkbox, Input, Select, sectionLabelClass } from '@/components/ui'
import { isSqlType } from '@/lib/resource-types'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { useAppHostContext, useAppHostState, useAppValue } from '../runtime/react'
import { AppCodeField, EditorField, NameField, problemsAt, useParsedText, ValuePreview } from './fields'
import { HandlersEditor } from './handlers'
import { PageSelect } from './inspector'
import { AddLibraryQueryDialog, LibraryQueryBody, LibraryQueryHeader } from './library'
import { type PanelTab, useAppEditor } from './store'

/** The bottom panel: queries, transformers and variables; the app's state; problems; the console. */
export function CodePanel() {
  const tab = useAppEditor((s) => s.panelTab)
  const setTab = useAppEditor((s) => s.setPanelTab)
  const problems = useAppEditor((s) => s.diagnostics.filter((d) => d.severity === 'error').length)
  const logs = useAppHostState((s) => s.logs.length)
  const tabs: { id: PanelTab; label: string }[] = [
    { id: 'code', label: 'Code' },
    { id: 'state', label: 'State' },
    { id: 'problems', label: problems ? `Problems (${problems})` : 'Problems' },
    { id: 'console', label: logs ? `Console (${logs})` : 'Console' },
  ]
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div role="tablist" className="flex gap-1 border-b border-border px-2">
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
      <div className="min-h-0 flex-1">
        {tab === 'code' && <CodeTab />}
        {tab === 'state' && <StateTab />}
        {tab === 'problems' && <ProblemsTab />}
        {tab === 'console' && <ConsoleTab />}
      </div>
    </div>
  )
}

function CodeTab() {
  const definition = useAppEditor((s) => s.definition)
  const open = useAppEditor((s) => s.openCode)
  const openItem = useAppEditor((s) => s.openCodeItem)
  const update = useAppEditor((s) => s.update)
  const add = (make: (def: typeof definition) => { definition: typeof definition; name: string }) => {
    const made = make(useAppEditor.getState().definition)
    update(() => made.definition)
    openItem(made.name)
  }
  // New queries and transformers go on the page being edited.
  const page = useAppEditor((s) => (s.definition.pages?.length ? s.url.page : null))
  const [picking, setPicking] = useState(false)
  const query = definition.queries.find((q) => q.name === open)
  const transformer = definition.transformers?.find((t) => t.name === open)
  const variable = definition.variables?.find((v) => v.name === open)

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-2 text-sm">
        <ListSection
          title="Queries"
          actions={
            <>
              <Button
                size="icon"
                variant="ghost"
                title="Add a resource query"
                onClick={() => add((d) => addQuery(d, 'resource', { page }))}
              >
                <Database className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Add a JS query"
                onClick={() => add((d) => addQuery(d, 'js', { page }))}
              >
                <Code2 className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Add a query from the library"
                onClick={() => setPicking(true)}
              >
                <Library className="size-3.5" />
              </Button>
              {picking && <AddLibraryQueryDialog page={page} onAdd={add} onClose={() => setPicking(false)} />}
            </>
          }
        >
          {definition.queries.map((q) => (
            <ListItem
              key={q.name}
              name={q.name}
              open={open === q.name}
              onOpen={() => openItem(q.name)}
              page={q.page}
              query
            />
          ))}
        </ListSection>
        <ListSection
          title="Transformers"
          actions={
            <Button
              size="icon"
              variant="ghost"
              title="Add a transformer"
              onClick={() => add((d) => addTransformer(d, { page }))}
            >
              <Braces className="size-3.5" />
            </Button>
          }
        >
          {definition.transformers?.map((t) => (
            <ListItem
              key={t.name}
              name={t.name}
              open={open === t.name}
              onOpen={() => openItem(t.name)}
              page={t.page}
            />
          ))}
        </ListSection>
        <ListSection
          title="Variables"
          actions={
            <Button size="icon" variant="ghost" title="Add a variable" onClick={() => add(addVariable)}>
              <VariableIcon className="size-3.5" />
            </Button>
          }
        >
          {definition.variables?.map((v) => (
            <ListItem key={v.name} name={v.name} open={open === v.name} onOpen={() => openItem(v.name)} />
          ))}
        </ListSection>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-3">
        {query && <QueryEditor query={query} />}
        {transformer && <TransformerEditor name={transformer.name} />}
        {variable && <VariableEditor name={variable.name} />}
        {!query && !transformer && !variable && (
          <p className="text-sm text-muted">
            Add a query to read or change data, a transformer to reshape it, or a variable to hold state.
          </p>
        )}
      </div>
    </div>
  )
}

function ListSection({
  title,
  actions,
  children,
}: {
  title: string
  actions: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="flex items-center gap-1 px-1">
        <h3 className={cn('flex-1', sectionLabelClass)}>{title}</h3>
        {actions}
      </div>
      <ul className="mt-1 flex flex-col">{children}</ul>
    </section>
  )
}

function ListItem({
  name,
  open,
  onOpen,
  page,
  query,
}: {
  name: string
  open: boolean
  onOpen: () => void
  /** The page it's on, if it's on one. */
  page?: string
  query?: boolean
}) {
  const fetching = useAppValue<boolean>(`${name}.isFetching`)
  const failed = useAppValue<unknown>(`${name}.error`) != null
  const problems = useAppEditor((s) => s.diagnostics.some((d) => d.entity === name && d.severity === 'error'))
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs',
          open ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-canvas hover:text-ink',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {page && (
          <span className="text-[10px] text-muted" title={`On page ${page}`}>
            {page}
          </span>
        )}
        {query && fetching && <Loader2 className="size-3 animate-spin" />}
        {(problems || (query && failed)) && (
          <span className="size-1.5 rounded-full bg-danger" title="Has problems" />
        )}
      </button>
    </li>
  )
}

/** Sends the current draft to the sandbox and runs the query (the host saves the draft first). */
function useRunQuery() {
  const host = useAppHostContext()
  return (name: string) => {
    host.update(useAppEditor.getState().definition)
    host.trigger(name)
  }
}

function QueryEditor({ query }: { query: AppQuery }) {
  const trpc = useTRPC()
  const resources = useQuery(trpc.resources.list.queryOptions())
  const definition = useAppEditor((s) => s.definition)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const update = useAppEditor((s) => s.update)
  const openItem = useAppEditor((s) => s.openCodeItem)
  const run = useRunQuery()
  const index = definition.queries.findIndex((q) => q.name === query.name)
  const base = ['queries', index]
  const edit = (change: (q: AppQuery) => AppQuery) => update((def) => updateQuery(def, query.name, change))
  const editLibrary = (change: (q: LibraryAppQuery) => LibraryAppQuery) =>
    edit((q) => (q.kind === 'library' ? change(q) : q))
  const resource =
    query.kind === 'resource' ? resources.data?.resources.find((r) => r.slug === query.resource) : undefined
  const sql = query.kind === 'resource' && (resource ? isSqlType(resource.type) : 'sql' in query.query)
  /** Sets or (empty) removes an optional field. */
  const optional = <K extends 'confirm' | 'disabled' | 'transform'>(key: K, value: string) =>
    edit((q) => {
      const { [key]: _, ...rest } = q
      return (value.trim() ? { ...rest, [key]: value } : rest) as AppQuery
    })

  return (
    <div className="flex flex-col gap-3" data-testid={`query-${query.name}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-56 shrink-0">
          <NameField name={query.name} onRenamed={openItem} />
        </div>
        <CodePage name={query.name} page={query.page} />
        {query.kind === 'resource' ? (
          <>
            <Select
              aria-label="Resource"
              className="w-56"
              value={query.resource}
              onChange={(e) => edit((q) => ({ ...q, resource: e.target.value }))}
            >
              {!resources.data?.resources.some((r) => r.slug === query.resource) && (
                <option value={query.resource}>{query.resource}</option>
              )}
              {resources.data?.resources.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.name}
                  {r.systemKind ? ' · built-in' : ''}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Run"
              className="w-56"
              value={query.run}
              onChange={(e) => edit((q) => ({ ...q, run: e.target.value as 'auto' | 'manual' }))}
            >
              <option value="auto">Run automatically when inputs change</option>
              <option value="manual">Run only when triggered</option>
            </Select>
          </>
        ) : query.kind === 'library' ? (
          <LibraryQueryHeader query={query} edit={editLibrary} />
        ) : (
          <span className="self-center text-xs text-muted">JavaScript, run in the browser</span>
        )}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="primary" onClick={() => run(query.name)}>
            <Play className="size-3.5" /> Run
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Delete query"
            onClick={() => {
              update((def) => removeCode(def, query.name))
              openItem(null)
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {query.kind === 'resource' ? (
        sql ? (
          <AppCodeField
            path={[...base, 'query', 'sql']}
            language="sql"
            height={140}
            value={String(query.query.sql ?? '')}
            problems={problemsAt(diagnostics, [...base, 'query'])}
            onChange={(text) =>
              edit((q) => (q.kind === 'resource' ? { ...q, query: { ...q.query, sql: text } } : q))
            }
          />
        ) : (
          <JsonQueryField
            query={query}
            path={[...base, 'query']}
            onChange={(next) => edit((q) => (q.kind === 'resource' ? { ...q, query: next } : q))}
          />
        )
      ) : query.kind === 'js' ? (
        <AppCodeField
          path={[...base, 'code']}
          language="javascript"
          height={140}
          value={query.code}
          problems={problemsAt(diagnostics, [...base, 'code'])}
          onChange={(code) => edit((q) => (q.kind === 'js' ? { ...q, code } : q))}
        />
      ) : (
        <LibraryQueryBody query={query} base={base} edit={editLibrary} />
      )}

      <QueryResult name={query.name} />

      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Advanced</summary>
        <div className="flex flex-col gap-3 border-t border-border p-3">
          {(query.kind === 'js' || query.run === 'manual') && (
            <Checkbox
              label="Also run when the app opens"
              checked={query.runOnLoad ?? false}
              onChange={(e) =>
                edit((q) => {
                  const { runOnLoad: _, ...rest } = q
                  return (e.target.checked ? { ...rest, runOnLoad: true } : rest) as AppQuery
                })
              }
            />
          )}
          <EditorField label="Ask to confirm" hint="A message ({{ }} allowed); empty runs without asking">
            <AppCodeField
              path={[...base, 'confirm']}
              language="plaintext"
              singleLine
              height={30}
              value={query.confirm ?? ''}
              problems={problemsAt(diagnostics, [...base, 'confirm'])}
              onChange={(v) => optional('confirm', v)}
              removeEmpty
            />
          </EditorField>
          <EditorField label="Disabled when" hint="A {{ }} template; while truthy, the query doesn't run">
            <AppCodeField
              path={[...base, 'disabled']}
              language="plaintext"
              singleLine
              height={30}
              value={query.disabled ?? ''}
              problems={problemsAt(diagnostics, [...base, 'disabled'])}
              onChange={(v) => optional('disabled', v)}
              removeEmpty
            />
          </EditorField>
          <EditorField
            label="Transform the result"
            hint="JavaScript with the result as data; return the new data"
          >
            <AppCodeField
              path={[...base, 'transform']}
              language="javascript"
              height={80}
              value={query.transform ?? ''}
              problems={problemsAt(diagnostics, [...base, 'transform'])}
              onChange={(v) => optional('transform', v)}
              removeEmpty
            />
          </EditorField>
          <EditorField label="Timeout (ms)">
            <Input
              type="number"
              min={100}
              className="h-8 w-40"
              value={query.timeoutMs ?? ''}
              placeholder="120000"
              onChange={(e) =>
                edit((q) => {
                  const { timeoutMs: _, ...rest } = q
                  const n = Math.round(Number(e.target.value))
                  return (
                    e.target.value && n >= 100 ? { ...rest, timeoutMs: Math.min(n, 600_000) } : rest
                  ) as AppQuery
                })
              }
            />
          </EditorField>
        </div>
      </details>

      <section className="flex flex-col gap-2">
        <h3 className={sectionLabelClass}>Event handlers</h3>
        <HandlersEditor
          handlers={query.events ?? []}
          events={['success', 'failure']}
          base={[...base, 'events']}
          onChange={(events) => update((def) => setHandlers(def, query.name, events))}
        />
      </section>
    </div>
  )
}

/** A non-SQL connector's query (REST) as JSON; strings in it are templates. */
function JsonQueryField({
  query,
  path,
  onChange,
}: {
  query: Extract<AppQuery, { kind: 'resource' }>
  path: (string | number)[]
  onChange: (next: Record<string, JsonValue>) => void
}) {
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const [text, setText] = useState(() => JSON.stringify(query.query, null, 2))
  const [error, setError] = useState<string | null>(null)
  return (
    <EditorField
      label="Request"
      hint='The connector’s query as JSON, e.g. {"method": "GET", "path": "/orders/{{ id.value }}"}'
    >
      <AppCodeField
        path={path}
        // The query as JSON, parsed into it: not bound to a shared text.
        bind={false}
        language="json"
        height={140}
        value={text}
        problems={problemsAt(diagnostics, path)}
        onChange={(next) => {
          setText(next)
          try {
            const parsed = JSON.parse(next) as unknown
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error('Expected an object')
            setError(null)
            onChange(parsed as Record<string, JsonValue>)
          } catch (err) {
            setError((err as Error).message)
          }
        }}
      />
      {error && <span className="text-xs text-danger">{error}</span>}
    </EditorField>
  )
}

function QueryResult({ name }: { name: string }) {
  const data = useAppValue(`${name}.data`)
  const error = useAppValue<{ message: string } | null>(`${name}.error`)
  const fetching = useAppValue<boolean>(`${name}.isFetching`)
  const lastRunAt = useAppValue<string | null>(`${name}.lastRunAt`)
  return (
    <div className="flex flex-col gap-1" data-testid={`result-${name}`}>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-medium text-ink">Result</span>
        {fetching && (
          <span className="flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> running
          </span>
        )}
        {lastRunAt && !fetching && <span>at {new Date(lastRunAt).toLocaleTimeString()}</span>}
        {Array.isArray(data) && <span>· {data.length} rows</span>}
      </div>
      {error ? (
        <div role="alert" className="rounded-md bg-danger/5 p-2 text-xs text-danger">
          {error.message}
        </div>
      ) : (
        <ValuePreview value={data} className="max-h-48" />
      )}
    </div>
  )
}

function TransformerEditor({ name }: { name: string }) {
  const definition = useAppEditor((s) => s.definition)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const update = useAppEditor((s) => s.update)
  const openItem = useAppEditor((s) => s.openCodeItem)
  const value = useAppValue(`${name}.value`)
  const error = useAppHostState((s) => s.errors[`${name}.value`])
  const index = (definition.transformers ?? []).findIndex((t) => t.name === name)
  const transformer = definition.transformers![index]!
  return (
    <div className="flex flex-col gap-3" data-testid={`transformer-${name}`}>
      <div className="flex items-start gap-2">
        <div className="w-56 shrink-0">
          <NameField name={name} onRenamed={openItem} />
        </div>
        <CodePage name={name} page={transformer.page} />
        <span className="self-center text-xs text-muted">
          Re-evaluated whenever what it reads changes; return its value
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto"
          title="Delete transformer"
          onClick={() => {
            update((def) => removeCode(def, name))
            openItem(null)
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <AppCodeField
        path={['transformers', index, 'code']}
        language="javascript"
        height={160}
        value={transformer.code}
        problems={problemsAt(diagnostics, ['transformers', index, 'code'])}
        onChange={(code) => update((def) => updateTransformer(def, name, (t) => ({ ...t, code })))}
      />
      {error ? (
        <div className="rounded-md bg-danger/5 p-2 text-xs text-danger">{error}</div>
      ) : (
        <ValuePreview value={value} className="max-h-48" />
      )}
    </div>
  )
}

function VariableEditor({ name }: { name: string }) {
  const definition = useAppEditor((s) => s.definition)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const update = useAppEditor((s) => s.update)
  const openItem = useAppEditor((s) => s.openCodeItem)
  const value = useAppValue(`${name}.value`)
  const index = (definition.variables ?? []).findIndex((v) => v.name === name)
  const variable = definition.variables![index]!
  const initial = variable.initialValue
  return (
    <div className="flex flex-col gap-3" data-testid={`variable-${name}`}>
      <div className="flex items-start gap-2">
        <div className="w-56 shrink-0">
          <NameField name={name} onRenamed={openItem} />
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto"
          title="Delete variable"
          onClick={() => {
            update((def) => removeCode(def, name))
            openItem(null)
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <EditorField label="Initial value" hint="Evaluated when the app opens: text, JSON or a {{ }} template">
        <InitialValueField
          index={index}
          value={initial}
          problems={problemsAt(diagnostics, ['variables', index, 'initialValue'])}
          onChange={(next) =>
            update((def) =>
              updateVariable(def, name, (v) => {
                const { initialValue: _, ...rest } = v
                return next === undefined ? rest : { ...rest, initialValue: next }
              }),
            )
          }
        />
      </EditorField>
      <EditorField label="Current value">
        <ValuePreview value={value} className="max-h-48" />
      </EditorField>
    </div>
  )
}

/** A variable's initial value: JSON when it parses (and has no {{ }}), text otherwise; kept as typed. */
function InitialValueField({
  index,
  value,
  problems,
  onChange,
}: {
  index: number
  value: JsonValue | undefined
  problems: ReturnType<typeof problemsAt>
  onChange: (value: JsonValue | undefined) => void
}) {
  const [text, setText] = useParsedText(
    value,
    (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)),
    (t): JsonValue | undefined => {
      if (!t.trim()) return undefined
      if (!t.includes('{{')) {
        try {
          return JSON.parse(t) as JsonValue
        } catch {
          // Plain text.
        }
      }
      return t
    },
    onChange,
  )
  return (
    <AppCodeField
      path={['variables', index, 'initialValue']}
      // Parsed into the initial value: not bound to a shared text.
      bind={false}
      language="plaintext"
      singleLine
      height={30}
      value={text}
      problems={problems}
      onChange={setText}
    />
  )
}

/** Every value of the app, by component, query, transformer and variable. */
function StateTab() {
  const values = useAppHostState((s) => s.values)
  const errors = useAppHostState((s) => s.errors)
  const [filter, setFilter] = useState('')
  const byEntity = new Map<string, Record<string, unknown>>()
  for (const [key, value] of Object.entries(values)) {
    const dot = key.indexOf('.')
    const entity = key.slice(0, dot)
    if (filter && !entity.toLowerCase().includes(filter.toLowerCase())) continue
    byEntity.set(entity, { ...byEntity.get(entity), [key.slice(dot + 1)]: value })
  }
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <Input
        aria-label="Filter state"
        placeholder="Filter by name"
        className="h-8 w-64"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {[...byEntity.entries()].map(([entity, state]) => (
        <details key={entity} className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-1.5 font-mono text-xs">
            {entity}
            {Object.keys(errors).some((k) => k.startsWith(`${entity}.`)) && (
              <span className="ml-2 text-danger">has errors</span>
            )}
          </summary>
          <ValuePreview value={state} className="m-2 max-h-72" />
        </details>
      ))}
    </div>
  )
}

function ProblemsTab() {
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const definition = useAppEditor((s) => s.definition)
  const select = useAppEditor((s) => s.select)
  const openItem = useAppEditor((s) => s.openCodeItem)
  if (!diagnostics.length) return <p className="p-3 text-sm text-muted">No problems.</p>
  return (
    <ul className="h-full overflow-y-auto p-2 text-xs">
      {diagnostics.map((d) => (
        <li key={`${d.path.join('.')}:${d.code}:${d.start ?? ''}:${d.message}`}>
          <button
            type="button"
            className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-canvas"
            onClick={() => {
              if (!d.entity) return
              if (definition.components.some((c) => c.name === d.entity)) select(d.entity)
              else openItem(d.entity)
            }}
          >
            <span
              className={cn(
                'mt-1 size-1.5 shrink-0 rounded-full',
                d.severity === 'error' ? 'bg-danger' : 'bg-warning',
              )}
            />
            <span className="font-mono text-muted">{d.entity ?? d.path.join('.')}</span>
            <span>{d.message}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ConsoleTab() {
  const logs = useAppHostState((s) => s.logs)
  if (!logs.length)
    return <p className="p-3 text-sm text-muted">Nothing logged yet. console.log in scripts shows here.</p>
  return (
    <ol className="h-full overflow-y-auto p-2 font-mono text-xs">
      {logs.map((l) => (
        <li
          key={l.id}
          className={cn(
            'border-b border-border/60 px-1 py-0.5',
            l.level === 'error' && 'text-danger',
            l.level === 'warn' && 'text-warning-strong',
          )}
        >
          <span className="mr-2 text-muted">{new Date(l.at).toLocaleTimeString()}</span>
          {l.message}
        </li>
      ))}
    </ol>
  )
}

/** A query's or transformer's page, in an app with pages: one of them, or every page. */
function CodePage({ name, page }: { name: string; page?: string }) {
  const pages = useAppEditor((s) => s.definition.pages)
  const update = useAppEditor((s) => s.update)
  if (!pages?.length) return null
  return (
    <PageSelect
      className="w-40"
      value={page ?? null}
      onChange={(to) => update((def) => setEntityPage(def, name, to))}
    />
  )
}
