import { type AppDefinition, renameAppEntity, renamePage } from '@ow/app-definition'
import { renameBlock, renameFunction, type WorkflowDefinition } from '@ow/definition'
import { equal } from './shared'

/**
 * Renames in a merge (M22, architecture §2.25): what a side renamed is found against the base and applied to the
 * base and the other side before the merge, so a rename on one side and edits on the other merge to both instead
 * of a deleted item and a new one.
 */

/** A definition's named items and how to rename one (rewriting every reference, as the editors do). */
export interface Renamer<D> {
  /** Every named item, by the collection it's in (`blocks`, `components`…): a rename stays within its collection. */
  items(definition: D): readonly { group: string; name: string; item: unknown }[]
  /** The definition with the item renamed and references rewritten; null when it can't be. */
  rename(definition: D, group: string, from: string, to: string): D | null
}

export interface Rename {
  group: string
  from: string
  to: string
}

/**
 * What `side` renamed since `base`: an item gone and one new item in the same collection that equals it once the
 * base has the rename applied (references to the old name read as the new). An item renamed and also changed on the
 * same side isn't recognised: it stays a deleted item and a new one.
 */
export function findRenames<D>(renamer: Renamer<D>, base: D, side: D): Rename[] {
  const before = renamer.items(base)
  const after = renamer.items(side)
  const has = (list: typeof before, group: string, name: string) =>
    list.some((i) => i.group === group && i.name === name)
  const gone = before.filter((i) => !has(after, i.group, i.name))
  const added = after.filter((i) => !has(before, i.group, i.name))
  const used = new Set<string>()
  const renames: Rename[] = []
  for (const old of gone) {
    for (const fresh of added) {
      if (fresh.group !== old.group || used.has(`${fresh.group}:${fresh.name}`)) continue
      const renamed = renamer.rename(base, old.group, old.name, fresh.name)
      const item =
        renamed && renamer.items(renamed).find((i) => i.group === old.group && i.name === fresh.name)
      if (item && equal(item.item, fresh.item)) {
        renames.push({ group: old.group, from: old.name, to: fresh.name })
        used.add(`${fresh.group}:${fresh.name}`)
        break
      }
    }
  }
  return renames
}

/** Workflows: blocks of the main graph and functions. */
export const workflowRenamer: Renamer<WorkflowDefinition> = {
  items: (def) => [
    ...def.blocks.map((b) => ({ group: 'blocks', name: b.name, item: b })),
    ...(def.functions ?? []).map((f) => ({ group: 'functions', name: f.name, item: f })),
  ],
  rename(def, group, from, to) {
    const result = group === 'functions' ? renameFunction(def, from, to) : renameBlock(def, from, to)
    return result.ok ? result.definition : null
  },
}

/** Apps and modules: components, queries, transformers and variables (one namespace), and pages. */
export const appRenamer: Renamer<AppDefinition> = {
  items: (def) => [
    ...def.components.map((c) => ({ group: 'components', name: c.name, item: c })),
    ...def.queries.map((q) => ({ group: 'queries', name: q.name, item: q })),
    ...(def.transformers ?? []).map((t) => ({ group: 'transformers', name: t.name, item: t })),
    ...(def.variables ?? []).map((v) => ({ group: 'variables', name: v.name, item: v })),
    ...(def.pages ?? []).map((p) => ({ group: 'pages', name: p.name, item: p })),
  ],
  rename(def, group, from, to) {
    if (group === 'pages') {
      const next = renamePage(def, from, to)
      return next === def ? null : next
    }
    const result = renameAppEntity(def, from, to)
    return result.ok ? result.definition : null
  },
}
