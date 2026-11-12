import {
  type Block,
  type BlockSettings,
  blockNameSchema,
  codeFields,
  DEFAULT_BLOCK_SETTINGS,
  DEFAULT_RUN_TIMEOUT_MS,
  type Edge,
  type FunctionDefinition,
  fieldRefs,
  freshName,
  type LoopRunner,
  MAX_RUN_TIMEOUT_MS,
  type RetrySettings,
  renameBlock,
  renameFunction,
  reservedNameReason,
  SCHEMA_VERSION,
  validateDefinition,
  type WorkflowDefinition,
} from '@ow/definition'
import type { RetoolBlock, RetoolFunction, RetoolWorkflow } from '../model'
import { type ImportReport, ReportBuilder, type ReportEntry } from '../report'
import { convertQuery, isResourceEditor, type QueryContext, type ResourceMapping } from './queries'

export interface ConvertWorkflowOptions {
  /** Retool resource (name or uuid) → our resource slug. Unmapped ones get a `retool_…` placeholder. */
  resources?: ResourceMapping
}

export interface WorkflowConversion {
  definition: WorkflowDefinition
  report: ImportReport
}

/** A Retool function: a `function` block (its definition) and, for a multi-block one, its subflow. */
interface RetoolFunctionDef {
  uuid: string
  name: string
  params: { id: string; name: string; testValue: unknown }[]
  definition: RetoolBlock | null
  subflow: RetoolFunction | null
}

/** The graph being converted: the workflow's, or a function's. */
interface GraphContext extends QueryContext {
  /** The function's name, for the report; undefined for the workflow. */
  in?: string
  byUuid: Map<string, RetoolBlock>
  functions: Map<string, RetoolFunctionDef>
}

interface Converted {
  block: Block
  status: ReportEntry['status']
  notes: string[]
}

type BlockConverter = (b: RetoolBlock, ctx: GraphContext) => Converted

/** Retool block types the converter knows, by `blockType`. Anything else becomes a placeholder. */
const BLOCKS: Record<string, BlockConverter> = {
  webhook: (b) => ({ block: { name: b.name, type: 'startTrigger' }, status: 'converted', notes: [] }),
  code: convertCode,
  default: convertQueryBlock,
  conditional: convertConditional,
  filter: convertFilter,
  loop: convertLoop,
  webhookReturn: convertResponse,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Retool's preloaded libraries: built in here (M36 step 0), by package and by the name code uses. */
const BUILT_IN_LIBRARIES = new Set(['lodash', 'numbro', 'papaparse', 'moment', 'moment-timezone', 'uuid'])
const BUILT_IN_NAMES = new Set(['_', 'numbro', 'Papa', 'moment', 'uuid'])

/** Converts a read Retool workflow into a workflow definition, with a report of what became what. */
export function convertWorkflow(wf: RetoolWorkflow, opts: ConvertWorkflowOptions = {}): WorkflowConversion {
  const report = new ReportBuilder('workflow', wf.name)
  const functions = functionDefs(wf)
  const base = { report, resources: opts.resources ?? {}, functions }

  const main = convertGraph(
    wf.blocks.filter((b) => b.blockType !== 'function'),
    { ...base, byUuid: new Map(wf.blocks.map((b) => [b.uuid, b])) },
    false,
  )
  const fnDefinitions: FunctionDefinition[] = [...functions.values()].map((fn) => convertFunction(fn, base))

  let definition: WorkflowDefinition = {
    schemaVersion: SCHEMA_VERSION,
    triggers: triggers(wf, report),
    blocks: main.blocks,
    edges: main.edges,
    ...(fnDefinitions.length && { functions: fnDefinitions }),
    layout: { blocks: main.layout },
  }
  definition = librariesAndSetup(definition, wf, report)
  definition = fixNames(definition, report)

  if (wf.memoryLimitMb)
    report.note(`Retool's ${wf.memoryLimitMb} MB code memory limit wasn't imported (code here gets 512 MB)`)

  const result = validateDefinition(definition)
  const diagnostics = result.ok
    ? []
    : result.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => ({ code: d.code, message: d.message, ...(d.block && { where: d.block }) }))
  return { definition, report: report.build(diagnostics) }
}

