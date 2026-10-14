import {
  type Block,
  type BlockOf,
  DEFAULT_BLOCK_SETTINGS,
  type Diagnostic,
  renameBlock,
} from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ArrowDown, ArrowUp, Play, Plus, Trash2, X } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react'
import { Button, Field, Input, Select, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { removeFrom } from './canvas'
import { BLOCK_KINDS } from './catalog'
import type { CodeFieldProps, FieldProblem } from './code-field'
import { runBlock, useRun } from './run-state'
import { updateBlock, useEditor } from './store'
import { TriggersForm } from './triggers'

// Monaco is big: it loads the first time a code field is shown.
const LazyCodeField = lazy(() => import('./code-field'))

function Code(props: CodeFieldProps) {
  return (
    <Suspense
      fallback={
        <div
          style={{ height: props.height }}
          className="animate-pulse rounded-md border border-border bg-canvas"
        />
      }
    >
      <LazyCodeField {...props} />
    </Suspense>
  )
}

/**
 * Like `Field`, but a `div`: Monaco must not sit inside a `<label>`, which redirects clicks to the label's control
 * and breaks Monaco's focus handling.
 */
function EditorField({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  )
}

/** Everything about one block: name, its type's settings, retries and timeouts, and its problems. */
export function Inspector({ name }: { name: string }) {
  const definition = useEditor((s) => s.definition)
  const diagnostics = useEditor((s) => s.diagnostics)
  const workflowId = useEditor((s) => s.workflowId)
  const index = definition.blocks.findIndex((b) => b.name === name)
  const block = definition.blocks[index]
  if (!block) return null

  /** Validator problems for a field of this block, as editor markers. */
  const problemsAt = (...path: (string | number)[]): FieldProblem[] =>
    diagnostics
      .filter((d) => d.block === name && startsWith(d.path, ['blocks', index, ...path]))
      .map((d) => ({ start: d.start, end: d.end, message: d.message, severity: d.severity }))
  const modelPath = (field: string) => `file:///${workflowId}/${name}/${field}`
  const ctx: FormContext = { problemsAt, modelPath }
  const kind = BLOCK_KINDS[block.type]
  const Icon = kind.icon

  return (
    <div className="flex flex-col gap-5 p-4" data-testid={`inspector-${name}`}>
      <div className="flex items-start gap-2">
        <span className={cn('mt-1 rounded-md p-1.5', kind.tone)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <NameField name={name} />
          <div className="mt-1 text-xs text-muted">{kind.label}</div>
        </div>
        {block.type !== 'startTrigger' && <RunBlockButton name={name} />}
        {block.type !== 'startTrigger' && <DeleteBlock name={name} />}
      </div>

      <TypeForm block={block} ctx={ctx} />

      {block.type !== 'startTrigger' && <SettingsForm block={block} />}

      <Field label="Description">
        <Textarea
          rows={2}
          value={block.description ?? ''}
          placeholder="What this block does, for whoever reads the workflow next"
          onChange={(e) =>
            updateBlock(name, (b) => {
              const { description: _, ...rest } = b
              return (e.target.value ? { ...rest, description: e.target.value } : rest) as Block
            })
          }
        />
      </Field>

      <BlockProblems diagnostics={diagnostics.filter((d) => d.block === name)} />
    </div>
  )
}

interface FormContext {
  problemsAt: (...path: (string | number)[]) => FieldProblem[]
  modelPath: (field: string) => string
}

function startsWith(path: (string | number)[], prefix: (string | number)[]) {
  return prefix.every((p, i) => path[i] === p)
}

/** The block name, renamed with every reference to it when the field is committed (Enter or blur). */
function NameField({ name }: { name: string }) {
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  useEffect(() => {
    setDraft(name)
    setError(null)
  }, [name])

  const commit = () => {
    if (draft === name) return setError(null)
    const result = renameBlock(useEditor.getState().definition, name, draft)
    if (!result.ok) return setError(result.error)
    setError(null)
    setSkipped(result.skipped.map((s) => s.block))
    useEditor.getState().update(() => result.definition)
    useEditor.getState().select(draft)
  }

  return (
    <div>
      <Input
        aria-label="Block name"
        data-testid="block-name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(name)
            setError(null)
          }
        }}
        className="h-8 font-mono font-medium"
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {skipped.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          Not updated in {[...new Set(skipped)].join(', ')}: fix the syntax errors there, then rename again.
        </p>
      )}
    </div>
  )
}

