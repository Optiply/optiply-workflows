import { diff3Merge } from 'node-diff3'
import { equal, isRecord } from './shared'
import type { CollabSpec, Path } from './spec'

/**
 * A three-way merge of definitions (architecture §2.23), driven by the spec M16 maps them onto Yjs with, so both
 * agree on what an item is: objects merge key by key, identity arrays item by item, text line by line (diff3), and
 * atomic objects and arrays without an identity as values.
 */

/** Lines of a text, `\n`-separated: joined again they give the text back exactly. */
export type Lines = string[]

/** A stretch of a merged text: lines both sides agree on, or a conflict between them. */
export type TextChunk = { ok: Lines } | { conflict: { base: Lines; ours: Lines; theirs: Lines } }

interface ConflictBase {
  /** A hash of where it is and its three sides: the same conflict, merged again, has the same id. */
  id: string
  /** Where it is: object keys, and an identity array's item by its identity (`['blocks', 'fetchOrders', 'config']`). */
  at: string[]
}

/** Both sides changed a value differently (a missing side is `undefined`). */
export interface ValueConflict extends ConflictBase {
  kind: 'value'
  base: unknown
  ours: unknown
  theirs: unknown
}

/** An identity array's item, whole: deleted on one side and changed on the other, or changed to another `type` or `kind`. */
export interface ItemConflict extends ConflictBase {
  kind: 'item'
  base: unknown
  ours: unknown
  theirs: unknown
}

/** Both sides changed the same lines of a text. */
export interface TextConflict extends ConflictBase {
  kind: 'text'
  base: string
  ours: string
  theirs: string
  chunks: TextChunk[]
}

export type MergeConflict = ValueConflict | ItemConflict | TextConflict

/** A conflict before it has its id. */
type Unidentified = MergeConflict extends infer C ? (C extends MergeConflict ? Omit<C, 'id'> : never) : never

/**
 * How a conflict is resolved: one side whole, a text's conflicting chunks one by one (`both`: ours, then theirs),
 * or a text written by hand.
 */
export type Resolution = 'ours' | 'theirs' | { chunks: ('ours' | 'theirs' | 'both')[] } | { text: string }

type Side = 'ours' | 'theirs'

export interface MergeResult<T> {
  /** The merge, with each unresolved conflict at ours. */
  merged: T
  conflicts: MergeConflict[]
}

/**
 * Merges `ours` and `theirs`, both changed from `base`. A conflict whose id is in `resolutions` is resolved as it
 * says instead of being reported; ids that match nothing are ignored, so a resolution only applies to the conflict
 * it was made for.
 */
export function merge<T>(
  spec: CollabSpec,
  base: T,
  ours: T,
  theirs: T,
  resolutions: Readonly<Record<string, Resolution>> = {},
): MergeResult<T> {
  const conflicts: MergeConflict[] = []
  const merged = new Merger(spec, resolutions, conflicts, new Set(), 'ours').value(base, ours, theirs, [], [])
  return { merged: merged as T, conflicts }
}

/** A protected object as Git sync keeps it: its name and description beside its definition. */
export interface MergeObject<D> {
  name: string
  description: string | null
  definition: D
}

/**
 * Merges an object (its name and description as values, its definition by `spec`). `check` returns where the
 * merged definition breaks its schema: two sides' changes that don't fit together. The innermost item there that
 * both sides changed (a block, a component…; else the definition's key, else the definition) is then merged whole,
 * as one conflict, until the merge fits.
 */
export function mergeObject<D>(
  spec: CollabSpec,
  base: MergeObject<D>,
  ours: MergeObject<D>,
  theirs: MergeObject<D>,
  opts: {
    resolutions?: Readonly<Record<string, Resolution>>
    check?: (definition: D) => readonly Path[]
  } = {},
): MergeResult<MergeObject<D>> {
  const objectSpec = withinDefinition(spec)
  const forced = new Set<string>()
  const run = (fallback: Side, conflicts: MergeConflict[] = []) =>
    new Merger(objectSpec, opts.resolutions ?? {}, conflicts, forced, fallback).value(
      base,
      ours,
      theirs,
      [],
      [],
    ) as MergeObject<D>
  for (;;) {
    const conflicts: MergeConflict[] = []
    const merged = run('ours', conflicts)
    if (!opts.check) return { merged, conflicts }
    // Checked with the conflicts left at ours and at theirs, so a misfit doesn't depend on which side is which.
    let grew = false
    for (const value of conflicts.length > 0 ? [merged, run('theirs')] : [merged]) {
      for (const issue of opts.check(value.definition)) {
        const at = enclosing(objectSpec, value, ['definition', ...issue]).find((a) => !forced.has(a))
        if (at !== undefined) {
          forced.add(at)
          grew = true
        }
      }
    }
    // Nothing left to merge whole: a side doesn't fit its schema by itself (saving says so).
    if (!grew) return { merged, conflicts }
  }
}

