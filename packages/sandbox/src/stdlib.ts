import { STDLIB_BUNDLE } from './stdlib.generated'

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

  // Calls into the host through \`__owHost\`, a Reference set per context. Arguments go out as JSON text; the host
  // answers { ok, value } or { ok: false, name, message }, so errors keep their message across the boundary.
  const host = (kind, name, args) => {
    const ref = globalThis.__owHost
    if (!ref) return Promise.reject(new Error(kind === 'fetch' ? "fetch isn't available here" : name + " isn't available here"))
    return ref
      .apply(undefined, [kind, name, safeJson(args)], { arguments: { copy: true }, result: { promise: true, copy: true } })
      .then((json) => {
        const reply = JSON.parse(json)
        if (reply.ok) return reply.value
        const err = new Error(reply.message)
        err.name = reply.name || 'Error'
        throw err
      })
  }
  // JavaScript packages: \`import\` lines become \`__owImport(name)\`, reading the bundle's \`__owModules\` (set per
  // context when the workflow or app has packages). CommonJS modules get a \`default\` (the module itself) and keep
  // their properties as named imports; ES modules are as they are.
  globalThis.__owImport = (name) => {
    const modules = globalThis.__owModules
    if (!modules || !Object.prototype.hasOwnProperty.call(modules, name)) {
      const slash = name.startsWith('@') ? name.indexOf('/', name.indexOf('/') + 1) : name.indexOf('/')
      if (slash > 0 && modules && Object.prototype.hasOwnProperty.call(modules, name.slice(0, slash))) {
        throw new Error('Import "' + name + '": only a package itself can be imported, from "' + name.slice(0, slash) + '"')
      }
      throw new Error('The package "' + name + '" is not installed: add it to the JavaScript packages')
    }
    const m = modules[name]
    if (m !== null && (typeof m === 'object' || typeof m === 'function')) {
      if (m.__esModule) return m
      return new Proxy(m, { get: (target, key) => (key === 'default' ? m : Reflect.get(target, key)) })
    }
    return { default: m }
  }
  // Web Crypto's random part (uuid.v4 needs it): bytes from the host's crypto through \`__owRandom\`, a Callback set
  // per context (a snapshot can't hold a source of randomness).
  const fillRandom = (array) => {
    if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) {
      throw new TypeError('getRandomValues takes an integer typed array')
    }
    if (array.byteLength > 65536) throw new RangeError('getRandomValues fills at most 65536 bytes at a time')
    const random = globalThis.__owRandom
    if (typeof random !== 'function') throw new Error("crypto isn't available here")
    const hex = random(array.byteLength)
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return array
  }
  globalThis.crypto = Object.freeze({
    getRandomValues: fillRandom,
    randomUUID() {
      const b = fillRandom(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
    },
  })
  globalThis.__owBindFunctions = (names) => {
    for (const name of names) globalThis[name] = (...args) => host('function', name, args)
  }

  const makeHeaders = (pairs) => {
    const map = new Map()
    for (const [k, v] of pairs) {
      const key = String(k).toLowerCase()
      map.set(key, map.has(key) ? map.get(key) + ', ' + v : String(v))
    }
    return Object.freeze({
      get: (name) => map.get(String(name).toLowerCase()) ?? null,
      has: (name) => map.has(String(name).toLowerCase()),
      forEach: (fn) => map.forEach((v, k) => fn(v, k)),
      entries: () => map.entries(),
      keys: () => map.keys(),
      values: () => map.values(),
      [Symbol.iterator]: () => map.entries(),
    })
  }
  const headerPairs = (headers) => {
    if (headers == null) return []
    if (Array.isArray(headers)) return headers.map(([k, v]) => [String(k), String(v)])
    if (typeof headers.entries === 'function') return [...headers.entries()].map(([k, v]) => [String(k), String(v)])
    if (typeof headers === 'object') return Object.entries(headers).map(([k, v]) => [k, String(v)])
    throw new TypeError('headers must be an object or a list of [name, value] pairs')
  }

  // A small fetch: a URL string and { method, headers, body (a string) }; the response has status, headers,
  // text() and json(). The host makes the request (private networks blocked, size capped).
  globalThis.fetch = async (url, init) => {
    if (typeof url !== 'string') throw new TypeError('fetch takes a URL string')
    const options = init || {}
    const body = options.body == null ? null : options.body
    if (body !== null && typeof body !== 'string') {
      throw new TypeError('The body must be a string; use JSON.stringify(...) to send JSON')
    }
    const res = await host('fetch', '', [{
      url,
      method: String(options.method || 'GET').toUpperCase(),
      headers: headerPairs(options.headers),
      body,
    }])
    let read = false
    const take = () => {
      if (read) throw new TypeError('The body has already been read')
      read = true
      return res.body
    }
    return Object.freeze({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      redirected: res.redirected,
      headers: makeHeaders(res.headers),
      text: async () => take(),
      json: async () => JSON.parse(take()),
    })
  }
})();
`

/**
 * The full source baked into the isolate snapshot: lodash (`_`), dayjs (+utc/timezone/…), moment, numbro, Papa,
 * uuid, sql, the console shim, crypto's random part and fetch.
 */
export function stdlibSource(): string {
  return STDLIB_BUNDLE + PRELUDE
}
