import { type CodeField, codeFields, fieldRefs } from './fields'
import { reservedNameReason } from './names'
import {
  type Block,
  blockNameSchema,
  type Edge,
  type FunctionDefinition,
  type WorkflowDefinition,
} from './schema'

export type RenameResult =
  | {
      ok: true
      definition: WorkflowDefinition
      /** Fields whose code changed, for the editor to refresh. */
      changed: { block: string; path: (string | number)[] }[]
      /** Fields with syntax errors that mention the old name; they can't be analysed, so they were left alone. */
      skipped: { block: string; path: (string | number)[] }[]
    }
  | { ok: false; error: string }

/**
 * Renames a block and rewrites every reference to it: in code, templates, conditions and queries, plus edges and
 * layout. Only real references change: locals, property names (`x.from`) and strings are left alone, and a
 * shorthand property keeps its key (`{ old }` becomes `{ old: renamed }`). Refuses when a local variable in some
 * block already uses the new name, since references there would silently change meaning.
 *
 * With `function`, renames a block inside that function; block names are local to their function.
 */
export function renameBlock(
  def: WorkflowDefinition,
  from: string,
  to: string,
  opts: { function?: string } = {},
): RenameResult {
  const fnIndex =
    opts.function === undefined ? -1 : (def.functions ?? []).findIndex((f) => f.name === opts.function)
  if (opts.function !== undefined && fnIndex < 0) {
    return { ok: false, error: `No function is named "${opts.function}"` }
  }
  const graph: GraphPart = fnIndex < 0 ? def : def.functions![fnIndex]!
  if (!graph.blocks.some((b) => b.name === from)) return { ok: false, error: `No block is named "${from}"` }
  if (from === to) return { ok: true, definition: def, changed: [], skipped: [] }
  const valid = blockNameSchema.safeParse(to)
  if (!valid.success) return { ok: false, error: valid.error.issues[0]!.message }
  const reserved = reservedNameReason(to)
  if (reserved) return { ok: false, error: reserved }
  if (graph.blocks.some((b) => b.name === to))
    return { ok: false, error: `Another block is already named "${to}"` }
  if (def.functions?.some((f) => f.name === to))
    return { ok: false, error: `A function is already named "${to}"` }

  const rewritten = rewriteRefs(graph.blocks, from, to, () => true)
  if (!rewritten.ok) return rewritten
  const blocks = rewritten.blocks.map((b) => (b.name === from ? { ...b, name: to } : b))
  const edges = graph.edges.map((e) => ({
    ...e,
    from: e.from === from ? to : e.from,
    to: e.to === from ? to : e.to,
  }))
  const part: GraphPart = { ...graph, blocks, edges }
  if (graph.layout?.blocks?.[from]) {
    const { [from]: position, ...rest } = graph.layout.blocks
    part.layout = { ...graph.layout, blocks: { ...rest, [to]: position! } }
  }

  let definition: WorkflowDefinition
  if (fnIndex < 0) {
    definition = { ...def, ...part }
  } else {
    const fn = { ...(part as FunctionDefinition) }
    if (fn.returns === from) fn.returns = to
    definition = { ...def, functions: def.functions!.map((f, i) => (i === fnIndex ? fn : f)) }
  }
  return { ok: true, definition, changed: rewritten.changed, skipped: rewritten.skipped }
}

/**
 * Renames a function and every call to it: Function blocks, loop function runners and `await name()` in code, in
 * the workflow and in every function. Refuses when the new name is taken by a block or function, or when a local
 * variable would capture it. `changed` and `skipped` name blocks of the main graph by name and blocks inside
 * functions as `<function>.<block>`.
 */
