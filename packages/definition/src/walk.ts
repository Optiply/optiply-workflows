import { codeFields, fieldRefs } from './fields'
import type { LibraryReference } from './library'
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

/** Slugs of the resources the definition's triggers use (Pub/Sub, SQS and Kafka triggers receive through one). */
export function triggerResources(def: WorkflowDefinition): string[] {
  const t = def.triggers
  return [...new Set([...(t?.pubsub ?? []), ...(t?.sqs ?? []), ...(t?.kafka ?? [])].map((q) => q.resource))]
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

/** The library query a block uses (M21): a Library query block's or a library loop runner's, with its path. */
export function libraryCall(block: Block): { call: LibraryReference; at: (string | number)[] } | undefined {
  if (block.type === 'libraryQuery') return { call: block.config, at: ['config'] }
  if (block.type === 'loop' && block.config.runner.kind === 'library') {
    return { call: block.config.runner, at: ['config', 'runner'] }
  }
  return undefined
}

/** Slugs of every library query the definition uses (M21), functions included. */
export function usedLibraries(def: WorkflowDefinition): string[] {
  const slugs = new Set<string>()
  for (const block of allBlocks(def)) {
    const use = libraryCall(block)
    if (use) slugs.add(use.call.library)
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

/** A Python code field, with where it sits (for the executor's syntax check and its diagnostics). */
export interface PythonField {
  /** The path joined with dots: unique in the definition. */
  id: string
  /** Path into the definition, e.g. `['functions', 0, 'blocks', 1, 'config', 'code']`. */
  path: (string | number)[]
  block: string
  function?: string
  source: string
}

/** Every Python code field of a workflow, its functions' included, in order. */
export function pythonFields(def: WorkflowDefinition): PythonField[] {
  return blockGraphs(def).flatMap((graph) =>
    graph.blocks.flatMap((block, i) =>
      codeFields(block)
        .filter((field) => field.kind === 'python-body')
        .map((field) => {
          const path = [...graph.path, 'blocks', i, ...field.path]
          return {
            id: path.join('.'),
            path,
            block: block.name,
            ...(graph.function && { function: graph.function.name }),
            source: field.source,
          }
        }),
    ),
  )
}

/** The offset in `source` of a 1-based line and column (Python's syntax errors); the line's start without one. */
export function lineColumnOffset(source: string, line: number, column?: number | null): number {
  let offset = 0
  for (let l = 1; l < line; l++) {
    const next = source.indexOf('\n', offset)
    if (next < 0) return source.length
    offset = next + 1
  }
  const lineEnd = source.indexOf('\n', offset)
  const end = lineEnd < 0 ? source.length : lineEnd
  return Math.min(offset + Math.max(0, (column ?? 1) - 1), end)
}
