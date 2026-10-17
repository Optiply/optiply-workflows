import { codeFields, fieldRefs } from './fields'
import type { Block, Edge, FunctionDefinition, WorkflowDefinition } from './schema'

/** The main graph or one function's: what the validator, the engine and renaming walk. */
export interface BlockGraphSource {
  /** Undefined for the main graph. */
  function?: FunctionDefinition
  blocks: readonly Block[]
  edges: readonly Edge[]
  /** Where the graph lives in the definition: `[]`, or `['functions', i]`. */
  path: (string | number)[]
}

/** The main graph first, then each function's. */
export function blockGraphs(def: WorkflowDefinition): BlockGraphSource[] {
  return [
    { blocks: def.blocks, edges: def.edges, path: [] },
    ...(def.functions ?? []).map((fn, i) => ({
      function: fn,
      blocks: fn.blocks,
      edges: fn.edges,
      path: ['functions', i],
    })),
  ]
}

/** Every block in the definition, functions included. */
export function allBlocks(def: WorkflowDefinition): Block[] {
  return blockGraphs(def).flatMap((g) => g.blocks)
}

/** Slugs of every resource the definition queries: query blocks and loop query runners, functions included. */
export function queriedResources(def: WorkflowDefinition): string[] {
  const slugs = new Set<string>()
  for (const block of allBlocks(def)) {
    if (block.type === 'resourceQuery') slugs.add(block.config.resource)
    if (block.type === 'loop' && block.config.runner.kind === 'query') slugs.add(block.config.runner.resource)
  }
  return [...slugs]
}

/** Slugs of every workflow the definition calls: Workflow blocks and loop workflow runners, functions included. */
export function calledWorkflows(def: WorkflowDefinition): string[] {
  const slugs = new Set<string>()
  for (const block of allBlocks(def)) {
    if (block.type === 'workflow') slugs.add(block.config.workflow)
    if (block.type === 'loop' && block.config.runner.kind === 'workflow')
      slugs.add(block.config.runner.workflow)
  }
  return [...slugs]
}

/** User Task assignees written out in full (no `{{ }}`): emails (lowercased) and group names. */
export function literalAssignees(def: WorkflowDefinition): { users: string[]; groups: string[] } {
  const users = new Set<string>()
  const groups = new Set<string>()
  for (const block of allBlocks(def)) {
    if (block.type !== 'userTask') continue
    for (const u of block.config.assignees.users ?? []) {
      if (u.trim() && !u.includes('{{')) users.add(u.trim().toLowerCase())
    }
    for (const g of block.config.assignees.groups ?? []) {
      if (g.trim() && !g.includes('{{')) groups.add(g.trim())
    }
  }
  return { users: [...users], groups: [...groups] }
}

/**
 * The functions a block calls: a Function block's or a function runner's, plus `await name()` in its code. Names
 * that aren't in `functions` are ignored (they're blocks, globals or mistakes).
 */
export function calledFunctions(block: Block, functions: ReadonlySet<string>): Set<string> {
  const called = new Set<string>()
  if (block.type === 'function') called.add(block.config.function)
  if (block.type === 'loop' && block.config.runner.kind === 'function')
    called.add(block.config.runner.function)
  for (const field of codeFields(block)) {
    // Python can't call functions (the validator says so); a name there is a variable of the code's.
    if (field.kind === 'python-body') continue
    for (const ref of fieldRefs(field).refs) if (functions.has(ref.name)) called.add(ref.name)
  }
  return called
}

/**
 * The block whose data a function returns: `returns`, or else the only block nothing follows. Undefined when
 * that's ambiguous or names no block.
 */
export function functionReturnBlock(fn: FunctionDefinition): string | undefined {
  if (fn.returns !== undefined) return fn.blocks.some((b) => b.name === fn.returns) ? fn.returns : undefined
  const sources = new Set(fn.edges.map((e) => e.from))
  const sinks = fn.blocks.filter((b) => !sources.has(b.name))
  return sinks.length === 1 ? sinks[0]!.name : undefined
}
