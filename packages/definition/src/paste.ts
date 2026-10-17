import { z } from 'zod'
import { canonicalize, canonicalJson } from './canonical'
import { referencedNames } from './fields'
import { isGlobalName, PARAMS_NAME, reservedNameReason } from './names'
import { renameBlock } from './rename'
import {
  type Block,
  blockNameSchema,
  blockSchema,
  type Edge,
  edgeSchema,
  type FunctionDefinition,
  functionSchema,
  layoutSchema,
  type WorkflowDefinition,
} from './schema'
import { notInFunction } from './validate'
import { calledFunctions } from './walk'

/**
 * Blocks on the clipboard (M13): what `copyBlocks` takes from a graph, for `pasteBlocks` to put into another one
 * (or the same). Self-contained: the edges between the blocks, their positions, and the functions they call.
 */
export const blockClipSchema = z.strictObject({
  ow: z.literal('workflow-blocks'),
  v: z.literal(1),
  blocks: z.array(blockSchema).min(1).max(200),
  edges: z.array(edgeSchema).max(1000),
  positions: layoutSchema.shape.blocks,
  functions: z.array(functionSchema).max(50),
})
export type BlockClip = z.output<typeof blockClipSchema>

type Position = { x: number; y: number }

/** The blocks, edges and layout of a graph: the workflow's own, or a function's. */
interface Graph {
  blocks: Block[]
  edges: Edge[]
  layout?: WorkflowDefinition['layout']
}

function graphIn(def: WorkflowDefinition, fn: string | null): Graph | undefined {
  return fn === null ? def : def.functions?.find((f) => f.name === fn)
}

function withGraph(def: WorkflowDefinition, fn: string | null, graph: Graph): WorkflowDefinition {
  if (fn === null) return { ...def, blocks: graph.blocks, edges: graph.edges, layout: graph.layout }
  return { ...def, functions: def.functions!.map((f) => (f.name === fn ? { ...f, ...graph } : f)) }
}

/**
 * The named blocks of the graph `fn` names (null: the workflow's) as a clip: the edges between them, their
 * positions, and the functions they call (and those call in turn). The start trigger isn't copied: every workflow
 * has its own. Null when nothing can be copied.
 */
export function copyBlocks(
  def: WorkflowDefinition,
  fn: string | null,
  names: Iterable<string>,
): BlockClip | null {
  const graph = graphIn(def, fn)
  if (!graph) return null
  const wanted = new Set(names)
  const blocks = graph.blocks.filter((b) => wanted.has(b.name) && b.type !== 'startTrigger')
  if (!blocks.length) return null
  const copied = new Set(blocks.map((b) => b.name))
  const positions: Record<string, Position> = {}
  for (const name of copied) {
    const at = graph.layout?.blocks?.[name]
    if (at) positions[name] = at
  }
  return {
    ow: 'workflow-blocks',
    v: 1,
    blocks: structuredClone(blocks),
    edges: graph.edges.filter((e) => copied.has(e.from) && copied.has(e.to)).map((e) => ({ ...e })),
    positions,
    functions: structuredClone(functionsCalled(def, blocks)),
  }
}

/** The functions `blocks` call, directly or through other functions, in the definition's order. */
function functionsCalled(def: WorkflowDefinition, blocks: Block[]): FunctionDefinition[] {
  const all = new Map((def.functions ?? []).map((f) => [f.name, f]))
  const names = new Set(all.keys())
  const found = new Set<string>()
  const visit = (from: Block[]) => {
    for (const block of from) {
      for (const name of calledFunctions(block, names)) {
        if (found.has(name)) continue
        found.add(name)
        visit(all.get(name)!.blocks)
      }
    }
  }
  visit(blocks)
  return (def.functions ?? []).filter((f) => found.has(f.name))
}

export interface PasteOptions {
  /** Where the pasted blocks' top-left corner goes. Without it, they keep their positions, moved by `offset`. */
  at?: Position
  /** Added to the copied positions when there's no `at` (duplicating in place). */
  offset?: Position
  /** A block of the target graph to connect (`out`) to the pasted blocks nothing connects into, like Add does. */
  connectFrom?: string | null
}