/** Retool's `function` blocks are function definitions (the Functions panel); multi-block ones have a subflow. */
function functionDefs(wf: RetoolWorkflow): Map<string, RetoolFunctionDef> {
  const subflows = new Map(wf.functions.map((f) => [f.id, f]))
  const defs = new Map<string, RetoolFunctionDef>()
  for (const b of wf.blocks.filter((x) => x.blockType === 'function')) {
    const subflowId = typeof b.options.subflowId === 'string' ? b.options.subflowId : null
    const subflow = subflowId ? (subflows.get(subflowId) ?? null) : null
    if (subflowId) subflows.delete(subflowId)
    const params = Array.isArray(b.options.parameters)
      ? (b.options.parameters as Record<string, unknown>[])
      : []
    defs.set(b.uuid, {
      uuid: b.uuid,
      name: b.name,
      params: params.map((p) => ({
        id: String(p.id ?? ''),
        name: String(p.name ?? ''),
        testValue: testValue(p.exampleValue),
      })),
      definition: b,
      subflow,
    })
  }
  // Subflows no function block names (an older export?): still imported, under a made-up name.
  let n = 1
  for (const subflow of subflows.values()) {
    defs.set(subflow.id, {
      uuid: subflow.id,
      name: `function${n++}`,
      params: subflow.parameters.map((p) => ({
        id: p.id,
        name: p.name,
        testValue: testValue(p.exampleValue),
      })),
      definition: null,
      subflow,
    })
  }
  return defs
}

function testValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? undefined
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function convertFunction(
  fn: RetoolFunctionDef,
  base: Omit<GraphContext, 'byUuid' | 'in'>,
): FunctionDefinition {
  const params = fn.params
    .filter((p) => p.name)
    .map((p) => ({ name: p.name, ...(p.testValue !== undefined && { testValue: p.testValue as never }) }))
  if (fn.subflow) {
    // The subflow's webhook block is its start; what it leads to starts the function here.
    const blocks = fn.subflow.blocks.filter((b) => b.blockType !== 'webhook')
    const graph = convertGraph(
      blocks,
      { ...base, in: fn.name, byUuid: new Map(fn.subflow.blocks.map((b) => [b.uuid, b])) },
      true,
    )
    const ends = graph.blocks.filter((b) => !graph.edges.some((e) => e.from === b.name)).length
    base.report.add({
      retool: fn.name,
      kind: 'function',
      became: 'function',
      status: ends > 1 ? 'approximated' : 'converted',
      notes:
        ends > 1
          ? [`It returns ${graph.returns}'s data, the last of its ${ends} end blocks: check that's the one`]
          : [],
    })
    return {
      name: fn.name,
      ...(params.length && { params }),
      blocks: graph.blocks.map((b) =>
        withParams(
          b,
          params.map((p) => p.name),
          graph.blocks,
        ),
      ),
      edges: graph.edges,
      ...(graph.returns && { returns: graph.returns }),
      layout: { blocks: graph.layout },
    }
  }
  // A function that is one query (no subflow): a function of one block here.
  const def = fn.definition!
  const ctx: GraphContext = { ...base, in: fn.name, byUuid: new Map() }
  const inner: RetoolBlock = {
    ...def,
    name: 'request',
    blockType: 'default',
    incoming: [],
    incomingPorts: [],
  }
  const converted =
    isResourceEditor(def.editorType) || def.editorType === 'JavascriptQuery'
      ? convertQueryBlock(inner, ctx, fn.name)
      : placeholder(inner, `Retool ${def.editorType ?? 'unknown'} functions aren't supported yet`)
  base.report.add({
    retool: fn.name,
    kind: `function (${def.editorType ?? 'query'})`,
    became: `function with a ${converted.block.type} block`,
    status: converted.status,
    notes: converted.notes,
  })
  return {
    name: fn.name,
    ...(params.length && { params }),
    blocks: [
      withParams(
        converted.block,
        params.map((p) => p.name),
        [converted.block],
      ),
    ],
    edges: [],
    layout: { blocks: { request: { x: 0, y: 0 } } },
  }
}

