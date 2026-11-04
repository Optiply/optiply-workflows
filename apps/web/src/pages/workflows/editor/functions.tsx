import {
  type FunctionDefinition,
  functionReturnBlock,
  identifierSchema,
  renameFunction,
  reservedNameReason,
} from '@ow/definition'
import { ArrowLeft, Plus, SquareFunction, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { Button, Field, Input, Select, Textarea } from '@/components/ui'
import { useEditor } from './store'

/** Updates one function by name. */
function updateFunction(name: string, edit: (fn: FunctionDefinition) => FunctionDefinition) {
  useEditor.getState().update((def) => ({
    ...def,
    functions: (def.functions ?? []).map((f) => (f.name === name ? edit(f) : f)),
  }))
}

/** Why `name` can't be a new function's name, or null. */
function nameProblem(name: string): string | null {
  if (!identifierSchema.safeParse(name).success) {
    return 'Use letters, digits or underscores, starting with a letter or underscore'
  }
  const reserved = reservedNameReason(name)
  if (reserved) return reserved
  const def = useEditor.getState().definition
  if (def.functions?.some((f) => f.name === name)) return `A function is already named "${name}"`
  const graphs = [def, ...(def.functions ?? [])]
  if (graphs.some((g) => g.blocks.some((b) => b.name === name))) return `A block is already named "${name}"`
  return null
}

/** The workflow's functions: reusable subflows called from Function blocks, loops and `await name()` in code. */
export function FunctionsTab({ canEdit }: { canEdit: boolean }) {
  const functions = useEditor((s) => s.definition.functions) ?? []
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = () => {
    const name = draft.trim()
    const problem = nameProblem(name)
    if (problem) return setError(problem)
    useEditor.getState().update((def) => ({
      ...def,
      functions: [
        ...(def.functions ?? []),
        {
          name,
          params: [],
          blocks: [{ name: 'result', type: 'code', config: { code: 'return params' } }],
          edges: [],
        },
      ],
    }))
    setDraft('')
    setError(null)
    useEditor.getState().openGraph(name)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="functions-tab">
      <p className="text-xs text-muted">
        Reusable subflows. Call one from a Function block, a loop, or code with <code>await name(a, b)</code>.
        Its blocks read the arguments as <code>params</code>.
      </p>
      {functions.length === 0 && <p className="text-sm text-muted">No functions yet.</p>}
      <ul className="flex flex-col gap-1">
        {functions.map((fn) => (
          <li key={fn.name}>
            <button
              type="button"
              onClick={() => useEditor.getState().openGraph(fn.name)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-canvas"
            >
              <SquareFunction className="size-4 text-accent" />
              <span className="font-mono text-sm">
                {fn.name}({(fn.params ?? []).map((p) => p.name).join(', ')})
              </span>
              <span className="ml-auto text-xs text-muted">
                {fn.blocks.length} block{fn.blocks.length === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Input
              aria-label="New function name"
              placeholder="lookupCustomer"
              className="h-8 font-mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <Button
              size="sm"
              className="shrink-0 whitespace-nowrap"
              onClick={create}
              disabled={!draft.trim()}
            >
              <Plus className="size-3.5" /> New function
            </Button>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}

/** The open function's name, description, parameters and return block (the side panel with no block selected). */
export function FunctionSettings({ name, canEdit }: { name: string; canEdit: boolean }) {
  const fn = useEditor((s) => s.definition.functions?.find((f) => f.name === name))
  if (!fn) return null
  const params = fn.params ?? []
  const inferred = functionReturnBlock({ ...fn, returns: undefined })

  return (
    <div className="flex flex-col gap-5 p-4" data-testid="function-settings">
      <div className="flex items-start gap-2">
        <span className="mt-1 rounded-md bg-op-blue-1 p-1.5 text-op-blue-4">
          <SquareFunction className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <FunctionNameField name={name} disabled={!canEdit} />
          <div className="mt-1 text-xs text-muted">Function</div>
        </div>
        {canEdit && (
          <Button
            size="icon"
            variant="ghost"
            title="Delete function"
            onClick={async () => {
              if (
                !(await confirmDialog(`Delete function "${name}"? Blocks that call it will show a problem.`, {
                  danger: true,
                  confirm: 'Delete',
                }))
              )
                return
              useEditor.getState().openGraph(null)
              useEditor.getState().update((def) => ({
                ...def,
                functions: (def.functions ?? []).filter((f) => f.name !== name),
              }))
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>

      <Field label="Description">
        <Textarea
          rows={2}
          disabled={!canEdit}
          value={fn.description ?? ''}
          placeholder="What this function does"
          onChange={(e) =>
            updateFunction(name, (f) => {
              const { description: _, ...rest } = f
              return e.target.value ? { ...rest, description: e.target.value } : rest
            })
          }
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Parameters</span>
        <p className="-mt-1 text-xs text-muted">
          In order: <code>await {name}(a, b)</code> passes them by position. Blocks read them as{' '}
          <code>params.name</code>.
        </p>
        {params.map((param, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parameters are edited in place by position
          <div key={i} className="flex gap-1.5">
            <Input
              aria-label="Parameter name"
              className="h-8 font-mono"
              disabled={!canEdit}
              value={param.name}
              onChange={(e) =>
                updateFunction(name, (f) => ({
                  ...f,
                  params: (f.params ?? []).map((p, j) => (j === i ? { ...p, name: e.target.value } : p)),
                }))
              }
            />
            {canEdit && (
              <Button
                size="icon"
                variant="ghost"
                title="Remove parameter"
                onClick={() =>
                  updateFunction(name, (f) => ({ ...f, params: (f.params ?? []).filter((_, j) => j !== i) }))
                }
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() =>
              updateFunction(name, (f) => {
                const taken = new Set((f.params ?? []).map((p) => p.name))
                let n = taken.size + 1
                while (taken.has(`param${n}`)) n++
                return { ...f, params: [...(f.params ?? []), { name: `param${n}` }] }
              })
            }
          >
            <Plus className="size-3.5" /> Add parameter
          </Button>
        )}
      </div>

      <Field label="Returns">
        <Select
          disabled={!canEdit}
          value={fn.returns ?? ''}
          onChange={(e) =>
            updateFunction(name, (f) => {
              const { returns: _, ...rest } = f
              return e.target.value ? { ...rest, returns: e.target.value } : rest
            })
          }
        >
          <option value="">
            {inferred ? `The last block (${inferred})` : 'The last block (choose one)'}
          </option>
          {fn.blocks.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>

      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => useEditor.getState().openGraph(null)}
      >
        <ArrowLeft className="size-3.5" /> Back to the workflow
      </Button>
    </div>
  )
}

/** Renames the function, and every call to it, on Enter or blur. */
function FunctionNameField({ name, disabled }: { name: string; disabled: boolean }) {
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(name), [name])
  const commit = () => {
    if (draft === name) return setError(null)
    const result = renameFunction(useEditor.getState().definition, name, draft)
    if (!result.ok) return setError(result.error)
    setError(null)
    useEditor.getState().update(() => result.definition)
    useEditor.getState().openGraph(draft)
  }
  return (
    <div>
      <Input
        aria-label="Function name"
        data-testid="function-name"
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="h-8 font-mono font-medium"
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}

/** Over the canvas while a function is open: which one, and the way back. */
export function FunctionBanner() {
  const fn = useEditor((s) => s.graph)
  if (fn === null) return null
  return (
    <div
      className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-lg border border-op-blue-2 bg-op-blue-1/95 px-3 py-1.5 text-sm shadow-card"
      data-testid="function-banner"
    >
      <SquareFunction className="size-4 text-accent" />
      <span>
        Editing function <span className="font-mono font-medium">{fn}</span>
      </span>
      <Button size="sm" variant="ghost" onClick={() => useEditor.getState().openGraph(null)}>
        <ArrowLeft className="size-3.5" /> Workflow
      </Button>
    </div>
  )
}
