/**
 * How editors group edits into undo steps (M13; the steps themselves are `@ow/collab`'s `SharedHistory` since M16):
 * edits that only change the same values one after another (typing in a field, nudging a block) share a key and merge
 * into one step while they come quickly.
 */

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
