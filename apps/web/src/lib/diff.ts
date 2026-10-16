export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
  /** Line numbers in the old and the new text (1-based), where the line exists there. */
  before: number | null
  after: number | null
}

/** Above this many lines on either side, a diff isn't worked out (the texts are shown whole). */
export const MAX_DIFF_LINES = 3000

/**
 * The lines of `after` against `before`: a longest-common-subsequence diff, removals before additions where lines
 * changed. Null when either text is too long to compare.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null
  // Common prefix and suffix first: most commits change a few lines of a long file.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  // lengths[i][j]: LCS of midA[i..] and midB[j..].
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        midA[i] === midB[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  for (let k = 0; k < start; k++) out.push({ kind: 'same', text: a[k]!, before: k + 1, after: k + 1 })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      out.push({ kind: 'same', text: midA[i]!, before: start + i + 1, after: start + j + 1 })
      i++
      j++
    } else if (j < m && (i >= n || lengths[i]![j + 1]! > lengths[i + 1]![j]!)) {
      out.push({ kind: 'added', text: midB[j]!, before: null, after: start + j + 1 })
      j++
    } else {
      out.push({ kind: 'removed', text: midA[i]!, before: start + i + 1, after: null })
      i++
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    out.push({ kind: 'same', text: a[endA + k]!, before: endA + k + 1, after: endB + k + 1 })
  }
  return out
}

/** The diff with unchanged stretches longer than `context * 2` lines folded away (null marks a fold). */
export function withContext(lines: DiffLine[], context = 3): Array<DiffLine | null> {
  const changed = lines.map((l) => l.kind !== 'same')
  const keep = lines.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      if (changed[k]) return true
    }
    return false
  })
  const out: Array<DiffLine | null> = []
  lines.forEach((line, i) => {
    if (keep[i]) out.push(line)
    else if (out.at(-1) !== null) out.push(null)
  })
  return out
}
