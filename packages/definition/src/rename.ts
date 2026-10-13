import { type CodeField, codeFields, fieldRefs } from './fields'
import { reservedNameReason } from './names'
import { type Block, blockNameSchema, type WorkflowDefinition } from './schema'

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
 */
export function renameBlock(def: WorkflowDefinition, from: string, to: string): RenameResult {
  if (!def.blocks.some((b) => b.name === from)) return { ok: false, error: `No block is named "${from}"` }
  if (from === to) return { ok: true, definition: def, changed: [], skipped: [] }
  const valid = blockNameSchema.safeParse(to)
  if (!valid.success) return { ok: false, error: valid.error.issues[0]!.message }
  const reserved = reservedNameReason(to)
  if (reserved) return { ok: false, error: reserved }
  if (def.blocks.some((b) => b.name === to))
    return { ok: false, error: `Another block is already named "${to}"` }

  const changed: { block: string; path: (string | number)[] }[] = []
  const skipped: { block: string; path: (string | number)[] }[] = []
  const blocks: Block[] = []
  for (const original of def.blocks) {
    const block = structuredClone(original)
    for (const field of codeFields(original)) {
      const result = renameInField(field, from, to)
      if (result === 'captured') {
        return {
          ok: false,
          error: `"${to}" is already a variable in block "${original.name}"; pick another name`,
        }
      }
      if (result.skipped) skipped.push({ block: original.name, path: field.path })
      if (result.source !== field.source) {
        setAt(block, field.path, result.source)
        changed.push({ block: original.name, path: field.path })
      }
    }
    if (block.name === from) block.name = to
    blocks.push(block)
  }

  const edges = def.edges.map((e) => ({
    ...e,
    from: e.from === from ? to : e.from,
    to: e.to === from ? to : e.to,
  }))
  const definition: WorkflowDefinition = { ...def, blocks, edges }
  if (def.layout?.blocks?.[from]) {
    const { [from]: position, ...rest } = def.layout.blocks
    definition.layout = { ...def.layout, blocks: { ...rest, [to]: position! } }
  }
  return { ok: true, definition, changed, skipped }
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