function convertGraph(
  retoolBlocks: RetoolBlock[],
  ctx: GraphContext,
  inFunction: boolean,
): {
  blocks: Block[]
  edges: Edge[]
  layout: Record<string, { x: number; y: number; w?: number }>
  returns?: string
} {
  const blocks: Block[] = []
  const layout: Record<string, { x: number; y: number; w?: number }> = {}
  let returns: string | undefined
  // A loop or filter nothing leads to runs after the block it goes through (Retool ran such a chain, M36 session
  // 47): that edge is added here, and noted.
  const implied = impliedEdges([...ctx.byUuid.values()])
  const withImplied = (b: RetoolBlock): RetoolBlock => {
    const from = implied.get(b.uuid)
    return from ? { ...b, incoming: [from] } : b
  }
  const reachable = reachableFromStart([...ctx.byUuid.values()].map(withImplied))
  const kept: RetoolBlock[] = []
  for (const original of retoolBlocks) {
    const b = withImplied(original)
    if (reachable && !reachable.has(b.uuid)) {
      ctx.report.add({
        retool: b.name,
        kind: b.blockType === 'default' && b.editorType ? b.editorType : b.blockType,
        became: 'nothing',
        ...(ctx.in && { in: ctx.in }),
        status: 'skipped',
        notes: ['Nothing leads to it in Retool, so it never ran there: not imported'],
      })
      continue
    }
    kept.push(b)
    let converted: Converted
    if (inFunction && b.blockType === 'webhookReturn') {
      // A function returns its last block's data here: the response's body becomes a code block's return.
      const body =
        typeof b.options.body === 'string' && b.options.body.trim() ? b.options.body.trim() : 'null'
      converted = {
        block: { name: b.name, type: 'code', config: { code: `return ${stripBraces(body)}` } },
        status: 'approximated',
        notes: ["A function's response became a code block returning its body"],
      }
      returns = b.name
    } else {
      const convert = BLOCKS[b.blockType]
      converted = convert
        ? convert(b, ctx)
        : placeholder(b, `Retool ${b.blockType} blocks aren't supported yet`)
    }
    const from = implied.get(b.uuid)
    if (from) {
      const source = ctx.byUuid.get(from)!.name
      converted.notes.push(
        `No edge led to it in the export; Retool ran it after ${source}, the block it goes through: connected after it here`,
      )
      if (converted.status === 'converted') converted.status = 'approximated'
    }
    const block = withCommon(converted.block, b, converted.notes)
    blocks.push(block)
    ctx.report.add({
      retool: b.name,
      kind: b.blockType === 'default' && b.editorType ? b.editorType : b.blockType,
      became: block.type,
      ...(ctx.in && { in: ctx.in }),
      status: converted.status,
      notes: converted.notes,
    })
    layout[b.name] = {
      x: Math.round(b.left),
      y: Math.round(b.top),
      ...(b.width && { w: Math.min(2000, Math.max(160, Math.round(b.width))) }),
    }
  }
  const edges = convertEdges(kept, ctx)
  if (inFunction && !returns) returns = returnBlock(kept, edges)
  return { blocks, edges, layout, ...(returns && { returns }) }
}

/**
 * Loops and filters that nothing leads to, by the block they go through (`iterable`, `blockToIterate`): Retool runs
 * them after it.
 */
function impliedEdges(all: RetoolBlock[]): Map<string, string> {
  const uuids = new Set(all.map((b) => b.uuid))
  const out = new Map<string, string>()
  for (const b of all) {
    if (b.blockType !== 'loop' && b.blockType !== 'filter') continue
    if (b.incoming.length || b.incomingPorts.length) continue
    const target = b.blockType === 'loop' ? b.options.iterable : b.options.blockToIterate
    if (typeof target === 'string' && uuids.has(target) && target !== b.uuid) out.set(b.uuid, target)
  }
  return out
}

/**
 * The blocks a run reaches from the start (Retool's webhook block), through success edges and ports; null when the
 * graph has no start to go from (then every block is kept).
 */
function reachableFromStart(all: RetoolBlock[]): Set<string> | null {
  const starts = all.filter((b) => b.blockType === 'webhook')
  if (!starts.length) return null
  const next = new Map<string, string[]>()
  for (const b of all) {
    for (const from of [...b.incoming, ...b.incomingPorts.map((p) => p.blockId)]) {
      next.set(from, [...(next.get(from) ?? []), b.uuid])
    }
  }
  const seen = new Set<string>()
  const queue = starts.map((b) => b.uuid)
  while (queue.length) {
    const id = queue.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(next.get(id) ?? []))
  }
  return seen
}