/** Runs just this block, reusing the results of the blocks before it from the latest run. */
function RunBlockButton({ name }: { name: string }) {
  const starting = useRun((s) => s.starting)
  const errors = useEditor((s) => s.diagnostics.some((d) => d.severity === 'error'))
  return (
    <Button
      size="icon"
      variant="ghost"
      loading={starting}
      disabled={errors}
      title={errors ? 'Fix the problems first' : 'Run this block (earlier results are reused)'}
      onClick={() => runBlock(name)}
    >
      {!starting && <Play className="size-4" />}
    </Button>
  )
}

function DeleteBlock({ name }: { name: string }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      title="Delete block"
      onClick={() => {
        useEditor.getState().update((def) => removeFrom(def, new Set([name])))
        useEditor.getState().select(null)
      }}
    >
      <Trash2 className="size-4" />
    </Button>
  )
}

function TypeForm({ block, ctx }: { block: Block; ctx: FormContext }) {
  switch (block.type) {
    case 'startTrigger':
      return <StartTriggerForm block={block} ctx={ctx} />
    case 'code':
      return <CodeForm block={block} ctx={ctx} />
    case 'resourceQuery':
      return <QueryForm block={block} ctx={ctx} />
    case 'branch':
      return <BranchForm block={block} ctx={ctx} />
    case 'filter':
      return <FilterForm block={block} ctx={ctx} />
    case 'response':
      return <ResponseForm block={block} ctx={ctx} />
  }
}

function StartTriggerForm({ block, ctx }: { block: BlockOf<'startTrigger'>; ctx: FormContext }) {
  const stored = block.config?.testInput
  const [text, setText] = useState(() => (stored === undefined ? '' : JSON.stringify(stored, null, 2)))
  const [invalid, setInvalid] = useState(false)
  return (
    <div className="flex flex-col gap-5">
      <EditorField
        label="Test input"
        hint={
          invalid ? (
            <span className="text-danger">Not valid JSON yet; the last valid input is kept.</span>
          ) : (
            'JSON the Run button sends as startTrigger.data.'
          )
        }
      >
        <Code
          path={ctx.modelPath('testInput.json')}
          language="json"
          height={140}
          value={text}
          onChange={(next) => {
            setText(next)
            if (!next.trim()) {
              setInvalid(false)
              return updateBlock<BlockOf<'startTrigger'>>(block.name, (b) => ({ ...b, config: {} }))
            }
            try {
              const testInput = JSON.parse(next)
              setInvalid(false)
              updateBlock<BlockOf<'startTrigger'>>(block.name, (b) => ({ ...b, config: { testInput } }))
            } catch {
              setInvalid(true)
            }
          }}
        />
      </EditorField>
      <TriggersForm testInput={stored} />
    </div>
  )
}

function CodeForm({ block, ctx }: { block: BlockOf<'code'>; ctx: FormContext }) {
  return (
    <EditorField
      label="JavaScript"
      hint="An async function body: use other blocks' results, await, and return the data."
    >
      <Code
        path={ctx.modelPath('code.js')}
        language="javascript"
        height={260}
        value={block.config.code}
        problems={ctx.problemsAt('config', 'code')}
        onChange={(code) => updateBlock<BlockOf<'code'>>(block.name, (b) => ({ ...b, config: { code } }))}
      />
    </EditorField>
  )
}

type KeyValue = { key: string; value: string }
const DEFAULT_REST = { method: 'GET', path: '', params: [], headers: [], body: { type: 'none' } }

