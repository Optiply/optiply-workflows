import { isServiceType } from '@ow/connectors/actions'
import {
  type Block,
  type BlockOf,
  type BlockSettings,
  blockingErrors,
  DEFAULT_BLOCK_SETTINGS,
  DEFAULT_LOOP_BATCH_SIZE,
  DEFAULT_LOOP_CONCURRENCY,
  type Diagnostic,
  isTrigger,
  MAX_LOOP_CONCURRENCY,
  renameBlock,
  resolveBlockSettings,
  TASK_DUE_UNITS,
  WAIT_UNITS,
  type WaitUnit,
} from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertCircle, ArrowDown, ArrowUp, ExternalLink, Play, Plus, Trash2, X, Zap } from 'lucide-react'
import { createContext, lazy, type ReactNode, Suspense, useContext, useEffect, useState } from 'react'
import { ActionQueryForm, RequestAuthFields } from '@/components/action-query'
import { type MultipartPart, MultipartParts } from '@/components/multipart-parts'
import { OpenApiQueryForm } from '@/components/openapi-query'
import { Button, Field, Input, Select, Textarea } from '@/components/ui'
import { useGraphqlSchema } from '@/lib/graphql-schema'
import { useOpenApiOperations } from '@/lib/openapi-operations'
import {
  defaultQuery,
  isMessageKind,
  MESSAGE_QUERIES,
  type MessageKind,
  type QueryKind,
  queryKind,
} from '@/lib/resource-types'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { removeFrom } from './canvas'
import { kindOf } from './catalog'
import type { FieldProblem, WorkflowCodeFieldProps } from './code-field'
import { useRemoteCarets, withCarets } from './preview-cursors'
import { usePythonCheck } from './python-check'
import { runBlock, useRun } from './run-state'
import { graphOf, problemsOf, updateBlock, updateGraph, useEditor } from './store'
import { TriggersForm } from './triggers'

// Monaco is big: it loads the first time a code field is shown.
const LazyCodeField = lazy(() => import('./code-field'))

/** In a node, whether its code fields are editors yet; the side panel's always are. */
const CodeInNode = createContext<{ active: boolean; onActivate: () => void } | null>(null)

/** A code field's height in a node: shorter than in the side panel. */
const NODE_CODE_HEIGHT = 140

function Code(props: WorkflowCodeFieldProps) {
  const node = useContext(CodeInNode)
  const height = node ? Math.min(props.height, NODE_CODE_HEIGHT) : props.height
  if (node && !node.active) return <CodePreview {...props} height={height} onActivate={node.onActivate} />
  props = { ...props, height }
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

/** A code field in a node until the block is inspected: its text, with others' carets in it (M16). */
function CodePreview(props: WorkflowCodeFieldProps & { onActivate: () => void }) {
  const carets = useRemoteCarets(props.text)
  return (
    <button
      type="button"
      style={{ height: props.height }}
      onClick={props.onActivate}
      title="Click to edit"
      data-testid={`code-preview-${props.path}`}
      className="flex w-full cursor-text items-start justify-start overflow-hidden rounded-md border border-border bg-field px-2 py-1 text-left font-mono text-xs whitespace-pre text-ink"
    >
      <span>{withCarets(props.value, carets)}</span>
    </button>
  )
}

/**
 * Like `Field`, but a `div`: Monaco must not sit inside a `<label>`, which redirects clicks to the label's control
 * and breaks Monaco's focus handling.
 */
function EditorField({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  // Nodes stay compact: hints show in the side panel only.
  const inNode = useContext(CodeInNode) !== null
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && !inNode && <span className="text-xs text-muted">{hint}</span>}
    </div>
  )
}

/** A block of the open graph and what its form needs: where its fields sit, their problems and models. */
function useBlockForm(name: string) {
  const definition = useEditor((s) => s.definition)
  const allDiagnostics = useEditor((s) => s.diagnostics)
  const workflowId = useEditor((s) => s.workflowId)
  const fn = useEditor((s) => s.graph)
  const graph = graphOf(definition, fn)
  const index = graph.blocks.findIndex((b) => b.name === name)
  const block = graph.blocks[index]
  if (!block) return null
  const diagnostics = problemsOf(allDiagnostics, name, fn)
  // Where this block sits in the definition: ['blocks', i], or ['functions', f, 'blocks', i].
  const base =
    fn === null
      ? ['blocks', index]
      : ['functions', (definition.functions ?? []).findIndex((f) => f.name === fn), 'blocks', index]

  /** Validator problems for a field of this block, as editor markers. */
  const problemsAt = (...path: (string | number)[]): FieldProblem[] =>
    diagnostics
      .filter((d) => startsWith(d.path, [...base, ...path]))
      .map((d) => ({ start: d.start, end: d.end, message: d.message, severity: d.severity }))
  // Block names repeat across functions, so the function is part of each field's model.
  const modelPath = (field: string) => `file:///${workflowId}/${fn ?? '_'}/${name}/${field}`
  const ctx: FormContext = { problemsAt, modelPath, text: (...path) => [...base, ...path] }
  return { block, ctx, diagnostics, fn }
}

/**
 * A block's own form, in its node on the canvas (M28). Code fields there show their text until the block is
 * selected, then become editors: a canvas of many blocks keeps one or two Monaco editors.
 */
export function BlockBody({ name, active }: { name: string; active: boolean }) {
  const form = useBlockForm(name)
  if (!form) return null
  return (
    <CodeInNode.Provider value={{ active, onActivate: () => useEditor.getState().inspect(name) }}>
      <div className="flex flex-col gap-3 text-sm">
        <TypeForm block={form.block} ctx={form.ctx} />
      </div>
    </CodeInNode.Provider>
  )
}

/** A block's timeout, retries and what happens when it fails, for its node's Settings tab. */
export function BlockSettingsForm({ name, open }: { name: string; open?: boolean }) {
  const form = useBlockForm(name)
  if (!form || isTrigger(form.block)) return null
  return <SettingsForm block={form.block} open={open} />
}

/** Everything about one block: name, its type's settings, retries and timeouts, and its problems. */
export function Inspector({ name }: { name: string }) {
  const form = useBlockForm(name)
  if (!form) return null
  const { block, ctx, diagnostics, fn } = form
  const kind = kindOf(block)
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
        {fn === null && !isTrigger(block) && <RunBlockButton name={name} />}
        {block.type !== 'startTrigger' && <DeleteBlock name={name} />}
      </div>

      <TypeForm block={block} ctx={ctx} />

      {!isTrigger(block) && <SettingsForm block={block} />}

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

      <BlockProblems diagnostics={diagnostics} />
    </div>
  )
}

interface FormContext {
  problemsAt: (...path: (string | number)[]) => FieldProblem[]
  modelPath: (field: string) => string
  /** A field of this block's place in the definition: where its text is in the shared document (M16). */
  text: (...path: (string | number)[]) => (string | number)[]
}

function startsWith(path: (string | number)[], prefix: (string | number)[]) {
  return prefix.every((p, i) => path[i] === p)
}

