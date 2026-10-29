import { type CustomComponentInterface, customInstanceRelease } from '@ow/app-definition'
import type { ComponentLibraryRelease } from '@ow/app-runtime'
import type { FrameTheme, FromFrame } from '@ow/component-sdk/protocol'
import { Blocks, RotateCcw } from 'lucide-react'
import { useContext, useEffect, useRef, useState } from 'react'
import { EditingContext } from '../grid-context'
import type { RendererProps } from '../renderer'
import { fetchBundle, type MountedFrame, mountComponentFrame } from '../runtime/frame-mount'
import { useAppHostContext, useAppHostState, useAppScope } from '../runtime/react'

/**
 * A custom component (M25): its library's bundle running in a frame of its own (an iframe with an opaque origin and
 * a policy allowing only the library's origins, see `runtime/component-frame.ts`). The page passes the props the
 * app evaluated in, and passes on what the component sets (state), fires (events) and asks for (utils); the app's
 * calls to its methods reach it through the host. A frame that stops answering, or navigates away, is stopped.
 */

/** A ping every 2 s; nothing back for 10 s and the frame is stuck. Method calls wait as long. */
const PING_MS = 2_000
const STUCK_MS = 10_000

export function CustomRenderer({ component }: RendererProps) {
  const ref = customInstanceRelease(component)
  const release = useAppHostState((s) =>
    ref && Object.hasOwn(s.libraries, ref.key) ? s.libraries[ref.key] : undefined,
  )
  const iface =
    ref && release && Object.hasOwn(release.components, ref.component)
      ? release.components[ref.component]
      : undefined
  const [attempt, setAttempt] = useState(0)
  if (!ref || !release || !iface) {
    return (
      <div className="flex h-full items-center justify-center gap-2 rounded-md border border-dashed border-border p-2 text-xs text-muted">
        <Blocks className="size-4 shrink-0" />
        <span className="truncate">
          {!ref
            ? 'Pick a component library and component'
            : !release
              ? `Component library ${ref.slug} (${ref.version}) isn't available`
              : `${ref.slug} v${release.version} has no component ${ref.component}`}
        </span>
      </div>
    )
  }
  return (
    <CustomFrame
      // A release changing only its origins or the component's interface keeps its bundle: a new frame all the same.
      key={`${release.bundleHash}:${ref.component}:${JSON.stringify(release.allowedOrigins)}:${JSON.stringify(iface)}:${attempt}`}
      name={component.name}
      component={ref.component}
      release={release}
      iface={iface}
      restart={() => setAttempt((n) => n + 1)}
    />
  )
}

export { fetchBundle }

/** The Optiply tokens a component sees (`--ow-<name>`), from the page's own variables. */
export function currentTheme(): FrameTheme {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  const tokens: Record<string, string> = {}
  for (const name of [
    'accent',
    'accent-soft',
    'accent-strong',
    'on-accent',
    'ink',
    'muted',
    'subtle',
    'faint',
    'surface',
    'canvas',
    'field',
    'border',
    'divider',
    'danger',
    'success',
    'warning',
  ]) {
    const value = read(`--color-${name}`)
    if (value) tokens[name] = value
  }
  const extra = {
    font: read('--font-sans'),
    'font-mono': read('--font-mono'),
    radius: read('--radius-panel'),
  }
  for (const [name, value] of Object.entries(extra)) if (value) tokens[name] = value
  // Plain names for the common ones.
  if (tokens.ink) tokens.text = tokens.ink
  if (tokens.accent) tokens.primary = tokens.accent
  if (tokens.surface) tokens.background = tokens.surface
  return { mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light', tokens }
}

type FrameStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }
  | { kind: 'stuck' }

