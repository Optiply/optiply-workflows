import { componentSpec, type EventHandler, type HandlerAction } from '@ow/app-definition'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Input, Select } from '@/components/ui'
import { AppCodeField, EditorField, ProblemList, problemsAt } from './fields'
import { useAppEditor } from './store'

const ACTIONS: { type: HandlerAction['type']; label: string }[] = [
  { type: 'controlQuery', label: 'Control query' },
  { type: 'controlComponent', label: 'Control component' },
  { type: 'setVariable', label: 'Set variable' },
  { type: 'runScript', label: 'Run script' },
  { type: 'notify', label: 'Show notification' },
  { type: 'openPage', label: 'Go to page' },
  { type: 'openUrl', label: 'Open URL' },
  { type: 'setUrlParams', label: 'Set URL parameters' },
  { type: 'copyToClipboard', label: 'Copy to clipboard' },
  { type: 'download', label: 'Export data' },
  { type: 'setLocalStorage', label: 'Set local storage' },
  { type: 'clearLocalStorage', label: 'Clear local storage' },
  // In a module only (M14).
  { type: 'moduleEvent', label: 'Fire module event' },
]

type Names = {
  queries: string[]
  components: string[]
  variables: string[]
  events: string[]
  pages: string[]
}

const newId = () => Math.random().toString(36).slice(2, 10)

/** A fresh action of a type, pointing at the first thing it can. */
function defaultAction(type: HandlerAction['type'], names: Names) {
  switch (type) {
    case 'controlQuery':
      return { type, query: names.queries[0] ?? 'query1', method: 'trigger' } as const
    case 'controlComponent':
      return { type, component: names.components[0] ?? 'component1', method: 'setHidden' } as const
    case 'setVariable':
      return { type, variable: names.variables[0] ?? 'variable1', value: '' } as const
    case 'runScript':
      return { type, code: '' } as const
    case 'notify':
      return { type, message: '' } as const
    case 'openUrl':
      return { type, url: '' } as const
    case 'moduleEvent':
      return { type, event: names.events[0] ?? 'event1' } as const
    case 'openPage':
      return { type, page: names.pages[0] ?? 'page1' } as const
    case 'setUrlParams':
      return { type, params: {} } as const
    case 'copyToClipboard':
      return { type, text: '' } as const
    case 'download':
      return { type, data: '', fileName: 'export.csv' } as const
    case 'setLocalStorage':
      return { type, key: 'key', value: '' } as const
    case 'clearLocalStorage':
      return { type } as const
  }
}

function describe(h: EventHandler): string {
  const a = h.action
  switch (a.type) {
    case 'controlQuery':
      return `${a.method} ${a.query}`
    case 'controlComponent':
      return `${a.component}.${a.method}()`
    case 'setVariable':
      return `set ${a.variable}`
    case 'runScript':
      return 'run script'
    case 'notify':
      return 'notify'
    case 'openUrl':
      return 'open URL'
    case 'moduleEvent':
      return `fire ${a.event}`
    case 'openPage':
      return `go to ${a.page}`
    case 'setUrlParams':
      return 'set URL parameters'
    case 'copyToClipboard':
      return 'copy to clipboard'
    case 'download':
      return 'export data'
    case 'setLocalStorage':
      return `store ${a.key}`
    case 'clearLocalStorage':
      return a.key ? `forget ${a.key}` : 'clear local storage'
  }
}

/**
 * The event handlers of a component or query. `base` is where they sit in the definition, for problems and
 * Monaco model paths.
 */
