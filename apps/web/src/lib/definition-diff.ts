import {
  appRenamer,
  appSpec,
  type CollabSpec,
  type DefinitionDiff,
  type DiffChange,
  diff,
  libraryQuerySpec,
  type Renamer,
  workflowRenamer,
  workflowSpec,
} from '@ow/collab'

/**
 * What Compare shows (M24, architecture §2.27): two definitions' diff from `@ow/collab`, grouped by what people edit
 * (components, queries, blocks…), each item with its field changes.
 */

export type DefinitionKind = 'workflow' | 'app' | 'module' | 'library'

const SPECS: Record<DefinitionKind, { spec: CollabSpec; renamer?: Renamer<never> }> = {
  workflow: { spec: workflowSpec, renamer: workflowRenamer as Renamer<never> },
  app: { spec: appSpec, renamer: appRenamer as Renamer<never> },
  module: { spec: appSpec, renamer: appRenamer as Renamer<never> },
  library: { spec: libraryQuerySpec },
}

/** What changed from `before` to `after`, renames followed where the kind has them. */
export function compareDefinitions(kind: DefinitionKind, before: unknown, after: unknown): DefinitionDiff {
  const { spec, renamer } = SPECS[kind]
  return diff(spec, before as never, after as never, renamer ? { renamer } : {})
}

export interface FieldChange {
  /** Where in the item (`props.text`, `config.query.sql`); empty for the item whole. */
  label: string
  change: DiffChange
}

export interface DiffItem {
  key: string
  /** The item's name as people know it (an edge as `from → to`). */
  name: string
  status: 'added' | 'removed' | 'changed' | 'renamed'
  renamedFrom?: string
  /** The whole item, for one added or removed. */
  value?: unknown
  changes: FieldChange[]
}

export interface DiffGroup {
  key: string
  label: string
  items: DiffItem[]
  /** The group's items are in another order. */
  reordered: boolean
}

const LABELS: Record<string, string> = {
  blocks: 'Blocks',
  edges: 'Connections',
  functions: 'Functions',
  components: 'Components',
  queries: 'Queries',
  transformers: 'Transformers',
  variables: 'Variables',
  pages: 'Pages',
  layout: 'Layout',
  settings: 'Settings',
  triggers: 'Triggers',
  module: 'Module inputs, outputs and events',
  params: 'Parameters',
  query: 'Query',
  resource: 'Resource',
}

const label = (key: string) => LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)

/** An edge's identity (`from port to`) as people read it. */
const itemName = (group: string, key: string) => {
  if (group !== 'edges') return key
  const [from, port, to] = key.split(' ')
  return port === 'out' ? `${from} → ${to}` : `${from} (${port}) → ${to}`
}

/**
 * The diff grouped by the definition's top-level keys, in the order they first change. In a collection with an
 * identity (blocks, components…) each item is one entry; elsewhere (settings, layout, a library query's SQL) each
 * change is its own entry, named by where it is. Items come in the diff's order: removals first.
 */
export function groupDiff(kind: DefinitionKind, result: DefinitionDiff): DiffGroup[] {
  const { spec } = SPECS[kind]
  const groups = new Map<string, DiffGroup>()
  const group = (key: string) => {
    let g = groups.get(key)
    if (!g) {
      g = { key, label: label(key), items: [], reordered: false }
      groups.set(key, g)
    }
    return g
  }
  const item = (g: DiffGroup, key: string, name = itemName(g.key, key)) => {
    let i = g.items.find((x) => x.key === key)
    if (!i) {
      i = { key, name, status: 'changed', changes: [] }
      g.items.push(i)
    }
    return i
  }
  for (const r of result.renames) {
    const i = item(group(r.group), r.to)
    i.status = 'renamed'
    i.renamedFrom = r.from
  }
  for (const change of result.changes) {
    const [top, second] = change.at
    if (top === undefined) {
      // The definition itself changed whole (it isn't an object): one entry.
      item(group('definition'), '', 'Definition').changes.push({ label: '', change })
      continue
    }
    const g = group(top)
    if (change.at.length === 1 && change.kind === 'order') {
      g.reordered = true
      continue
    }
    if (spec.identity([top]) && second !== undefined) {
      const i = item(g, second)
      if (change.at.length === 2 && (change.kind === 'added' || change.kind === 'removed')) {
        i.status = change.kind
        i.value = change.kind === 'added' ? change.after : change.before
      } else {
        i.changes.push({ label: change.at.slice(2).join('.'), change })
      }
      continue
    }
    const rest = change.at.slice(1).join('.')
    const i = item(g, rest, rest || g.label)
    if (change.kind === 'added' || change.kind === 'removed') {
      i.status = change.kind
      i.value = change.kind === 'added' ? change.after : change.before
    } else i.changes.push({ label: '', change })
  }
  return [...groups.values()]
}

/** How many items were added, removed, renamed and changed, for the summary line. */
export function diffSummary(groups: DiffGroup[]): Record<DiffItem['status'], number> {
  const counts = { added: 0, removed: 0, changed: 0, renamed: 0 }
  for (const g of groups) for (const i of g.items) counts[i.status]++
  return counts
}
