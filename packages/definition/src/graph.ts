import type { Block, Edge, WorkflowDefinition } from './schema'

export interface WorkflowGraph {
  blocks: ReadonlyMap<string, Block>
  /** Edges by target and by source. Edges naming unknown blocks are left out. */
  incoming: ReadonlyMap<string, readonly Edge[]>
  outgoing: ReadonlyMap<string, readonly Edge[]>
  /** The start trigger's name, if there is exactly one. */
  start: string | undefined
  /** Every block in dependency order (parents first), or null when the graph has a cycle. */
  order: string[] | null
  /** The blocks of one cycle, in edge order, or null when the graph is acyclic. */
  cycle: string[] | null
  /** Blocks with a path to `name` (excluding `name` unless it's on a cycle). */
  ancestors(name: string): ReadonlySet<string>
  /** Blocks reachable from `name` (excluding `name` unless it's on a cycle). */
  descendants(name: string): ReadonlySet<string>
}

/**
 * Indexes a definition's blocks and edges. Doesn't validate: with duplicate names the last block wins, so run
 * `validateDefinition` first when that matters.
 */
export function buildGraph(def: Pick<WorkflowDefinition, 'blocks' | 'edges'>): WorkflowGraph {
  const blocks = new Map(def.blocks.map((b) => [b.name, b]))
  const incoming = new Map<string, Edge[]>()
  const outgoing = new Map<string, Edge[]>()
  for (const name of blocks.keys()) {
    incoming.set(name, [])
    outgoing.set(name, [])
  }
  for (const edge of def.edges) {
    if (!blocks.has(edge.from) || !blocks.has(edge.to)) continue
    outgoing.get(edge.from)!.push(edge)
    incoming.get(edge.to)!.push(edge)
  }

  const starts = def.blocks.filter((b) => b.type === 'startTrigger')
  const order = topologicalOrder(blocks, incoming, outgoing)
  const cycle = order ? null : findCycle(blocks, outgoing)

  const reach = (index: ReadonlyMap<string, readonly Edge[]>, side: 'from' | 'to') => {
    const memo = new Map<string, Set<string>>()
    return (name: string): ReadonlySet<string> => {
      let found = memo.get(name)
      if (found) return found
      found = new Set<string>()
      const stack = [name]
      while (stack.length) {
        for (const edge of index.get(stack.pop()!) ?? []) {
          const next = edge[side]
          if (!found.has(next)) {
            found.add(next)
            stack.push(next)
          }
        }
      }
      memo.set(name, found)
      return found
    }
  }

  return {
    blocks,
    incoming,
    outgoing,
    start: starts.length === 1 ? starts[0]!.name : undefined,
    order,
    cycle,
    ancestors: reach(incoming, 'from'),
    descendants: reach(outgoing, 'to'),
  }
}

/** Kahn's algorithm; ties keep definition order so the result is stable. */
function topologicalOrder(
  blocks: ReadonlyMap<string, Block>,
  incoming: ReadonlyMap<string, readonly Edge[]>,
  outgoing: ReadonlyMap<string, readonly Edge[]>,
): string[] | null {
  const pending = new Map([...blocks.keys()].map((name) => [name, incoming.get(name)!.length]))
  const ready = [...blocks.keys()].filter((name) => pending.get(name) === 0)
  const order: string[] = []
  while (ready.length) {
    const name = ready.shift()!
    order.push(name)
    for (const edge of outgoing.get(name)!) {
      const left = pending.get(edge.to)! - 1
      pending.set(edge.to, left)
      if (left === 0) ready.push(edge.to)
    }
  }
  return order.length === blocks.size ? order : null
}

/** Depth-first search for a back edge; returns the blocks on that cycle. */
function findCycle(
  blocks: ReadonlyMap<string, Block>,
  outgoing: ReadonlyMap<string, readonly Edge[]>,
): string[] | null {
  const state = new Map<string, 'open' | 'done'>()
  const path: string[] = []
  const visit = (name: string): string[] | null => {
    state.set(name, 'open')
    path.push(name)
    for (const edge of outgoing.get(name)!) {
      const s = state.get(edge.to)
      if (s === 'open') return path.slice(path.indexOf(edge.to))
      if (s === undefined) {
        const found = visit(edge.to)
        if (found) return found
      }
    }
    path.pop()
    state.set(name, 'done')
    return null
  }
  for (const name of blocks.keys()) {
    if (state.has(name)) continue
    const found = visit(name)
    if (found) return found
  }
  return null
}
