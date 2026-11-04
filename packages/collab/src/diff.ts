import { diffComm } from 'node-diff3'
import { findRenames, type Rename, type Renamer } from './renames'
import { equal, isRecord } from './shared'
import type { CollabSpec, Path } from './spec'

/**
 * What changed between two definitions (architecture §2.27): the two-way companion of the merge, driven by the same
 * spec, so a change is described the way the merge and the shared editor see it: objects key by key, identity arrays
 * item by item, text line by line, atomic objects and arrays without an identity as values.
 */

/** A stretch of a text diff: lines both have, or lines one has instead of the other's. */
export type TextHunk = { same: string[] } | { removed: string[]; added: string[] }

interface ChangeBase {
  /** Where it is: object keys, and an identity array's item by its identity (`['components', 'table1', 'props']`). */
  at: string[]
  /** The spec's path to it: array indexes as in `after` (as in `before` for something removed). */
  path: Path
}

/** A key or an identity item that only `after` has; `index` is an item's position in `after`'s array. */
export interface AddedChange extends ChangeBase {
  kind: 'added'
  after: unknown
  index?: number
}

/** A key or an identity item that only `before` has. */
export interface RemovedChange extends ChangeBase {
  kind: 'removed'
  before: unknown
}

/** A value changed whole: an atomic object, an array without an identity, an item of another type, a scalar. */
export interface ValueChange extends ChangeBase {
  kind: 'value'
  before: unknown
  after: unknown
}

/** A text changed: code, SQL, a template. */
export interface TextChange extends ChangeBase {
  kind: 'text'
  before: string
  after: string
  hunks: TextHunk[]
}

/** An identity array whose items kept are in another order; `after` is every item's identity, in `after`'s order. */
export interface OrderChange extends ChangeBase {
  kind: 'order'
  before: string[]
  after: string[]
}

export type DiffChange = AddedChange | RemovedChange | ValueChange | TextChange | OrderChange

export interface DefinitionDiff {
  /** Items renamed (with the references to them), found as the merge finds them; `changes` are after the renames. */
  renames: Rename[]
  /** Depth first, in the order of the definition's keys and items. */
  changes: DiffChange[]
}

/**
 * What changed from `before` to `after`. With a `renamer`, an item renamed (and the references rewritten, as the
 * editors do) is a rename, not an item removed and another added; its other changes are reported under its new name.
 */
export function diff<D>(
  spec: CollabSpec,
  before: D,
  after: D,
  opts: { renamer?: Renamer<D> } = {},
): DefinitionDiff {
  let base = before
  const renames: Rename[] = []
  if (opts.renamer) {
    for (const rename of findRenames(opts.renamer, before, after)) {
      const next = opts.renamer.rename(base, rename.group, rename.from, rename.to)
      if (!next) continue
      base = next
      renames.push(rename)
    }
  }
  const changes: DiffChange[] = []
  new Differ(spec, changes).value(base, after, [], [])
  return { renames, changes }
}

/** A text's line diff. */
export function diffLines(before: string, after: string): TextHunk[] {
  const parts = diffComm(before.split('\n'), after.split('\n')) as unknown as (
    | { common: string[] }
    | { buffer1: string[]; buffer2: string[] }
  )[]
  const hunks: TextHunk[] = []
  for (const part of parts) {
    const last = hunks.at(-1)
    if ('common' in part) {
      if (last && 'same' in last) last.same.push(...part.common)
      else hunks.push({ same: [...part.common] })
    } else if (last && 'removed' in last) {
      last.removed.push(...part.buffer1)
      last.added.push(...part.buffer2)
    } else {
      hunks.push({ removed: [...part.buffer1], added: [...part.buffer2] })
    }
  }
  return hunks
}

/** What kind of item it is: a block's or component's `type`, an app query's `kind` (as the merge has it). */
const typeOf = (v: unknown) => (isRecord(v) ? JSON.stringify([v.type, v.kind]) : undefined)

class Differ {
  constructor(
    private readonly spec: CollabSpec,
    private readonly changes: DiffChange[],
  ) {}

  value(before: unknown, after: unknown, path: Path, at: string[]): void {
    if (equal(before, after)) return
    if (this.spec.isAtomic(path)) this.whole(before, after, path, at)
    else if (typeof before === 'string' && typeof after === 'string' && this.spec.isText(path)) {
      this.changes.push({ kind: 'text', at, path, before, after, hunks: diffLines(before, after) })
    } else if (isRecord(before) && isRecord(after)) this.record(before, after, path, at)
    else {
      const identity = Array.isArray(before) && Array.isArray(after) ? this.spec.identity(path) : undefined
      const itemized =
        identity !== undefined && this.items(before as unknown[], after as unknown[], path, at, identity)
      if (!itemized) this.whole(before, after, path, at)
    }
  }

  private whole(before: unknown, after: unknown, path: Path, at: string[]): void {
    this.changes.push({ kind: 'value', at, path, before, after })
  }

  private record(before: Record<string, unknown>, after: Record<string, unknown>, path: Path, at: string[]) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    for (const key of keys) {
      const b = before[key]
      const a = after[key]
      const p = [...path, key]
      if (b === undefined && a !== undefined)
        this.changes.push({ kind: 'added', at: [...at, key], path: p, after: a })
      else if (a === undefined && b !== undefined)
        this.changes.push({ kind: 'removed', at: [...at, key], path: p, before: b })
      else this.value(b, a, p, [...at, key])
    }
  }

  /** An identity array item by item; false when an identity is missing or repeated (then it's a value). */
  private items(
    before: readonly unknown[],
    after: readonly unknown[],
    path: Path,
    at: string[],
    identity: (item: unknown) => string | undefined,
  ): boolean {
    const index = (list: readonly unknown[]) => {
      const map = new Map<string, number>()
      for (const [i, item] of list.entries()) {
        const key = identity(item)
        if (key === undefined || map.has(key)) return null
        map.set(key, i)
      }
      return map
    }
    const b = index(before)
    const a = index(after)
    if (!b || !a) return false
    for (const [key, i] of b) {
      if (!a.has(key))
        this.changes.push({ kind: 'removed', at: [...at, key], path: [...path, i], before: before[i] })
    }
    for (const [key, i] of a) {
      const item = after[i]
      const bi = b.get(key)
      if (bi === undefined) {
        this.changes.push({ kind: 'added', at: [...at, key], path: [...path, i], after: item, index: i })
      } else if (typeOf(before[bi]) !== typeOf(item)) {
        this.whole(before[bi], item, [...path, i], [...at, key])
      } else {
        this.value(before[bi], item, [...path, i], [...at, key])
      }
    }
    const kept = (keys: Iterable<string>, other: Map<string, number>) => [...keys].filter((k) => other.has(k))
    if (!equal(kept(b.keys(), a), kept(a.keys(), b))) {
      this.changes.push({ kind: 'order', at, path, before: [...b.keys()], after: [...a.keys()] })
    }
    return true
  }
}
