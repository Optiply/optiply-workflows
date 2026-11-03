import { Graph, layout } from '@dagrejs/dagre'
import { type Block, type BlockType, blockPorts } from '@ow/definition'
import type { GraphPart } from './store'

/**
 * A block's place on the canvas, its width once resized, whether it's minimized and its result panel's height once
 * resized (M28).
 */
export interface LayoutEntry {
  x: number
  y: number
  w?: number
  minimized?: boolean
  h?: number
}

type Positions = Record<string, LayoutEntry>

/** The space a pasted or added block leaves after the block it follows. */
export const NODE_WIDTH = 240
export const NODE_GAP = 80

/** A block's default width, with its form inside (M28): code and queries get more room. */
const TYPE_WIDTH: Partial<Record<BlockType, number>> = {
  startTrigger: 300,
  code: 400,
  resourceQuery: 440,
  libraryQuery: 420,
  loop: 360,
  userTask: 380,
  response: 360,
  workflow: 340,
  function: 320,
}
const DEFAULT_WIDTH = 300
/** Roughly how tall each type's form makes its block, until React Flow has measured it. */
const TYPE_HEIGHT: Partial<Record<BlockType, number>> = {
  startTrigger: 300,
  code: 280,
  resourceQuery: 260,
  filter: 180,
  branch: 200,
  wait: 180,
  response: 260,
}
/** Minimized: the header alone. */
const HEADER_HEIGHT = 34

export function blockWidth(block: Block, entry?: LayoutEntry): number {
  return entry?.w ?? TYPE_WIDTH[block.type] ?? DEFAULT_WIDTH
}

/** Rough node height for dagre before React Flow has measured it: header, form and footer. */
export function nodeHeight(block: Block, entry?: LayoutEntry): number {
  if (entry?.minimized) return HEADER_HEIGHT
  const ports = blockPorts(block).length
  return (TYPE_HEIGHT[block.type] ?? 240) + (ports > 1 ? ports * 22 : 0)
}

/**
 * Left-to-right layered layout of every block (top-left corners, as React Flow expects), with each block's measured
 * size when known. Widths and minimized states are kept.
 */
export function autoLayout(
  def: Pick<GraphPart, 'blocks' | 'edges' | 'layout'>,
  sizes: Record<string, { width: number; height: number }> = {},
): Positions {
  const saved = def.layout?.blocks ?? {}
  const size = (block: Block) =>
    sizes[block.name] ?? {
      width: blockWidth(block, saved[block.name]),
      height: nodeHeight(block, saved[block.name]),
    }
  const g = new Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const block of def.blocks) g.setNode(block.name, size(block))
  for (const edge of def.edges) if (g.hasNode(edge.from) && g.hasNode(edge.to)) g.setEdge(edge.from, edge.to)
  layout(g)
  const positions: Positions = {}
  for (const block of def.blocks) {
    const { x, y } = g.node(block.name)
    const { width, height } = size(block)
    positions[block.name] = {
      ...saved[block.name],
      x: Math.round(x - width / 2),
      y: Math.round(y - height / 2),
    }
  }
  return positions
}

/**
 * Saved positions, with dagre filling in any block that has none (e.g. a workflow created through the API). Filling
 * in doesn't change the definition; positions are only saved when the user moves blocks or runs autolayout.
 */
export function positionsFor(
  def: GraphPart,
  sizes?: Record<string, { width: number; height: number }>,
): Positions {
  const saved = def.layout?.blocks ?? {}
  if (def.blocks.every((b) => saved[b.name])) return saved
  return { ...autoLayout(def, sizes), ...saved }
}
