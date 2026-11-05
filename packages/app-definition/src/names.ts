import { isReservedWord, JS_GLOBALS } from '@ow/definition'

/** The stdlib the app runtime preloads, like the server sandbox's. */
export const APP_STDLIB_GLOBALS: ReadonlySet<string> = new Set(['_', 'dayjs', 'sql', 'console'])

/**
 * Added by the app runtime: `current_user` (`{ id, email, name }`), `utils` (`notify`, `openUrl`, `openPage`,
 * `copyToClipboard`, `downloadFile`), `appContext` (`{ appSlug, environment, version }`) and `url` (`{ page,
 * params }`, the page shown and its URL's query parameters; values in the graph, since they change as people move
 * between pages) and `localStorage` (`{ values }`, what the app keeps in this browser; session 41).
 */
export const APP_RUNTIME_GLOBALS: ReadonlySet<string> = new Set([
  'current_user',
  'utils',
  'appContext',
  'url',
  'localStorage',
])

/** Names an app's code can read without them being one of its components, queries, transformers or variables. */
export function isAppGlobalName(name: string): boolean {
  return JS_GLOBALS.has(name) || APP_STDLIB_GLOBALS.has(name) || APP_RUNTIME_GLOBALS.has(name)
}

/** Why `name` can't name something in an app, or null if it can. Assumes the identifier pattern matched. */
export function appNameReason(name: string): string | null {
  if (isReservedWord(name)) return `"${name}" is a JavaScript keyword`
  if (isAppGlobalName(name)) return `"${name}" is already a global available to the app`
  return null
}