export interface PasteResult {
  definition: WorkflowDefinition
  /** The pasted blocks' names in the target, in the clip's order. */
  added: string[]
  /** Copied names that had to change: copied name → pasted name. */
  renamed: Record<string, string>
  /** Blocks left out, with why. */
  skipped: { name: string; reason: string }[]
  functions: {
    /** Added to the target, which didn't have them. */
    added: string[]
    /** The target had them, the same. */
    reused: string[]
    /** The target has a function of that name that differs: its own stays (the pasted blocks call it). */
    kept: string[]
    /** Not added: the name is a block's in the target. */
    conflicts: string[]
  }
  /**
   * Names the pasted blocks read that are neither pasted blocks nor functions: blocks that weren't copied.
   * `inTarget` when the target has a block of that name, which the reference now reads.
   */
  outside: { name: string; inTarget: boolean }[]
}

/** Gap between pasted blocks without a position, in canvas units. */
const STACK_GAP = 120

/**
 * Pastes `clip` into the graph `fn` names (null: the workflow's). Blocks whose names are taken in the target get
 * fresh ones (the copied name's stem and the next free number), and references between pasted blocks follow, as do
 * their edges and positions; references to blocks that weren't copied are left as they are, and listed. The start
 * trigger isn't pasted, nor a second error trigger, nor what a function can't hold. Functions the blocks call come
 * along when the target lacks them.
 */
export function pasteBlocks(
  def: WorkflowDefinition,
  fn: string | null,
  clip: BlockClip,
  opts: PasteOptions = {},
): PasteResult {
  const skipped: PasteResult['skipped'] = []
  const functions: PasteResult['functions'] = { added: [], reused: [], kept: [], conflicts: [] }
  let target = def

  // Functions first: their names are taken for blocks.
  const blockNames = new Set([def, ...(def.functions ?? [])].flatMap((g) => g.blocks.map((b) => b.name)))
  for (const copied of clip.functions) {
    const existing = target.functions?.find((f) => f.name === copied.name)
    if (!existing) {
      if (blockNames.has(copied.name)) functions.conflicts.push(copied.name)
      else {
        target = { ...target, functions: [...(target.functions ?? []), structuredClone(copied)] }
        functions.added.push(copied.name)
      }
    } else if (sameFunction(existing, copied)) functions.reused.push(copied.name)
    else functions.kept.push(copied.name)
  }

  const graph = graphIn(target, fn)
  if (!graph) return { definition: def, added: [], renamed: {}, skipped, functions, outside: [] }
  const inFunction = fn !== null
  let hasErrorTrigger = !inFunction && graph.blocks.some((b) => b.type === 'errorTrigger')
  const pasted: Block[] = []
  for (const block of clip.blocks) {
    const reason =
      block.type === 'startTrigger'
        ? 'Every workflow has its own start trigger'
        : block.type === 'errorTrigger' && hasErrorTrigger
          ? 'A workflow has one error handler'
          : inFunction
            ? notInFunction(block)
            : null
    if (reason) {
      skipped.push({ name: block.name, reason })
      continue
    }
    if (block.type === 'errorTrigger') hasErrorTrigger = true
    pasted.push(block)
  }
  if (!pasted.length) return { definition: def, added: [], renamed: {}, skipped, functions, outside: [] }

  // Rename on a definition holding only the pasted blocks, so references between them follow and nothing else does.
  const pastedNames = new Set(pasted.map((b) => b.name))
  const functionNames = new Set((target.functions ?? []).map((f) => f.name))
  const taken = new Set([...graph.blocks.map((b) => b.name), ...functionNames])
  let scratch: WorkflowDefinition = {
    schemaVersion: 1,
    blocks: pasted,
    edges: clip.edges.filter((e) => pastedNames.has(e.from) && pastedNames.has(e.to)),
    layout: { blocks: { ...clip.positions } },
    functions: target.functions,
  }
  const renamed: Record<string, string> = {}
  for (const block of pasted) {
    const name = block.name
    if (!taken.has(name) && !reservedNameReason(name)) {
      taken.add(name)
      continue
    }
    const inScratch = new Set(scratch.blocks.map((b) => b.name))
    for (let n = 1; ; n++) {
      const candidate = freshName(name, n)
      if (candidate === null) throw new Error(`No free name for "${name}"`)
      if (taken.has(candidate) || inScratch.has(candidate)) continue
      const result = renameBlock(scratch, name, candidate)
      if (!result.ok) continue // A local in a pasted block uses the name: try the next one.
      scratch = result.definition
      renamed[name] = candidate
      taken.add(candidate)
      break
    }
  }

  const added = scratch.blocks.map((b) => b.name)
  const addedSet = new Set(added)
  const outsideNames = new Set<string>()
  for (const block of scratch.blocks) {
    for (const name of referencedNames(block)) {
      if (addedSet.has(name) || functionNames.has(name) || isGlobalName(name) || name === PARAMS_NAME)
        continue
      if (blockNameSchema.safeParse(name).success) outsideNames.add(name)
    }
  }
  const targetNames = new Set(graph.blocks.map((b) => b.name))
  const outside = [...outsideNames].sort().map((name) => ({ name, inTarget: targetNames.has(name) }))

  const positions = placed(scratch.blocks, scratch.layout?.blocks ?? {}, opts)
  const roots = added.filter((name) => !scratch.edges.some((e) => e.to === name))
  const from = opts.connectFrom
  const connect =
    from && graph.blocks.some((b) => b.name === from && b.type !== 'branch')
      ? roots
          .filter((name) => scratch.blocks.find((b) => b.name === name)!.type !== 'errorTrigger')
          .map((to) => ({ from, port: 'out', to }))
      : []

  const next: Graph = {
    blocks: [...graph.blocks, ...scratch.blocks],
    edges: [...graph.edges, ...scratch.edges, ...connect],
    layout: { ...graph.layout, blocks: { ...graph.layout?.blocks, ...positions } },
  }
  return { definition: withGraph(target, fn, next), added, renamed, skipped, functions, outside }
}

