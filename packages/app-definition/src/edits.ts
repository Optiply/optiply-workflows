import { componentSpec, type JsonValue } from './components'
import { appNameReason } from './names'
import type {
  AppComponent,
  AppDefinition,
  AppQuery,
  EventHandler,
  Position,
  Transformer,
  Variable,
} from './schema'

/**
 * The editor's changes to an app, as pure functions: each returns a new definition and leaves its input alone.
 * Renaming (which rewrites references) is `renameAppEntity`.
 */

/** Every name in use: components, queries, transformers and variables share one namespace. */
export function usedNames(def: AppDefinition): Set<string> {
  return new Set([
    ...def.components.map((c) => c.name),
    ...def.queries.map((q) => q.name),
    ...(def.transformers ?? []).map((t) => t.name),
    ...(def.variables ?? []).map((v) => v.name),
  ])
}

/** `base1`, `base2`, …: the first free name. */
export function nextName(def: AppDefinition, base: string): string {
  const used = usedNames(def)
  for (let n = 1; ; n++) {
    const name = `${base}${n}`
    if (!used.has(name) && !appNameReason(name)) return name
  }
}

/** The component and everything inside it, at any depth. */
export function withDescendants(def: AppDefinition, name: string): Set<string> {
  const out = new Set([name])
  for (let grew = true; grew; ) {
    grew = false
    for (const c of def.components) {
      if (c.parent !== undefined && out.has(c.parent) && !out.has(c.name)) {
        out.add(c.name)
        grew = true
      }
    }
  }
  return out
}

/** The first free row below `parent`'s children. */
function bottomOf(def: AppDefinition, parent: string | undefined): number {
  let bottom = 0
  for (const c of def.components) {
    const p = def.layout?.[c.name]
    if (c.parent === parent && p) bottom = Math.max(bottom, p.y + p.h)
  }
  return bottom
}

/**
 * Adds a component of `type` to `parent` (the page when missing): at `position`, or below what's there at the
 * type's default size. Modals always go on the page, without a position. Returns the new definition and its name.
 */
export function addComponent(
  def: AppDefinition,
  type: string,
  opts: { parent?: string; position?: Partial<Position> } = {},
): { definition: AppDefinition; name: string } {
  const spec = componentSpec(type)
  if (!spec) throw new Error(`Unknown component type "${type}"`)
  const name = nextName(def, type)
  const parent = spec.overlay ? undefined : opts.parent
  const component: AppComponent = { name, type, ...(parent !== undefined && { parent }) }
  const layout = { ...def.layout }
  if (!spec.overlay) {
    const w = Math.min(opts.position?.w ?? spec.defaultSize.w, 12)
    layout[name] = {
      x: Math.min(opts.position?.x ?? 0, 12 - w),
      y: opts.position?.y ?? bottomOf(def, parent),
      w,
      h: opts.position?.h ?? spec.defaultSize.h,
    }
  }
  return { definition: { ...def, components: [...def.components, component], layout }, name }
}

/** Removes a component with everything inside it. References to them are left for the validator to point out. */
export function removeComponent(def: AppDefinition, name: string): AppDefinition {
  const gone = withDescendants(def, name)
  const layout = Object.fromEntries(Object.entries(def.layout ?? {}).filter(([k]) => !gone.has(k)))
  return { ...def, components: def.components.filter((c) => !gone.has(c.name)), layout }
}

/** Replaces one component (by name) with `edit`'s result. */
export function updateComponent(
  def: AppDefinition,
  name: string,
  edit: (component: AppComponent) => AppComponent,
): AppDefinition {
  return { ...def, components: def.components.map((c) => (c.name === name ? edit(c) : c)) }
}

/** Sets a prop, or with `undefined` goes back to the default. */
export function setProp(
  def: AppDefinition,
  name: string,
  prop: string,
  value: JsonValue | undefined,
): AppDefinition {
  return updateComponent(def, name, (c) => {
    const props = { ...c.props }
    if (value === undefined) delete props[prop]
    else props[prop] = value
    const { props: _old, ...rest } = c
    return Object.keys(props).length ? { ...rest, props } : rest
  })
}