function QueryForm({ block, ctx }: { block: BlockOf<'resourceQuery'>; ctx: FormContext }) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.resources.list.queryOptions())
  const resources = data?.resources ?? []
  const current = resources.find((r) => r.slug === block.config.resource)
  const query = block.config.query as Record<string, unknown>
  const setQuery = (patch: Record<string, unknown>) =>
    updateBlock<BlockOf<'resourceQuery'>>(block.name, (b) => ({
      ...b,
      config: { ...b.config, query: { ...(b.config.query as object), ...patch } as never },
    }))

  return (
    <div className="flex flex-col gap-4">
      <Field label="Resource">
        <Select
          value={block.config.resource}
          onChange={(e) => {
            const next = resources.find((r) => r.slug === e.target.value)
            updateBlock<BlockOf<'resourceQuery'>>(block.name, (b) => ({
              ...b,
              config: {
                resource: e.target.value,
                // Switching kinds of resource starts a fresh query.
                query:
                  next && current && next.type === current.type
                    ? b.config.query
                    : next?.type === 'postgres'
                      ? { sql: 'select 1' }
                      : (DEFAULT_REST as never),
              },
            }))
          }}
        >
          {!current && <option value={block.config.resource}>{block.config.resource} (not found)</option>}
          {resources.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.name} ({r.slug})
            </option>
          ))}
        </Select>
      </Field>
      {current?.type === 'postgres' || (!current && typeof query.sql === 'string') ? (
        <EditorField label="SQL" hint="{{ }} values are sent as bind parameters, never pasted into the SQL.">
          <Code
            path={ctx.modelPath('query.sql')}
            language="sql"
            height={200}
            value={String(query.sql ?? '')}
            problems={ctx.problemsAt('config', 'query', 'sql')}
            onChange={(sql) => setQuery({ sql })}
          />
        </EditorField>
      ) : (
        <RestQueryForm query={query} setQuery={setQuery} ctx={ctx} />
      )}
    </div>
  )
}

function RestQueryForm({
  query,
  setQuery,
  ctx,
}: {
  query: Record<string, unknown>
  setQuery: (patch: Record<string, unknown>) => void
  ctx: FormContext
}) {
  const body = (query.body ?? { type: 'none' }) as {
    type: string
    json?: string
    raw?: string
    fields?: KeyValue[]
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Select value={String(query.method ?? 'GET')} onChange={(e) => setQuery({ method: e.target.value })}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <Input
          aria-label="Path"
          className="font-mono"
          placeholder="/orders/{{ startTrigger.data.id }}"
          value={String(query.path ?? '')}
          onChange={(e) => setQuery({ path: e.target.value })}
        />
      </div>
      <KeyValues
        label="Query parameters"
        rows={(query.params as KeyValue[]) ?? []}
        onChange={(params) => setQuery({ params })}
      />
      <KeyValues
        label="Headers"
        rows={(query.headers as KeyValue[]) ?? []}
        onChange={(headers) => setQuery({ headers })}
      />
      <Field label="Body">
        <Select
          value={body.type}
          onChange={(e) => {
            const type = e.target.value
            setQuery({
              body:
                type === 'json'
                  ? { type, json: '{}' }
                  : type === 'form'
                    ? { type, fields: [] }
                    : type === 'raw'
                      ? { type, raw: '', contentType: 'text/plain' }
                      : { type: 'none' },
            })
          }}
        >
          <option value="none">No body</option>
          <option value="json">JSON</option>
          <option value="form">Form</option>
          <option value="raw">Raw</option>
        </Select>
      </Field>
      {body.type === 'json' && (
        <Code
          path={ctx.modelPath('body.json')}
          language="plaintext"
          height={140}
          value={body.json ?? ''}
          problems={ctx.problemsAt('config', 'query', 'body', 'json')}
          onChange={(json) => setQuery({ body: { type: 'json', json } })}
        />
      )}
      {body.type === 'form' && (
        <KeyValues
          label="Form fields"
          rows={body.fields ?? []}
          onChange={(fields) => setQuery({ body: { type: 'form', fields } })}
        />
      )}
      {body.type === 'raw' && (
        <Textarea
          rows={4}
          className="font-mono"
          value={body.raw ?? ''}
          onChange={(e) => setQuery({ body: { ...body, raw: e.target.value } })}
        />
      )}
    </div>
  )
}

