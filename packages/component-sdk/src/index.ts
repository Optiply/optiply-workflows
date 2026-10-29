import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { currentBridge } from './bridge'
import type { FrameTheme } from './protocol'

/**
 * The SDK custom components are written with (M25): `import { useProp, … } from '@ow/component-sdk'`. Every name a
 * hook takes is one the component declares in its library (Components panel): props the app sets, state the app
 * reads (`custom1.selected`), events whose handlers the app runs, methods the app calls (`custom1.highlight(2)`).
 */

function useBridge() {
  const bridge = currentBridge()
  useSyncExternalStore(bridge.subscribe, bridge.snapshot, bridge.snapshot)
  return bridge
}

/** A prop's value as the app evaluated it (its declared default when the app leaves it empty). */
export function useProp<T = unknown>(name: string): T {
  return useBridge().props[name] as T
}

/** Every prop by name. */
export function useProps<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  return useBridge().props as T
}

/**
 * A state value and its setter. The app reads it as `<component>.<name>` and is told of each change; it starts from
 * the declared default.
 */
export function useStateValue<T = unknown>(name: string): [T, (next: T | ((previous: T) => T)) => void] {
  const bridge = useBridge()
  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      const value = typeof next === 'function' ? (next as (p: T) => T)(bridge.state[name] as T) : next
      bridge.setState(name, value)
    },
    [bridge, name],
  )
  return [bridge.state[name] as T, set]
}

/** A function that fires one of the component's events: the app runs its handlers. */
export function useEvent(name: string): () => void {
  const bridge = currentBridge()
  return useCallback(() => bridge.fire(name), [bridge, name])
}

/**
 * Answers the app's calls to one of the component's methods (`custom1.<name>(…)` in its code or handlers) with
 * `fn`'s result, awaited when it's a promise. The latest `fn` answers.
 */
export function useMethod(name: string, fn: (...args: never[]) => unknown): void {
  const bridge = currentBridge()
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    const call = (...args: unknown[]) => (latest.current as (...a: unknown[]) => unknown)(...args)
    bridge.methods.set(name, call)
    return () => {
      if (bridge.methods.get(name) === call) bridge.methods.delete(name)
    }
  }, [bridge, name])
}

/** Light or dark, and the Optiply tokens (also CSS variables `--ow-<name>` on the frame's root). */
export function useTheme(): FrameTheme {
  return useBridge().theme
}

/** What the app does for a component, after checking it as for the app's own code. */
export const utils = {
  openUrl(url: string, options: { newTab?: boolean } = {}) {
    currentBridge().util({
      action: 'openUrl',
      url,
      ...(options.newTab !== undefined && { newTab: options.newTab }),
    })
  },
  openPage(page: string, params?: Record<string, string>) {
    currentBridge().util({ action: 'openPage', page, ...(params && { params }) })
  },
  notify(message: string, tone: 'info' | 'success' | 'error' = 'info') {
    currentBridge().util({ action: 'notify', message, tone })
  },
}

export type { FrameTheme } from './protocol'
