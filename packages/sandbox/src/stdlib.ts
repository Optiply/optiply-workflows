import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

/**
 * Code that runs once inside the snapshot after the stdlib bundle. Every context created from the snapshot
 * starts with these globals, so per-evaluation setup stays tiny.
 *
 * `__owLog` is injected per context by the host (when the caller wants logs); console.* forwards to it as a
 * JSON string so arbitrary (circular, bigint, function-holding) values never break the copy.
 */
const PRELUDE = `
(() => {
  const safeJson = (value) => {
    const seen = new WeakSet()
    try {
      const out = JSON.stringify(value, (_k, v) => {
        if (typeof v === 'bigint') return v.toString()
        if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']'
        if (typeof v === 'symbol') return v.toString()
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
        }
        return v
      })
      return out === undefined ? 'null' : out
    } catch (e) {
      return JSON.stringify(String(value))
    }
  }
  const forward = (level) => (...args) => {
    const sink = globalThis.__owLog
    if (typeof sink === 'function') sink(level, safeJson(args))
  }
  globalThis.console = Object.freeze({
    log: forward('log'), info: forward('info'), debug: forward('log'),
    warn: forward('warn'), error: forward('error'),
  })
  // Return values must be plain JSON (Retool semantics): Dates become ISO strings, functions are dropped.
  globalThis.__owToJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
})();
`

let cached: string | undefined

/** The full source baked into the isolate snapshot: lodash (`_`), dayjs (+utc/timezone/…), console shim. */
export function stdlibSource(): string {
  if (cached) return cached
  const here = dirname(fileURLToPath(import.meta.url))
  const result = buildSync({
    entryPoints: [join(here, 'stdlib-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'silent',
  })
  cached = result.outputFiles[0]!.text + PRELUDE
  return cached
}
