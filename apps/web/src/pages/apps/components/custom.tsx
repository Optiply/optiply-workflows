import { type CustomComponentInterface, customInstanceRelease } from '@ow/app-definition'
import type { ComponentLibraryRelease } from '@ow/app-runtime'
import { CONNECT_MESSAGE, type FrameTheme, type FromFrame, type ToFrame } from '@ow/component-sdk/protocol'
import { Blocks, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RendererProps } from '../renderer'
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
      key={`${release.bundleHash}:${ref.component}:${attempt}`}
      name={component.name}
      component={ref.component}
      release={release}
      iface={iface}
      restart={() => setAttempt((n) => n + 1)}
    />
  )
}

/** The bundles fetched so far, by hash (they never change). */
const bundles = new Map<string, Promise<{ js: string; css: string }>>()

export function fetchBundle(hash: string): Promise<{ js: string; css: string }> {
  let found = bundles.get(hash)
  if (!found) {
    const get = async (ext: string) => {
      const res = await fetch(`/api/component-bundles/${hash}.${ext}`, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`The component library's bundle didn't load (${res.status})`)
      return res.text()
    }
    found = Promise.all([get('js'), get('css')]).then(([js, css]) => ({ js, css }))
    found.catch(() => bundles.delete(hash))
    bundles.set(hash, found)
  }
  return found
}

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
  const portRef = useRef<MessagePort | null>(null)
  const [status, setStatus] = useState<FrameStatus>({ kind: 'loading' })
  const propNames = Object.keys(iface.props)
  // The declared props the app evaluated, as one string so a change of any re-sends them all.
  const propsJson = useAppHostState((s) =>
    JSON.stringify(Object.fromEntries(propNames.map((p) => [p, s.values[`${scope}${name}.${p}`] ?? null]))),
  )
  const latestProps = useRef(propsJson)
  latestProps.current = propsJson

  // biome-ignore lint/correctness/useExhaustiveDependencies: the frame is made once per bundle and component (its key); props follow below.
  useEffect(() => {
    let disposed = false
    let loads = 0
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

    const iframe = document.createElement('iframe')
    // No allow-same-origin: an opaque origin, so it reads neither this page nor its cookies.
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.title = component
    iframe.className = 'size-full border-0 bg-transparent'
    const send = (message: ToFrame) => portRef.current?.postMessage(message)

    const onMessage = (event: MessageEvent<FromFrame>) => {
      const message = event.data
      if (disposed || !message || typeof message !== 'object') return
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

    const unregister = host.registerFrame(name, {
      call(method, args) {
        if (!Object.hasOwn(iface.methods, method))
          return Promise.reject(new Error(`${component} has no method "${method}"`))
        if (!portRef.current) return Promise.reject(new Error(`${name} isn't ready yet`))
        return new Promise((resolve, reject) => {
          const id = ++callId
          const timer = window.setTimeout(() => {
            calls.delete(id)
            reject(new Error(`${name}.${method} didn't answer in ${STUCK_MS / 1000} s`))
          }, STUCK_MS)
          calls.set(id, { resolve, reject, timer })
          send({ type: 'call', id, method, args })
        })
      },
    })

    iframe.addEventListener('load', () => {
      loads++
      if (loads > 1) {
        // Its document was replaced: it navigated (to send data somewhere?). Stopped and reported.
        iframe.remove()
        portRef.current?.close()
        portRef.current = null
        fail('The component tried to leave its frame, so it was stopped')
        host.componentLog(name, 'error', 'The component navigated its frame away, so it was stopped')
        return
      }
      const channel = new MessageChannel()
      portRef.current = channel.port1
      channel.port1.onmessage = onMessage
      iframe.contentWindow?.postMessage(CONNECT_MESSAGE, '*', [channel.port2])
      void fetchBundle(release.bundleHash).then(
        ({ js, css }) => {
          if (disposed) return
          const state = Object.fromEntries(
            Object.keys(iface.state).map((s) => [
              s,
              host.store.getState().values[`${scope}${name}.${s}`] ?? iface.state[s]!.default,
            ]),
          )
          send({
            type: 'init',
            js,
            css,
            component,
            props: JSON.parse(latestProps.current),
            state,
            theme: currentTheme(),
          })
        },
        (err: Error) => fail(err.message),
      )
    })

    void import('../runtime/component-frame').then(({ componentFrameDocument }) => {
      if (disposed) return
      iframe.srcdoc = componentFrameDocument(release.allowedOrigins)
      container.current?.appendChild(iframe)
    })

    const pinger = window.setInterval(() => {
      if (!portRef.current) return
      if (performance.now() - lastPong > STUCK_MS) {
        window.clearInterval(pinger)
        iframe.remove()
        if (!disposed) setStatus({ kind: 'stuck' })
        host.componentLog(name, 'error', `It stopped answering for ${STUCK_MS / 1000} s, so it was stopped`)
        return
      }
      send({ type: 'ping', n: ++ping })
    }, PING_MS)

    // The theme follows the page's light/dark switch.
    const observer = new MutationObserver(() => send({ type: 'theme', theme: currentTheme() }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      disposed = true
      window.clearInterval(pinger)
      observer.disconnect()
      unregister()
      for (const call of calls.values()) {
        window.clearTimeout(call.timer)
        call.reject(new Error(`${name} is gone`))
      }
      portRef.current?.close()
      portRef.current = null
      iframe.remove()
    }
  }, [])

  // Props the app re-evaluated go in as they change.
  useEffect(() => {
    if (status.kind === 'ready')
      portRef.current?.postMessage({ type: 'props', props: JSON.parse(propsJson) } satisfies ToFrame)
  }, [propsJson, status.kind])

  return (
    <div
      className="relative size-full overflow-hidden"
      data-custom-component={component}
      data-frame-status={status.kind}
    >
      <div ref={container} className="size-full" />
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