/** A definition's spec, for the object holding it under `definition`. */
function withinDefinition(spec: CollabSpec): CollabSpec {
  const inner = (path: Path) => (path[0] === 'definition' ? path.slice(1) : null)
  return {
    identity: (path) => {
      const p = inner(path)
      return p ? spec.identity(p) : undefined
    },
    isText: (path) => {
      const p = inner(path)
      return p ? spec.isText(p) : false
    },
    isAtomic: (path) => {
      const p = inner(path)
      return p ? spec.isAtomic(p) : false
    },
  }
}

/**
 * What could be merged whole around `path` in `value`, innermost first: each identity item on the way, then the
 * definition's key, then the definition (as `at` keys joined, `forced`'s form).
 */
function enclosing(spec: CollabSpec, value: unknown, path: Path): string[] {
  const at: string[] = []
  const found: string[][] = []
  let node = value
  for (const [i, step] of path.entries()) {
    if (Array.isArray(node) && typeof step === 'number') {
      const identity = spec.identity(path.slice(0, i))
      const key = identity?.(node[step])
      if (key === undefined) break
      at.push(key)
      found.push([...at])
    } else if (isRecord(node) && typeof step === 'string') {
      at.push(step)
      if (i === 1) found.push([...at])
    } else break
    node = (node as Record<string | number, unknown>)[step]
  }
  return [...found.reverse(), ['definition']].map(atKey)
}

const atKey = (at: readonly string[]) => at.join('\u0000')

/** A text conflict's text from a choice per conflicting chunk; `null` when the choices don't fit its chunks. */
export function composeText(
  chunks: readonly TextChunk[],
  choices: readonly ('ours' | 'theirs' | 'both')[],
): string | null {
  const conflicting = chunks.filter((c) => 'conflict' in c).length
  if (choices.length !== conflicting) return null
  const lines: string[] = []
  let k = 0
  for (const chunk of chunks) {
    if ('ok' in chunk) {
      lines.push(...chunk.ok)
      continue
    }
    const choice = choices[k++]
    if (choice !== 'theirs') lines.push(...chunk.conflict.ours)
    if (choice !== 'ours') lines.push(...chunk.conflict.theirs)
  }
  return lines.join('\n')
}

/** A text merged line by line: its chunks, and whether any conflict. */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
): { chunks: TextChunk[]; clean: boolean } {
  const regions = diff3Merge<string>(ours.split('\n'), base.split('\n'), theirs.split('\n'), {
    excludeFalseConflicts: true,
  })
  const chunks: TextChunk[] = []
  for (const region of regions) {
    if (region.ok) {
      const last = chunks.at(-1)
      if (last && 'ok' in last) last.ok.push(...region.ok)
      else chunks.push({ ok: [...region.ok] })
    } else if (region.conflict) {
      const { a, o, b } = region.conflict
      chunks.push({ conflict: { base: o, ours: a, theirs: b } })
    }
  }
  return { chunks, clean: chunks.every((c) => 'ok' in c) }
}

/** What kind of item it is: a block's or component's `type`, an app query's `kind`. */
const typeOf = (v: unknown) => (isRecord(v) ? JSON.stringify([v.type, v.kind]) : undefined)

class Merger {
  constructor(
    private readonly spec: CollabSpec,
    private readonly resolutions: Readonly<Record<string, Resolution>>,
    private readonly conflicts: MergeConflict[],
    /** Places merged whole, as one conflict, when both sides changed them (`mergeObject`'s misfits). */
    private readonly forced: ReadonlySet<string>,
    /** Where an unresolved conflict's place is left in the merge. */
    private readonly fallback: Side,
  ) {}

  /** `path` is the spec's (array indexes as in ours, or theirs for their additions); `at` the conflict's. */
  value(base: unknown, ours: unknown, theirs: unknown, path: Path, at: string[]): unknown {
    if (equal(ours, theirs)) return ours
    if (equal(base, ours)) return theirs
    if (equal(base, theirs)) return ours
    // Both changed, differently.
    if (this.spec.isAtomic(path) || this.forced.has(atKey(at)))
      return this.valueConflict(base, ours, theirs, at)
    if (typeof ours === 'string' && typeof theirs === 'string' && this.spec.isText(path)) {
      return this.text(typeof base === 'string' ? base : '', ours, theirs, at)
    }
    if (isRecord(ours) && isRecord(theirs)) {
      return this.record(isRecord(base) ? base : {}, ours, theirs, path, at)
    }
    if (Array.isArray(ours) && Array.isArray(theirs)) {
      const identity = this.spec.identity(path)
      if (identity) {
        const items = this.items(Array.isArray(base) ? base : [], ours, theirs, path, at, identity)
        if (items) return items
      }
    }
    return this.valueConflict(base, ours, theirs, at)
  }

