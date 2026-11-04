import type { ComponentLibraryDefinition, CustomComponentDefinition } from '@ow/app-definition'
import type { FromFrame } from '@ow/component-sdk/protocol'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Hammer, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, ErrorNote, Field, Input, SectionLabel, Select } from '@/components/ui'
import { errorMessage, type RouterOutputs, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { currentTheme } from '../apps/components/custom'
import { type MountedFrame, mountComponentFrame } from '../apps/runtime/frame-mount'
import { useComponentLibraryEditor } from './store'

type Detail = RouterOutputs['componentLibraries']['get']
type Outcome = RouterOutputs['componentLibraries']['build']

const STAGES = { validate: 'Not valid', install: 'Installing packages failed', bundle: 'Bundling failed' }

/**
 * Build and Preview (M25): the draft built on the server (its packages installed, its components bundled; problems
 * shown on their files), then a component previewed in a frame like an app's, with its props' test values. What it
 * sets and fires is listed; its methods can be called.
 */
export function BuildCard({
  detail,
  branchDraftId,
  definition,
  ensureSaved,
}: {
  detail: Detail
  branchDraftId: string | null
  definition: ComponentLibraryDefinition
  ensureSaved: () => Promise<number>
}) {
  const trpc = useTRPC()
  const build = useMutation(trpc.componentLibraries.build.mutationOptions())
  const [saveError, setSaveError] = useState<string | null>(null)
  const [built, setBuilt] = useState<Extract<Outcome, { ok: true }> | null>(null)
  const [component, setComponent] = useState<string | null>(null)
  const setBuildProblems = useComponentLibraryEditor((s) => s.setBuildProblems)
  const setLock = useComponentLibraryEditor((s) => s.setLock)
  const shown = definition.components.find((c) => c.name === component) ?? definition.components[0]
  const outcome = build.data
  const canEdit = detail.level === 'edit' || detail.level === 'own'
  const remoteChanges = useComponentLibraryEditor((s) => s.remoteChanges)
  // Pushes from the components CLI (M33): a change from elsewhere asks whether it was one; a new one rebuilds.
  const lastPush = useQuery({
    ...trpc.componentLibraries.lastPush.queryOptions({ componentLibraryId: detail.id }),
    enabled: canEdit && !branchDraftId,
  })
  const followed = useRef<number | null>(null)

  const run = async () => {
    setSaveError(null)
    try {
      await ensureSaved()
    } catch (err) {
      return setSaveError(errorMessage(err))
    }
    build.mutate(
      { componentLibraryId: detail.id, ...(branchDraftId && { branchDraftId }) },
      {
        onSuccess: (result) => {
          setBuildProblems(result.ok ? [] : result.problems)
          if (result.ok) {
            setBuilt(result)
            if (!branchDraftId) setLock(result.lock)
          }
        },
      },
    )
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: asks again after a change from elsewhere
  useEffect(() => {
    if (!remoteChanges || !lastPush.isFetched) return
    const timer = setTimeout(() => void lastPush.refetch(), 400)
    return () => clearTimeout(timer)
  }, [remoteChanges])
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for a new push only
  useEffect(() => {
    if (lastPush.data === undefined) return
    const at = lastPush.data ? new Date(lastPush.data.at).getTime() : 0
    if (followed.current === null) {
      followed.current = at // what was there when the editor opened: nothing to follow
      return
    }
    if (at > followed.current) {
      followed.current = at
      if (canEdit && !build.isPending) void run()
    }
  }, [lastPush.data])

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="library-build">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel className="flex-1">Build and preview</SectionLabel>
        {outcome?.ok && (
          <Badge tone="success">
            Built{outcome.cached ? ' (unchanged)' : ''} · {(outcome.sizeBytes / 1024).toFixed(0)} KB
          </Badge>
        )}
        {outcome && !outcome.ok && <Badge tone="danger">{STAGES[outcome.stage]}</Badge>}
        {canEdit && (
          <Button
            size="sm"
            variant="primary"
            loading={build.isPending}
            onClick={run}
            data-testid="build-library"
          >
            <Hammer className="size-3.5" /> Build
          </Button>
        )}
      </div>
      {lastPush.data && (
        <p className="text-xs text-muted" data-testid="library-last-push">
          Pushed from the CLI by {lastPush.data.by}, {new Date(lastPush.data.at).toLocaleString()}
          {lastPush.data.revision ? ` (draft revision ${lastPush.data.revision})` : ''}
        </p>
      )}
      <ErrorNote error={saveError ?? build.error} />
      {outcome && !outcome.ok && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="build-problems">
          {outcome.problems.map((p) => (
            <li
              key={`${p.file}:${p.line}:${p.column}:${p.message}`}
              className="font-mono text-xs whitespace-pre-wrap text-danger"
            >
              {p.file && `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ''}` : ''}: `}
              {p.message}
            </li>
          ))}
          {outcome.log && (
            <details className="text-xs text-muted">
              <summary>npm's output</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{outcome.log}</pre>
            </details>
          )}
        </ul>
      )}
      {!built && !outcome && (
        <p className="text-sm text-muted">
          Build the draft to preview its components with their test values.
        </p>
      )}
      {built && shown && (
        <>
          <Field label="Component" className="w-64">
            <Select
              aria-label="Preview component"
              value={shown.name}
              onChange={(e) => setComponent(e.target.value)}
            >
              {definition.components.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label || c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Preview
            // Origins or the component's declaration changed with the same bundle: a new frame all the same.
            key={`${built.bundleHash}:${JSON.stringify(definition.allowedOrigins)}:${JSON.stringify(shown)}`}
            bundleHash={built.bundleHash}
            origins={definition.allowedOrigins}
            component={shown}
          />
        </>
      )}
      <UseTheCli slug={detail.slug} />
    </Card>
  )
}

/** How to work on this library from a folder with the components CLI (M33). */
function UseTheCli({ slug }: { slug: string }) {
  const origin = window.location.origin
  return (
    <details className="text-xs text-muted" data-testid="use-the-cli">
      <summary className="cursor-pointer">Use the CLI</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p>
          Work on this library in your own editor: make a token under Settings → Access tokens, then (Node 20
          or later):
        </p>
        <pre className="overflow-auto rounded-md bg-canvas p-2 font-mono text-ink">
          {[
            `curl -O ${origin}/api/cli/ow-components.mjs`,
            `node ow-components.mjs login ${origin}`,
            `node ow-components.mjs pull ${slug}`,
            `cd ${slug} && node ../ow-components.mjs dev`,
          ].join('\n')}
        </pre>
        <p>
          <code className="font-mono">dev</code> pushes each saved file into this draft and builds it; this
          Preview follows. <code className="font-mono">push --publish 1.2.0</code> publishes a release.
        </p>
      </div>
    </details>
  )
}

interface Entry {
  id: number
  text: string
  tone: 'info' | 'error'
}

/** A built component in a frame with its props' test values (their defaults when unset). */
function Preview({
  bundleHash,
  origins,
  component,
}: {
  bundleHash: string
  origins: string[]
  component: CustomComponentDefinition
}) {
  const container = useRef<HTMLDivElement>(null)
  const port = useRef<MountedFrame | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [state, setState] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(Object.entries(component.state).map(([n, s]) => [n, s.default])),
  )
  const [args, setArgs] = useState<Record<string, string>>({})
  const [ready, setReady] = useState(false)
  const nextId = useRef(0)
  const pending = useRef(new Map<number, string>())
  const add = (text: string, tone: Entry['tone'] = 'info') =>
    setEntries((list) => [...list.slice(-49), { id: nextId.current++, text, tone }])

  // biome-ignore lint/correctness/useExhaustiveDependencies: one frame per bundle, origins and component (the key)
  useEffect(() => {
    const onMessage = (m: FromFrame) => {
      switch (m.type) {
        case 'ready':
          setReady(true)
          return
        case 'setState':
          setState((s) => ({ ...s, [m.name]: m.value }))
          add(`state ${m.name} = ${JSON.stringify(m.value)}`)
          return
        case 'event':
          add(`event ${m.name}`)
          return
        case 'util':
          add(
            `utils.${m.action}(${JSON.stringify('message' in m ? m.message : 'url' in m ? m.url : m.page)})`,
          )
          return
        case 'result': {
          const method = pending.current.get(m.id)
          pending.current.delete(m.id)
          add(
            m.ok ? `${method} → ${JSON.stringify(m.value)}` : `${method} failed: ${m.error}`,
            m.ok ? 'info' : 'error',
          )
          return
        }
        case 'error':
        case 'log':
          add(String(m.message), 'error')
          return
      }
    }
    const frame = mountComponentFrame(container.current!, {
      title: `Preview of ${component.name}`,
      bundleHash,
      origins,
      init: () => ({
        component: component.name,
        props: Object.fromEntries(
          Object.entries(component.props).map(([n, p]) => [
            n,
            p.testValue !== undefined ? p.testValue : p.default,
          ]),
        ),
        state,
        theme: currentTheme(),
      }),
      onMessage,
      onError: (message) => add(message, 'error'),
      onLeft: () => add('The component navigated its frame away, so it was stopped', 'error'),
    })
    port.current = frame
    return () => {
      frame.close()
      port.current = null
    }
  }, [])

  const call = (method: string) => {
    let parsed: unknown[] = []
    const text = args[method]?.trim()
    if (text) {
      try {
        const value = JSON.parse(`[${text}]`)
        parsed = Array.isArray(value) ? value : [value]
      } catch {
        return add(`${method}: the arguments aren't JSON (write them as for a call: 2, "a")`, 'error')
      }
    }
    const id = nextId.current++
    pending.current.set(id, method)
    port.current?.post({ type: 'call', id, method, args: parsed })
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div
        ref={container}
        className="h-72 overflow-hidden rounded-md border border-border bg-surface"
        data-testid="library-preview"
        data-ready={ready}
      />
      <div className="flex flex-col gap-2 text-xs">
        {Object.keys(state).length > 0 && (
          <div>
            <SectionLabel>State</SectionLabel>
            <ul className="font-mono" data-testid="preview-state">
              {Object.entries(state).map(([name, value]) => (
                <li key={name} className="truncate">
                  {name}: {JSON.stringify(value)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {Object.entries(component.methods).map(([method, m]) => (
          <div key={method} className="flex items-center gap-1">
            <Input
              aria-label={`Arguments of ${method}`}
              className="h-7 flex-1 font-mono text-xs"
              placeholder={m.params.join(', ') || 'no arguments'}
              value={args[method] ?? ''}
              onChange={(e) => setArgs((a) => ({ ...a, [method]: e.target.value }))}
            />
            <Button size="sm" variant="ghost" disabled={!ready} onClick={() => call(method)}>
              <Play className="size-3" /> {method}
            </Button>
          </div>
        ))}
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto font-mono" data-testid="preview-log">
          {entries.map((e) => (
            <li
              key={e.id}
              className={cn('truncate', e.tone === 'error' ? 'text-danger' : 'text-muted')}
              title={e.text}
            >
              {e.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
