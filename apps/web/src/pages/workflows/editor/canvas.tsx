import { type Block, blockPorts, type Diagnostic, isTrigger } from '@ow/definition'
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  type Connection,
  ConnectionLineType,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  type EdgeProps,
  type Edge as FlowEdge,
  getBezierPath,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  useReactFlow,
  ViewportPortal,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertCircle, Map as MapIcon, X } from 'lucide-react'
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'
import { kindOf, summary } from './catalog'
import { NODE_WIDTH, positionsFor } from './layout'
import { sharePointer, usePresence } from './presence'
import { type LiveBlock, useRun } from './run-state'
import { type GraphPart, graphOf, problemsOf, updateGraph, useEditor } from './store'

type BlockNodeData = { block: Block; problems: Diagnostic[]; live?: LiveBlock }
type BlockNode = Node<BlockNodeData, 'block'>

const nodeTypes = { block: memo(BlockNodeView) }
const edgeTypes = { workflow: WorkflowEdge }

const NO_LIVE: Record<string, LiveBlock> = {}

/**
 * The open graph: the workflow's, or a function's. Blocks and edges come from the store; every edit goes back
 * through `updateGraph`. Run statuses only show on the workflow's own graph (function calls aren't recorded per block).
 */
/** Whether the minimap shows, per browser: it can cover blocks in a short canvas, so it can be hidden. */
const MINIMAP_KEY = 'ow.minimap'

function useMinimap(): [boolean, () => void] {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(MINIMAP_KEY) !== 'hidden'
    } catch {
      return true
    }
  })
  const toggle = () =>
    setShown((was) => {
      try {
        if (was) localStorage.setItem(MINIMAP_KEY, 'hidden')
        else localStorage.removeItem(MINIMAP_KEY)
      } catch {
        // Storage blocked: the choice lasts until the page reloads.
      }
      return !was
    })
  return [shown, toggle]
}

