/**
 * Undo and redo for an editor's definition (M13): snapshots, not patches. Edits already return a new definition that
 * shares what didn't change, so keeping both sides of every edit costs little and can't drift from the edit itself.
 *
 * Each entry also keeps the editor's `view` (what was selected) when the edit was made, so undo shows what it undid.
 * Edits that change the same values one after another (typing in a field, nudging a block) merge into one entry while
 * less than `MERGE_MS` apart; anything else, an undo or redo, or a change of selection (`seal`) starts a new one.
 */

export interface HistoryEntry<D, V> {
  before: D
  after: D
  view: V
  /** What was showing when the edit was undone (after it, as near as is known): redoing it shows that again. */
  redoView?: V
  /** What the edit changed, when it only changed values in place (see `changeKey`); merged edits share it. */
  key: string | null
  at: number
}

export interface History<D, V> {
  past: HistoryEntry<D, V>[]
  future: HistoryEntry<D, V>[]
  /** Whether the last entry may still take in the next edit. */
  open: boolean
}

/** At most this many edits can be undone. */
export const HISTORY_LIMIT = 100
/** Edits of the same values less than this far apart are one step. */
export const MERGE_MS = 1000

export function emptyHistory<D, V>(): History<D, V> {
  return { past: [], future: [], open: false }
}

/** Records an edit from `before` to `after`. A new edit drops what could be redone. */
export function record<D, V>(
  history: History<D, V>,
  edit: { before: D; after: D; view: V; at: number },
): History<D, V> {
  const key = changeKey(edit.before, edit.after)
  const last = history.past.at(-1)
  if (history.open && last && key !== null && last.key === key && edit.at - last.at < MERGE_MS) {
    return {
      past: [...history.past.slice(0, -1), { ...last, after: edit.after, at: edit.at }],
      future: [],
      open: true,
    }
  }
  const past = [...history.past, { ...edit, key }]
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past,
    future: [],
    open: key !== null,
  }
}

/**
 * The entry to undo (put back its `before`), and the history after it; null when there's nothing to undo. `view` is
 * what's showing now, which redoing the entry shows again.
 */
export function undo<D, V>(
  history: History<D, V>,
  view?: V,
): { entry: HistoryEntry<D, V>; history: History<D, V> } | null {
  const entry = history.past.at(-1)
  if (!entry) return null
  const undone = view === undefined ? entry : { ...entry, redoView: view }
  return {
    entry,
    history: { past: history.past.slice(0, -1), future: [undone, ...history.future], open: false },
  }
}

/**
 * The entry to redo (put back its `after`, and show its `redoView` if it has one), and the history after it; null
 * when there's nothing to redo.
 */
export function redo<D, V>(
  history: History<D, V>,
): { entry: HistoryEntry<D, V>; history: History<D, V> } | null {
  const entry = history.future[0]
  if (!entry) return null
  return { entry, history: { past: [...history.past, entry], future: history.future.slice(1), open: false } }
}

/** Ends the open step: the next edit starts a new one, whatever it changes. */
export function seal<D, V>(history: History<D, V>): History<D, V> {
  return history.open ? { ...history, open: false } : history
}

/** Paths that changed in one edit before it stops counting as editing values in place. */
const MAX_CHANGED_PATHS = 16

/**
 * What an edit changed, when all it did was replace plain values (strings, numbers, booleans, or set or clear one):
 * the changed paths, joined. Null when it changed the shape (added or removed list items, objects or lists): such
 * edits are steps of their own. Compares by reference first, so the unchanged parts of a large definition cost nothing.
 */
export function changeKey(before: unknown, after: unknown): string | null {
  const paths: string[] = []
  return collect(before, after, '', paths) && paths.length ? paths.join('|') : null
}

function collect(a: unknown, b: unknown, path: string, paths: string[]): boolean {
  if (a === b) return true
  const aIsList = Array.isArray(a)
  const bIsList = Array.isArray(b)
  const aIsObject = isObject(a)
  const bIsObject = isObject(b)
  if (!aIsList && !bIsList && !aIsObject && !bIsObject) {
    paths.push(path)
    return paths.length <= MAX_CHANGED_PATHS
  }
  if (aIsList && bIsList) {
    const listA = a as unknown[]
    const listB = b as unknown[]
    if (listA.length !== listB.length) return false
    return listA.every((item, i) => collect(item, listB[i], `${path}.${i}`, paths))
  }
  if (aIsObject && bIsObject) {
    const objA = a as Record<string, unknown>
    const objB = b as Record<string, unknown>
    for (const k of new Set([...Object.keys(objA), ...Object.keys(objB)])) {
      if (!collect(objA[k], objB[k], `${path}.${k}`, paths)) return false
    }
    return true
  }
  return false
}

/**
 * Whether two definitions are the same as JSON (a key holding `undefined` counts as absent), comparing by reference
 * first. Some edits rebuild an object without changing it: they mustn't become a step to undo, nor a save.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (!sameValue(a[k], b[k])) return false
    return true
  }
  return false
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
