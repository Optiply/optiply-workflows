import { type Block, blockPorts, type Diagnostic, type WorkflowDefinition } from '@ow/definition'
import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge as FlowEdge,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertCircle } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { BLOCK_KINDS, summary } from './catalog'
import { NODE_WIDTH, positionsFor } from './layout'
import { problemsOf, useEditor } from './store'

type BlockNodeData = { block: Block; problems: Diagnostic[] }
type BlockNode = Node<BlockNodeData, 'block'>

const nodeTypes = { block: memo(BlockNodeView) }

/** The workflow graph. Blocks and edges come from the store; every edit goes back through `update`. */
export function Canvas() {
  const definition = useEditor((s) => s.definition)
  const diagnostics = useEditor((s) => s.diagnostics)
  const selected = useEditor((s) => s.selected)
  const update = useEditor((s) => s.update)
  const select = useEditor((s) => s.select)

  const derived = useMemo(
    () => toNodes(definition, diagnostics, selected),
    [definition, diagnostics, selected],
  )
  // React Flow owns node state while dragging; it's rebuilt whenever the definition changes.
  const [nodes, setNodes] = useState<BlockNode[]>(derived)
  useEffect(() => setNodes(derived), [derived])
  const edges = useMemo(() => toEdges(definition, diagnostics), [definition, diagnostics])

  const onNodesChange = useCallback(
    (changes: NodeChange<BlockNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  )

  const onConnect = useCallback(
    ({ source, sourceHandle, target }: Connection) => {
      if (source === target) return
      const port = sourceHandle ?? 'out'
      update((def) =>
        def.edges.some((e) => e.from === source && e.port === port && e.to === target)
          ? def
          : { ...def, edges: [...def.edges, { from: source, port, to: target }] },
      )
    },
    [update],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, _node: BlockNode, dragged: BlockNode[]) => {
      update((def) => {
        const blocks = { ...positionsFor(def) }
        for (const n of dragged) blocks[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) }
        return { ...def, layout: { ...def.layout, blocks } }
      })
    },
    [update],
  )

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: BlockNode[]; edges: FlowEdge[] }) => {
      const names = new Set(gone.map((n) => n.id))
      const ids = new Set(cut.map((e) => e.id))
      update((def) => removeFrom(def, names, ids))
      if (selected && names.has(selected)) select(null)
    },
    [update, select, selected],
  )

  return (
    <ReactFlow<BlockNode, FlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      onNodeDragStop={onNodeDragStop}
      onDelete={onDelete}
      onNodeClick={(_, node) => select(node.id)}
      onPaneClick={() => select(null)}
      deleteKeyCode={['Backspace', 'Delete']}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="!bg-surface" nodeStrokeWidth={3} />
    </ReactFlow>
  )
}

/** Removes blocks (and their edges and positions) and edges by id. The start trigger can't be removed. */
export function removeFrom(def: WorkflowDefinition, toRemove: Set<string>, edgeIds = new Set<string>()) {
  const names = new Set([...toRemove].filter((n) => n !== 'startTrigger'))
  if (!names.size && !edgeIds.size) return def
  const blocks = { ...def.layout?.blocks }
  for (const name of names) delete blocks[name]
  return {
    ...def,
    blocks: def.blocks.filter((b) => !names.has(b.name) || b.type === 'startTrigger'),
    edges: def.edges.filter((e) => !names.has(e.from) && !names.has(e.to) && !edgeIds.has(edgeId(e))),
    ...(def.layout && { layout: { ...def.layout, blocks } }),
  }
}

const edgeId = (e: { from: string; port: string; to: string }) => `${e.from}|${e.port}|${e.to}`

function toNodes(def: WorkflowDefinition, diagnostics: Diagnostic[], selected: string | null): BlockNode[] {
  const positions = positionsFor(def)
  return def.blocks.map((block) => ({
    id: block.name,
    type: 'block',
    position: positions[block.name] ?? { x: 0, y: 0 },
    data: { block, problems: problemsOf(diagnostics, block.name) },
    selected: block.name === selected,
    deletable: block.type !== 'startTrigger',
  }))
}

function toEdges(def: WorkflowDefinition, diagnostics: Diagnostic[]): FlowEdge[] {
  const broken = new Set(
    diagnostics.flatMap((d) => (d.path[0] === 'edges' && typeof d.path[1] === 'number' ? [d.path[1]] : [])),
  )
  return def.edges.map((e, i) => ({
    id: edgeId(e),
    source: e.from,
    sourceHandle: e.port,
    target: e.to,
    type: 'smoothstep',
    animated: false,
    className: cn(e.port === 'error' && 'ow-edge-error', broken.has(i) && 'ow-edge-broken'),
  }))
}

function BlockNodeView({ data, selected }: NodeProps<BlockNode>) {
  const { block, problems } = data
  const kind = BLOCK_KINDS[block.type]
  const Icon = kind.icon
  const ports = blockPorts(block)
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors

  return (
    <div
      style={{ width: NODE_WIDTH }}
      data-testid={`block-${block.name}`}
      className={cn(
        'rounded-lg border bg-surface shadow-sm transition-shadow',
        errors ? 'border-danger/60' : 'border-border',
        selected && 'ring-2 ring-accent',
      )}
    >
      {block.type !== 'startTrigger' && (
        <Handle type="target" position={Position.Left} className="ow-handle" />
      )}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={cn('rounded-md p-1', kind.tone)}>
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{block.name}</span>
        {(errors > 0 || warnings > 0) && (
          <span
            title={problems.map((p) => p.message).join('\n')}
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 text-xs font-medium',
              errors ? 'bg-danger/10 text-danger' : 'bg-amber-100 text-amber-700',
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

function portLabel(block: Block, port: string): string {
  if (port === 'out') return 'on success'
  if (port === 'error') return 'on error'
  if (port === 'else') return 'else'
  const id = port.slice('cond:'.length)
  if (block.type !== 'branch') return id
  const expression = block.config.conditions.find((c) => c.id === id)?.expression ?? id
  return `if ${expression.length > 24 ? `${expression.slice(0, 24)}…` : expression}`
}