function CustomFrame({
  name,
  component,
  release,
  iface,
  restart,
}: {
  name: string
  component: string
  release: ComponentLibraryRelease
  iface: CustomComponentInterface
  restart: () => void
}) {
  const host = useAppHostContext()
  const scope = useAppScope()
  const container = useRef<HTMLDivElement>(null)
  const portRef = useRef<MountedFrame | null>(null)
  const [status, setStatus] = useState<FrameStatus>({ kind: 'loading' })
  const propNames = Object.keys(iface.props)
  // The declared props the app evaluated, as one string so a change of any re-sends them all.
  const propsJson = useAppHostState((s) =>
    JSON.stringify(Object.fromEntries(propNames.map((p) => [p, s.values[`${scope}${name}.${p}`] ?? null]))),
  )
  const latestProps = useRef(propsJson)
  latestProps.current = propsJson
  // In the editor, a click on the frame selects the component (a frame keeps its clicks); a double-click lets the
  // component be used until the pointer leaves it.
  const editing = useContext(EditingContext)
  const [using, setUsing] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the frame is made once per release and component (its key); props follow below.
  useEffect(() => {
    let disposed = false
    let lastPong = performance.now()
    let ping = 0
    let callId = 0
    const calls = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
    >()
    const fail = (message: string) => {
      if (!disposed) setStatus({ kind: 'failed', message })
    }
    const settleAll = (why: string) => {
      for (const call of calls.values()) {
        window.clearTimeout(call.timer)
        call.reject(new Error(why))
      }
      calls.clear()
    }
    // Calls to it fail at once once it's gone (stuck, left), rather than waiting for their timeout.
    let unregister = () => {}

    const onMessage = (message: FromFrame) => {
      if (disposed) return
      switch (message.type) {
        case 'ready':
          setStatus({ kind: 'ready' })
          return
        case 'pong':
          lastPong = performance.now()
          return
        case 'setState':
          // Only state the component declares reaches the app.
          if (typeof message.name === 'string' && Object.hasOwn(iface.state, message.name)) {
            host.set({ [`${name}.${message.name}`]: message.value })
          }
          return
        case 'event':
          if (typeof message.name === 'string' && iface.events.includes(message.name))
            host.fire(name, message.name)
          return
        case 'util':
          host.componentUtil(message)
          return
        case 'result': {
          const call = calls.get(message.id)
          if (!call) return
          calls.delete(message.id)
          window.clearTimeout(call.timer)
          if (message.ok) call.resolve(message.value)
          else call.reject(new Error(String(message.error)))
          return
        }
        case 'error':
          fail(String(message.message))
          host.componentLog(name, 'error', String(message.message))
          return
        case 'log':
          host.componentLog(name, message.level === 'warn' ? 'warn' : 'error', String(message.message))
          return
      }
    }

    const frame = mountComponentFrame(container.current!, {
      title: component,
      bundleHash: release.bundleHash,
      origins: release.allowedOrigins,
      init: () => ({
        component,
        props: JSON.parse(latestProps.current),
        state: Object.fromEntries(
          Object.keys(iface.state).map((s) => [
            s,
            host.store.getState().values[`${scope}${name}.${s}`] ?? iface.state[s]!.default,
          ]),
        ),
        theme: currentTheme(),
      }),
      onMessage,
      onError: fail,
      onLeft: () => {
        unregister()
        settleAll(`${name} was stopped`)
        fail('The component tried to leave its frame, so it was stopped')
        host.componentLog(name, 'error', 'The component navigated its frame away, so it was stopped')
      },
    })
    portRef.current = frame

    unregister = host.registerFrame(name, {
      call(method, args) {
        if (!Object.hasOwn(iface.methods, method)) {
          return Promise.reject(new Error(`${component} has no method "${method}"`))
        }
        if (!frame.open) return Promise.reject(new Error(`${name} isn't ready yet`))
        return new Promise((resolve, reject) => {
          const id = ++callId
          const timer = window.setTimeout(() => {
            calls.delete(id)
            reject(new Error(`${name}.${method} didn't answer in ${STUCK_MS / 1000} s`))
          }, STUCK_MS)
          calls.set(id, { resolve, reject, timer })
          frame.post({ type: 'call', id, method, args })
        })
      },
    })

    const pinger = window.setInterval(() => {
      if (!frame.open) return
      if (performance.now() - lastPong > STUCK_MS) {
        window.clearInterval(pinger)
        frame.close()
        unregister()
        settleAll(`${name} stopped responding`)
        if (!disposed) setStatus({ kind: 'stuck' })
        host.componentLog(name, 'error', `It stopped answering for ${STUCK_MS / 1000} s, so it was stopped`)
        return
      }
      frame.post({ type: 'ping', n: ++ping })
    }, PING_MS)

    // The theme follows the page's light/dark switch.
    const observer = new MutationObserver(() => frame.post({ type: 'theme', theme: currentTheme() }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      disposed = true
      window.clearInterval(pinger)
      observer.disconnect()
      unregister()
      settleAll(`${name} is gone`)
      frame.close()
      portRef.current = null
    }
  }, [])

  // Props the app re-evaluated go in as they change.
  useEffect(() => {
    if (status.kind === 'ready') portRef.current?.post({ type: 'props', props: JSON.parse(propsJson) })
  }, [propsJson, status.kind])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only, ends the editor's "use it here" (below)
    <div
      className="relative size-full overflow-hidden"
      data-custom-component={component}
      data-frame-status={status.kind}
      onMouseLeave={() => setUsing(false)}
    >
      <div ref={container} className="size-full" />
      {editing && !using && (
        // biome-ignore lint/a11y/noStaticElementInteractions: a mouse affordance in the editor; keyboard focus reaches the frame
        <div
          className="absolute inset-0"
          title="Double-click to use it here"
          data-testid="custom-editor-cover"
          onDoubleClick={() => setUsing(true)}
        />
      )}
      {(status.kind === 'failed' || status.kind === 'stuck') && (
        <div className="absolute inset-0 flex flex-col items-start gap-2 overflow-auto rounded-md border border-danger bg-surface p-2 text-xs">
          <span className="font-medium text-danger">
            {status.kind === 'stuck' ? `${component} stopped responding` : `${component} failed`}
          </span>
          {status.kind === 'failed' && <span className="whitespace-pre-wrap text-ink">{status.message}</span>}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-ink hover:bg-canvas"
            onClick={restart}
          >
            <RotateCcw className="size-3" /> Restart
          </button>
        </div>
      )}
    </div>
  )
}
