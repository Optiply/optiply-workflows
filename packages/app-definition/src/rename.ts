import { fieldRefs, renameInField } from '@ow/definition'
import { appFields } from './fields'
import { appNameReason } from './names'
import { type AppDefinition, appNameSchema, type EventHandler } from './schema'

export type AppRenameResult =
  | {
      ok: true
      definition: AppDefinition
      /** Paths of the fields whose code changed. */
      changed: (string | number)[][]
      /** Fields with syntax errors that mention the old name; they can't be analysed, so they were left alone. */
      skipped: (string | number)[][]
    }
  | { ok: false; error: string }

/**
 * Renames a component, query, transformer or variable and rewrites every reference to it: in templates and code,
 * parents, the layout and event handlers. Only real references change (locals, property names and strings are
 * left alone; a shorthand property keeps its key). Refuses when a local variable somewhere already uses the new
 * name, since references there would silently change meaning.
 */
export function renameAppEntity(def: AppDefinition, from: string, to: string): AppRenameResult {
  const names = [
    ...def.components.map((c) => c.name),
    ...def.queries.map((q) => q.name),
    ...(def.transformers ?? []).map((t) => t.name),
    ...(def.variables ?? []).map((v) => v.name),
  ]
  if (!names.includes(from)) return { ok: false, error: `Nothing is named "${from}"` }
  if (from === to) return { ok: true, definition: def, changed: [], skipped: [] }
  const valid = appNameSchema.safeParse(to)
  if (!valid.success) return { ok: false, error: valid.error.issues[0]!.message }
  const reserved = appNameReason(to)
  if (reserved) return { ok: false, error: reserved }
  if (names.includes(to)) return { ok: false, error: `Something else is already named "${to}"` }

  const next = structuredClone(def)
  const changed: (string | number)[][] = []
  const skipped: (string | number)[][] = []
  for (const field of appFields(def)) {
    const result = renameInField(field, from, to)
    if (result === 'captured') {
      return {
        ok: false,
        error: `"${to}" is already a variable in the code of "${field.owner}"; pick another name`,
      }
    }
    if (result.skipped) skipped.push(field.path)
    if (result.source !== field.source) {
      setAt(next, field.path, result.source)
      changed.push(field.path)
    }
  }

  const rename = (name: string) => (name === from ? to : name)
  const renameHandlers = (handlers: EventHandler[] | undefined) => {
    for (const h of handlers ?? []) {
      const a = h.action
      if (a.type === 'controlQuery') a.query = rename(a.query)
      if (a.type === 'controlComponent') a.component = rename(a.component)
      if (a.type === 'setVariable') a.variable = rename(a.variable)
    }
  }
  for (const c of next.components) {
    c.name = rename(c.name)
    if (c.parent !== undefined) c.parent = rename(c.parent)
    renameHandlers(c.events)
  }
  for (const q of next.queries) {
    q.name = rename(q.name)
    renameHandlers(q.events)
  }
  for (const t of next.transformers ?? []) t.name = rename(t.name)
  for (const v of next.variables ?? []) v.name = rename(v.name)
  if (next.layout && Object.hasOwn(next.layout, from)) {
    next.layout = Object.fromEntries(Object.entries(next.layout).map(([k, p]) => [rename(k), p]))
  }
  return { ok: true, definition: next, changed, skipped }
}

/** Sets the string at `path` inside `target` (a copy the caller owns). */
export function setAt(target: unknown, path: (string | number)[], value: string) {
  let node = target as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>
  node[path.at(-1)!] = value
}

/**
 * A module's input renamed (M21): every `inputs.<from>` (and `inputs['<from>']`) read in the module's templates and
 * code becomes `inputs.<to>`. `inputs` is a reserved name in modules, so the read is unambiguous; a field with a
 * syntax error that mentions it is left alone (`skipped`), and so is everything while `to` isn't a valid name.
 */
export function renameModuleInputReads(
  def: AppDefinition,
  from: string,
  to: string,
): { definition: AppDefinition; changed: (string | number)[][]; skipped: (string | number)[][] } {
  // A name that isn't one (the validator says so) would break the code reading it: the reads wait for a valid one.
  if (from === to || !def.module || !appNameSchema.safeParse(to).success) {
    return { definition: def, changed: [], skipped: [] }
  }
  const next = structuredClone(def)
  const changed: (string | number)[][] = []
  const skipped: (string | number)[][] = []
  for (const field of appFields(def)) {
    const { refs, errors } = fieldRefs(field, { properties: true })
    const reads = refs.filter(
      (r) => r.name === 'inputs' && r.property === from && r.propertyStart !== undefined,
    )
    if (errors.length && /\binputs\b/.test(field.source)) skipped.push(field.path)
    if (!reads.length) continue
    let source = field.source
    for (const r of [...reads].reverse())
      source = source.slice(0, r.propertyStart!) + to + source.slice(r.propertyEnd!)
    setAt(next, field.path, source)
    changed.push(field.path)
  }
  return { definition: next, changed, skipped }
}