/** The block name, renamed with every reference to it when the field is committed (Enter or blur). */
export function NameField({ name, onDone }: { name: string; onDone?: () => void }) {
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  useEffect(() => {
    setDraft(name)
    setError(null)
  }, [name])

  const commit = () => {
    if (draft === name) {
      setError(null)
      return onDone?.()
    }
    const { definition, graph, panelBlock } = useEditor.getState()
    const result = renameBlock(definition, name, draft, graph === null ? {} : { function: graph })
    if (!result.ok) return setError(result.error)
    setError(null)
    setSkipped(result.skipped.map((s) => s.block))
    useEditor.getState().update(() => result.definition)
    useEditor.getState().select(draft)
    if (panelBlock === name) useEditor.getState().openInPanel(draft)
    onDone?.()
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
            onDone?.()
          }
        }}
        autoFocus={onDone !== undefined}
        className={cn('font-mono font-medium', onDone ? 'h-6 px-1.5 text-sm' : 'h-8')}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {skipped.length > 0 && (
        <p className="mt-1 text-xs text-warning-strong">
          Not updated in {[...new Set(skipped)].join(', ')}: fix the syntax errors there, then rename again.
        </p>
      )}
    </div>
  )
}

/** Runs just this block, reusing the results of the blocks before it from the latest run. */
export function RunBlockButton({ name, compact }: { name: string; compact?: boolean }) {
  const starting = useRun((s) => s.starting)
  // Only problems in this block, the blocks before it and what they call stop it (M28).
  const errors = useEditor((s) => blockingErrors(s.definition, s.diagnostics, [name]).length > 0)
  return (
    <Button
      size="icon"
      variant="ghost"
      className={compact ? 'size-6 text-accent [&_svg]:size-3.5' : undefined}
      loading={starting}
      disabled={errors}
      title={
        errors
          ? 'Fix the problems in this block or the blocks before it first'
          : 'Run this block (earlier results are reused)'
      }
      onClick={() => runBlock(name)}
    >
      {!starting && <Play className={compact ? 'fill-current' : 'size-4'} />}
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
        updateGraph((g) => removeFrom(g, new Set([name])))
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
    case 'libraryQuery':
      return <LibraryQueryForm block={block} ctx={ctx} />
    case 'branch':
      return <BranchForm block={block} ctx={ctx} />
    case 'filter':
      return <FilterForm block={block} ctx={ctx} />
    case 'response':
      return <ResponseForm block={block} ctx={ctx} />
    case 'loop':
      return <LoopForm block={block} ctx={ctx} />
    case 'function':
      return <FunctionCallForm block={block} ctx={ctx} />
    case 'workflow':
      return <WorkflowForm block={block} ctx={ctx} />
    case 'wait':
      return <WaitForm block={block} ctx={ctx} />
    case 'userTask':
      return <UserTaskForm block={block} ctx={ctx} />
    case 'errorTrigger':
      return <ErrorTriggerForm block={block} />
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
      {useContext(CodeInNode) ? <EnabledTriggers name={block.name} /> : <TriggersForm testInput={stored} />}
    </div>
  )
}

/** In the start trigger's node: which triggers are on, and a way to their settings (the side panel). */
function EnabledTriggers({ name }: { name: string }) {
  const triggers = useEditor((s) => s.definition.triggers)
  const on = [
    triggers?.webhook?.enabled ? 'Webhook' : null,
    ...(['schedules', 'pubsub', 'sqs', 'kafka', 'rabbitmq', 'kinesis'] as const).map((kind) => {
      const n = (triggers?.[kind] ?? []).filter((t) => t.enabled).length
      return n ? `${TRIGGER_LABELS[kind]}${n > 1 ? ` (${n})` : ''}` : null
    }),
  ].filter(Boolean)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">Enabled triggers</span>
      <div className="rounded-md border border-border px-2 py-1.5 text-center text-xs text-muted">
        {on.length ? on.join(' · ') : 'No triggers enabled'}
      </div>
      <Button size="sm" variant="ghost" onClick={() => useEditor.getState().openInPanel(name)}>
        <Zap className="size-3.5" /> Edit triggers
      </Button>
    </div>
  )
}

const TRIGGER_LABELS = {
  schedules: 'Schedule',
  pubsub: 'Pub/Sub',
  sqs: 'SQS',
  kafka: 'Kafka',
  rabbitmq: 'RabbitMQ',
  kinesis: 'Kinesis',
} as const

function CodeForm({ block, ctx }: { block: BlockOf<'code'>; ctx: FormContext }) {
  return (
    <LanguageCode
      language={block.config.language}
      code={block.config.code}
      model="code"
      height={260}
      hints={{
        javascript: "An async function body: use other blocks' results, await, and return the data.",
        python:
          'A function body: read other blocks as variables (query1.data) and return the data. pandas and numpy are available; no network.',
      }}
      problems={ctx.problemsAt('config', 'code')}
      text={ctx.text('config', 'code')}
      ctx={ctx}
      onChange={(next) =>
        updateBlock<BlockOf<'code'>>(block.name, (b) => ({
          ...b,
          config: withLanguage({ ...b.config, ...next }),
        }))
      }
    />
  )
}

/** A code or runner config with `language` only for Python (JavaScript is no language: hashes stay as they were). */
function withLanguage<T extends { language?: 'python' }>(config: T): T {
  const { language, ...rest } = config
  return (language === 'python' ? { ...rest, language } : rest) as T
}

/**
 * Code in JavaScript or Python: the language picker (switching keeps the text), the editor in that language with
 * the validator's problems and, for Python, the executor's syntax check.
 */
function LanguageCode({
  language,
  code,
  model,
  height,
  hints,
  problems,
  text,
  ctx,
  onChange,
}: {
  language: 'python' | undefined
  code: string
  /** The code's place in the definition (shared editing). */
  text: (string | number)[]
  /** The Monaco model's name: `<model>.js` or `<model>.py`. */
  model: string
  height: number
  hints: { javascript: string; python: string }
  problems: FieldProblem[]
  ctx: FormContext
  onChange: (next: { code?: string; language?: 'python' }) => void
}) {
  const python = language === 'python'
  const check = usePythonCheck(code, python)
  return (
    <div className="flex flex-col gap-3">
      <Field label="Language">
        <Select
          value={python ? 'python' : 'javascript'}
          onChange={(e) => onChange({ language: e.target.value === 'python' ? 'python' : undefined })}
        >
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
        </Select>
      </Field>
      <EditorField label={python ? 'Python' : 'JavaScript'} hint={python ? hints.python : hints.javascript}>
        <Code
          path={ctx.modelPath(`${model}.${python ? 'py' : 'js'}`)}
          language={python ? 'python' : 'javascript'}
          height={height}
          value={code}
          problems={[...problems, ...check.problems]}
          text={text}
          onChange={(next) => onChange({ code: next })}
        />
        {check.unavailable && (
          <span
            className="flex items-center gap-1 text-xs text-warning-strong"
            data-testid="python-unavailable"
          >
            <AlertCircle className="size-3.5" /> {check.unavailable}: this code can't run here.
          </span>
        )}
      </EditorField>
    </div>
  )
}