export function Canvas() {
  const [minimap, toggleMinimap] = useMinimap()
  const definition = useEditor((s) => s.definition)
  const fn = useEditor((s) => s.graph)
  const allDiagnostics = useEditor((s) => s.diagnostics)
  const selected = useEditor((s) => s.selected)
  const selection = useEditor((s) => s.selection)
  const select = useEditor((s) => s.select)
  // Read-only (Use, or a protected workflow's main draft): blocks can be selected, not moved, connected or deleted.
  const editable = !useEditor((s) => s.readOnly)
  const graph = useMemo(() => graphOf(definition, fn), [definition, fn])
  const diagnostics = useMemo(
    () => allDiagnostics.filter((d) => (d.function ?? null) === fn),
    [allDiagnostics, fn],
  )

  const { screenToFlowPosition } = useReactFlow()
  const runBlocks = useRun((s) => s.blocks)
  const live = fn === null ? runBlocks : NO_LIVE
  const derived = useMemo(
    () => toNodes(graph, diagnostics, selection, live, fn),
    [graph, diagnostics, selection, live, fn],
  )
  // React Flow owns node state while dragging; it's rebuilt whenever the definition changes. What's selected comes
  // from the store alone (see onNodesChange), so the two never disagree about it.
  const [nodes, setNodes] = useState<BlockNode[]>(derived)
  useEffect(() => setNodes(derived), [derived])
  const edges = useMemo(() => toEdges(graph, diagnostics, live, fn), [graph, diagnostics, live, fn])

  // Clicks, ⌘/Ctrl-clicks and box selection arrive as `select` changes: they go to the store's selection (in the
  // graph's order), which the nodes are rebuilt from. Everything else (dragging, measuring) stays React Flow's.
  const onNodesChange = useCallback((changes: NodeChange<BlockNode>[]) => {
    const picks = changes.filter((c) => c.type === 'select')
    if (picks.length) {
      const state = useEditor.getState()
      const chosen = new Set(state.selection)
      for (const c of picks) {
        if (c.selected) chosen.add(c.id)
        else chosen.delete(c.id)
      }
      const order = graphOf(state.definition, state.graph).blocks.map((b) => b.name)
      state.setSelection(order.filter((name) => chosen.has(name)))
    }
    const rest = changes.filter((c) => c.type !== 'select')
    if (rest.length) setNodes((current) => applyNodeChanges(rest, current))
  }, [])

  const onConnect = useCallback(({ source, sourceHandle, target }: Connection) => {
    if (source === target) return
    const port = sourceHandle ?? 'out'
    updateGraph((g) =>
      g.edges.some((e) => e.from === source && e.port === port && e.to === target)
        ? g
        : { ...g, edges: [...g.edges, { from: source, port, to: target }] },
    )
  }, [])

  // Dragging an edge's end onto another block or port moves it there (M28).
  const onReconnect = useCallback((old: FlowEdge, next: Connection) => {
    if (!next.source || !next.target || next.source === next.target) return
    const moved = { from: next.source, port: next.sourceHandle ?? 'out', to: next.target }
    updateGraph((g) => {
      const edges = g.edges.filter((e) => edgeId(e) !== old.id)
      return edges.some((e) => edgeId(e) === edgeId(moved))
        ? { ...g, edges }
        : { ...g, edges: [...edges, moved] }
    })
  }, [])
  const hover = useEdgeHover()

  const onNodeDragStop = useCallback((_: unknown, _node: BlockNode, dragged: BlockNode[]) => {
    updateGraph((g) => {
      const blocks = { ...positionsFor(g) }
      for (const n of dragged) blocks[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) }
      return { ...g, layout: { ...g.layout, blocks } }
    })
  }, [])

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: BlockNode[]; edges: FlowEdge[] }) => {
      const names = new Set(gone.map((n) => n.id))
      const ids = new Set(cut.map((e) => e.id))
      updateGraph((g) => removeFrom(g, names, ids))
      if (selected && names.has(selected)) select(null)
      else useEditor.getState().setSelection(useEditor.getState().selection.filter((n) => !names.has(n)))
    },
    [select, selected],
  )

  return (
    <EdgeHover.Provider value={hover}>
      <ReactFlow<BlockNode, FlowEdge>
        // A fresh view per graph, fitted to its blocks.
        key={fn ?? ''}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        edgesReconnectable={editable}
        connectionLineType={ConnectionLineType.Bezier}
        onEdgeMouseEnter={(_, edge) => hover.enter(edge.id)}
        onEdgeMouseLeave={() => hover.leave()}
        onNodeDragStop={onNodeDragStop}
        onDelete={onDelete}
        // A click shows the block; React Flow keeps the selection (several with ⌘/Ctrl-click or a box), for copying.
        onNodeClick={(_, node) => useEditor.getState().inspect(node.id)}
        onPaneClick={() => select(null)}
        nodesDraggable={editable}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        // Where this editor's pointer is, for everyone else (M16): in flow coordinates.
        onMouseMove={(e) => sharePointer(screenToFlowPosition({ x: e.clientX, y: e.clientY }))}
        onMouseLeave={() => sharePointer(null)}
      >
        <Background gap={20} size={1} />
        <ViewportPortal>
          <Pointers graph={fn} />
        </ViewportPortal>
        <Controls showInteractive={false}>
          <ControlButton
            onClick={toggleMinimap}
            title={minimap ? 'Hide the minimap' : 'Show the minimap'}
            aria-label={minimap ? 'Hide the minimap' : 'Show the minimap'}
            aria-pressed={minimap}
          >
            <MapIcon />
          </ControlButton>
        </Controls>
        {minimap && (
          <MiniMap
            pannable
            zoomable
            className="!bg-surface"
            style={{ width: 140, height: 96 }}
            nodeStrokeWidth={3}
          />
        )}
      </ReactFlow>
    </EdgeHover.Provider>
  )
}

/** Which edge the pointer is on; leaving waits a moment so the pointer can reach the edge's × button. */
interface EdgeHoverState {
  hovered: string | null
  enter(id: string): void
  leave(): void
}

const EdgeHover = createContext<EdgeHoverState>({ hovered: null, enter: () => {}, leave: () => {} })

function useEdgeHover(): EdgeHoverState {
  const [hovered, setHovered] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  return useMemo(
    () => ({
      hovered,
      enter: (id: string) => {
        clearTimeout(timer.current)
        setHovered(id)
      },
      leave: () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setHovered(null), 150)
      },
    }),
    [hovered],
  )
}