/**
 * The block a function returns when several end it: Retool's flow runs left to right, so the right-most end (then
 * the lowest). Undefined when one block ends it (ours picks that one).
 */
function returnBlock(blocks: RetoolBlock[], edges: Edge[]): string | undefined {
  const ends = blocks.filter((b) => !edges.some((e) => e.from === b.name))
  if (ends.length < 2) return undefined
  return [...ends].sort((a, b) => b.left - a.left || b.top - a.top)[0]!.name
}

/** Success edges (`out`) and a conditional's ports (`cond:<id>`, `else`). */
function convertEdges(retoolBlocks: RetoolBlock[], ctx: GraphContext): Edge[] {
  const kept = new Set(retoolBlocks.map((b) => b.uuid))
  const edges: Edge[] = []
  const seen = new Set<string>()
  const push = (edge: Edge) => {
    const key = `${edge.from}|${edge.port}|${edge.to}`
    if (!seen.has(key)) {
      seen.add(key)
      edges.push(edge)
    }
  }
  for (const b of retoolBlocks) {
    for (const from of b.incoming) {
      const source = ctx.byUuid.get(from)
      if (source && kept.has(from)) push({ from: source.name, port: 'out', to: b.name })
    }
    for (const { blockId, portId } of b.incomingPorts) {
      const source = ctx.byUuid.get(blockId)
      if (source && kept.has(blockId))
        push({ from: source.name, port: conditionPort(source, portId), to: b.name })
    }
  }
  return edges
}

/** Retool conditions → ours: `if`/`elseif` become `c1`, `c2`…; `else` is the else port. */
function conditions(b: RetoolBlock): { id: string; retool: Record<string, unknown> }[] {
  const all = Array.isArray(b.options.conditions) ? (b.options.conditions as Record<string, unknown>[]) : []
  return all.filter((c) => c.type !== 'else').map((c, i) => ({ id: `c${i + 1}`, retool: c }))
}

function conditionPort(source: RetoolBlock, portId: string): string {
  if (source.blockType !== 'conditional') return 'out'
  const match = conditions(source).find((c) => c.retool.outgoingPortId === portId)
  return match ? `cond:${match.id}` : 'else'
}

/** Settings every executable block shares: description, retries, timeout. */
function withCommon(block: Block, b: RetoolBlock, notes: string[]): Block {
  const out = { ...block } as Block & { description?: string; settings?: BlockSettings }
  if (b.comment?.trim()) out.description = b.comment.trim().slice(0, 2000)
  if (block.type === 'startTrigger' || block.type === 'loop') return out
  const settings: BlockSettings = {}
  const retry = retrySettings(b)
  if (retry) settings.retry = retry
  const timeout = timeoutOf(b)
  const defaultTimeout = block.type === 'function' ? DEFAULT_RUN_TIMEOUT_MS : DEFAULT_BLOCK_SETTINGS.timeoutMs
  if (timeout && timeout !== defaultTimeout) settings.timeoutMs = timeout
  if (Object.keys(settings).length) out.settings = settings
  if (b.failureCondition?.trim())
    notes.push(`Its failure condition (${b.failureCondition.trim().slice(0, 40)}) wasn't imported`)
  return out
}

function retrySettings(b: RetoolBlock): RetrySettings | undefined {
  if (!b.retry || b.retry.attempts <= 0) return undefined
  return {
    count: Math.min(10, Math.round(b.retry.attempts)),
    ...(b.retry.intervalMs !== null && {
      intervalMs: Math.min(3_600_000, Math.max(0, Math.round(b.retry.intervalMs))),
    }),
  }
}

function timeoutOf(b: RetoolBlock): number | undefined {
  const raw = b.plugin?.template.queryTimeout
  const ms = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(MAX_RUN_TIMEOUT_MS, Math.max(100, Math.round(ms)))
}

function codeOf(b: RetoolBlock): string {
  const q = b.plugin?.template.query
  return typeof q === 'string' ? q : ''
}

function convertCode(b: RetoolBlock): Converted {
  const python = /python/i.test(b.editorType ?? '')
  return {
    block: {
      name: b.name,
      type: 'code',
      config: { code: codeOf(b), ...(python && { language: 'python' as const }) },
    },
    status: 'converted',
    notes: [],
  }
}

