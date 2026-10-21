import * as Y from 'yjs'
import type { CollabSpec, Identity, Path } from './spec'

/** The root map of a document holding a definition. */
export const ROOT = 'definition'

/** Above this many cells, an array's middle is matched by position rather than by a longest common subsequence. */
const MAX_LCS_CELLS = 1_000_000

// biome-ignore lint/suspicious/noExplicitAny: Yjs types are generic over their content.
type YType = Y.AbstractType<any>

/**
 * A definition (plain JSON) held in a Yjs document, as architecture §2.19 maps it: objects as `Y.Map` (or as one
 * value where the spec says they're atomic), arrays as `Y.Array`, the spec's text fields as `Y.Text`, everything else
 * as values.
 *
 * `value` turns the document back into the definition, rebuilding only what changed since the last read: every
 * unchanged part is the same object as before, so React and the canvas redraw only what changed. `set` makes the
 * document equal to an edited definition with the fewest changes, so edits made at the same time elsewhere merge.
 *
 * Items of an identity-matched array that repeat an earlier item's identity (two people adding `code2` at once) are
 * left out of `value`, the first one in the document winning everywhere alike; the next `set` that touches the array
 * removes them.
 */
export class SharedDefinition<T> {
  readonly root: Y.Map<unknown>
  /** The JSON last read from (or written to) each type; dropped when the type or anything inside it changes. */
  private cache = new WeakMap<YType, unknown>()

  constructor(
    readonly doc: Y.Doc,
    readonly spec: CollabSpec,
  ) {
    this.root = doc.getMap(ROOT)
    doc.on('afterTransaction', this.invalidate)
  }

  destroy(): void {
    this.doc.off('afterTransaction', this.invalidate)
  }

  /** The definition, sharing every part that hasn't changed since the last read. */
  get value(): T {
    return this.read(this.root, []) as T
  }

  /**
   * Makes the document equal to `next` with the fewest changes, in one transaction with `origin` (an undo manager
   * tracks its own origin). Afterwards `value` is `next` itself, except where `next` repeats an identity.
   */
  set(next: T, origin?: unknown): void {
    if (this.cache.get(this.root) === next) return
    const seeds: [YType, unknown][] = [[this.root, next]]
    let exact = true
    const writer = new Writer(this, seeds, () => {
      exact = false
    })
    this.doc.transact(() => writer.map(this.root, next as Record<string, unknown>, []), origin)
    // `afterTransaction` has dropped what changed; what remains equal to `next` reads as `next`'s own objects.
    if (exact) for (const [type, json] of seeds) this.cache.set(type, json)
  }