/** `name`'s stem (without its trailing digits) and `n`: `query3` → `query1`, `query2`, … Null past 9,999. */
function freshName(name: string, n: number): string | null {
  if (n > 9999) return null
  const stem = name.replace(/\d+$/, '') || name
  return `${stem}${n}`
}

/** Where the pasted blocks go: their copied positions moved to `at` (or by `offset`), else stacked below. */
function placed(
  blocks: Block[],
  copied: Record<string, Position>,
  opts: PasteOptions,
): Record<string, Position> {
  const known = blocks.filter((b) => copied[b.name])
  const minX = Math.min(...known.map((b) => copied[b.name]!.x))
  const minY = Math.min(...known.map((b) => copied[b.name]!.y))
  const shift = opts.at
    ? { x: opts.at.x - (known.length ? minX : 0), y: opts.at.y - (known.length ? minY : 0) }
    : (opts.offset ?? { x: 0, y: 0 })
  const out: Record<string, Position> = {}
  let below = known.length ? Math.max(...known.map((b) => copied[b.name]!.y)) + STACK_GAP : 0
  for (const block of blocks) {
    const at = copied[block.name]
    if (at) out[block.name] = { x: Math.round(at.x + shift.x), y: Math.round(at.y + shift.y) }
    else {
      out[block.name] = { x: Math.round((known.length ? minX : 0) + shift.x), y: Math.round(below + shift.y) }
      below += STACK_GAP
    }
  }
  return out
}

/** Whether two functions are the same, ignoring where their blocks sit on the canvas and in which order. */
function sameFunction(a: FunctionDefinition, b: FunctionDefinition): boolean {
  const canonical = (f: FunctionDefinition) => {
    const { layout: _, ...rest } = canonicalize({ schemaVersion: 1, blocks: [], edges: [], functions: [f] })
      .functions![0]!
    return canonicalJson(rest)
  }
  return canonical(a) === canonical(b)
}
