import { type AppDefinition, type AppGraph, componentSpec } from '@ow/app-definition'

/*
 * Getting around an app in the editor (session 41, after Retool's code search, ⌘K and dependency graph): what each
 * component, query, transformer and variable reads and is read by, a search over every field, and the palette's
 * fuzzy match. Pure, so it's tested without a page.
 */

/** What an entity reads (`uses`) and what reads it (`usedBy`), by name, from the fields' references. */
export interface EntityLinks {
  uses: string[]
  usedBy: string[]
}

/** Every entity's links. References to globals (`url`, `current_user`) and to itself don't count. */
export function entityLinks(graph: AppGraph): Map<string, EntityLinks> {
  const uses = new Map<string, Set<string>>()
  const usedBy = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>()
    set.add(value)
    map.set(key, set)
  }
  for (const field of graph.fields) {
    for (const ref of field.refs) {
      const target = graph.entities.get(ref.name)
      if (!target || ref.name === field.owner || !isAppEntity(target.kind)) continue
      if (!graph.entities.has(field.owner)) continue
      add(uses, field.owner, ref.name)
      add(usedBy, ref.name, field.owner)
    }
  }
  const links = new Map<string, EntityLinks>()
  for (const name of graph.entities.keys()) {
    links.set(name, {
      uses: [...(uses.get(name) ?? [])].sort(),
      usedBy: [...(usedBy.get(name) ?? [])].sort(),
    })
  }
  return links
}

const isAppEntity = (kind: string) => ['component', 'query', 'transformer', 'variable'].includes(kind)

export interface SearchOptions {
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
}

/** A place a search found: an entity's field (with where in it), or the entity's name. */
export interface SearchHit {
  owner: string
  /** The field's path in the definition; empty for a hit on the name. */
  path: (string | number)[]
  /** The field as people read it: "Text", "SQL", "Event handler 1". */
  label: string
  /** The line around the first match. */
  before: string
  match: string
  after: string
  /** The page the owner is on; null for every page. */
  page: string | null
}

/** A search's pattern, or why it isn't one (a bad regular expression). */
export function searchPattern(query: string, options: SearchOptions = {}): RegExp | string | null {
  if (!query) return null
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (options.wholeWord) source = `\\b${source}\\b`
  try {
    return new RegExp(source, options.matchCase ? 'g' : 'gi')
  } catch (err) {
    return err instanceof Error ? err.message : 'Not a regular expression'
  }
}

/**
 * Every field and name matching `pattern`, by owner in the definition's order (components, queries, transformers,
 * variables), one hit per field (its first match).
 */
export function searchApp(def: AppDefinition, graph: AppGraph, pattern: RegExp): SearchHit[] {
  const pages = pagesOf(def)
  const hits: SearchHit[] = []
  const first = (text: string) => {
    pattern.lastIndex = 0
    const m = pattern.exec(text)
    return m && m[0].length > 0 ? m : null
  }
  const owners = [
    ...def.components.map((c) => c.name),
    ...def.queries.map((q) => q.name),
    ...(def.transformers ?? []).map((t) => t.name),
    ...(def.variables ?? []).map((v) => v.name),
  ]
  const byOwner = new Map<string, typeof graph.fields>()
  for (const field of graph.fields) byOwner.set(field.owner, [...(byOwner.get(field.owner) ?? []), field])
  for (const owner of owners) {
    const page = pages.get(owner) ?? null
    const named = first(owner)
    if (named) hits.push({ owner, path: [], label: 'Name', ...around(owner, named), page })
    for (const field of byOwner.get(owner) ?? []) {
      const m = first(field.source)
      if (m)
        hits.push({
          owner,
          path: field.path,
          label: fieldLabel(def, field.path),
          ...around(field.source, m),
          page,
        })
    }
  }
  return hits
}

/** The line holding a match, with the match cut out of it (long lines shortened around it). */
function around(text: string, m: RegExpExecArray): Pick<SearchHit, 'before' | 'match' | 'after'> {
  const lineStart = text.lastIndexOf('\n', m.index - 1) + 1
  const lineEnd = text.indexOf('\n', m.index + m[0].length)
  const before = text.slice(lineStart, m.index)
  const after = text.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd)
  return {
    before: before.length > 40 ? `…${before.slice(-40)}` : before,
    match: m[0],
    after: after.length > 60 ? `${after.slice(0, 60)}…` : after,
  }
}

/** Which page each entity is on (components inside others take their outermost's). */
function pagesOf(def: AppDefinition): Map<string, string | null> {
  const byName = new Map(def.components.map((c) => [c.name, c]))
  const pages = new Map<string, string | null>()
  for (const c of def.components) {
    let at = c
    while (at.parent && byName.has(at.parent)) at = byName.get(at.parent)!
    pages.set(c.name, at.page ?? null)
  }
  for (const q of def.queries) pages.set(q.name, q.page ?? null)
  for (const t of def.transformers ?? []) pages.set(t.name, t.page ?? null)
  for (const v of def.variables ?? []) pages.set(v.name, null)
  return pages
}

const QUERY_FIELD_LABELS: Record<string, string> = {
  code: 'Code',
  sql: 'SQL',
  confirm: 'Confirmation',
  disabled: 'Disable when',
  transform: 'Transform',
  body: 'Body',
  url: 'URL',
}

/** A field's path as people read it: a component's prop label, a query's part, an event handler. */
export function fieldLabel(def: AppDefinition, path: readonly (string | number)[]): string {
  const [kind, index, part, key, ...rest] = path
  const handler = (i: unknown) => `Event handler ${Number(i) + 1}`
  if (kind === 'components' && typeof index === 'number') {
    const component = def.components[index]
    if (part === 'events') return handler(key)
    if (part === 'props' && typeof key === 'string') {
      const label = component && componentSpec(component.type)?.props[key]?.label
      const inner = rest.length ? ` › ${rest.filter((r) => typeof r === 'string').join(' › ')}` : ''
      return `${label || key}${inner}`
    }
  }
  if (kind === 'queries') {
    if (part === 'events') return handler(key)
    if (part === 'query' && typeof key === 'string') return QUERY_FIELD_LABELS[key] ?? key
    if (typeof part === 'string') return QUERY_FIELD_LABELS[part] ?? part
  }
  if (kind === 'transformers') return 'Code'
  if (kind === 'variables') return 'Initial value'
  return path.filter((p) => typeof p === 'string').join(' › ')
}

/**
 * How well `query` matches `text` as a subsequence (⌘K): null when it doesn't; higher is better. Matches at the start,
 * at word starts and in a row score more; shorter texts win ties.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let at = 0
  let last = -2
  for (const ch of q) {
    const found = t.indexOf(ch, at)
    if (found === -1) return null
    const wordStart =
      found === 0 || /[\s_\-./]/.test(t[found - 1]!) || (text[found] !== t[found] && found > 0)
    score += 1 + (found === last + 1 ? 3 : 0) + (wordStart ? 2 : 0) + (found === 0 ? 3 : 0)
    last = found
    at = found + 1
  }
  return score - text.length * 0.01
}