  private record(
    base: Record<string, unknown>,
    ours: Record<string, unknown>,
    theirs: Record<string, unknown>,
    path: Path,
    at: string[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)])]
    for (const key of keys) {
      const v = this.value(base[key], ours[key], theirs[key], [...path, key], [...at, key])
      if (v !== undefined) out[key] = v
    }
    return out
  }

  /** An identity array merged item by item; `null` when an identity is missing or repeated (merged as a value). */
  private items(
    base: readonly unknown[],
    ours: readonly unknown[],
    theirs: readonly unknown[],
    path: Path,
    at: string[],
    identity: (item: unknown) => string | undefined,
  ): unknown[] | null {
    const index = (list: readonly unknown[]) => {
      const map = new Map<string, { item: unknown; i: number }>()
      for (const [i, item] of list.entries()) {
        const key = identity(item)
        if (key === undefined || map.has(key)) return null
        map.set(key, { item, i })
      }
      return map
    }
    const b = index(base)
    const o = index(ours)
    const t = index(theirs)
    if (!b || !o || !t) return null

    // Each identity's merged item, `undefined` when it's gone.
    const merged = new Map<string, unknown>()
    for (const key of new Set([...o.keys(), ...t.keys(), ...b.keys()])) {
      const bi = b.get(key)?.item
      const oi = o.get(key)?.item
      const ti = t.get(key)?.item
      const itemPath = [...path, o.get(key)?.i ?? t.get(key)?.i ?? b.get(key)?.i ?? 0]
      const itemAt = [...at, key]
      merged.set(key, this.item(bi, oi, ti, itemPath, itemAt))
    }

    // Ours' order, then theirs' items ours doesn't have (an item ours deleted and a resolution brought back among
    // them), each after the one before it in theirs.
    const order = ours.map((item) => identity(item)!)
    let after = -1
    for (const item of theirs) {
      const key = identity(item)!
      const pos = order.indexOf(key)
      if (pos >= 0) after = pos
      else order.splice(++after, 0, key)
    }
    return order.flatMap((key) => {
      const item = merged.get(key)
      return item === undefined ? [] : [item]
    })
  }

  private item(base: unknown, ours: unknown, theirs: unknown, path: Path, at: string[]): unknown {
    if (equal(ours, theirs)) return ours
    if (equal(base, ours)) return theirs
    if (equal(base, theirs)) return ours
    // Deleted on one side, changed on the other; or changed to another kind of item.
    const types = new Set([base, ours, theirs].filter((v) => v !== undefined).map(typeOf))
    if (ours === undefined || theirs === undefined || types.size > 1 || this.forced.has(atKey(at))) {
      return this.conflict({ kind: 'item', at, base, ours, theirs })
    }
    return this.value(base, ours, theirs, path, at)
  }

  private valueConflict(base: unknown, ours: unknown, theirs: unknown, at: string[]): unknown {
    return this.conflict({ kind: 'value', at, base, ours, theirs })
  }

  private text(base: string, ours: string, theirs: string, at: string[]): string {
    const { chunks, clean } = mergeText(base, ours, theirs)
    if (clean) return composeText(chunks, [])!
    return this.conflict({ kind: 'text', at, base, ours, theirs, chunks }, (r) => {
      if ('text' in r) return typeof r.text === 'string' ? r.text : undefined
      return Array.isArray(r.chunks) ? (composeText(chunks, r.chunks) ?? undefined) : undefined
    }) as string
  }

  /**
   * A conflict resolved where it has a resolution that applies (a side, even a deleted one; or what `apply` makes of
   * a text's), and reported otherwise.
   */
  private conflict(
    conflict: Unidentified,
    apply?: (resolution: Exclude<Resolution, 'ours' | 'theirs'>) => unknown,
  ): unknown {
    const id = conflictId(conflict)
    const resolution = this.resolutions[id]
    if (resolution === 'ours' || resolution === 'theirs') return conflict[resolution]
    if (isRecord(resolution) && apply) {
      const value = apply(resolution)
      if (value !== undefined) return value
    }
    this.conflicts.push({ id, ...conflict } as MergeConflict)
    return conflict[this.fallback]
  }
}

/** A conflict's id: a hash of its place and its sides (and its kind), so a resolution can't apply to another. */
function conflictId(conflict: Unidentified): string {
  const { kind, at, base, ours, theirs } = conflict
  return hash(stableStringify([kind, at, base ?? null, ours ?? null, theirs ?? null]))
}

/** JSON with sorted keys (a key holding `undefined` left out, as `equal` does). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v ?? null)).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** cyrb53 twice with different seeds: 28 hex characters, the same in the browser and on the server. */
function hash(text: string): string {
  const one = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
  }
  return one(1) + one(2)
}