  /**
   * The text field at `path` (keys and array indexes, as in `value`), or null when there's none there (not a text
   * field, or not set yet). Indexes count what `value` shows: an identity repeated in the document is skipped.
   */
  textAt(path: Path): Y.Text | null {
    let current: unknown = this.root
    const at: (string | number)[] = []
    for (const segment of path) {
      if (current instanceof Y.Map) current = current.get(String(segment))
      else if (current instanceof Y.Array && typeof segment === 'number') {
        const identity = this.spec.identity(at)
        const seen = new Set<string>()
        const shown = current.toArray().filter((item, i) => {
          const key = identity?.(this.read(item, [...at, i]))
          if (key === undefined) return true
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        current = shown[segment]
      } else return null
      at.push(segment)
    }
    return current instanceof Y.Text ? current : null
  }

  /** The JSON of a type (cached) or a value as it is. */
  read(content: unknown, path: Path): unknown {
    if (!(content instanceof Y.AbstractType)) return content
    const cached = this.cache.get(content)
    if (cached !== undefined) return cached
    let json: unknown
    if (content instanceof Y.Text) json = content.toString()
    else if (content instanceof Y.Map) {
      const obj: Record<string, unknown> = {}
      for (const [key, v] of content.entries()) obj[key] = this.read(v, [...path, key])
      json = obj
    } else if (content instanceof Y.Array) {
      const identity = this.spec.identity(path)
      const seen = new Set<string>()
      const items: unknown[] = []
      for (const v of content.toArray()) {
        const item = this.read(v, [...path, items.length])
        const key = identity?.(item)
        if (key !== undefined) {
          if (seen.has(key)) continue
          seen.add(key)
        }
        items.push(item)
      }
      json = items
    } else throw new Error(`Unexpected ${content.constructor.name} at ${path.join('.')}`)
    this.cache.set(content, json)
    return json
  }

  private invalidate = (tr: Y.Transaction): void => {
    // Up to the root: a parent can be cached while a child made in a `set` isn't yet.
    for (const type of tr.changed.keys()) {
      let t: YType | null = type
      while (t !== null) {
        this.cache.delete(t)
        t = t.parent as YType | null
      }
    }
  }
}

const KEEP = Symbol('keep')

/** One `set`: brings each part of the document in line with the next definition. */
class Writer {
  constructor(
    private shared: SharedDefinition<unknown>,
    private seeds: [YType, unknown][],
    private inexact: () => void,
  ) {}

  map(ymap: Y.Map<unknown>, next: Record<string, unknown>, path: Path): void {
    for (const key of [...ymap.keys()]) if (next[key] === undefined) ymap.delete(key)
    for (const [key, v] of Object.entries(next)) {
      if (v === undefined) continue
      const at = [...path, key]
      if (!ymap.has(key)) ymap.set(key, this.create(v, at))
      else {
        const replacement = this.update(ymap.get(key), v, at)
        if (replacement !== KEEP) ymap.set(key, replacement)
      }
    }
  }

  /**
   * Matches the document's items to the next ones (by identity, or by content for positional arrays) along their
   * longest common subsequence; between matches, items are updated in place pairwise (a renamed block keeps edits
   * made inside it meanwhile), and the rest deleted or inserted.
   */
  array(yarr: Y.Array<unknown>, next: readonly unknown[], path: Path): void {
    const identity = this.shared.spec.identity(path)
    let current = yarr.toArray()
    let json = current.map((v, i) => this.shared.read(v, [...path, i]))
    if (identity) {
      // Drop repeats of an identity (concurrent adds of one name), as `value` already does.
      const seen = new Set<string>()
      for (let i = json.length - 1; i >= 0; i--) {
        const key = identity(json[i])
        if (key !== undefined && json.findIndex((item) => identity(item) === key) !== i) yarr.delete(i, 1)
      }
      if (yarr.length !== current.length) {
        current = yarr.toArray()
        json = current.map((v, i) => this.shared.read(v, [...path, i]))
      }
      for (const item of next) {
        const key = identity(item)
        if (key !== undefined && seen.has(key)) this.inexact()
        if (key !== undefined) seen.add(key)
      }
    }
    const matches = commonSubsequence(json, next, matcher(identity))
    let i = 0
    let j = 0
    let pos = 0
    for (const [mi, mj] of [...matches, [json.length, next.length] as const]) {
      const paired = Math.min(mi - i, mj - j)
      for (let k = 0; k < paired; k++) this.at(yarr, pos++, current[i + k], next[j + k], [...path, j + k])
      if (mi - i > paired) yarr.delete(pos, mi - i - paired)
      if (mj - j > paired) {
        const added = next.slice(j + paired, mj).map((v, k) => this.create(v, [...path, j + paired + k]))
        yarr.insert(pos, added)
        pos += added.length
      }
      if (mi < json.length) this.at(yarr, pos++, current[mi], next[mj], [...path, mj])
      i = mi + 1
      j = mj + 1
    }
  }

  private at(yarr: Y.Array<unknown>, pos: number, current: unknown, next: unknown, path: Path): void {
    const replacement = this.update(current, next, path)
    if (replacement === KEEP) return
    yarr.delete(pos, 1)
    yarr.insert(pos, [replacement])
  }

  /** Updates `current` in place to equal `next` (returning KEEP), or returns what to put in its place. */
  private update(current: unknown, next: unknown, path: Path): unknown {
    if (current instanceof Y.AbstractType) {
      if (this.shared.read(current, path) === next) return KEEP
      if (current instanceof Y.Map && isRecord(next) && sameVariant(current, next))
        this.map(current, next, path)
      else if (current instanceof Y.Array && Array.isArray(next)) this.array(current, next, path)
      else if (current instanceof Y.Text && typeof next === 'string' && this.shared.spec.isText(path))
        text(current, this.wellFormed(next))
      else return this.create(next, path)
      this.seeds.push([current, next])
      return KEEP
    }
    // A value: kept when equal (a string that became a text field turns into `Y.Text` on its next change).
    const value = typeof next === 'string' ? this.wellFormed(next) : next
    return equal(current, value) ? KEEP : this.create(value, path)
  }

  /**
   * The string as the document stores it: Yjs encodes a lone surrogate (half an emoji) as U+FFFD, so writing one as
   * is would leave this replica with a string no other replica has. Changing one makes `value` read the document.
   */
  private wellFormed(s: string): string {
    if (!LONE_SURROGATE.test(s)) return s
    this.inexact()
    return s.replace(LONE_SURROGATE_ALL, '\uFFFD')
  }

  /** A copy without the keys holding `undefined`, to store as one value. */
  private json(v: unknown): unknown {
    if (typeof v === 'string') return this.wellFormed(v)
    if (Array.isArray(v)) return v.map((item) => this.json(item ?? null))
    if (!isRecord(v)) return v
    return Object.fromEntries(
      Object.entries(v).flatMap(([k, item]) => (item === undefined ? [] : [[k, this.json(item)]])),
    )
  }

  create(v: unknown, path: Path): unknown {
    if (isRecord(v) && this.shared.spec.isAtomic(path)) return this.json(v)
    if (typeof v === 'string') {
      const s = this.wellFormed(v)
      return this.shared.spec.isText(path) ? new Y.Text(s) : s
    }
    if (Array.isArray(v)) {
      const yarr = new Y.Array<unknown>()
      yarr.push(v.map((item, i) => this.create(item ?? null, [...path, i])))
      return yarr
    }
    if (isRecord(v)) {
      const ymap = new Y.Map<unknown>()
      for (const [key, item] of Object.entries(v))
        if (item !== undefined) ymap.set(key, this.create(item, [...path, key]))
      return ymap
    }
    return v
  }
}

/** Replaces the part of `ytext` that differs from `next`: one delete and one insert between the common ends. */
function text(ytext: Y.Text, next: string): void {
  const prev = ytext.toString()
  if (prev === next) return
  let start = 0
  const max = Math.min(prev.length, next.length)
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++
  // Never split a surrogate pair: back off to its first half.
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start--
  let end = 0
  while (
    end < max - start &&
    prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  )
    end++
  if (end > 0 && isLowSurrogate(prev.charCodeAt(prev.length - end))) end--
  const removed = prev.length - start - end
  if (removed > 0) ytext.delete(start, removed)
  const inserted = next.slice(start, next.length - end)
  if (inserted) ytext.insert(start, inserted)
}

/** The keys that pick a variant of a discriminated union (a block's or handler action's `type`, a runner's `kind`). */
const DISCRIMINATORS = ['type', 'kind']

/**
 * Whether `next` is the same variant as the object in the document. Another variant replaces the object whole:
 * updated in place, a field someone sets meanwhile in the old variant (a wait's `unit` while another switches it to
 * `until`) would survive the merge into a shape no variant accepts.
 */
const sameVariant = (current: Y.Map<unknown>, next: Record<string, unknown>) =>
  DISCRIMINATORS.every((key) => current.get(key) === next[key])

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE.source, 'g')

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Identity arrays match items with the same (defined) identity; positional ones match equal items. */
function matcher(identity: Identity | undefined): (a: unknown, b: unknown) => boolean {
  if (!identity) return equal
  return (a, b) => {
    const key = identity(a)
    return key !== undefined && key === identity(b)
  }
}

/** Index pairs of a longest common subsequence: common ends first, then a table over the middle when it's small. */
export function commonSubsequence(
  a: readonly unknown[],
  b: readonly unknown[],
  eq: (x: unknown, y: unknown) => boolean,
): [number, number][] {
  let head = 0
  while (head < a.length && head < b.length && eq(a[head], b[head])) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    eq(a[a.length - 1 - tail], b[b.length - 1 - tail])
  )
    tail++
  const pairs: [number, number][] = []
  for (let k = 0; k < head; k++) pairs.push([k, k])
  const n = a.length - head - tail
  const m = b.length - head - tail
  if (n > 0 && m > 0 && n * m <= MAX_LCS_CELLS) {
    // lengths[i][j]: the LCS length of a's middle from i and b's middle from j.
    const lengths = new Uint32Array((n + 1) * (m + 1))
    const at = (i: number, j: number) => i * (m + 1) + j
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[at(i, j)] = eq(a[head + i], b[head + j])
          ? (lengths[at(i + 1, j + 1)] ?? 0) + 1
          : Math.max(lengths[at(i + 1, j)] ?? 0, lengths[at(i, j + 1)] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (eq(a[head + i], b[head + j])) pairs.push([head + i++, head + j++])
      else if ((lengths[at(i + 1, j)] ?? 0) >= (lengths[at(i, j + 1)] ?? 0)) i++
      else j++
    }
  }
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k])
  return pairs
}

/** JSON equality; a key holding `undefined` counts as missing. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (!isRecord(a) || !isRecord(b)) return false
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined)
  const ak = keys(a)
  return ak.length === keys(b).length && ak.every((k) => equal(a[k], b[k]))
}
