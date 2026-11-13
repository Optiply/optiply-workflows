/**
 * Transit JSON (https://github.com/cognitect/transit-format) to plain JSON, for Retool's exports: an app's
 * `page.data.appState` and a workflow's `templateData` are Immutable.js values written by transit-immutable-js.
 *
 * - `["^ ", k1, v1, …]` is a map; `["~#tag", value]` a tagged value.
 * - Strings may be escaped (`~~x`, `~^x`) or typed (`~m<ms>` a time, `~i` an integer, `~?t` true, `~_` null …).
 * - `^0`, `^1`, … `^0A`… are cache codes: two characters base 44 from char 48 after the `^`. Map keys longer than
 *   3 characters and `~#`/`~:`/`~$` strings longer than 3 characters enter the cache in the order they're read, which
 *   is the order they were written; it wraps around after 44 × 44 entries.
 *
 * Immutable's tags become plain values: `iM`/`iOM` maps → objects, `iL`/`iS`/`iOS`/`iStk` → arrays, and `iR`
 * records (`{ n: name, v: values }`) → their values plus `$record: name`. An unknown tag is kept as
 * `{ $tag, value }`, so nothing is lost silently.
 */

export const RECORD_KEY = '$record'
export const TAG_KEY = '$tag'

const CACHE_DIGITS = 44
const BASE_CHAR = 48
const MAX_CACHE = CACHE_DIGITS * CACHE_DIGITS
const MIN_CACHEABLE = 4

export class TransitError extends Error {
  override name = 'TransitError'
}

/** Decodes Transit JSON, given as text or as already-parsed JSON. */
export function decodeTransit(input: string | unknown): unknown {
  let json: unknown = input
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input)
    } catch (err) {
      throw new TransitError(`Not JSON: ${(err as Error).message}`)
    }
  }
  return new Reader().read(json, false)
}

class Reader {
  private cache: string[] = []
  private next = 0

  read(value: unknown, asMapKey: boolean): unknown {
    if (typeof value === 'string') return decodeString(this.resolve(value, asMapKey))
    if (Array.isArray(value)) return this.readArray(value)
    if (value !== null && typeof value === 'object') return this.readObject(value as Record<string, unknown>)
    return value
  }

  /** The string a raw string stands for: a cached one for a cache code; otherwise itself, cached if it qualifies. */
  private resolve(raw: string, asMapKey: boolean): string {
    if (raw.length > 1 && raw[0] === '^' && raw !== '^ ') {
      const index =
        raw.length === 2
          ? code(raw, 1)
          : raw.length === 3
            ? code(raw, 1) * CACHE_DIGITS + code(raw, 2)
            : Number.NaN
      const cached = this.cache[index]
      if (cached === undefined) throw new TransitError(`Unknown cache code ${raw}`)
      return cached
    }
    if (raw.length >= MIN_CACHEABLE && (asMapKey || (raw[0] === '~' && '#:$'.includes(raw[1] ?? '')))) {
      if (this.next === MAX_CACHE) this.next = 0
      this.cache[this.next++] = raw
    }
    return raw
  }

  private readArray(array: unknown[]): unknown {
    if (array[0] === '^ ') {
      const out: Record<string, unknown> = {}
      for (let i = 1; i < array.length; i += 2) {
        const key = this.read(array[i], true)
        setKey(out, keyString(key), this.read(array[i + 1], false))
      }
      return out
    }
    if (array.length === 2 && typeof array[0] === 'string') {
      const first = this.resolve(array[0], false)
      if (first.startsWith('~#')) return tagged(first.slice(2), this.read(array[1], false))
      return [decodeString(first), this.read(array[1], false)]
    }
    return array.map((item) => this.read(item, false))
  }

  /** The verbose form (`{"~#tag": value}`, or a plain map with string keys). */
  private readObject(object: Record<string, unknown>): unknown {
    const entries = Object.entries(object)
    if (entries.length === 1) {
      const [rawKey, rawValue] = entries[0]!
      const key = this.resolve(rawKey, true)
      if (key.startsWith('~#')) return tagged(key.slice(2), this.read(rawValue, false))
      const single: Record<string, unknown> = {}
      setKey(single, keyString(decodeString(key)), this.read(rawValue, false))
      return single
    }
    const out: Record<string, unknown> = {}
    for (const [rawKey, rawValue] of entries) {
      setKey(out, keyString(decodeString(this.resolve(rawKey, true))), this.read(rawValue, false))
    }
    return out
  }
}

function code(raw: string, at: number): number {
  const digit = raw.charCodeAt(at) - BASE_CHAR
  if (digit < 0 || digit >= CACHE_DIGITS) throw new TransitError(`Bad cache code ${raw}`)
  return digit
}

function keyString(key: unknown): string {
  return typeof key === 'string' ? key : JSON.stringify(key)
}

/** A scalar string's value (after cache resolution). */
function decodeString(s: string): unknown {
  if (s[0] !== '~' || s.length < 2) return s
  const body = s.slice(2)
  switch (s[1]) {
    case '~':
    case '^':
    case '`':
      return s.slice(1)
    case '_':
      return null
    case '?':
      return body === 't'
    case 'i':
    case 'd':
    case 'f':
    case 'n': {
      const n = Number(body)
      return Number.isFinite(n) ? n : body
    }
    case 'z':
      return null // NaN, INF, -INF: not JSON.
    case 'm': {
      const time = new Date(Number(body))
      return Number.isNaN(time.getTime()) ? body : time.toISOString()
    }
    case 't':
    case 'u':
    case 'r':
    case ':':
    case '$':
    case 'c':
    case 'b':
      return body
    default:
      return s
  }
}

function tagged(tag: string, value: unknown): unknown {
  switch (tag) {
    case "'":
      return value
    case 'iM':
    case 'iOM':
      return Array.isArray(value) ? pairsToObject(value) : value
    case 'iL':
    case 'iS':
    case 'iOS':
    case 'iStk':
    case 'set':
    case 'list':
      return value
    case 'iR': {
      const record = value as { n?: unknown; v?: unknown } | null
      const values = record?.v && typeof record.v === 'object' ? (record.v as Record<string, unknown>) : {}
      const out: Record<string, unknown> = { [RECORD_KEY]: String(record?.n ?? '') }
      for (const [k, v] of Object.entries(values)) setKey(out, k, v)
      return out
    }
    case 'cmap':
      return Array.isArray(value) ? pairsToObject(value) : value
    default:
      return { [TAG_KEY]: tag, value }
  }
}

function pairsToObject(pairs: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < pairs.length; i += 2) setKey(out, keyString(pairs[i]), pairs[i + 1])
  return out
}

/** Sets an own property, even `__proto__` (a plain assignment would replace the object's prototype). */
function setKey(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}