export function renameFunction(def: WorkflowDefinition, from: string, to: string): RenameResult {
  const functions = def.functions ?? []
  if (!functions.some((f) => f.name === from)) return { ok: false, error: `No function is named "${from}"` }
  if (from === to) return { ok: true, definition: def, changed: [], skipped: [] }
  const valid = blockNameSchema.safeParse(to)
  if (!valid.success) return { ok: false, error: valid.error.issues[0]!.message }
  const reserved = reservedNameReason(to)
  if (reserved) return { ok: false, error: reserved }
  if (functions.some((f) => f.name === to))
    return { ok: false, error: `Another function is already named "${to}"` }
  const graphs: GraphPart[] = [def, ...functions]
  if (graphs.some((g) => g.blocks.some((b) => b.name === to))) {
    return { ok: false, error: `A block is already named "${to}"` }
  }

  const changed: RenameLocation[] = []
  const skipped: RenameLocation[] = []
  const renamed: GraphPart[] = []
  for (const [i, graph] of graphs.entries()) {
    const prefix = i === 0 ? '' : `${functions[i - 1]!.name}.`
    // A graph with a block named like the function reads the block there, not the function.
    const shadowed = graph.blocks.some((b) => b.name === from)
    const rewritten = shadowed
      ? { ok: true as const, blocks: [...graph.blocks], changed: [], skipped: [] }
      : rewriteRefs(graph.blocks, from, to, (field) => field.kind === 'function-body')
    if (!rewritten.ok) return rewritten
    const blocks = rewritten.blocks.map((block): Block => {
      if (block.type === 'function' && block.config.function === from) {
        changed.push({ block: `${prefix}${block.name}`, path: ['config', 'function'] })
        return { ...block, config: { ...block.config, function: to } }
      }
      if (
        block.type === 'loop' &&
        block.config.runner.kind === 'function' &&
        block.config.runner.function === from
      ) {
        changed.push({ block: `${prefix}${block.name}`, path: ['config', 'runner', 'function'] })
        return { ...block, config: { ...block.config, runner: { ...block.config.runner, function: to } } }
      }
      return block
    })
    for (const c of rewritten.changed) changed.push({ ...c, block: `${prefix}${c.block}` })
    for (const s of rewritten.skipped) skipped.push({ ...s, block: `${prefix}${s.block}` })
    renamed.push({ ...graph, blocks })
  }

  const [main, ...rest] = renamed
  const definition: WorkflowDefinition = {
    ...def,
    blocks: main!.blocks,
    functions: rest.map((g, i) => {
      const fn = g as FunctionDefinition
      return functions[i]!.name === from ? { ...fn, name: to } : fn
    }),
  }
  return { ok: true, definition, changed, skipped }
}

type RenameLocation = { block: string; path: (string | number)[] }

/** What renaming needs from the main graph or a function. */
type GraphPart = {
  blocks: Block[]
  edges: Edge[]
  layout?: WorkflowDefinition['layout']
}

/** Rewrites free references to `from` in the code fields `include` accepts. */
function rewriteRefs(
  original: readonly Block[],
  from: string,
  to: string,
  include: (field: CodeField) => boolean,
):
  | { ok: true; blocks: Block[]; changed: RenameLocation[]; skipped: RenameLocation[] }
  | { ok: false; error: string } {
  const changed: RenameLocation[] = []
  const skipped: RenameLocation[] = []
  const blocks: Block[] = []
  for (const source of original) {
    const block = structuredClone(source)
    for (const field of codeFields(source)) {
      if (!include(field)) continue
      const result = renameInField(field, from, to)
      if (result === 'captured') {
        return {
          ok: false,
          error: `"${to}" is already a variable in block "${source.name}"; pick another name`,
        }
      }
      if (result.skipped) skipped.push({ block: source.name, path: field.path })
      if (result.source !== field.source) {
        setAt(block, field.path, result.source)
        changed.push({ block: source.name, path: field.path })
      }
    }
    blocks.push(block)
  }
  return { ok: true, blocks, changed, skipped }
}

/**
 * The field's new source, plus `skipped` when part of it can't be analysed but mentions `from` (the analysable
 * parts are still renamed), or `captured` when a local would shadow `to`.
 */
function renameInField(
  field: CodeField,
  from: string,
  to: string,
): { source: string; skipped: boolean } | 'captured' {
  const before = fieldRefs(field)
  const targets = before.refs.filter((r) => r.name === from)
  const skipped = before.errors.length > 0 && new RegExp(`\\b${from}\\b`).test(field.source)
  if (!targets.length) return { source: field.source, skipped }

  let source = field.source
  for (const ref of [...targets].reverse()) {
    const replacement = ref.shorthand ? `${from}: ${to}` : to
    source = source.slice(0, ref.start) + replacement + source.slice(ref.end)
  }
  // Every rewritten reference must still be free; a local named `to` would capture it.
  const count = (refs: { name: string }[]) => refs.filter((r) => r.name === to).length
  const after = fieldRefs({ ...field, source })
  if (count(after.refs) !== count(before.refs) + targets.length) return 'captured'
  return { source, skipped }
}

function setAt(target: unknown, path: (string | number)[], value: string) {
  let node = target as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>
  node[path.at(-1)!] = value
}