/** How the report names a block: `fn.block` inside a function. */
function whereOf(b: RetoolBlock, ctx: GraphContext): string {
  return ctx.in ? `${ctx.in}.${b.name}` : b.name
}

function convertQueryBlock(b: RetoolBlock, ctx: GraphContext, where = whereOf(b, ctx)): Converted {
  if (!b.editorType || b.editorType === 'JavascriptQuery') return convertCode(b)
  if (!b.plugin) return placeholder(b, 'Its settings are missing from the export')
  const q = convertQuery(ctx, b.editorType, b.resourceName ?? b.plugin.resourceName, b.plugin, where)
  if (!q.ok) return placeholder(b, q.reason)
  return {
    block: { name: b.name, type: 'resourceQuery', config: { resource: q.resource, query: q.query as never } },
    status: q.approximated ? 'approximated' : 'converted',
    notes: q.notes,
  }
}

function convertConditional(b: RetoolBlock): Converted {
  const notes: string[] = []
  const conds = conditions(b).map(({ id, retool }) => {
    let expression = typeof retool.statement === 'string' ? stripBraces(retool.statement.trim()) : ''
    if (!expression) {
      expression = 'false'
      notes.push(`Condition ${id} was empty in Retool; it's false here`)
    }
    return { id, expression }
  })
  if (!conds.length) {
    conds.push({ id: 'c1', expression: 'false' })
    notes.push('It had no conditions in Retool')
  }
  return {
    block: { name: b.name, type: 'branch', config: { conditions: conds.slice(0, 50) } },
    status: notes.length ? 'approximated' : 'converted',
    notes,
  }
}

function convertFilter(b: RetoolBlock, ctx: GraphContext): Converted {
  const notes: string[] = []
  const input = inputOf(b.options.blockToIterate, ctx, notes)
  const statement =
    typeof b.options.filterStatement === 'string' ? stripBraces(b.options.filterStatement.trim()) : ''
  if (!statement) notes.push('Its filter was empty in Retool; it keeps every item here')
  return {
    block: { name: b.name, type: 'filter', config: { input, condition: statement || 'true' } },
    status: notes.length ? 'approximated' : 'converted',
    notes,
  }
}

/** What a loop or filter iterates: Retool names a block (by uuid) or writes a template. */
function inputOf(raw: unknown, ctx: GraphContext, notes: string[]): string {
  if (typeof raw === 'string') {
    const block = ctx.byUuid.get(raw)
    if (block) return `{{ ${block.name}.data }}`
    if (raw.includes('{{')) return raw
    if (UUID.test(raw.trim())) {
      notes.push("The block it goes through isn't in the export: set its input")
      return '{{ [] }}'
    }
    if (raw.trim()) return `{{ ${raw.trim()} }}`
  }
  notes.push("The list it goes through wasn't in the export: set its input")
  return '{{ [] }}'
}

function convertLoop(b: RetoolBlock, ctx: GraphContext): Converted {
  const notes: string[] = []
  const o = b.options
  const input = inputOf(o.iterable, ctx, notes)
  const runner = loopRunner(b, ctx, notes)
  if (!runner) return placeholder(b, notes.at(-1) ?? 'Its loop body could not be imported')
  const config: Extract<Block, { type: 'loop' }>['config'] = { input, runner }
  const batch =
    o.batchConfig && typeof o.batchConfig === 'object' ? (o.batchConfig as Record<string, unknown>) : null
  const batchSize = Number(batch?.batchSize)
  const delay = Number(batch?.delayInMs)
  if (Number.isFinite(delay) && delay > 0) {
    config.mode = 'batch'
    config.batchSize =
      Number.isFinite(batchSize) && batchSize >= 1 ? Math.min(1000, Math.round(batchSize)) : 1
    config.batchDelayMs = Math.min(3_600_000, Math.round(delay))
  } else if (o.executionMode === 'sequential') {
    config.mode = 'sequential'
  } else if (o.executionMode === 'parallel' && Number.isFinite(batchSize) && batchSize >= 1) {
    config.mode = 'parallel'
    config.concurrency = Math.min(50, Math.round(batchSize))
  }
  const errorPolicy = (o.iterationErrorConfig as Record<string, unknown> | undefined)?.errorPolicy
  if (errorPolicy === 'ignore' || errorPolicy === 'continue') config.onError = 'continue'
  const iteration: NonNullable<typeof config.iteration> = {}
  const perIteration = Number(o.timeoutInMs)
  if (Number.isFinite(perIteration) && perIteration >= 100)
    iteration.timeoutMs = Math.min(MAX_RUN_TIMEOUT_MS, Math.round(perIteration))
  const retry = retrySettings(b)
  if (retry) iteration.retry = retry
  if (Object.keys(iteration).length) config.iteration = iteration
  const block: Block = { name: b.name, type: 'loop', config }
  const timeout = timeoutOf(b)
  if (timeout && timeout !== MAX_RUN_TIMEOUT_MS && timeout > DEFAULT_BLOCK_SETTINGS.timeoutMs) {
    // Retool's query timeout on a loop is its body's; here the loop as a whole is bounded by the run.
    iteration.timeoutMs ??= timeout
    config.iteration = iteration
  }
  return { block, status: notes.length ? 'approximated' : 'converted', notes }
}

