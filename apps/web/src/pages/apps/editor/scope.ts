import {
  type AppDefinition,
  appEntities,
  type Entity,
  entityMethods,
  entityProperties,
  VARIABLE_METHODS,
} from '@ow/app-definition'
import type { CodeScope } from '@/components/code/code-field'
import { SQL_HELPERS, typeOf } from '../../workflows/editor/scope-types'

/**
 * Completions for the app editor: a `.d.ts` declaring every component, query, transformer and variable with the
 * types of their current values (from the running draft) and their methods, plus the app's globals.
 */

const GLOBALS = `
/** Lodash. */
declare const _: any
/** Day.js, with the utc, timezone, customParseFormat and relativeTime plugins. */
declare const dayjs: any
${SQL_HELPERS}
/** Who is using the app. In a resource query, a {{ }} reading only current_user is filled in by the server. */
declare const current_user: { id: string; email: string; name: string }
declare const appContext: { appSlug: string; environment: string; version: string | null }
/** The page shown (null in an app without pages) and the query parameters of its URL. */
declare const url: { page: string | null; params: Record<string, string> }
/** What the app keeps in this browser (Set local storage), by key. */
declare const localStorage: { values: Record<string, any> }
declare const utils: {
  /** Shows a notification. */
  notify(message: any, tone?: 'info' | 'success' | 'error'): void
  /** Opens an http(s) or mailto link. */
  openUrl(url: string, options?: { newTab?: boolean }): void
  /** Opens one of the app's pages; params become its URL's query string (read back as url.params, strings). */
  openPage(page: string, options?: { params?: Record<string, any>; newTab?: boolean }): void
  copyToClipboard(text: any): void
  /** Saves data as a file: a string as-is, an array of objects as CSV for a .csv name, JSON otherwise. */
  downloadFile(data: any, fileName?: string): void
}
/** In a query's transform: the query's result. */
declare const data: any
`

function methodSignatures(entity: Entity): string[] {
  const params = (names: readonly string[]) => names.map((n) => `${n}?: any`).join(', ')
  switch (entity.kind) {
    case 'query':
      return ['trigger(options?: { additionalScope?: Record<string, any> }): Promise<any>', 'reset(): void']
    case 'variable':
      return Object.entries(VARIABLE_METHODS).map(([name, m]) => `${name}(${params(m.params)}): void`)
    case 'component':
      return entityMethods(entity).map(
        (name) => `${name}(${params(entity.spec!.methods[name]!.params)}): any`,
      )
    case 'transformer':
    case 'url':
    case 'storage':
    case 'inputs':
      return []
  }
}

export function appScope(def: AppDefinition, values: Record<string, unknown>): CodeScope {
  const lines = [GLOBALS]
  const sample: Record<string, unknown> = {
    current_user: { id: '', email: '', name: '' },
    utils: {},
    appContext: {},
  }
  for (const entity of appEntities(def).values()) {
    const view: Record<string, unknown> = {}
    const fields = entityProperties(entity).map((p) => {
      const value = values[`${entity.name}.${p}`]
      view[p] = value
      return `${p}: ${value === undefined ? 'any' : typeOf(value)}`
    })
    for (const m of methodSignatures(entity)) {
      fields.push(m)
      view[m.slice(0, m.indexOf('('))] = () => {}
    }
    lines.push(`declare const ${entity.name}: { ${fields.join('; ')} }`)
    sample[entity.name] = view
  }
  return { dts: lines.join('\n'), sample }
}
