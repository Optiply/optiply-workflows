import { type AppDiagnostic, renameAppEntity } from '@ow/app-definition'
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react'
import type { CodeFieldProps, FieldProblem } from '@/components/code/code-field'
import { Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAppHostState } from '../runtime/react'
import { appScope } from './scope'
import { useAppEditor } from './store'

// Monaco is big: it loads the first time a code field is shown.
const LazyCodeField = lazy(() => import('@/components/code/code-field'))

/** A Monaco field whose completions know the app's components, queries and their current values. */
export function AppCodeField(props: Omit<CodeFieldProps, 'path'> & { path: (string | number)[] }) {
  const definition = useAppEditor((s) => s.definition)
  const appId = useAppEditor((s) => s.appId)
  const values = useAppHostState((s) => s.values)
  const scope = useMemo(() => appScope(definition, values), [definition, values])
  return (
    <Suspense
      fallback={
        <div
          style={{ height: props.height }}
          className="animate-pulse rounded-md border border-border bg-canvas"
        />
      }
    >
      <LazyCodeField {...props} path={`file:///app/${appId}/${props.path.join('/')}`} scope={scope} />
    </Suspense>
  )
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
          className={cn('text-xs', p.severity === 'error' ? 'text-danger' : 'text-amber-600')}
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
