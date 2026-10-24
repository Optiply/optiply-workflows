import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { AppHost, type AppHostOptions, type AppHostState } from './host'

/**
 * React bindings for a running app: `useAppHost` owns the host (and its sandbox) for as long as the page shows the
 * app; components read their values with `useAppValue`.
 */

const HostContext = createContext<AppHost | null>(null)

/**
 * Inside a module instance (M14): its prefix (`picker1/`, or `shell1/picker1/` nested: M21). Its components' values are the runtime's under that
 * prefix, and the names they send (`set`, `fire`, `call`, `trigger`) get it too, so renderers work unchanged.
 */
const ScopeContext = createContext('')

export function AppHostProvider({ host, children }: { host: AppHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>
}

/** Renders `children` as a module instance's components; inside another instance (M21), under both prefixes. */
export function AppScope({ instance, children }: { instance: string; children: ReactNode }) {
  const outer = useContext(ScopeContext)
  return <ScopeContext.Provider value={`${outer}${instance}/`}>{children}</ScopeContext.Provider>
}

/** The prefix of the module instance rendering here; empty in the app itself. */
export function useAppScope(): string {
  return useContext(ScopeContext)
}

/** The running app's host; inside a module instance, one whose names are the instance's. */
export function useAppHostContext(): AppHost {
  const host = useContext(HostContext)
  const scope = useContext(ScopeContext)
  const scoped = useMemo(() => (host && scope ? scopedHost(host, scope) : host), [host, scope])
  if (!scoped) throw new Error('No app is running here')
  return scoped
}

/** `host` with the names it's given prefixed; everything else is the host's own. */
function scopedHost(host: AppHost, prefix: string): AppHost {
  const own = {
    set: (updates: Record<string, unknown>) =>
      host.set(Object.fromEntries(Object.entries(updates).map(([k, v]) => [prefix + k, v]))),
    fire: (owner: string, event: string) => host.fire(prefix + owner, event),
    call: (entity: string, method: string, args?: unknown[]) => host.call(prefix + entity, method, args),
    trigger: (query: string) => host.trigger(prefix + query),
  }
  return new Proxy(host, {
    get(target, property) {
      if (Object.hasOwn(own, property)) return own[property as keyof typeof own]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** One value of the app (`textInput1.value`), re-rendering when it changes. */
export function useAppValue<T = unknown>(key: string): T {
  const scope = useContext(ScopeContext)
  return useStore(useAppHostContext().store, (s) => s.values[scope + key] as T)
}

export function useAppError(key: string): string | undefined {
  const scope = useContext(ScopeContext)
  return useStore(useAppHostContext().store, (s) => s.errors[scope + key])
}

export function useAppHostState<T>(select: (s: AppHostState) => T): T {
  return useStore(useAppHostContext().store, select)
}

/**
 * Starts the app in a sandbox mounted into the returned ref's element, and stops it on unmount or when `key`
 * changes (another release, environment or draft). Options are read when the host starts.
 */
export function useAppHost(key: string, options: AppHostOptions) {
  const ref = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<AppHost | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is what restarts the sandbox; options are read through the ref.
  useEffect(() => {
    const current = optionsRef.current
    const next = new AppHost({
      ...current,
      notify: (...args) => optionsRef.current.notify(...args),
      confirm: (message) => optionsRef.current.confirm(message),
      ...(current.openPage && {
        openPage: (...args: Parameters<NonNullable<AppHostOptions['openPage']>>) =>
          optionsRef.current.openPage?.(...args),
      }),
      beforeQuery: () => optionsRef.current.beforeQuery?.() ?? Promise.resolve(),
    })
    next.mount(ref.current!)
    setHost(next)
    return () => {
      next.destroy()
      setHost(null)
    }
  }, [key])

  return { ref, host }
}
