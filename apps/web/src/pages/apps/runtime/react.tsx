import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { AppHost, type AppHostOptions, type AppHostState } from './host'

/**
 * React bindings for a running app: `useAppHost` owns the host (and its sandbox) for as long as the page shows the
 * app; components read their values with `useAppValue`.
 */

const HostContext = createContext<AppHost | null>(null)

export function AppHostProvider({ host, children }: { host: AppHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>
}

export function useAppHostContext(): AppHost {
  const host = useContext(HostContext)
  if (!host) throw new Error('No app is running here')
  return host
}

/** One value of the app (`textInput1.value`), re-rendering when it changes. */
export function useAppValue<T = unknown>(key: string): T {
  return useStore(useAppHostContext().store, (s) => s.values[key] as T)
}

export function useAppError(key: string): string | undefined {
  return useStore(useAppHostContext().store, (s) => s.errors[key])
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