export function setHandlers(def: AppDefinition, owner: string, events: EventHandler[]): AppDefinition {
  const apply = <T extends { name: string; events?: EventHandler[] }>(item: T): T => {
    if (item.name !== owner) return item
    const { events: _old, ...rest } = item
    return (events.length ? { ...rest, events } : rest) as T
  }
  return { ...def, components: def.components.map(apply), queries: def.queries.map(apply) }
}

/** Positions from the canvas, for the children of one parent. Positions of other components are kept. */
export function setPositions(def: AppDefinition, positions: Record<string, Position>): AppDefinition {
  const layout = { ...def.layout }
  let changed = false
  for (const [name, p] of Object.entries(positions)) {
    const before = layout[name]
    if (before && before.x === p.x && before.y === p.y && before.w === p.w && before.h === p.h) continue
    layout[name] = { x: p.x, y: p.y, w: p.w, h: p.h }
    changed = true
  }
  return changed ? { ...def, layout } : def
}

/**
 * Moves a component (and what's inside it) into another parent, below what's there. Refused (unchanged) for a
 * parent inside the component itself, or one that can't hold components.
 */
export function moveToParent(def: AppDefinition, name: string, parent: string | undefined): AppDefinition {
  const component = def.components.find((c) => c.name === name)
  if (!component || component.parent === parent) return def
  if (parent !== undefined) {
    const target = def.components.find((c) => c.name === parent)
    if (!target || !componentSpec(target.type)?.container || withDescendants(def, name).has(parent))
      return def
  }
  const moved = updateComponent(def, name, (c) => {
    const next = { ...c }
    if (parent === undefined) delete next.parent
    else next.parent = parent
    return next
  })
  const position = def.layout?.[name]
  if (!position) return moved
  // Below the new parent's children, counted before the move (the component's old place doesn't count).
  return { ...moved, layout: { ...moved.layout, [name]: { ...position, x: 0, y: bottomOf(def, parent) } } }
}

/** Adds a query: a resource query (manual unless it reads, `auto`) or a JS query. */
export function addQuery(
  def: AppDefinition,
  kind: 'resource' | 'js',
  opts: { resource?: string; run?: 'auto' | 'manual' } = {},
): { definition: AppDefinition; name: string } {
  const name = nextName(def, 'query')
  const query: AppQuery =
    kind === 'js'
      ? { name, kind: 'js', code: 'return 1' }
      : {
          name,
          kind: 'resource',
          resource: opts.resource ?? 'optiply_db',
          query: { sql: 'select 1' },
          run: opts.run ?? 'auto',
        }
  return { definition: { ...def, queries: [...def.queries, query] }, name }
}

export function updateQuery(
  def: AppDefinition,
  name: string,
  edit: (query: AppQuery) => AppQuery,
): AppDefinition {
  return { ...def, queries: def.queries.map((q) => (q.name === name ? edit(q) : q)) }
}

export function addTransformer(def: AppDefinition): { definition: AppDefinition; name: string } {
  const name = nextName(def, 'transformer')
  const transformer: Transformer = { name, code: 'return null' }
  return { definition: { ...def, transformers: [...(def.transformers ?? []), transformer] }, name }
}

export function updateTransformer(
  def: AppDefinition,
  name: string,
  edit: (t: Transformer) => Transformer,
): AppDefinition {
  return { ...def, transformers: (def.transformers ?? []).map((t) => (t.name === name ? edit(t) : t)) }
}

export function addVariable(def: AppDefinition): { definition: AppDefinition; name: string } {
  const name = nextName(def, 'variable')
  const variable: Variable = { name }
  return { definition: { ...def, variables: [...(def.variables ?? []), variable] }, name }
}

export function updateVariable(
  def: AppDefinition,
  name: string,
  edit: (v: Variable) => Variable,
): AppDefinition {
  return { ...def, variables: (def.variables ?? []).map((v) => (v.name === name ? edit(v) : v)) }
}

/** Removes a query, transformer or variable. */
export function removeCode(def: AppDefinition, name: string): AppDefinition {
  return {
    ...def,
    queries: def.queries.filter((q) => q.name !== name),
    ...(def.transformers && { transformers: def.transformers.filter((t) => t.name !== name) }),
    ...(def.variables && { variables: def.variables.filter((v) => v.name !== name) }),
  }
}
