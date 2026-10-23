import { composeText, type MergeConflict, type Resolution, type TextChunk } from '@ow/collab'

/**
 * The merge dialog's pure parts (architecture §2.23): what a conflict is called, what the person chose for it, and
 * the resolution that choice sends.
 */

/** What the person chose for a conflict: a side; per chunk of a text; or the text edited by hand. */
export type Choice = { side: 'ours' | 'theirs' } | { chunks: (ChunkChoice | undefined)[] } | { text: string }

export type ChunkChoice = 'ours' | 'theirs' | 'both'

const SINGULAR: Record<string, string> = {
  blocks: 'Block',
  functions: 'Function',
  edges: 'Connection',
  params: 'Parameter',
  components: 'Component',
  queries: 'Query',
  pages: 'Page',
  transformers: 'Transformer',
  variables: 'Variable',
  events: 'Event handler',
  schedules: 'Schedule',
  pubsub: 'Pub/Sub trigger',
  inputs: 'Input',
  outputs: 'Output',
  conditions: 'Condition',
  fields: 'Field',
  outcomes: 'Outcome',
}

/** Collections whose items `at` names by identity (the merge's identity arrays). */
const ITEM_COLLECTIONS = new Set(Object.keys(SINGULAR))

/**
 * A conflict's place for people: `Block fetchOrders · config.sql`, `Component table1 · props.data`, `Name`. The
 * innermost named item leads; what's inside it follows.
 */
export function conflictLabel(at: readonly string[]): string {
  const path = at[0] === 'definition' ? at.slice(1) : [...at]
  if (path.length === 0) return 'The whole definition'
  if (path.length === 1 && (path[0] === 'name' || path[0] === 'description')) {
    return path[0] === 'name' ? 'Name' : 'Description'
  }
  // Canvas and grid positions: `layout.blocks.<block>` in workflows, `layout.<component>` in apps.
  if (path[0] === 'layout' && path.length >= 2) {
    return `${path[1] === 'blocks' ? 'Block' : 'Component'} ${path.at(-1)} · position`
  }
  // The last collection item along the path (a block inside a function: the block).
  let item = -1
  for (let i = 0; i < path.length - 1; i++) {
    if (ITEM_COLLECTIONS.has(path[i]!)) item = i
  }
  if (item < 0) return path.join('.')
  const owner =
    item >= 2 && ITEM_COLLECTIONS.has(path[item - 2]!) ? `${conflictLabel(path.slice(0, item))} › ` : ''
  const name = `${SINGULAR[path[item]!]} ${path[item + 1]}`
  const rest = path.slice(item + 2).join('.')
  return `${owner}${name}${rest ? ` · ${rest}` : ''}`
}

/** The editor language for a text conflict, from where it is. */
export function conflictLanguage(at: readonly string[]): 'sql' | 'javascript' | 'json' | 'plaintext' {
  const last = at.at(-1)
  if (last === 'sql') return 'sql'
  if (last === 'json' || last === 'messages') return 'json'
  if (last === 'code' || last === 'transform' || last === 'expression' || last === 'condition')
    return 'javascript'
  return 'plaintext'
}

/** The conflicting chunks of a text conflict (each is one choice). */
export function conflictingChunks(chunks: readonly TextChunk[]): number {
  return chunks.filter((c) => 'conflict' in c).length
}

/** Whether a choice settles its conflict. */
export function isResolved(conflict: MergeConflict, choice: Choice | undefined): boolean {
  if (!choice) return false
  if ('side' in choice || 'text' in choice) return true
  if (conflict.kind !== 'text') return false
  const n = conflictingChunks(conflict.chunks)
  return choice.chunks.length === n && choice.chunks.every((c) => c !== undefined)
}

/** The resolution a settled choice sends; undefined while it isn't settled. */
export function resolutionOf(conflict: MergeConflict, choice: Choice | undefined): Resolution | undefined {
  if (!choice || !isResolved(conflict, choice)) return undefined
  if ('side' in choice) return choice.side
  if ('text' in choice) return { text: choice.text }
  return { chunks: choice.chunks as ChunkChoice[] }
}

/**
 * A text conflict's text under a choice, for editing by hand: chunks not chosen yet keep both sides, ours first, so
 * nothing is lost.
 */
export function textOf(
  conflict: Extract<MergeConflict, { kind: 'text' }>,
  choice: Choice | undefined,
): string {
  if (choice && 'text' in choice) return choice.text
  if (choice && 'side' in choice) return choice.side === 'ours' ? conflict.ours : conflict.theirs
  const picked = choice && 'chunks' in choice ? choice.chunks : []
  const choices = Array.from({ length: conflictingChunks(conflict.chunks) }, (_, i) => picked[i] ?? 'both')
  return composeText(conflict.chunks, choices) ?? conflict.ours
}

/** A choice with chunk `index` (of `count`) set. */
export function chooseChunk(
  choice: Choice | undefined,
  index: number,
  count: number,
  pick: ChunkChoice,
): Choice {
  const chunks =
    choice && 'chunks' in choice ? [...choice.chunks] : Array.from({ length: count }, () => undefined)
  chunks[index] = pick
  return { chunks }
}

/** A value for showing: JSON, `(none)` for a side that deleted it. */
export function showValue(value: unknown): string {
  if (value === undefined) return '(deleted)'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

/** How many of the conflicts are settled. */
export function resolvedCount(
  conflicts: readonly MergeConflict[],
  choices: Readonly<Record<string, Choice | undefined>>,
): number {
  return conflicts.filter((c) => isResolved(c, choices[c.id])).length
}