export function HandlersEditor({
  handlers,
  events,
  base,
  onChange,
}: {
  handlers: EventHandler[]
  events: readonly string[]
  base: (string | number)[]
  onChange: (next: EventHandler[]) => void
}) {
  const definition = useAppEditor((s) => s.definition)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const [open, setOpen] = useState<string | null>(null)
  const names: Names = {
    queries: definition.queries.map((q) => q.name),
    components: definition.components.map((c) => c.name),
    variables: (definition.variables ?? []).map((v) => v.name),
    events: (definition.module?.events ?? []).map((e) => e.name),
    pages: (definition.pages ?? []).map((p) => p.name),
  }
  const actions = ACTIONS.filter(
    (a) => (a.type !== 'moduleEvent' || definition.module) && (a.type !== 'openPage' || names.pages.length),
  )
  if (!events.length) return <p className="text-xs text-muted">This component has no events.</p>
  const replace = (i: number, next: EventHandler) => onChange(handlers.map((h, j) => (j === i ? next : h)))

  return (
    <div className="flex flex-col gap-2">
      {handlers.map((h, i) => {
        const expanded = open === h.id
        const at = [...base, i]
        return (
          <div key={h.id} className="rounded-md border border-border" data-testid={`handler-${h.event}-${i}`}>
            <div className="flex items-center gap-1 px-2 py-1.5">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                onClick={() => setOpen(expanded ? null : h.id)}
              >
                {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                <span className="font-medium">on {h.event}</span>
                <span className="truncate text-muted">→ {describe(h)}</span>
              </button>
              <Button
                size="icon"
                variant="ghost"
                title="Remove handler"
                onClick={() => onChange(handlers.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {expanded && (
              <div className="flex flex-col gap-3 border-t border-border p-2">
                <div className="grid grid-cols-2 gap-2">
                  <EditorField label="Event">
                    <Select
                      aria-label="Event"
                      value={h.event}
                      onChange={(e) => replace(i, { ...h, event: e.target.value })}
                    >
                      {events.map((ev) => (
                        <option key={ev}>{ev}</option>
                      ))}
                    </Select>
                  </EditorField>
                  <EditorField label="Action">
                    <Select
                      aria-label="Action"
                      value={h.action.type}
                      onChange={(e) =>
                        replace(i, {
                          ...h,
                          action: defaultAction(e.target.value as HandlerAction['type'], names),
                        })
                      }
                    >
                      {actions.map((a) => (
                        <option key={a.type} value={a.type}>
                          {a.label}
                        </option>
                      ))}
                    </Select>
                  </EditorField>
                </div>
                <ActionFields
                  action={h.action}
                  at={[...at, 'action']}
                  names={names}
                  onChange={(action) => replace(i, { ...h, action })}
                />
                <EditorField label="Only run when" hint="A {{ }} template; the handler runs when it's truthy">
                  <AppCodeField
                    path={[...at, 'onlyIf']}
                    removeEmpty
                    language="plaintext"
                    singleLine
                    height={30}
                    value={h.onlyIf ?? ''}
                    problems={problemsAt(diagnostics, [...at, 'onlyIf'])}
                    onChange={(v) => {
                      const { onlyIf: _, ...rest } = h
                      replace(i, v.trim() ? { ...rest, onlyIf: v } : rest)
                    }}
                  />
                </EditorField>
                <WaitFields handler={h} onChange={(next) => replace(i, next)} />
                <ProblemList path={[...at, 'event']} />
              </div>
            )}
          </div>
        )
      })}
      <Button
        size="sm"
        className="self-start"
        onClick={() => {
          const h: EventHandler = {
            id: newId(),
            event: events[0]!,
            action: defaultAction('controlQuery', names),
          }
          onChange([...handlers, h])
          setOpen(h.id)
        }}
      >
        <Plus className="size-3.5" /> Add handler
      </Button>
    </div>
  )
}

function ActionFields({
  action,
  at,
  names,
  onChange,
}: {
  action: HandlerAction
  at: (string | number)[]
  names: Names
  onChange: (next: HandlerAction) => void
}) {
  const definition = useAppEditor((s) => s.definition)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const template = (field: (string | number)[], label: string, value: string, set: (v: string) => void) => (
    <EditorField key={field.join('.')} label={label}>
      <AppCodeField
        path={[...at, ...field]}
        language="plaintext"
        singleLine
        height={30}
        value={value}
        problems={problemsAt(diagnostics, [...at, ...field])}
        onChange={set}
      />
    </EditorField>
  )
  const pick = (label: string, value: string, options: string[], set: (v: string) => void) => (
    <EditorField label={label}>
      <Select aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
        {!options.includes(value) && <option value={value}>{value} (missing)</option>}
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    </EditorField>
  )

  switch (action.type) {
    case 'controlQuery':
      return (
        <div className="grid grid-cols-2 gap-2">
          {pick('Query', action.query, names.queries, (query) => onChange({ ...action, query }))}
          {pick('Method', action.method, ['trigger', 'reset'], (m) =>
            onChange({ ...action, method: m as 'trigger' | 'reset' }),
          )}
        </div>
      )
    case 'controlComponent': {
      const target = definition.components.find((c) => c.name === action.component)
      const spec = target ? componentSpec(target.type) : undefined
      const methods = spec ? Object.keys(spec.methods) : []
      const params = spec?.methods[action.method]?.params ?? []
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            {pick('Component', action.component, names.components, (component) =>
              onChange({ type: 'controlComponent', component, method: action.method }),
            )}
            {pick('Method', action.method, methods, (method) =>
              onChange({ type: 'controlComponent', component: action.component, method }),
            )}
          </div>
          {params.map((p, j) =>
            template(['args', j], p, action.args?.[j] ?? '', (v) => {
              const args = [...(action.args ?? [])]
              args[j] = v
              while (args.length && !args.at(-1)) args.pop()
              const { args: _, ...rest } = action
              onChange(args.length ? { ...rest, args } : rest)
            }),
          )}
        </>
      )
    }
    case 'setVariable':
      return (
        <>
          {pick('Variable', action.variable, names.variables, (variable) =>
            onChange({ ...action, variable }),
          )}
          {template(['value'], 'Value', action.value, (value) => onChange({ ...action, value }))}
        </>
      )
    case 'runScript':
      return (
        <EditorField label="Script" hint="JavaScript; may await queries (await query1.trigger())">
          <AppCodeField
            path={[...at, 'code']}
            language="javascript"
            height={120}
            value={action.code}
            problems={problemsAt(diagnostics, [...at, 'code'])}
            onChange={(code) => onChange({ ...action, code })}
          />
        </EditorField>
      )
    case 'notify':
      return (
        <>
          {template(['message'], 'Message', action.message, (message) => onChange({ ...action, message }))}
          {pick('Tone', action.tone ?? 'info', ['info', 'success', 'error'], (tone) =>
            onChange({ ...action, tone: tone as 'info' | 'success' | 'error' }),
          )}
        </>
      )
    case 'openUrl':
      return (
        <>
          {template(['url'], 'URL', action.url, (url) => onChange({ ...action, url }))}
          <Checkbox
            label="Open in a new tab"
            checked={action.newTab ?? false}
            onChange={(e) => onChange({ ...action, newTab: e.target.checked })}
          />
        </>
      )
    case 'moduleEvent':
      return pick('Module event', action.event, names.events, (event) => onChange({ ...action, event }))
    case 'openPage':
      return (
        <>
          {pick('Page', action.page, names.pages, (page) => onChange({ ...action, page }))}
          <ParamsFields
            params={action.params ?? {}}
            at={[...at, 'params']}
            onChange={(params) => {
              const { params: _, ...rest } = action
              onChange(Object.keys(params).length ? { ...rest, params } : rest)
            }}
          />
          <Checkbox
            label="Open in a new tab"
            checked={action.newTab ?? false}
            onChange={(e) => onChange({ ...action, newTab: e.target.checked })}
          />
        </>
      )
    case 'setUrlParams':
      return (
        <ParamsFields
          params={action.params}
          at={[...at, 'params']}
          hint="Other parameters stay; one that evaluates to empty is removed"
          onChange={(params) => onChange({ ...action, params })}
        />
      )
    case 'copyToClipboard':
      return template(['text'], 'Text', action.text, (text) => onChange({ ...action, text }))
    case 'download':
      return (
        <>
          {template(['data'], 'Data', action.data, (data) => onChange({ ...action, data }))}
          {template(['fileName'], 'File name', action.fileName, (fileName) =>
            onChange({ ...action, fileName }),
          )}
          <p className="text-[11px] text-muted">
            Rows (an array of objects) save as CSV for a .csv name, JSON otherwise.
          </p>
        </>
      )
    case 'setLocalStorage':
      return (
        <>
          <EditorField label="Key" hint="Read back as localStorage.values.<key>">
            <Input
              aria-label="Key"
              className="h-8 font-mono"
              value={action.key}
              onChange={(e) => onChange({ ...action, key: e.target.value })}
            />
          </EditorField>
          {template(['value'], 'Value', action.value, (value) => onChange({ ...action, value }))}
        </>
      )
    case 'clearLocalStorage':
      return (
        <EditorField label="Key" hint="Empty: every key the app keeps">
          <Input
            aria-label="Key"
            className="h-8 font-mono"
            value={action.key ?? ''}
            onChange={(e) =>
              onChange(e.target.value ? { ...action, key: e.target.value } : { type: action.type })
            }
          />
        </EditorField>
      )
  }
}

/** Query parameters as name / {{ }} value rows, with a row to add one. */
function ParamsFields({
  params,
  at,
  hint,
  onChange,
}: {
  params: Record<string, string>
  at: (string | number)[]
  hint?: string
  onChange: (next: Record<string, string>) => void
}) {
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const entries = Object.entries(params)
  const rename = (from: string, to: string) =>
    onChange(Object.fromEntries(entries.map(([k, v]) => [k === from ? to : k, v])))
  return (
    <EditorField label="URL parameters" hint={hint}>
      <div className="flex flex-col gap-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-1.5">
            <Input
              aria-label="Parameter name"
              className="h-[30px] w-24 shrink-0 font-mono text-xs"
              defaultValue={key}
              onBlur={(e) => {
                const next = e.target.value.trim()
                if (next && next !== key && !(next in params)) rename(key, next)
                else e.target.value = key
              }}
            />
            <div className="min-w-0 flex-1">
              <AppCodeField
                path={[...at, key]}
                language="plaintext"
                singleLine
                height={30}
                value={value}
                problems={problemsAt(diagnostics, [...at, key])}
                onChange={(v) => onChange({ ...params, [key]: v })}
              />
            </div>
            <Button
              size="icon"
              variant="ghost"
              title={`Remove ${key}`}
              onClick={() => onChange(Object.fromEntries(entries.filter(([k]) => k !== key)))}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          className="self-start"
          onClick={() => {
            let n = entries.length + 1
            while (`param${n}` in params) n++
            onChange({ ...params, [`param${n}`]: '' })
          }}
        >
          <Plus className="size-3.5" /> Add parameter
        </Button>
      </div>
    </EditorField>
  )
}

/** How a handler waits: not at all, debounced (after the events stop) or throttled (at most once per window). */
function WaitFields({
  handler,
  onChange,
}: {
  handler: EventHandler
  onChange: (next: EventHandler) => void
}) {
  const mode =
    handler.throttleMs !== undefined ? 'throttle' : handler.debounceMs !== undefined ? 'debounce' : 'none'
  const ms = handler.throttleMs ?? handler.debounceMs
  const { debounceMs: _d, throttleMs: _t, ...rest } = handler
  const set = (nextMode: string, nextMs: number | undefined) =>
    onChange(
      nextMode === 'none' || nextMs === undefined
        ? rest
        : { ...rest, [nextMode === 'throttle' ? 'throttleMs' : 'debounceMs']: nextMs },
    )
  return (
    <div className="grid grid-cols-2 gap-2">
      <EditorField label="Wait">
        <Select
          aria-label="Wait"
          value={mode}
          onChange={(e) => set(e.target.value, e.target.value === 'none' ? undefined : (ms ?? 300))}
        >
          <option value="none">Don't wait</option>
          <option value="debounce">Debounce</option>
          <option value="throttle">Throttle</option>
        </Select>
      </EditorField>
      {mode !== 'none' && (
        <EditorField label={mode === 'debounce' ? 'Debounce (ms)' : 'Throttle (ms)'}>
          <Input
            type="number"
            min={0}
            className="h-8"
            value={ms ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value)
              set(mode, e.target.value && n > 0 ? Math.min(60_000, Math.round(n)) : undefined)
            }}
          />
        </EditorField>
      )}
    </div>
  )
}