/** A loop's body: a function (by its definition's uuid), else its own code or query. */
function loopRunner(b: RetoolBlock, ctx: GraphContext, notes: string[]): LoopRunner | null {
  const fnId = typeof b.options.functionId === 'string' ? b.options.functionId : null
  const fn = fnId ? ctx.functions.get(fnId) : undefined
  if (fn) {
    const values = (b.options.functionParameters ?? {}) as Record<string, unknown>
    const params: Record<string, string> = {}
    for (const p of fn.params) {
      const v = values[p.id]
      if (p.name && typeof v === 'string' && v.trim()) params[p.name] = v
    }
    return { kind: 'function', function: fn.name, ...(Object.keys(params).length && { params }) }
  }
  if (!b.editorType || b.editorType === 'JavascriptQuery') {
    return { kind: 'code', code: codeOf(b) }
  }
  if (/python/i.test(b.editorType)) return { kind: 'code', code: codeOf(b), language: 'python' }
  if (!b.plugin) {
    notes.push('Its settings are missing from the export')
    return null
  }
  const q = convertQuery(
    ctx,
    b.editorType,
    b.resourceName ?? b.plugin.resourceName,
    b.plugin,
    whereOf(b, ctx),
  )
  if (!q.ok) {
    notes.push(q.reason)
    return null
  }
  notes.push(...q.notes)
  return { kind: 'query', resource: q.resource, query: q.query as never }
}

function convertResponse(b: RetoolBlock): Converted {
  const status =
    typeof b.options.status === 'string' && b.options.status.trim() ? b.options.status.trim() : undefined
  const raw = typeof b.options.body === 'string' ? b.options.body.trim() : ''
  // Retool's body is a JS expression (`query1.data`); ours is a JSON template.
  const body = !raw ? undefined : raw.includes('{{') ? raw : `{{ ${raw} }}`
  return {
    block: {
      name: b.name,
      type: 'response',
      config: { ...(status && status !== '200' && { status }), ...(body && { body }) },
    },
    status: 'converted',
    notes: [],
  }
}

/** A block standing in for one that couldn't be imported: it fails the run, saying what it was. */
function placeholder(b: RetoolBlock, reason: string): Converted {
  const what = `Retool ${b.blockType}${b.editorType ? ` (${b.editorType})` : ''} block "${b.name}"`
  return {
    block: {
      name: b.name,
      type: 'code',
      config: {
        code: `// ${reason}\nthrow new Error(${JSON.stringify(`Not imported from Retool: ${what}`)})`,
      },
    },
    status: 'unsupported',
    notes: [reason],
  }
}

/** `{{ x }}` → `x`: conditions are plain expressions here. */
function stripBraces(text: string): string {
  const m = /^\{\{([\s\S]*)\}\}$/.exec(text)
  return m && !m[1]!.includes('}}') ? m[1]!.trim() : text
}

