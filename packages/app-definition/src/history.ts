import { canonicalJson } from '@ow/definition'
import type { AppDefinition } from './schema'

/*
 * What changed between two versions of an app's draft (session 41, the History panel, after Retool's save log):
 * names added, removed or changed, and the parts of the app that aren't named (its theme, CSS, frame).
 */

export interface AppChangeSummary {
  added: string[]
  removed: string[]
  changed: string[]
  /** `theme`, `css`, `frame`, `module` (a module's inputs, outputs, events). */
  parts: string[]
}

const EMPTY: AppChangeSummary = { added: [], removed: [], changed: [], parts: [] }

/** Every named thing of an app, by name: components (with their place), code, pages. */
function named(def: AppDefinition | null): Map<string, string> {
  const items = new Map<string, string>()
  if (!def) return items
  for (const c of def.components) items.set(c.name, canonicalJson({ c, at: def.layout?.[c.name] ?? null }))
  for (const q of def.queries) items.set(q.name, canonicalJson(q))
  for (const t of def.transformers ?? []) items.set(t.name, canonicalJson(t))
  for (const v of def.variables ?? []) items.set(v.name, canonicalJson(v))
  // Pages share the names' space with nothing else in the summary: marked as such.
  for (const p of def.pages ?? []) items.set(`page ${p.name}`, canonicalJson(p))
  return items
}

/** What `after` changed of `before` (null: an app from nothing, everything added). */
export function summarizeAppChange(before: AppDefinition | null, after: AppDefinition): AppChangeSummary {
  const was = named(before)
  const now = named(after)
  const added = [...now.keys()].filter((n) => !was.has(n))
  const removed = [...was.keys()].filter((n) => !now.has(n))
  const changed = [...now.keys()].filter((n) => was.has(n) && was.get(n) !== now.get(n))
  const parts: string[] = (['theme', 'css', 'frame', 'module'] as const).filter(
    (part) => canonicalJson(before?.[part] ?? null) !== canonicalJson(after[part] ?? null),
  )
  // A save that only reorders (components in the tree, queries in their list) is a change too (review: unrecorded,
  // the newest entry wouldn't be the draft).
  const order = (d: AppDefinition | null) =>
    d
      ? canonicalJson([
          d.components.map((c) => c.name),
          d.queries.map((q) => q.name),
          (d.transformers ?? []).map((t) => t.name),
          (d.variables ?? []).map((v) => v.name),
        ])
      : null
  if (before && !added.length && !removed.length && order(before) !== order(after)) parts.push('order')
  // The order of pages counts too.
  if (
    before &&
    canonicalJson((before.pages ?? []).map((p) => p.name)) !==
      canonicalJson((after.pages ?? []).map((p) => p.name)) &&
    !added.some((n) => n.startsWith('page ')) &&
    !removed.some((n) => n.startsWith('page '))
  )
    parts.push('pages')
  return { added, removed, changed, parts }
}

/**
 * Two summaries in a row as one (edits close together in time make one history entry): what was added then
 * removed is gone from both, what was added then changed stays added.
 */
export function mergeChangeSummaries(first: AppChangeSummary, then: AppChangeSummary): AppChangeSummary {
  const added = new Set(first.added)
  const removed = new Set(first.removed)
  const changed = new Set(first.changed)
  for (const n of then.added) {
    if (removed.delete(n)) changed.add(n)
    else added.add(n)
  }
  for (const n of then.removed) {
    if (added.delete(n)) continue
    changed.delete(n)
    removed.add(n)
  }
  for (const n of then.changed) if (!added.has(n)) changed.add(n)
  return {
    added: [...added],
    removed: [...removed],
    changed: [...changed],
    parts: [...new Set([...first.parts, ...then.parts])],
  }
}

export function isEmptySummary(s: AppChangeSummary): boolean {
  return !s.added.length && !s.removed.length && !s.changed.length && !s.parts.length
}

const PART_LABELS: Record<string, string> = {
  theme: 'the theme',
  css: 'the custom CSS',
  frame: 'the frame',
  module: "the module's interface",
  pages: 'the pages’ order',
  order: 'the order',
}

/** A history entry's label: "Added button1, query2 · Changed table1 · Changed the theme". */
export function describeChange(s: AppChangeSummary = EMPTY, max = 3): string {
  const list = (names: string[]) =>
    names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ')
  const parts: string[] = []
  if (s.added.length) parts.push(`Added ${list(s.added)}`)
  if (s.removed.length) parts.push(`Removed ${list(s.removed)}`)
  if (s.changed.length) parts.push(`Changed ${list(s.changed)}`)
  if (s.parts.length) parts.push(`Changed ${s.parts.map((p) => PART_LABELS[p] ?? p).join(', ')}`)
  return parts.join(' · ') || 'No changes'
}