function KeyValues({
  label,
  rows,
  onChange,
}: {
  label: string
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
}) {
  const set = (i: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
        <div key={i} className="flex gap-1.5">
          <Input
            aria-label="Name"
            className="h-8 font-mono"
            placeholder="name"
            value={row.key}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <Input
            aria-label="Value"
            className="h-8 font-mono"
            placeholder="value or {{ }}"
            value={row.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <Button
            size="icon"
            variant="ghost"
            title="Remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        <Plus className="size-3.5" /> Add
      </Button>
    </div>
  )
}

function BranchForm({ block, ctx }: { block: BlockOf<'branch'>; ctx: FormContext }) {
  const conditions = block.config.conditions
  const setConditions = (next: typeof conditions) =>
    updateBlock<BlockOf<'branch'>>(block.name, (b) => ({ ...b, config: { conditions: next } }))
  const move = (i: number, by: number) => {
    const next = [...conditions]
    const [item] = next.splice(i, 1)
    next.splice(i + by, 0, item!)
    setConditions(next)
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Conditions</span>
      <p className="-mt-1 text-xs text-muted">
        Checked in order; the first true one continues on its own output, otherwise "else".
      </p>
      {conditions.map((c, i) => (
        <div key={c.id} className="flex items-center gap-1.5">
          <span className="w-8 shrink-0 font-mono text-xs text-muted">{i === 0 ? 'if' : 'elif'}</span>
          <div className="min-w-0 flex-1">
            <Code
              path={ctx.modelPath(`condition-${c.id}.js`)}
              language="javascript"
              singleLine
              height={30}
              value={c.expression}
              problems={ctx.problemsAt('config', 'conditions', i, 'expression')}
              onChange={(expression) =>
                setConditions(conditions.map((x) => (x.id === c.id ? { ...x, expression } : x)))
              }
            />
          </div>
          <Button size="icon" variant="ghost" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Move down"
            disabled={i === conditions.length - 1}
            onClick={() => move(i, 1)}
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Remove condition"
            disabled={conditions.length === 1}
            onClick={() =>
              // The condition's output goes with it.
              useEditor.getState().update((def) => ({
                ...def,
                blocks: def.blocks.map((b) =>
                  b.name === block.name && b.type === 'branch'
                    ? { ...b, config: { conditions: b.config.conditions.filter((x) => x.id !== c.id) } }
                    : b,
                ),
                edges: def.edges.filter((e) => !(e.from === block.name && e.port === `cond:${c.id}`)),
              }))
            }
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => {
          const ids = new Set(conditions.map((c) => c.id))
          let n = conditions.length + 1
          while (ids.has(`c${n}`)) n++
          setConditions([...conditions, { id: `c${n}`, expression: 'true' }])
        }}
      >
        <Plus className="size-3.5" /> Add condition
      </Button>
    </div>
  )
}

function FilterForm({ block, ctx }: { block: BlockOf<'filter'>; ctx: FormContext }) {
  const set = (patch: Partial<BlockOf<'filter'>['config']>) =>
    updateBlock<BlockOf<'filter'>>(block.name, (b) => ({ ...b, config: { ...b.config, ...patch } }))
  return (
    <div className="flex flex-col gap-4">
      <EditorField label="Items" hint="A {{ }} that gives an array, e.g. {{ query1.data }}.">
        <Code
          path={ctx.modelPath('input.txt')}
          language="plaintext"
          singleLine
          height={30}
          value={block.config.input}
          problems={ctx.problemsAt('config', 'input')}
          onChange={(input) => set({ input })}
        />
      </EditorField>
      <EditorField label="Keep items where" hint="A JavaScript expression with value (the item) and index.">
        <Code
          path={ctx.modelPath('condition.js')}
          language="javascript"
          singleLine
          height={30}
          value={block.config.condition}
          problems={ctx.problemsAt('config', 'condition')}
          onChange={(condition) => set({ condition })}
        />
      </EditorField>
    </div>
  )
}

function ResponseForm({ block, ctx }: { block: BlockOf<'response'>; ctx: FormContext }) {
  const set = (patch: Partial<BlockOf<'response'>['config']>) =>
    updateBlock<BlockOf<'response'>>(block.name, (b) => ({ ...b, config: { ...b.config, ...patch } }))
  return (
    <div className="flex flex-col gap-4">
      <Field label="Status">
        <Input
          className="font-mono"
          value={block.config.status ?? '200'}
          onChange={(e) => set({ status: e.target.value })}
        />
      </Field>
      <KeyValues label="Headers" rows={block.config.headers ?? []} onChange={(headers) => set({ headers })} />
      <EditorField label="Body" hint='JSON with {{ }}: {"total": {{ code1.data }}}'>
        <Code
          path={ctx.modelPath('body.txt')}
          language="plaintext"
          height={140}
          value={block.config.body ?? ''}
          problems={ctx.problemsAt('config', 'body')}
          onChange={(body) => set({ body })}
        />
      </EditorField>
    </div>
  )
}

type ExecutableBlock = Exclude<Block, BlockOf<'startTrigger'>>

/** Timeout, retries and what happens on failure. Unset values show their defaults as placeholders. */
function SettingsForm({ block }: { block: ExecutableBlock }) {
  const settings = block.settings ?? {}
  const retry = settings.retry ?? {}
  const defaults = DEFAULT_BLOCK_SETTINGS
  const set = (patch: Record<string, unknown>) =>
    updateBlock<ExecutableBlock>(block.name, (b) => {
      const next = { ...b.settings, ...patch } as Record<string, unknown>
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      return { ...b, settings: next } as ExecutableBlock
    })
  const setRetry = (patch: Record<string, unknown>) => {
    const next = { ...retry, ...patch } as Record<string, unknown>
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
    set({ retry: Object.keys(next).length ? next : undefined })
  }
  const num = (value: string) => (value === '' ? undefined : Math.max(0, Math.round(Number(value))))

  return (
    <details className="group rounded-md border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        Timeout, retries and failure
      </summary>
      <div className="grid grid-cols-2 gap-3 border-t border-border p-3">
        <Field label="Timeout (ms)">
          <Input
            type="number"
            min={100}
            placeholder={String(defaults.timeoutMs)}
            value={settings.timeoutMs ?? ''}
            onChange={(e) => set({ timeoutMs: num(e.target.value) })}
          />
        </Field>
        <Field label="On failure">
          <Select
            value={settings.finally ?? defaults.finally}
            onChange={(e) => set({ finally: e.target.value === 'stop' ? undefined : e.target.value })}
          >
            <option value="stop">Stop the run</option>
            <option value="continue">Continue on the error output</option>
          </Select>
        </Field>
        <Field label="Retries">
          <Input
            type="number"
            min={0}
            max={10}
            placeholder={String(defaults.retry.count)}
            value={retry.count ?? ''}
            onChange={(e) => setRetry({ count: num(e.target.value) })}
          />
        </Field>
        <Field label="Retry interval (ms)">
          <Input
            type="number"
            min={0}
            placeholder={String(defaults.retry.intervalMs)}
            value={retry.intervalMs ?? ''}
            onChange={(e) => setRetry({ intervalMs: num(e.target.value) })}
          />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={retry.exponential ?? defaults.retry.exponential}
            onChange={(e) => setRetry({ exponential: e.target.checked || undefined })}
          />
          Double the interval after each retry (up to {defaults.retry.maxIntervalMs / 1000} s)
        </label>
      </div>
    </details>
  )
}

function BlockProblems({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const select = useEditor((s) => s.select)
  if (!diagnostics.length) return null
  return (
    <Section title="Problems">
      <ul className="space-y-1.5" data-testid="block-problems">
        {diagnostics.map((d) => (
          <li
            key={`${d.code}:${d.path.join('.')}:${d.start ?? ''}`}
            className="flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className={cn(
                'mt-0.5 size-4 shrink-0',
                d.severity === 'error' ? 'text-danger' : 'text-amber-600',
              )}
            />
            <button type="button" className="text-left" onClick={() => d.block && select(d.block)}>
              {d.message}
              {d.hint && <span className="block text-xs text-muted">{d.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}
