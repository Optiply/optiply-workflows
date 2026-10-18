/**
 * Light or dark: a preference per browser (system, light or dark), applied as a `dark` class on <html>. index.html
 * applies the stored preference before the first paint; this keeps it applied as it, or the system's, changes.
 */
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

/** Read by the script in index.html too: keep the two in step. */
const STORAGE_KEY = 'ow.theme'

const listeners = new Set<() => void>()
const systemDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system' // Storage blocked: follow the system.
  }
}

let preference: ThemePreference = typeof window === 'undefined' ? 'system' : storedPreference()

/** The theme in effect: the preference, or the system's with `system`. */
export function currentTheme(): Theme {
  return preference === 'dark' || (preference === 'system' && systemDark()) ? 'dark' : 'light'
}

function apply() {
  document.documentElement.classList.toggle('dark', currentTheme() === 'dark')
  for (const listener of listeners) listener()
}

export function setThemePreference(next: ThemePreference): void {
  preference = next
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  apply()
}

if (typeof window !== 'undefined' && typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (preference === 'system') apply()
  })
  // Another tab changed it.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    preference = storedPreference()
    apply()
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The preference and the theme in effect, kept current. */
export function useTheme(): { preference: ThemePreference; theme: Theme } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light' as const)
  const pref = useSyncExternalStore(
    subscribe,
    () => preference,
    () => 'system' as const,
  )
  return { preference: pref, theme }
}