function triggers(wf: RetoolWorkflow, report: ReportBuilder): WorkflowDefinition['triggers'] {
  const out: NonNullable<WorkflowDefinition['triggers']> = {}
  const hook = wf.webhooks[0]
  if (hook) {
    const bodySchema = schemaOf(hook.inputSchema)
    out.webhook = {
      enabled: wf.enabled,
      ...(!hook.useHeaderApiKey && { auth: { type: 'apiKey' as const } }),
      ...(bodySchema && { bodySchema }),
    }
    if (!hook.useHeaderApiKey)
      report.note("Retool's webhook took its key in the URL; here it takes an API key header")
    if (hook.exampleInput?.trim())
      report.note("The webhook's example input wasn't imported (it can hold real data)")
    if (wf.webhooks.length > 1)
      report.note(`Only the first of ${wf.webhooks.length} webhook triggers was imported`)
  }
  if (wf.crontab?.trim()) {
    out.schedules = [
      {
        name: 'retool',
        enabled: wf.enabled,
        cron: wf.crontab.trim(),
        ...(wf.timezone && { timezone: wf.timezone }),
      },
    ]
  }
  return Object.keys(out).length ? out : undefined
}

/** Retool's input schema keeps `properties` as a list of `{ key, type }`; ours is JSON Schema. */
function schemaOf(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const props = (raw as { properties?: unknown }).properties
  if (Array.isArray(props)) {
    const properties: Record<string, unknown> = {}
    for (const p of props as Record<string, unknown>[]) {
      if (typeof p?.key !== 'string' || !p.key) continue
      properties[p.key] = typeof p.type === 'string' && p.type ? { type: p.type } : {}
    }
    return Object.keys(properties).length ? { type: 'object', properties } : undefined
  }
  if (props && typeof props === 'object' && Object.keys(props).length) return raw as Record<string, unknown>
  return undefined
}

/**
 * Names Retool allows that ours don't (reserved globals here, or a function and a block sharing a name) get a fresh
 * one, with every reference rewritten.
 */
function fixNames(def: WorkflowDefinition, report: ReportBuilder): WorkflowDefinition {
  let out = def
  const taken = () =>
    new Set([
      ...out.blocks.map((b) => b.name),
      ...(out.functions ?? []).flatMap((f) => [f.name, ...f.blocks.map((b) => b.name)]),
    ])
  const bad = (name: string) => !blockNameSchema.safeParse(name).success || reservedNameReason(name) !== null

  for (const fn of def.functions ?? []) {
    if (!bad(fn.name) && !out.blocks.some((b) => b.name === fn.name)) continue
    const to = pick(fn.name, taken())
    const renamed = renameFunction(out, fn.name, to)
    if (renamed.ok) {
      out = renamed.definition
      noteRename(report, fn.name, to, undefined)
    }
  }
  const graphs: (string | undefined)[] = [undefined, ...(out.functions ?? []).map((f) => f.name)]
  for (const fnName of graphs) {
    const blocks =
      fnName === undefined ? out.blocks : (out.functions ?? []).find((f) => f.name === fnName)!.blocks
    for (const name of blocks.map((b) => b.name)) {
      const clash = (out.functions ?? []).some((f) => f.name === name)
      if (!bad(name) && !clash) continue
      const used = taken()
      for (let attempt = 0; attempt < 5; attempt++) {
        const to = pick(name, used)
        const renamed = renameBlock(out, name, to, fnName === undefined ? {} : { function: fnName })
        if (renamed.ok) {
          out = renamed.definition
          noteRename(report, name, to, fnName)
          break
        }
        used.add(to)
      }
    }
  }
  return out
}

function pick(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_') || 'block'
  const stem =
    reservedNameReason(base) === null && blockNameSchema.safeParse(base).success && !taken.has(base)
      ? base
      : `${base}_`
  if (!taken.has(stem) && reservedNameReason(stem) === null && blockNameSchema.safeParse(stem).success)
    return stem
  for (let n = 2; ; n++) {
    const candidate = freshName(`${stem}1`, n)
    if (candidate && !taken.has(candidate)) return candidate
  }
}

function noteRename(report: ReportBuilder, from: string, to: string, fnName: string | undefined) {
  const entry = report.entries.find((e) => e.retool === from && (e.in ?? undefined) === fnName)
  if (entry) {
    entry.name = to
    entry.notes.push(`Renamed to ${to}: "${from}" is taken or reserved here`)
  } else {
    report.note(`"${from}" was renamed to ${to}: the name is taken or reserved here`)
  }
}

