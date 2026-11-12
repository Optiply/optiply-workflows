import { MAX_JS_PACKAGES } from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Button, ErrorNote, Field, Spinner, Textarea } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'

/**
 * A workflow's or app's JavaScript packages: npm packages, one a line (`zod@^3`, `date-fns`), bundled for its
 * JavaScript code, which imports them at the top (`import { z } from 'zod'`). Blank lines aren't kept; the
 * validator's problems show under the field, by line; for people with Edit, whether they're installed and Install
 * now. The registries are the admins' (Settings → npm registries).
 */

export interface JsPackagesTarget {
  kind: 'workflow' | 'app'
  id: string
}

export function JsPackagesField({
  target,
  packages,
  problems,
  canEdit,
  hasEdit,
  onChange,
}: {
  target: JsPackagesTarget
  packages: readonly string[] | undefined
  /** The validator's `invalid_js_package` problems: `index` is the line's, or none for the whole list. */
  problems: { index?: number; message: string }[]
  canEdit: boolean
  /** Edit on the workflow or app: the install state and Install now (about the packages, not this draft). */
  hasEdit: boolean
  /** The lines, trimmed, blank ones left out; none left: the setting goes. */
  onChange: (packages: string[]) => void
}) {
  const stored = packages?.join('\n') ?? ''
  const [text, setText] = useState(stored)
  // Someone else's change (a collaborator, undo, a reload) shows here; the field's own blank lines stay while typing.
  useEffect(() => {
    setText((current) => (packageLines(current).join('\n') === stored ? current : stored))
  }, [stored])
  const what =
    target.kind === 'app'
      ? "this app's JavaScript queries, transformers and scripts"
      : "this workflow's JavaScript code"
  return (
    <Field
      as="div"
      label="JavaScript packages"
      hint={`npm packages for ${what}, one a line (zod@^3, date-fns), at most ${MAX_JS_PACKAGES}; import them at the top of the code: import { z } from 'zod'. Bundled for the sandbox (packages that need Node itself, like fs, can't run there); kept with each release.`}
    >
      <Textarea
        rows={3}
        className="font-mono text-xs"
        disabled={!canEdit}
        placeholder="date-fns@^4"
        spellCheck={false}
        aria-label="JavaScript packages"
        data-testid="js-packages"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(packageLines(e.target.value))
        }}
      />
      {problems.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-danger" data-testid="js-package-problems">
          {problems.map((p) => (
            <li key={`${p.index ?? 'all'}-${p.message}`}>
              {p.index !== undefined ? `${packages?.[p.index] ?? `Line ${p.index + 1}`}: ` : ''}
              {p.message}
            </li>
          ))}
        </ul>
      )}
      {hasEdit && packages?.length && !problems.length ? (
        <JsPackagesState target={target} packages={packages} />
      ) : null}
    </Field>
  )
}

/**
 * Whether these packages are installed: their versions and the bundle's size, the Node built-ins some package
 * reaches for, npm's or the bundler's reason when it failed, or not yet; Install now so the next run doesn't wait.
 * Asked again a moment after the field stops changing.
 */
function JsPackagesState({ target, packages }: { target: JsPackagesTarget; packages: readonly string[] }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settled = useSettled([...packages], 600)
  const state = useQuery(trpc.jsPackages.state.queryOptions({ target, packages: settled }))
  const install = useMutation(
    trpc.jsPackages.install.mutationOptions({
      // Under the packages it installed: the field may have changed since.
      onSuccess: (data, sent) => queryClient.setQueryData(trpc.jsPackages.state.queryKey(sent), data),
    }),
  )
  const data = state.data
  // Installs what the field holds now (the state below may still be the settled value's, a moment behind).
  const button = (label: string) => (
    <Button
      size="sm"
      loading={install.isPending}
      onClick={() => install.mutate({ target, packages: [...packages] })}
    >
      {label}
    </Button>
  )
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="js-packages-state">
      {install.isPending ? (
        <span className="text-muted">Installing… (a first install can take a minute)</span>
      ) : !data ? (
        <Spinner />
      ) : data.state === 'none' ? (
        <div className="flex items-center gap-2">
          <span className="text-muted">Not installed yet: the next run installs them first.</span>
          {button('Install now')}
        </div>
      ) : data.state === 'invalid' ? (
        <span className="text-danger">{data.error}</span>
      ) : data.state === 'ready' ? (
        <>
          <span className="text-muted">
            Installed:{' '}
            {Object.entries(data.versions)
              .map(([name, version]) => `${name}@${version}`)
              .join(', ')}{' '}
            ({formatBytes(data.sizeBytes)})
          </span>
          {data.warnings.map((w) => (
            <span key={w} className="text-warning-strong">
              {w}
            </span>
          ))}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="whitespace-pre-wrap text-danger">Install failed: {data.error}</span>
            {button('Try again')}
          </div>
          {data.log && (
            <details>
              <summary className="cursor-pointer text-muted">npm's output</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-2 font-mono">
                {data.log}
              </pre>
            </details>
          )}
        </>
      )}
      <ErrorNote error={install.error ?? state.error} />
    </div>
  )
}

/** The field's lines as packages: trimmed, blank ones left out. */
export function packageLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** `value` once it has stayed the same for `ms` (compared as JSON). */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  const key = JSON.stringify(value)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `value`
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [key, ms])
  return settled
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