type KeyValue = { key: string; value: string }
function QueryForm({ block, ctx }: { block: BlockOf<'resourceQuery'>; ctx: FormContext }) {
  return (
    <QueryEditor
      resource={block.config.resource}
      query={block.config.query as Record<string, unknown>}
      at={['config']}
      models=""
      ctx={ctx}
      onChange={(next) =>
        updateBlock<BlockOf<'resourceQuery'>>(block.name, (b) => ({
          ...b,
          config: { resource: next.resource, query: next.query as never },
        }))
      }
    />
  )
}

/** A resource and its query (SQL, or a REST request), at `at` in the block (a query block's config, a loop's runner). */
function QueryEditor({
  resource,
  query,
  onChange,
  at,
  models,
  ctx,
}: {
  resource: string
  query: Record<string, unknown>
  onChange: (next: { resource: string; query: Record<string, unknown> }) => void
  at: (string | number)[]
  /** Prefix for its fields' Monaco models: `query.sql` in a query block, `runner.query.sql` in a loop. */
  models: string
  ctx: FormContext
}) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.resources.list.queryOptions())
  const resources = data?.resources ?? []
  const current = resources.find((r) => r.slug === resource)
  // Without the resource (deleted, or not visible): guessed from the query's own fields.
  const kind: QueryKind | null = current
    ? queryKind(current.type)
    : typeof query.sql === 'string'
      ? 'sql'
      : typeof query.messages === 'string'
        ? typeof query.queue === 'string'
          ? 'sqs'
          : 'pubsub'
        : typeof query.action === 'string'
          ? null
          : typeof query.operationId === 'string'
            ? 'openapi'
            : typeof query.url === 'string'
              ? 'restapi'
              : typeof query.query === 'string'
                ? 'graphql'
                : 'rest'
  const messageKind = kind !== null && isMessageKind(kind) ? kind : null
  const setQuery = (patch: Record<string, unknown>) => onChange({ resource, query: { ...query, ...patch } })

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Resource"
        hint={
          current?.systemKind === 'database'
            ? "The tables on the Database page, in the run's environment."
            : undefined
        }
      >
        <Select
          value={resource}
          onChange={(e) => {
            const next = resources.find((r) => r.slug === e.target.value)
            onChange({
              resource: e.target.value,
              // Switching kinds of resource starts a fresh query.
              query: next && current && next.type === current.type ? query : defaultQuery(next?.type),
            })
          }}
        >
          {!current && <option value={resource}>{resource} (not found)</option>}
          {resources.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.name} ({r.slug}){r.systemKind ? ' · built-in' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {kind === 'sql' ? (
        <EditorField label="SQL" hint="{{ }} values are sent as bind parameters, never pasted into the SQL.">
          <Code
            path={ctx.modelPath(`${models}query.sql`)}
            language="sql"
            height={200}
            value={String(query.sql ?? '')}
            problems={ctx.problemsAt(...at, 'query', 'sql')}
            text={ctx.text(...at, 'query', 'sql')}
            onChange={(sql) => setQuery({ sql })}
          />
        </EditorField>
      ) : messageKind ? (
        <MessageQueryForm
          kind={messageKind}
          query={query}
          setQuery={setQuery}
          ctx={ctx}
          at={at}
          models={models}
        />
      ) : kind === 'service' && current && isServiceType(current.type) ? (
        <ActionQueryForm
          type={current.type}
          query={query}
          onChange={(patch, replace) =>
            onChange({ resource, query: replace ? patch : { ...query, ...patch } })
          }
          code={({ field, value, onChange: set, language, height }) => (
            <Code
              path={ctx.modelPath(`${models}query.${field.key}`)}
              language={language}
              height={height}
              value={value}
              problems={ctx.problemsAt(...at, 'query', field.key)}
              text={ctx.text(...at, 'query', field.key)}
              onChange={set}
            />
          )}
        />
      ) : kind === null ? (
        <p className="text-sm text-muted">
          This query's resource isn't there: its query is kept as it is until you choose another resource.
        </p>
      ) : kind === 'openapi' ? (
        <OpenApiInspector
          query={query}
          setQuery={setQuery}
          ctx={ctx}
          at={at}
          models={models}
          resource={current}
        />
      ) : kind === 'graphql' ? (
        <GraphqlQueryForm
          query={query}
          setQuery={setQuery}
          ctx={ctx}
          at={at}
          models={models}
          resource={current}
        />
      ) : (
        <RestQueryForm
          query={query}
          setQuery={setQuery}
          ctx={ctx}
          at={at}
          models={models}
          builtIn={kind === 'restapi'}
        />
      )}
    </div>
  )
}

/**
 * A message resource's query (Pub/Sub M19, SQS and Kafka M26): send to a topic or queue, messages as JSON with
 * `{{ }}`.
 */
function MessageQueryForm({
  kind,
  query,
  setQuery,
  ctx,
  at,
  models,
}: {
  kind: MessageKind
  query: Record<string, unknown>
  setQuery: (patch: Record<string, unknown>) => void
  ctx: FormContext
  at: (string | number)[]
  models: string
}) {
  const q = MESSAGE_QUERIES[kind]
  return (
    <div className="flex flex-col gap-4">
      <Field label={q.label} hint={q.hint}>
        <Input
          className="font-mono"
          placeholder="orders"
          data-testid={`query-${q.target}`}
          value={String(query[q.target] ?? '')}
          onChange={(e) => setQuery({ [q.target]: e.target.value })}
        />
      </Field>
      <EditorField label="Messages" hint={q.messagesHint}>
        <Code
          path={ctx.modelPath(`${models}messages`)}
          language="plaintext"
          height={140}
          value={String(query.messages ?? '')}
          problems={ctx.problemsAt(...at, 'query', 'messages')}
          text={ctx.text(...at, 'query', 'messages')}
          onChange={(messages) => setQuery({ messages })}
        />
      </EditorField>
    </div>
  )
}

/** An OpenAPI resource's operation (M29): the shared form, with this editor's code fields. */
function OpenApiInspector({
  query,
  setQuery,
  ctx,
  at,
  models,
  resource,
}: {
  query: Record<string, unknown>
  setQuery: (patch: Record<string, unknown>) => void
  ctx: FormContext
  at: (string | number)[]
  models: string
  resource: Parameters<typeof useOpenApiOperations>[0]
}) {
  const { operations, message } = useOpenApiOperations(resource)
  return (
    <OpenApiQueryForm
      query={query}
      operations={operations}
      message={message}
      onChange={setQuery}
      code={({ field, value, onChange, height }) => (
        <Code
          path={ctx.modelPath(`${models}query.${field}`)}
          language="json"
          height={height}
          value={value}
          problems={ctx.problemsAt(...at, 'query', field)}
          text={ctx.text(...at, 'query', field)}
          onChange={onChange}
        />
      )}
    />
  )
}

/**
 * A GraphQL query (M27): the operation, its variables as JSON with `{{ }}` (values go there, never into the query),
 * the operation to run when there are several, and headers.
 */