/**
 * A connection as Retool draws it: a bezier curve, easy to hit, and on hover a × at its middle that removes it
 * with one click (undoable like any edit). Read-only drafts show no ×.
 */
function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const { hovered, enter, leave } = useContext(EdgeHover)
  const editable = !useEditor((s) => s.readOnly)
  const shown = editable && (hovered === id || selected)
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={22} />
      {shown && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan pointer-events-auto absolute flex size-5 cursor-pointer items-center justify-center rounded-full border-2 border-surface bg-danger text-white shadow-sm hover:brightness-110"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title="Remove this connection"
            aria-label="Remove this connection"
            data-testid={`edge-remove-${id}`}
            onMouseEnter={() => enter(id)}
            onMouseLeave={leave}
            onClick={() => updateGraph((g) => removeFrom(g, new Set(), new Set([id])))}
          >
            <X className="size-3" strokeWidth={3} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** Removes blocks (and their edges and positions) and edges by id. The start trigger can't be removed. */
export function removeFrom<G extends GraphPart>(
  def: G,
  toRemove: Set<string>,
  edgeIds = new Set<string>(),
): G {
  const starts = new Set(def.blocks.filter((b) => b.type === 'startTrigger').map((b) => b.name))
  const names = new Set([...toRemove].filter((n) => !starts.has(n)))
  if (!names.size && !edgeIds.size) return def
  const blocks = { ...def.layout?.blocks }
  for (const name of names) delete blocks[name]
  return {
    ...def,
    blocks: def.blocks.filter((b) => !names.has(b.name)),
    edges: def.edges.filter((e) => !names.has(e.from) && !names.has(e.to) && !edgeIds.has(edgeId(e))),
    ...(def.layout && { layout: { ...def.layout, blocks } }),
  }
}

const edgeId = (e: { from: string; port: string; to: string }) => `${e.from}|${e.port}|${e.to}`

function toNodes(
  def: GraphPart,
  diagnostics: Diagnostic[],
  selection: string[],
  live: Record<string, LiveBlock>,
  fn: string | null,
): BlockNode[] {
  const chosen = new Set(selection)
  const positions = positionsFor(def)
  return def.blocks.map((block) => ({
    id: block.name,
    type: 'block',
    position: positions[block.name] ?? { x: 0, y: 0 },
    data: { block, problems: problemsOf(diagnostics, block.name, fn), live: live[block.name] },
    selected: chosen.has(block.name),
    deletable: block.type !== 'startTrigger',
  }))
}

function toEdges(
  def: GraphPart,
  diagnostics: Diagnostic[],
  live: Record<string, LiveBlock>,
  fn: string | null,
): FlowEdge[] {
  // Edge problems are at ['edges', i] in the workflow, ['functions', f, 'edges', i] in a function.
  const at = fn === null ? 0 : 2
  const broken = new Set(
    diagnostics.flatMap((d) =>
      d.path[at] === 'edges' && typeof d.path[at + 1] === 'number' ? [d.path[at + 1] as number] : [],
    ),
  )
  return def.edges.map((e, i) => ({
    id: edgeId(e),
    source: e.from,
    sourceHandle: e.port,
    target: e.to,
    type: 'workflow',
    // The connections the open run took (their source finished on that port).
    animated: live[e.to]?.status === 'running' && live[e.from]?.port === e.port,
    className: cn(
      e.port === 'error' && 'ow-edge-error',
      broken.has(i) && 'ow-edge-broken',
      live[e.from]?.port === e.port && 'ow-edge-fired',
    ),
  }))
}

/** Everyone else's pointer on this graph: an arrow and their name in their colour, at their flow position. */
function Pointers({ graph }: { graph: string | null }) {
  const pointers = usePresence((s) => s.pointers)
  return pointers
    .filter((p) => p.area === graph)
    .map((p) => (
      <div
        key={p.clientId}
        data-testid={`pointer-${p.user.name}`}
        className={cn('pointer-events-none absolute', `ow-presence-${p.colour}`)}
        style={{ transform: `translate(${p.x}px, ${p.y}px)`, zIndex: 1000 }}
      >
        <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden className="drop-shadow-sm">
          <path d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z" fill="var(--presence)" stroke="white" />
        </svg>
        <span className="ml-3 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-white bg-[var(--presence)]">
          {p.user.name}
        </span>
      </div>
    ))
}

function BlockNodeView({ data, selected }: NodeProps<BlockNode>) {
  const { block, problems, live } = data
  // Who else has this block selected (M16): an outline in the first one's colour, and their names.
  const fn = useEditor((s) => s.graph)
  const watchers = usePresence(
    useShallow((s) => s.peers.filter((p) => p.area === fn && p.selection.includes(block.name))),
  )
  const first = watchers[0]
  const kind = kindOf(block)
  const Icon = kind.icon
  const ports = blockPorts(block)
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors

  return (
    <div
      style={{ width: NODE_WIDTH }}
      data-testid={`block-${block.name}`}
      className={cn(
        'relative rounded-lg border bg-surface shadow-card transition-shadow',
        errors ? 'border-danger/60' : 'border-border',
        live && RUN_RING[live.status],
        selected && 'ring-2 ring-accent',
        first && `ow-peer-selected ow-presence-${first.colour}`,
      )}
      data-status={live?.status}
    >
      {watchers.length > 0 && (
        <div
          className="pointer-events-none absolute -top-6 left-0 flex gap-1"
          data-testid={`peers-${block.name}`}
        >
          {watchers.map((p) => (
            <span
              key={p.clientId}
              className={cn(
                'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-white bg-[var(--presence)]',
                `ow-presence-${p.colour}`,
              )}
            >
              {p.user.name}
            </span>
          ))}
        </div>
      )}
      {!isTrigger(block) && <Handle type="target" position={Position.Left} className="ow-handle" />}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={cn('rounded-md p-1', kind.tone)}>
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{block.name}</span>
        {live && <RunStatusDot status={live.status} />}
        {(errors > 0 || warnings > 0) && (
          <span
            title={problems.map((p) => p.message).join('\n')}
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 text-xs font-medium',
              errors ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning-strong',
            )}
          >
            <AlertCircle className="size-3" />
            {errors || warnings}
          </span>
        )}
      </div>
      <div className="truncate px-3 pb-2.5 pt-1 font-mono text-xs text-muted">
        {summary(block) || kind.label}
      </div>
      {ports.length === 1 ? (
        <Handle type="source" position={Position.Right} id={ports[0]} className="ow-handle" />
      ) : (
        <div className="border-t border-border py-1">
          {ports.map((port) => (
            <div
              key={port}
              className="relative flex h-[22px] items-center justify-end pr-3 text-xs text-muted"
            >
              <span className={cn(port === 'error' && 'text-danger')}>{portLabel(block, port)}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port}
                className={cn('ow-handle', port === 'error' && 'ow-handle-error')}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** How the open run left each block: a coloured outline. */
const RUN_RING: Record<string, string> = {
  running: 'ow-block-running',
  waiting: 'ring-2 ring-warning',
  succeeded: 'ring-2 ring-success/70',
  errored: 'ring-2 ring-danger/70',
  failed: 'ring-2 ring-danger',
  cancelled: 'ring-2 ring-muted/50',
  interrupted: 'ring-2 ring-muted/50',
  skipped: 'opacity-55',
}

function RunStatusDot({ status }: { status: string }) {
  const tone =
    status === 'succeeded'
      ? 'bg-success'
      : status === 'running'
        ? 'animate-pulse bg-accent'
        : status === 'waiting'
          ? 'bg-warning'
          : status === 'failed' || status === 'errored'
            ? 'bg-danger'
            : 'bg-muted/50'
  return <span title={status} className={cn('size-2 shrink-0 rounded-full', tone)} />
}

function portLabel(block: Block, port: string): string {
  if (port === 'out') return 'on success'
  if (port === 'error') return 'on error'
  if (port === 'else') return 'else'
  const id = port.slice('cond:'.length)
  if (block.type !== 'branch') return id
  const expression = block.config.conditions.find((c) => c.id === id)?.expression ?? id
  return `if ${expression.length > 24 ? `${expression.slice(0, 24)}…` : expression}`
}
