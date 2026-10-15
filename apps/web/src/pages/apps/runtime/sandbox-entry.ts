/**
 * Runs inside the app's sandbox: an iframe with an opaque origin (`sandbox="allow-scripts"`) and a CSP without
 * network access, so the app's code can't read the page, use the viewer's session or send data anywhere. It talks
 * to the page only over the MessagePort the page hands it in its first message.
 *
 * Bundled on its own by vite/app-runtime.ts; the stdlib (`_`, `dayjs`) is loaded before it.
 */
import {
  AppRuntime,
  CONNECT_MESSAGE,
  type Effect,
  type HostBridge,
  type HostMessage,
  type LogLevel,
  type QueryOutcome,
  type SandboxMessage,
  type StatePatch,
} from '@ow/app-runtime'

let port: MessagePort | null = null
let runtime: AppRuntime | null = null
let globals: Record<string, unknown> = {}
let nextId = 1
const pending = new Map<number, (value: never) => void>()

window.addEventListener('message', (event) => {
  // Only the page that holds this frame, only once.
  if (port || event.source !== window.parent || event.data !== CONNECT_MESSAGE || !event.ports[0]) return
  port = event.ports[0]
  port.onmessage = (e: MessageEvent<HostMessage>) => handle(e.data)
  send({ type: 'ready' })
})

function send(message: SandboxMessage) {
  port?.postMessage(message)
}

function request<T>(make: (id: number) => SandboxMessage): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve) => {
    pending.set(id, resolve as (value: never) => void)
    send(make(id))
  })
}

function settle(id: number, value: unknown) {
  const resolve = pending.get(id)
  pending.delete(id)
  resolve?.(value as never)
}

/** Values the app produced may hold functions or other things a message can't carry; those become plain JSON. */
function publish(patch: StatePatch) {
  try {
    send({ type: 'patch', patch })
  } catch {
    const values: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch.values)) values[key] = toPlain(value)
    send({ type: 'patch', patch: { ...patch, values } })
  }
}

function toPlain(value: unknown): unknown {
  try {
    structuredClone(value)
    return value
  } catch {
    try {
      const text = JSON.stringify(value)
      return text === undefined ? null : JSON.parse(text)
    } catch {
      return String(value)
    }
  }
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.message
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

const log = (level: LogLevel, message: string) => send({ type: 'log', level, message })

/** What the app's code sees as `console`: printed here and in the page's app console. */
const appConsole = Object.fromEntries(
  (['log', 'info', 'warn', 'error'] as const).map((level) => [
    level,
    (...args: unknown[]) => {
      console[level](...args)
      log(level, format(args))
    },
  ]),
)

const bridge: HostBridge = {
  runQuery: (query, values) => request<QueryOutcome>((id) => ({ type: 'runQuery', id, query, values })),
  confirm: (message) => request<boolean>((id) => ({ type: 'confirm', id, message })),
  effect: (effect: Effect) => send({ type: 'effect', effect }),
  publish,
  log,
}

function handle(message: HostMessage) {
  switch (message.type) {
    case 'start': {
      if (runtime) return
      try {
        const g = globalThis as unknown as { _: unknown; dayjs: unknown }
        globals = { ...message.globals, _: g._, dayjs: g.dayjs, console: appConsole }
        runtime = new AppRuntime(message.definition, bridge, { globals })
        const loading = runtime.start()
        send({ type: 'started' })
        void loading
      } catch (err) {
        send({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    case 'update': {
      if (!runtime) return
      try {
        const next = new AppRuntime(message.definition, bridge, { globals })
        void next.start({ previous: runtime })
        runtime = next
      } catch (err) {
        log('error', `The edited app could not start: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }
    case 'set':
      runtime?.set(message.updates)
      return
    case 'fire':
      void runtime?.fire(message.owner, message.event)
      return
    case 'call':
      runtime?.call(message.entity, message.method, message.args).catch((err: unknown) => {
        log(
          'error',
          `${message.entity}.${message.method}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      return
    case 'trigger':
      // Failures are in the query's state (and notified for manual queries).
      runtime?.trigger(message.query).catch(() => {})
      return
    case 'queryResult':
      settle(message.id, message.outcome)
      return
    case 'confirmResult':
      settle(message.id, message.ok)
      return
  }
}