function GraphqlQueryForm({
  query,
  setQuery,
  ctx,
  at,
  models,
  resource,
}: {
  query: Record<string, unknown>
  setQuery: (patch: Record<string, unknown>) => void
  ctx: FormContext
  at: (string | number)[]
  models: string
  resource: Parameters<typeof useGraphqlSchema>[0]
}) {
  const schema = useGraphqlSchema(resource)
  return (
    <div className="flex flex-col gap-4">
      <EditorField label="Query" hint="Values go in the variables as $name, not {{ }} in the query.">
        <Code
          path={ctx.modelPath(`${models}query.query`)}
          language="graphql"
          height={200}
          graphqlSchema={schema}
          value={String(query.query ?? '')}
          problems={ctx.problemsAt(...at, 'query', 'query')}
          text={ctx.text(...at, 'query', 'query')}
          onChange={(text) => setQuery({ query: text })}
        />
      </EditorField>
      <EditorField label="Variables" hint='JSON with {{ }}, e.g. {"id": {{ startTrigger.data.id }}}'>
        <Code
          path={ctx.modelPath(`${models}query.variables`)}
          language="plaintext"
          height={100}
          value={String(query.variables ?? '')}
          problems={ctx.problemsAt(...at, 'query', 'variables')}
          text={ctx.text(...at, 'query', 'variables')}
          onChange={(variables) => setQuery({ variables })}
        />
      </EditorField>
      <Field label="Operation name" hint="Only when the query has several operations.">
        <Input
          className="font-mono"
          value={String(query.operationName ?? '')}
          onChange={(e) => setQuery({ operationName: e.target.value })}
        />
      </Field>
      <KeyValues
        label="Headers"
        rows={(query.headers as KeyValue[]) ?? []}
        onChange={(headers) => setQuery({ headers })}
      />
    </div>
  )
}

