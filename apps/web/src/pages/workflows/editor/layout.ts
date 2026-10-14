import { Graph, layout } from '@dagrejs/dagre'
import { type Block, blockPorts } from '@ow/definition'
import type { GraphPart } from './store'

export const NODE_WIDTH = 240

/** Rough node height, enough for dagre to keep rows apart: a header plus one row per extra output. */
export function nodeHeight(block: Block): number {
  const ports = blockPorts(block).length
  return 64 + (ports > 1 ? ports * 22 : 0)
}

type Positions = Record<string, { x: number; y: number }>

/** Left-to-right layered layout of every block (top-left corners, as React Flow expects). */
export function autoLayout(def: Pick<GraphPart, 'blocks' | 'edges'>): Positions {
  const g = new Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const block of def.blocks) g.setNode(block.name, { width: NODE_WIDTH, height: nodeHeight(block) })
  for (const edge of def.edges) if (g.hasNode(edge.from) && g.hasNode(edge.to)) g.setEdge(edge.from, edge.to)
  layout(g)
  const positions: Positions = {}
  for (const block of def.blocks) {
    const { x, y } = g.node(block.name)
    positions[block.name] = { x: Math.round(x - NODE_WIDTH / 2), y: Math.round(y - nodeHeight(block) / 2) }
  }
  return positions
}

/**
 * Saved positions, with dagre filling in any block that has none (e.g. a workflow created through the API). Filling
 * in doesn't change the definition; positions are only saved when the user moves blocks or runs autolayout.
 */
export function positionsFor(def: GraphPart): Positions {
  const saved = def.layout?.blocks ?? {}
  if (def.blocks.every((b) => saved[b.name])) return saved
  return { ...autoLayout(def), ...saved }
}
