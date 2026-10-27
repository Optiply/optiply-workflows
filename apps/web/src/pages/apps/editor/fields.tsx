import { type AppDiagnostic, renameAppEntity } from '@ow/app-definition'
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react'
import type { CodeFieldProps, FieldProblem } from '@/components/code/code-field'
import type { TextBinding } from '@/components/code/text-binding'
import { Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAppHostState } from '../runtime/react'
import { currentAwareness } from './collab'
import { appScope } from './scope'
import { useAppEditor } from './store'

// Monaco is big: it loads the first time a code field is shown.
const LazyCodeField = lazy(() => import('@/components/code/code-field'))

/**
 * A Monaco field for app code; its completions come from the one scope `ScopeSync` keeps installed. `path` is where
 * its value is in the definition: a text there is edited together with others (M16), unless `bind` is false (fields
 * whose text is parsed into the value, which typing straight into the text would bypass).
 */
export function AppCodeField({
  bind = true,
  removeEmpty,
  ...props
}: Omit<CodeFieldProps, 'path'> & {
  path: (string | number)[]
  bind?: boolean
  /** Cleared, the field is removed from the definition (optional fields where absent means something else). */
  removeEmpty?: boolean
}) {
  const appId = useAppEditor((s) => s.appId)
  const shared = useAppEditor((s) => s.shared)
  const readOnly = useAppEditor((s) => s.readOnly)
  const definition = useAppEditor((s) => s.definition)
  const at = props.path
  const key = at.join('\u0000')
  // Looked up again as the definition changes: the text appears with the field's first value, and is replaced when
  // its item is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `at`; `definition` marks the document changing
  const binding = useMemo((): TextBinding | null => {
    const text = bind && shared && !readOnly ? shared.textAt(at) : null
    if (!text) return null
    return {
      text,
      write: (change) => useAppEditor.getState().editText(at, change, { removeEmpty }),
      undo: () => useAppEditor.getState().undo(),
      redo: () => useAppEditor.getState().redo(),
      awareness: currentAwareness(),
    }
  }, [key, bind, shared, readOnly, definition, removeEmpty])
  return (
    <Suspense
      fallback={
        <div
          style={{ height: props.height }}
          className="animate-pulse rounded-md border border-border bg-canvas"
        />
      }
    >
      <LazyCodeField
        {...props}
        // A protected app on main (M22): shown, not edited.
        readOnly={props.readOnly || readOnly}
        binding={binding}
        path={`file:///app/${appId}/${props.path.join('/')}`}
      />
    </Suspense>
  )
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Text bound to a stored value it's parsed into (JSON props, numbers, variables). The text stays as typed while
 * it means the stored value, so parsing never reformats it under the cursor; it's replaced only when the value
 * changes some other way ("From data", undo, another field).
 */
export function useParsedText<T>(
  value: T,
  toText: (value: T) => string,
  fromText: (text: string) => T,
  onChange: (value: T) => void,
): [string, (text: string) => void] {
  const [text, setText] = useState(() => toText(value))
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new value from outside resets the text
  useEffect(() => {
    setText((current) => (sameJson(fromText(current), value) ? current : toText(value)))
  }, [value])
  return [
    text,
    (next: string) => {
      setText(next)
      onChange(fromText(next))
    },
  ]
}

/** How often completions catch up with the running app's values at most. */
const SCOPE_DELAY_MS = 300

/**
 * Keeps Monaco's completions in step with the app: one `.d.ts` of every component, query, transformer and variable
 * with the types of their current values, rebuilt at most every 300 ms (not once per field per value change).
 */
export function ScopeSync() {
  const definition = useAppEditor((s) => s.definition)
  const values = useAppHostState((s) => s.values)
  useEffect(() => {
    const timer = setTimeout(() => {
      const scope = appScope(definition, values)
      // Monaco is already loading with the code fields; this only waits for it.
      void import('@/components/code/monaco').then(({ setScope }) => setScope(scope.dts, scope.sample))
    }, SCOPE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [definition, values])
  return null
}

/** Validator problems at or under a path of the definition, as editor markers. */
export function problemsAt(diagnostics: AppDiagnostic[], path: (string | number)[]): FieldProblem[] {
  return diagnostics
    .filter((d) => path.every((p, i) => d.path[i] === p))
    .map((d) => ({ start: d.start, end: d.end, message: d.message, severity: d.severity }))
}

/** Problems (messages) of a path, for fields that aren't Monaco. */
export function ProblemList({ path }: { path: (string | number)[] }) {
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const problems = problemsAt(diagnostics, path)
  if (!problems.length) return null
  return (
    <ul className="flex flex-col gap-0.5">
      {problems.map((p) => (
        <li
          key={`${p.start ?? ''}:${p.message}`}
          className={cn('text-xs', p.severity === 'error' ? 'text-danger' : 'text-warning-strong')}
        >
          {p.message}
        </li>
      ))}
    </ul>
  )
}

/**
 * Like `Field`, but a `div`: Monaco must not sit inside a `<label>`, which redirects clicks to the label's control
 * and breaks Monaco's focus handling.
 */
export function EditorField({
  label,
  hint,
  children,
  aside,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">{label}</span>
          <span className="ml-auto">{aside}</span>
        </div>
      ) : null}
      {label || !aside ? (
        children
      ) : (
        // No label (a checkbox carries its own): the aside sits beside the control.
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{children}</div>
          {aside}
        </div>
      )}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  )
}

/** The name of a component, query, transformer or variable; renaming rewrites every reference to it. */
export function NameField({ name, onRenamed }: { name: string; onRenamed?: (next: string) => void }) {
  const update = useAppEditor((s) => s.update)
  const readOnly = useAppEditor((s) => s.readOnly)
  const [text, setText] = useState(name)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setText(name)
    setError(null)
  }, [name])
  const commit = () => {
    const next = text.trim()
    if (next === name) return setError(null)
    const result = renameAppEntity(useAppEditor.getState().definition, name, next)
    if (!result.ok) return setError(result.error)
    setError(null)
    update(() => result.definition)
    onRenamed?.(next)
  }
  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label="Name"
        value={text}
        disabled={readOnly}
        className="h-8 font-mono text-sm"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(name)
        }}
      />
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  )
}

/** A value as short, readable JSON. */
export function ValuePreview({ value, className }: { value: unknown; className?: string }) {
  const text = useMemo(() => {
    if (value === undefined) return 'undefined'
    try {
      const json = JSON.stringify(value, null, 2)
      return json.length > 20_000 ? `${json.slice(0, 20_000)}\n…` : json
    } catch {
      return String(value)
    }
  }, [value])
  return (
    <pre
      className={cn(
        'overflow-auto rounded-md bg-canvas p-2 font-mono text-xs whitespace-pre-wrap',
        className,
      )}
    >
      {text}
    </pre>
  )
}