/**
 * Retool's libraries and JavaScript setup script. Its preloaded ones are built in here; others become JavaScript
 * packages, imported at the top of the code that uses them. A setup script that only loads libraries is dropped;
 * anything else in it goes in front of each JavaScript body.
 */
function librariesAndSetup(
  def: WorkflowDefinition,
  wf: RetoolWorkflow,
  report: ReportBuilder,
): WorkflowDefinition {
  const extra = wf.libraries.filter(
    (l) => (l.language ?? 'javascript') === 'javascript' && l.name && !BUILT_IN_LIBRARIES.has(l.name),
  )
  const setup = wf.setupScript.javascript
  const declared = [
    ...stripComments(setup).matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1]!)
  const libraryNames = new Set([...BUILT_IN_NAMES, ...extra.flatMap((l) => (l.variable ? [l.variable] : []))])
  const setupMatters = stripComments(setup).trim() !== '' && declared.some((name) => !libraryNames.has(name))
  if (!extra.length && !setupMatters) {
    if (stripComments(setup).trim())
      report.note("The setup script only loaded Retool's libraries, which are built in here")
    return def
  }
  if (extra.length) {
    report.note(
      `Retool libraries ${extra.map((l) => l.name).join(', ')} became JavaScript packages, imported where code uses them`,
    )
  }
  if (setupMatters) {
    report.note(
      "The JavaScript setup script was put in front of each JavaScript code body: check it's still needed there",
    )
  }
  const prefix = (code: string) => {
    const imports = extra
      .filter(
        (l) => l.variable && new RegExp(`(^|[^\\w$.])${l.variable.replace(/[$]/g, '\\$')}\\b`).test(code),
      )
      .map((l) => `import ${l.variable} from ${JSON.stringify(l.name)}`)
    const head = [...imports, ...(setupMatters ? [stripLibraryLines(setup).trim()] : [])].filter(Boolean)
    return head.length ? `${head.join('\n')}\n${code}` : code
  }
  const mapBlock = (block: Block): Block => {
    if (block.type === 'code' && !block.config.language)
      return { ...block, config: { ...block.config, code: prefix(block.config.code) } }
    if (block.type === 'loop' && block.config.runner.kind === 'code' && !block.config.runner.language) {
      return {
        ...block,
        config: {
          ...block.config,
          runner: { ...block.config.runner, code: prefix(block.config.runner.code) },
        },
      }
    }
    return block
  }
  return {
    ...def,
    blocks: def.blocks.map(mapBlock),
    ...(def.functions && { functions: def.functions.map((f) => ({ ...f, blocks: f.blocks.map(mapBlock) })) }),
    ...(extra.length && {
      settings: {
        ...def.settings,
        javascript: { packages: extra.map((l) => (l.version ? `${l.name}@${l.version}` : l.name)) },
      },
    }),
  }
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The setup script without lines that load a library (`const _ = require('lodash')`): those are built in or imported. */
function stripLibraryLines(code: string): string {
  return code
    .split('\n')
    .filter((line) => !/^\s*(const|let|var)\s+[\w$]+\s*=\s*require\(/.test(line))
    .join('\n')
}

/**
 * Retool lets a function's blocks read its parameters by name (`{{ token }}`); here they're `params.token`. Names
 * that are blocks of the function (or locals) are left alone.
 */
function withParams(block: Block, paramNames: string[], blocks: Block[]): Block {
  const names = new Set(paramNames.filter((n) => !blocks.some((b) => b.name === n)))
  if (!names.size) return block
  const out = structuredClone(block)
  for (const field of codeFields(block)) {
    const refs = fieldRefs(field).refs.filter((r) => names.has(r.name))
    if (!refs.length) continue
    let source = field.source
    for (const ref of [...refs].sort((a, b) => b.start - a.start)) {
      const replacement = ref.shorthand ? `${ref.name}: params.${ref.name}` : `params.${ref.name}`
      source = source.slice(0, ref.start) + replacement + source.slice(ref.end)
    }
    let node = out as unknown as Record<string | number, unknown>
    for (const key of field.path.slice(0, -1)) node = node[key] as Record<string | number, unknown>
    node[field.path.at(-1)!] = source
  }
  return out
}