/** A REST query; the built-in REST API's (M27) has a full URL instead of a path, and its own sign-in. */
function RestQueryForm({
  query,
  setQuery,
  ctx,
  at,
  models,
  builtIn = false,
}: {
  query: Record<string, unknown>
  setQuery: (patch: Record<string, unknown>) => void
  ctx: FormContext
  at: (string | number)[]
  models: string
  builtIn?: boolean
}) {
  const urlKey = builtIn ? 'url' : 'path'
  const body = (query.body ?? { type: 'none' }) as {
    type: string
    json?: string
    raw?: string
    fields?: KeyValue[]
    parts?: MultipartPart[]
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
          aria-label={builtIn ? 'URL' : 'Path'}
          className="font-mono"
          placeholder={
            builtIn
              ? 'https://api.example.com/orders/{{ startTrigger.data.id }}'
              : '/orders/{{ startTrigger.data.id }}'
          }
          value={String(query[urlKey] ?? '')}
          onChange={(e) => setQuery({ [urlKey]: e.target.value })}
        />
      </div>
      {builtIn && (
        <RequestAuthFields
          auth={query.auth as Parameters<typeof RequestAuthFields>[0]['auth']}
          onChange={(auth) => setQuery({ auth })}
          secretsHint="Read secrets from secret config vars, e.g. {{ configVars.API_TOKEN }}: they reach live runs only, and are kept out of logs."
        />
      )}
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
                      : type === 'multipart'
                        ? { type, parts: [] }
                        : { type: 'none' },
            })
          }}
        >
          <option value="none">No body</option>
          <option value="json">JSON</option>
          <option value="form">Form</option>
          <option value="multipart">Multipart</option>
          <option value="raw">Raw</option>
        </Select>
      </Field>
      {body.type === 'json' && (
        <Code
          path={ctx.modelPath(`${models}body.json`)}
          language="plaintext"
          height={140}
          value={body.json ?? ''}
          problems={ctx.problemsAt(...at, 'query', 'body', 'json')}
          text={ctx.text(...at, 'query', 'body', 'json')}
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
      {body.type === 'multipart' && (
        <MultipartParts
          compact
          parts={body.parts ?? []}
          onChange={(parts) => setQuery({ body: { type: 'multipart', parts } })}
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
              text={ctx.text('config', 'conditions', i, 'expression')}
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
              updateGraph((def) => ({
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
          text={ctx.text('config', 'input')}
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
          text={ctx.text('config', 'condition')}
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
          text={ctx.text('config', 'body')}
          onChange={(body) => set({ body })}
        />
      </EditorField>
    </div>
  )
}

/** A one-line `{{ }}` template. */
function TemplateLine({
  path,
  value,
  onChange,
  problems,
  text,
  removeEmpty,
  placeholder,
}: {
  path: string
  value: string
  onChange: (value: string) => void
  problems?: FieldProblem[]
  /** The template's place in the definition (shared editing). */
  text?: (string | number)[]
  /** Cleared, the template is removed from the definition. */
  removeEmpty?: boolean
  placeholder?: string
}) {
  return (
    <div title={placeholder}>
      <Code
        path={path}
        language="plaintext"
        singleLine
        height={30}
        value={value}
        problems={problems}
        text={text}
        removeEmpty={removeEmpty}
        onChange={onChange}
      />
    </div>
  )
}

type LoopConfig = BlockOf<'loop'>['config']
type Runner = LoopConfig['runner']

function LoopForm({ block, ctx }: { block: BlockOf<'loop'>; ctx: FormContext }) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.resources.list.queryOptions())
  const functions = useEditor((s) => s.definition.functions) ?? []
  const config = block.config
  const set = (patch: Partial<LoopConfig>) =>
    updateBlock<BlockOf<'loop'>>(block.name, (b) => {
      const next = { ...b.config, ...patch } as Record<string, unknown>
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      return { ...b, config: next as LoopConfig }
    })
  const setRunner = (runner: Runner) => set({ runner })
  const mode = config.mode ?? 'parallel'
  const runner = config.runner
  const num = (value: string, min = 0) =>
    value === '' ? undefined : Math.max(min, Math.round(Number(value)))
  const iteration = config.iteration ?? {}
  const setIteration = (patch: Record<string, unknown>) => {
    const next = { ...iteration, ...patch } as Record<string, unknown>
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
    set({ iteration: Object.keys(next).length ? (next as LoopConfig['iteration']) : undefined })
  }

  return (
    <div className="flex flex-col gap-4">
      <EditorField label="Items" hint="A {{ }} that gives an array, e.g. {{ query1.data }}.">
        <TemplateLine
          path={ctx.modelPath('input.txt')}
          value={config.input}
          problems={ctx.problemsAt('config', 'input')}
          text={ctx.text('config', 'input')}
          onChange={(input) => set({ input })}
        />
      </EditorField>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Run">
          <Select value={mode} onChange={(e) => set({ mode: e.target.value as LoopConfig['mode'] })}>
            <option value="parallel">In parallel</option>
            <option value="sequential">One at a time</option>
            <option value="batch">In batches</option>
          </Select>
        </Field>
        {mode === 'parallel' && (
          <Field label="At once">
            <Input
              type="number"
              min={1}
              max={MAX_LOOP_CONCURRENCY}
              placeholder={String(DEFAULT_LOOP_CONCURRENCY)}
              value={config.concurrency ?? ''}
              onChange={(e) => set({ concurrency: num(e.target.value, 1) })}
            />
          </Field>
        )}
        {mode === 'batch' && (
          <>
            <Field label="Batch size">
              <Input
                type="number"
                min={1}
                placeholder={String(DEFAULT_LOOP_BATCH_SIZE)}
                value={config.batchSize ?? ''}
                onChange={(e) => set({ batchSize: num(e.target.value, 1) })}
              />
            </Field>
            <Field label="Pause between batches (ms)">
              <Input
                type="number"
                min={0}
                placeholder="0"
                value={config.batchDelayMs ?? ''}
                onChange={(e) => set({ batchDelayMs: num(e.target.value) })}
              />
            </Field>
          </>
        )}
      </div>

      <Field label="For each item, run">
        <Select
          value={runner.kind}
          onChange={(e) => {
            const kind = e.target.value as Runner['kind']
            if (kind === runner.kind) return
            const resource = data?.resources[0]
            setRunner(
              kind === 'code'
                ? { kind, code: 'return value' }
                : kind === 'query'
                  ? {
                      kind,
                      resource: resource?.slug ?? '',
                      query: (resource
                        ? defaultQuery(resource.type, 'select {{ value }}')
                        : { sql: 'select {{ value }}' }) as never,
                    }
                  : kind === 'function'
                    ? { kind, function: functions[0]?.name ?? '' }
                    : kind === 'library'
                      ? { kind, library: '', version: 'latest' }
                      : { kind, workflow: '' },
            )
          }}
        >
          <option value="code">Code</option>
          <option value="query">A resource query</option>
          <option value="library">A library query</option>
          <option value="function">A function</option>
          <option value="workflow">A workflow</option>
        </Select>
      </Field>
      {runner.kind === 'code' && (
        <LanguageCode
          language={runner.language}
          code={runner.code}
          model="runner"
          height={180}
          hints={{
            javascript: "value is the item and index its position; return the item's result.",
            python: "value is the item and index its position; return the item's result (no network).",
          }}
          problems={ctx.problemsAt('config', 'runner', 'code')}
          text={ctx.text('config', 'runner', 'code')}
          ctx={ctx}
          onChange={(next) => setRunner(withLanguage({ ...runner, ...next }))}
        />
      )}
      {runner.kind === 'query' && (
        <QueryEditor
          resource={runner.resource}
          query={runner.query as Record<string, unknown>}
          at={['config', 'runner']}
          models="runner."
          ctx={ctx}
          onChange={(next) =>
            setRunner({ kind: 'query', resource: next.resource, query: next.query as never })
          }
        />
      )}
      {runner.kind === 'library' && (
        <LibraryCall
          call={runner}
          at={['config', 'runner']}
          ctx={ctx}
          hint="Parameters may use value and index."
          onChange={(call) => setRunner({ kind: 'library', ...call })}
        />
      )}
      {runner.kind === 'function' && (
        <FunctionArgs
          fn={runner.function}
          params={runner.params}
          at={['config', 'runner']}
          ctx={ctx}
          hint="Arguments may use value and index."
          onChange={(fn, params) => setRunner({ kind: 'function', function: fn, ...(params && { params }) })}
        />
      )}
      {runner.kind === 'workflow' && (
        <ChildWorkflow
          workflow={runner.workflow}
          input={runner.input}
          mode={runner.mode}
          at={['config', 'runner']}
          ctx={ctx}
          onChange={(patch) => setRunner({ ...runner, ...patch })}
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="When an item fails">
          <Select
            value={config.onError ?? 'stop'}
            onChange={(e) => set({ onError: e.target.value === 'stop' ? undefined : 'continue' })}
          >
            <option value="stop">Fail the loop</option>
            <option value="continue">Leave null and go on</option>
          </Select>
        </Field>
        <Field label="Per item: timeout (ms)">
          <Input
            type="number"
            min={100}
            placeholder={String(DEFAULT_BLOCK_SETTINGS.timeoutMs)}
            value={iteration.timeoutMs ?? ''}
            onChange={(e) => setIteration({ timeoutMs: num(e.target.value, 100) })}
          />
        </Field>
        <Field label="Per item: retries">
          <Input
            type="number"
            min={0}
            max={10}
            placeholder="0"
            value={iteration.retry?.count ?? ''}
            onChange={(e) => {
              const count = num(e.target.value)
              setIteration({ retry: count === undefined ? undefined : { ...iteration.retry, count } })
            }}
          />
        </Field>
      </div>
    </div>
  )
}

/** A function to call and a template for each of its parameters (a Function block, a loop's function runner). */
function FunctionArgs({
  fn,
  params,
  onChange,
  at,
  ctx,
  hint,
}: {
  fn: string
  params: Record<string, string> | undefined
  onChange: (fn: string, params: Record<string, string> | undefined) => void
  at: (string | number)[]
  ctx: FormContext
  hint?: string
}) {
  const functions = useEditor((s) => s.definition.functions) ?? []
  const chosen = functions.find((f) => f.name === fn)
  return (
    <div className="flex flex-col gap-3">
      <Field label="Function">
        <Select
          value={fn}
          onChange={(e) => {
            // Keep the arguments the other function also takes.
            const next = functions.find((f) => f.name === e.target.value)
            const kept = Object.fromEntries(
              Object.entries(params ?? {}).filter(([k]) => next?.params?.some((p) => p.name === k)),
            )
            onChange(e.target.value, Object.keys(kept).length ? kept : undefined)
          }}
        >
          {!chosen && <option value={fn}>{fn ? `${fn} (not found)` : 'Choose a function…'}</option>}
          {functions.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}({(f.params ?? []).map((p) => p.name).join(', ')})
            </option>
          ))}
        </Select>
      </Field>
      {functions.length === 0 && (
        <p className="text-xs text-muted">Create a function in the Functions tab first.</p>
      )}
      {(chosen?.params ?? []).map((param) => (
        <EditorField key={param.name} label={<span className="font-mono">{param.name}</span>}>
          <TemplateLine
            path={ctx.modelPath(`${at.join('.')}.params.${param.name}.txt`)}
            value={params?.[param.name] ?? ''}
            problems={ctx.problemsAt(...at, 'params', param.name)}
            text={ctx.text(...at, 'params', param.name)}
            onChange={(value) => {
              const next = { ...params }
              if (value) next[param.name] = value
              else delete next[param.name]
              onChange(fn, Object.keys(next).length ? next : undefined)
            }}
            removeEmpty
          />
        </EditorField>
      ))}
      {hint && chosen?.params?.length ? <p className="-mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

function FunctionCallForm({ block, ctx }: { block: BlockOf<'function'>; ctx: FormContext }) {
  return (
    <FunctionArgs
      fn={block.config.function}
      params={block.config.params}
      at={['config']}
      ctx={ctx}
      onChange={(fn, params) =>
        updateBlock<BlockOf<'function'>>(block.name, (b) => ({
          ...b,
          config: { function: fn, ...(params && { params }) },
        }))
      }
    />
  )
}

type LibraryCallConfig = BlockOf<'libraryQuery'>['config']

/**
 * The library query to run, its version and the parameters' templates (a Library query block, a loop's library
 * runner; M21). The parameters shown are the chosen release's, plus any passed that it doesn't declare.
 */
function LibraryCall({
  call,
  onChange,
  at,
  ctx,
  hint,
}: {
  call: LibraryCallConfig
  onChange: (call: LibraryCallConfig) => void
  at: (string | number)[]
  ctx: FormContext
  hint?: string
}) {
  const trpc = useTRPC()
  const list = useQuery(trpc.libraryQueries.list.queryOptions())
  const ref = useEditor((s) => s.libraries[call.library])
  const id = ref?.id ?? list.data?.find((q) => q.slug === call.library)?.id
  const releases = useQuery({
    ...trpc.libraryQueries.releases.queryOptions({ libraryQueryId: id ?? '' }),
    enabled: !!id,
  })
  const published = (list.data ?? []).filter((q) => q.liveVersion)
  const chosen = published.find((q) => q.slug === call.library)
  const release = releases.data?.find((r) =>
    call.version === 'latest' ? r.live : r.version === call.version,
  )
  const declared = release?.params ?? []
  const extra = Object.keys(call.params ?? {}).filter((name) => !declared.some((p) => p.name === name))
  const setParam = (name: string, value: string) => {
    const params = { ...call.params }
    if (value) params[name] = value
    else delete params[name]
    const { params: _old, ...rest } = call
    onChange(Object.keys(params).length ? { ...rest, params } : rest)
  }
  return (
    <div className="flex flex-col gap-3" data-testid="library-call">
      <div className="flex items-end gap-2">
        <Field label="Library query" className="min-w-0 flex-1">
          <Select
            value={call.library}
            onChange={(e) => onChange({ library: e.target.value, version: 'latest' })}
          >
            {!chosen && (
              <option value={call.library}>
                {call.library ? `${call.library} (not found)` : 'Choose a library query…'}
              </option>
            )}
            {published.map((q) => (
              <option key={q.slug} value={q.slug}>
                {q.name} ({q.slug})
              </option>
            ))}
          </Select>
        </Field>
        {call.library && (
          <Link
            to="/library/$slug"
            params={{ slug: call.library }}
            title="Open in the Query Library"
            className="mb-2 text-muted hover:text-ink"
          >
            <ExternalLink className="size-4" />
          </Link>
        )}
      </div>
      {list.data && published.length === 0 && (
        <p className="text-xs text-muted">
          Only published library queries you can use are listed.{' '}
          <Link to="/library" className="text-accent hover:underline">
            Open the Query Library
          </Link>
        </p>
      )}
      {call.library && (
        <Field label="Version">
          <Select value={call.version} onChange={(e) => onChange({ ...call, version: e.target.value })}>
            <option value="latest">
              Latest, whichever is live{ref?.liveVersion ? ` (now v${ref.liveVersion})` : ''}
            </option>
            {releases.data?.map((r) => (
              <option key={r.id} value={r.version}>
                v{r.version}
              </option>
            ))}
            {call.version !== 'latest' && !releases.data?.some((r) => r.version === call.version) && (
              <option value={call.version}>v{call.version}</option>
            )}
          </Select>
        </Field>
      )}
      <Problems list={[...ctx.problemsAt(...at, 'library'), ...ctx.problemsAt(...at, 'version')]} />
      {release && declared.length === 0 && extra.length === 0 && (
        <p className="text-xs text-muted">This release has no parameters.</p>
      )}
      {[...declared, ...extra.map((name) => ({ name, description: undefined }))].map((p) => (
        <EditorField
          key={p.name}
          label={<span className="font-mono">{p.name}</span>}
          hint={p.description ?? (extra.includes(p.name) ? 'Not a parameter of this release' : undefined)}
        >
          <TemplateLine
            path={ctx.modelPath(`${at.join('.')}.params.${p.name}.txt`)}
            value={call.params?.[p.name] ?? ''}
            problems={ctx.problemsAt(...at, 'params', p.name)}
            text={ctx.text(...at, 'params', p.name)}
            onChange={(value) => setParam(p.name, value)}
            removeEmpty
          />
        </EditorField>
      ))}
      {hint && declared.length > 0 && <p className="-mt-1 text-xs text-muted">{hint}</p>}
      {release && (
        <details className="rounded-md border border-border" data-testid="library-call-query">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            The query (v{release.version}, on {release.resource})
          </summary>
          <pre className="overflow-x-auto px-3 pb-3 font-mono text-xs whitespace-pre-wrap">
            {typeof release.query.sql === 'string'
              ? release.query.sql
              : JSON.stringify(release.query, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}

function LibraryQueryForm({ block, ctx }: { block: BlockOf<'libraryQuery'>; ctx: FormContext }) {
  return (
    <LibraryCall
      call={block.config}
      at={['config']}
      ctx={ctx}
      onChange={(config) => updateBlock<BlockOf<'libraryQuery'>>(block.name, (b) => ({ ...b, config }))}
    />
  )
}

/** The child workflow to run, its input and whether to wait for it (a Workflow block, a loop's workflow runner). */
function ChildWorkflow({
  workflow,
  input,
  mode,
  onChange,
  at,
  ctx,
}: {
  workflow: string
  input: string | undefined
  mode: 'sync' | 'async' | undefined
  onChange: (patch: { workflow?: string; input?: string; mode?: 'sync' | 'async' }) => void
  at: (string | number)[]
  ctx: FormContext
}) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.workflows.list.queryOptions())
  const current = useEditor((s) => s.workflowId)
  const workflows = (data ?? []).filter((w) => w.id !== current)
  const chosen = workflows.find((w) => w.slug === workflow)
  return (
    <div className="flex flex-col gap-3">
      <Field label="Workflow">
        <Select value={workflow} onChange={(e) => onChange({ workflow: e.target.value })}>
          {!chosen && (
            <option value={workflow}>{workflow ? `${workflow} (not found)` : 'Choose a workflow…'}</option>
          )}
          {workflows.map((w) => (
            <option key={w.slug} value={w.slug}>
              {w.name} ({w.slug}){w.liveReleaseId ? '' : ' · not published'}
            </option>
          ))}
        </Select>
      </Field>
      <EditorField
        label="Input"
        hint="JSON with {{ }}; the child reads it as startTrigger.data. Its live release runs."
      >
        <Code
          path={ctx.modelPath(`${at.join('.')}.input.txt`)}
          language="plaintext"
          height={90}
          value={input ?? ''}
          problems={ctx.problemsAt(...at, 'input')}
          text={ctx.text(...at, 'input')}
          onChange={(next) => onChange({ input: next })}
        />
      </EditorField>
      <Field label="Then">
        <Select
          value={mode ?? 'sync'}
          onChange={(e) => onChange({ mode: e.target.value as 'sync' | 'async' })}
        >
          <option value="sync">Wait for it; its Response body is the result</option>
          <option value="async">Start it and go on; the result is its run id</option>
        </Select>
      </Field>
    </div>
  )
}

function WorkflowForm({ block, ctx }: { block: BlockOf<'workflow'>; ctx: FormContext }) {
  return (
    <ChildWorkflow
      workflow={block.config.workflow}
      input={block.config.input}
      mode={block.config.mode}
      at={['config']}
      ctx={ctx}
      onChange={(patch) =>
        updateBlock<BlockOf<'workflow'>>(block.name, (b) => {
          const config = { ...b.config, ...patch }
          if (!config.input) delete config.input
          if (config.mode === 'sync') delete config.mode
          return { ...b, config }
        })
      }
    />
  )
}

function WaitForm({ block, ctx }: { block: BlockOf<'wait'>; ctx: FormContext }) {
  const config = block.config
  const set = (next: BlockOf<'wait'>['config']) =>
    updateBlock<BlockOf<'wait'>>(block.name, (b) => ({ ...b, config: next }))
  return (
    <div className="flex flex-col gap-4">
      <Field label="Wait">
        <Select
          value={config.kind}
          onChange={(e) =>
            set(
              e.target.value === 'until'
                ? { kind: 'until', until: '{{ dayjs().add(1, "day").toISOString() }}' }
                : { kind: 'duration', amount: '1', unit: 'minutes' },
            )
          }
        >
          <option value="duration">For a while</option>
          <option value="until">Until a date and time</option>
        </Select>
      </Field>
      {config.kind === 'duration' ? (
        <div className="grid grid-cols-[1fr_8rem] gap-2">
          <EditorField label="How long">
            <TemplateLine
              path={ctx.modelPath('amount.txt')}
              value={config.amount}
              problems={ctx.problemsAt('config', 'amount')}
              text={ctx.text('config', 'amount')}
              onChange={(amount) => set({ ...config, amount })}
            />
          </EditorField>
          <Field label="Unit">
            <Select
              value={config.unit}
              onChange={(e) => set({ ...config, unit: e.target.value as WaitUnit })}
            >
              {WAIT_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : (
        <EditorField label="Until" hint="An ISO date and time, or a {{ }} that gives one.">
          <TemplateLine
            path={ctx.modelPath('until.txt')}
            value={config.until}
            problems={ctx.problemsAt('config', 'until')}
            text={ctx.text('config', 'until')}
            onChange={(until) => set({ kind: 'until', until })}
          />
        </EditorField>
      )}
      <p className="text-xs text-muted">
        At most 60 days. The run gives up its worker while it waits, and the time doesn't count toward the
        run's timeout.
      </p>
    </div>
  )
}

type TaskConfig = BlockOf<'userTask'>['config']
type TaskFieldDef = NonNullable<TaskConfig['fields']>[number]

const TONE = { error: 'text-danger', warning: 'text-warning-strong' } as const

/** Problems under a plain input (Monaco fields show theirs as markers). */
function Problems({ list }: { list: FieldProblem[] }) {
  if (!list.length) return null
  return (
    <div className="flex flex-col gap-0.5">
      {list.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: messages have no identity
        <span key={i} className={cn('text-xs', TONE[p.severity])}>
          {p.message}
        </span>
      ))}
    </div>
  )
}

function UserTaskForm({ block, ctx }: { block: BlockOf<'userTask'>; ctx: FormContext }) {
  const trpc = useTRPC()
  const groups = useQuery(trpc.groups.list.queryOptions())
  const config = block.config
  const set = (patch: Partial<TaskConfig>) =>
    updateBlock<BlockOf<'userTask'>>(block.name, (b) => ({ ...b, config: { ...b.config, ...patch } }))
  const users = config.assignees.users ?? []
  const groupNames = config.assignees.groups ?? []
  const fields = config.fields ?? []
  const outcomes = config.outcomes ?? []
  const setAssignees = (patch: Partial<TaskConfig['assignees']>) =>
    set({ assignees: { ...config.assignees, ...patch } })
  const setField = (i: number, patch: Partial<TaskFieldDef>) =>
    set({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) })
  const listId = `groups-${block.name}`

  return (
    <div className="flex flex-col gap-4">
      <EditorField label="Title" hint="What the person is asked, as it appears in their inbox.">
        <TemplateLine
          path={ctx.modelPath('title.txt')}
          value={config.title}
          problems={ctx.problemsAt('config', 'title')}
          text={ctx.text('config', 'title')}
          onChange={(title) => set({ title })}
        />
      </EditorField>
      <EditorField label="Description" hint="Optional. Plain text with {{ }}.">
        <Code
          path={ctx.modelPath('description.txt')}
          language="plaintext"
          height={80}
          value={config.description ?? ''}
          problems={ctx.problemsAt('config', 'description')}
          text={ctx.text('config', 'description')}
          onChange={(description) => set({ description: description || undefined })}
          removeEmpty
        />
      </EditorField>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Assigned to</span>
        <span className="text-xs text-muted">
          Anyone listed (or in a listed group) can complete it; admins always can. Emails can be {'{{ }}'}.
        </span>
        {users.map((u, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries have no identity besides their position
          <div key={i} className="flex items-start gap-1.5">
            <div className="flex-1">
              <TemplateLine
                path={ctx.modelPath(`assignee-${i}.txt`)}
                value={u}
                problems={ctx.problemsAt('config', 'assignees', 'users', i)}
                text={ctx.text('config', 'assignees', 'users', i)}
                onChange={(v) => setAssignees({ users: users.map((x, j) => (j === i ? v : x)) })}
              />
            </div>
            <Button
              size="icon"
              variant="ghost"
              title="Remove"
              onClick={() => setAssignees({ users: users.filter((_, j) => j !== i) })}
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
        {groupNames.map((g, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries have no identity besides their position
          <div key={`g${i}`} className="flex flex-col gap-0.5">
            <div className="flex gap-1.5">
              <Input
                aria-label="Group"
                className="h-8"
                list={listId}
                placeholder="Group name"
                value={g}
                onChange={(e) =>
                  setAssignees({ groups: groupNames.map((x, j) => (j === i ? e.target.value : x)) })
                }
              />
              <Button
                size="icon"
                variant="ghost"
                title="Remove"
                onClick={() => setAssignees({ groups: groupNames.filter((_, j) => j !== i) })}
              >
                <X className="size-4" />
              </Button>
            </div>
            <Problems list={ctx.problemsAt('config', 'assignees', 'groups', i)} />
          </div>
        ))}
        <datalist id={listId}>
          {groups.data?.map((group) => (
            <option key={group.id} value={group.name} />
          ))}
        </datalist>
        <Problems
          list={ctx.problemsAt('config', 'assignees').filter((p) => !/email|group is named/.test(p.message))}
        />
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setAssignees({ users: [...users, ''] })}>
            <Plus className="size-4" /> User
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAssignees({ groups: [...groupNames, ''] })}>
            <Plus className="size-4" /> Group
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Form fields</span>
        {fields.map((f, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fields are edited in place, by position
            key={i}
            className="flex flex-col gap-1.5 rounded-md border border-border p-2"
            data-testid={`task-field-${i}`}
          >
            <div className="flex gap-1.5">
              <Input
                aria-label="Field label"
                className="h-8"
                placeholder="Label"
                value={f.label}
                onChange={(e) => setField(i, { label: e.target.value })}
              />
              <Input
                aria-label="Field name"
                className="h-8 w-32 font-mono"
                placeholder="name"
                value={f.name}
                onChange={(e) => setField(i, { name: e.target.value })}
              />
              <Button
                size="icon"
                variant="ghost"
                title="Remove field"
                onClick={() => set({ fields: fields.filter((_, j) => j !== i) })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <Select
                aria-label="Field type"
                className="h-8"
                value={f.type}
                onChange={(e) => setField(i, { type: e.target.value as TaskFieldDef['type'] })}
              >
                <option value="text">Text</option>
                <option value="longText">Long text</option>
                <option value="number">Number</option>
                <option value="checkbox">Checkbox</option>
                <option value="select">Choice</option>
              </Select>
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={!!f.required}
                  onChange={(e) => setField(i, { required: e.target.checked || undefined })}
                />
                Required
              </label>
            </div>
            {f.type === 'select' && (
              <Input
                aria-label="Options"
                className="h-8"
                placeholder="Options, comma separated"
                value={(f.options ?? []).join(', ')}
                onChange={(e) => setField(i, { options: e.target.value.split(',').map((o) => o.trim()) })}
              />
            )}
            <Input
              aria-label="Starting value"
              className="h-8 font-mono"
              placeholder="Starting value or {{ }}"
              value={f.default ?? ''}
              onChange={(e) => setField(i, { default: e.target.value || undefined })}
            />
            <Problems list={ctx.problemsAt('config', 'fields', i)} />
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => {
            let n = fields.length + 1
            while (fields.some((f) => f.name === `field${n}`)) n++
            set({ fields: [...fields, { name: `field${n}`, label: `Field ${n}`, type: 'text' }] })
          }}
        >
          <Plus className="size-4" /> Field
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Buttons</span>
        <span className="text-xs text-muted">
          Each completes the task; the block's data has the one pressed as{' '}
          <code className="font-mono">outcome</code>. Without any, there's one Submit button.
        </span>
        {outcomes.map((o, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: outcomes are edited in place, by position
          <div key={i} className="flex flex-col gap-0.5">
            <div className="flex gap-1.5">
              <Input
                aria-label="Button label"
                className="h-8"
                placeholder="Label"
                value={o.label}
                onChange={(e) =>
                  set({ outcomes: outcomes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })
                }
              />
              <Input
                aria-label="Outcome id"
                className="h-8 w-32 font-mono"
                placeholder="id"
                value={o.id}
                onChange={(e) =>
                  set({ outcomes: outcomes.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })
                }
              />
              <Button
                size="icon"
                variant="ghost"
                title="Remove"
                onClick={() => set({ outcomes: outcomes.filter((_, j) => j !== i) })}
              >
                <X className="size-4" />
              </Button>
            </div>
            <Problems list={ctx.problemsAt('config', 'outcomes', i)} />
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => {
            let n = outcomes.length + 1
            while (outcomes.some((o) => o.id === `option${n}`)) n++
            set({ outcomes: [...outcomes, { id: `option${n}`, label: `Option ${n}` }] })
          }}
        >
          <Plus className="size-4" /> Button
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="inline-flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={!!config.due}
            onChange={(e) => set({ due: e.target.checked ? { amount: '1', unit: 'days' } : undefined })}
          />
          Due after
        </label>
        {config.due && (
          <div className="grid grid-cols-[1fr_8rem] gap-2">
            <TemplateLine
              path={ctx.modelPath('due.txt')}
              value={config.due.amount}
              problems={ctx.problemsAt('config', 'due', 'amount')}
              text={ctx.text('config', 'due', 'amount')}
              onChange={(amount) => set({ due: { ...config.due!, amount } })}
            />
            <Select
              aria-label="Due unit"
              value={config.due.unit}
              onChange={(e) =>
                set({ due: { ...config.due!, unit: e.target.value as (typeof TASK_DUE_UNITS)[number] } })
              }
            >
              {TASK_DUE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </div>
        )}
        <span className="text-xs text-muted">
          Past it, the task expires and this block fails. The run gives up its worker while it waits, and the
          time doesn't count toward its timeout. Its data is{' '}
          <code className="font-mono">{'{ outcome, values, completedBy, completedAt }'}</code>.
        </span>
      </div>
    </div>
  )
}

function ErrorTriggerForm({ block }: { block: BlockOf<'errorTrigger'> }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        Runs when the workflow fails: when a block that stops on failure fails, or the run times out. Connect
        the blocks that should run then after it.
      </p>
      <p className="text-muted">
        They read the failure as <code className="font-mono">{block.name}.data</code> ={' '}
        <code className="font-mono">{'{ block, code, message }'}</code>, and can read any block before the
        failure (those that didn't run read as skipped). A Response block here answers a webhook instead of
        the usual 500. The run still ends as failed.
      </p>
    </div>
  )
}

type ExecutableBlock = Exclude<Block, BlockOf<'startTrigger' | 'errorTrigger'>>

/**
 * Timeout, retries and what happens on failure. Unset values show their defaults as placeholders. A loop retries
 * per item (in its own form) and a wait only has "on failure".
 */
function SettingsForm({ block, open }: { block: ExecutableBlock; open?: boolean }) {
  const settings: BlockSettings = block.settings ?? {}
  const retry = settings.retry ?? {}
  const defaults = resolveBlockSettings({ ...block, settings: undefined } as Block)
  const hasTimeout = block.type !== 'wait' && block.type !== 'userTask'
  const hasRetries = block.type !== 'wait' && block.type !== 'userTask' && block.type !== 'loop'
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
    <details className="group rounded-md border border-border" open={open}>
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        {hasRetries ? 'Timeout, retries and failure' : hasTimeout ? 'Timeout and failure' : 'Failure'}
      </summary>
      <div className="grid grid-cols-2 gap-3 border-t border-border p-3">
        {hasTimeout && (
          <Field label="Timeout (ms)">
            <Input
              type="number"
              min={100}
              placeholder={String(defaults.timeoutMs)}
              value={settings.timeoutMs ?? ''}
              onChange={(e) => set({ timeoutMs: num(e.target.value) })}
            />
          </Field>
        )}
        <Field label="On failure">
          <Select
            value={settings.finally ?? defaults.finally}
            onChange={(e) => set({ finally: e.target.value === 'stop' ? undefined : e.target.value })}
          >
            <option value="stop">Stop the run</option>
            <option value="continue">Continue on the error output</option>
          </Select>
        </Field>
        {hasRetries && (
          <>
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
          </>
        )}
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
                d.severity === 'error' ? 'text-danger' : 'text-warning-strong',
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
