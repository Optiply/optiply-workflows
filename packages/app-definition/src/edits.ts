import { componentSpec, type JsonValue, moduleComponentSpec } from './components'
import { appNameReason } from './names'
import { RESERVED_PAGES } from './pages'
import { renameModuleInputReads } from './rename'
import {
  type AppComponent,
  type AppDefinition,
  type AppQuery,
  appNameSchema,
  type EventHandler,
  type ModuleSpec,
  type Position,
  type Transformer,
  type Variable,
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

const MAX_NAME_LENGTH = 64

/** `base1`, `base2`, …: the first free name. */
export function nextName(def: AppDefinition, base: string): string {
  const used = usedNames(def)
  for (let n = 1; ; n++) {
    // Names are up to 64 characters (`blockNameSchema`): a long base (a module's slug) gives way to the number.
    const name = `${base.slice(0, MAX_NAME_LENGTH - String(n).length)}${n}`
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

/** The first free row below `parent`'s children (at the top, those on `page`: each page has a grid of its own). */
export function bottomOf(def: AppDefinition, parent: string | undefined, page: string | null = null): number {
  let bottom = 0
  for (const c of def.components) {
    const p = def.layout?.[c.name]
    const sameGrid = parent !== undefined || (c.page ?? null) === page
    if (c.parent === parent && sameGrid && p) bottom = Math.max(bottom, p.y + p.h)
  }
  return bottom
}

/**
 * Adds a component of `type` to `parent` (the page when missing): at `position`, or below what's there at the
 * type's default size. Modals always go on the page, without a position. At the top, `page` puts it on that page
 * (on every page when null or missing); inside a container it's on its container's. Returns the new definition and
 * its name.
 */
export function addComponent(
  def: AppDefinition,
  type: string,
  opts: { parent?: string; position?: Partial<Position>; page?: string | null; base?: string } = {},
): { definition: AppDefinition; name: string } {
  const spec = type === 'module' ? moduleComponentSpec(null) : componentSpec(type)
  if (!spec) throw new Error(`Unknown component type "${type}"`)
  const name = nextName(def, opts.base ?? type)
  const parent = spec.overlay ? undefined : opts.parent
  const page = parent === undefined ? (opts.page ?? null) : null
  const component: AppComponent = {
    name,
    type,
    ...(parent !== undefined && { parent }),
    ...(page !== null && { page }),
  }
  const layout = { ...def.layout }
  if (!spec.overlay) {
    const w = Math.min(opts.position?.w ?? spec.defaultSize.w, 12)
    layout[name] = {
      x: Math.min(opts.position?.x ?? 0, 12 - w),
      y: opts.position?.y ?? bottomOf(def, parent, page),
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
 * parent inside the component itself, or one that can't hold components. Out to the top, it goes on `page` (every
 * page when null or missing); into a container, it's on the container's page.
 */
export function moveToParent(
  def: AppDefinition,
  name: string,
  parent: string | undefined,
  opts: { page?: string | null } = {},
): AppDefinition {
  const component = def.components.find((c) => c.name === name)
  if (!component || component.parent === parent) return def
  if (parent !== undefined) {
    const target = def.components.find((c) => c.name === parent)
    if (!target || !componentSpec(target.type)?.container || withDescendants(def, name).has(parent))
      return def
  }
  const page = parent === undefined ? (opts.page ?? null) : null
  const moved = updateComponent(def, name, (c) => {
    const next = { ...c }
    delete next.page
    if (parent === undefined) delete next.parent
    else next.parent = parent
    if (page !== null) next.page = page
    return next
  })
  const position = def.layout?.[name]
  if (!position) return moved
  // Below the new parent's children, counted before the move (the component's old place doesn't count).
  return {
    ...moved,
    layout: { ...moved.layout, [name]: { ...position, x: 0, y: bottomOf(def, parent, page) } },
  }
}

/** Adds a query: a resource query (manual unless it reads, `auto`) or a JS query. */
export function addQuery(
  def: AppDefinition,
  kind: 'resource' | 'js',
  opts: { resource?: string; run?: 'auto' | 'manual'; page?: string | null } = {},
): { definition: AppDefinition; name: string } {
  const name = nextName(def, 'query')
  const page = opts.page ? { page: opts.page } : {}
  const query: AppQuery =
    kind === 'js'
      ? { name, ...page, kind: 'js', code: 'return 1' }
      : {
          name,
          ...page,
          kind: 'resource',
          resource: opts.resource ?? 'optiply_db',
          query: { sql: 'select 1' },
          run: opts.run ?? 'auto',
        }
  return { definition: { ...def, queries: [...def.queries, query] }, name }
}

/**
 * Adds a query from the Query Library (M14), following its latest release and running automatically (most library
 * queries read); its parameters are filled in afterwards.
 */
export function addLibraryQuery(
  def: AppDefinition,
  library: string,
  opts: { version?: string; run?: 'auto' | 'manual'; page?: string | null } = {},
): { definition: AppDefinition; name: string } {
  const name = nextName(def, 'query')
  const query: AppQuery = {
    name,
    ...(opts.page ? { page: opts.page } : {}),
    kind: 'library',
    library,
    version: opts.version ?? 'latest',
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

export function addTransformer(
  def: AppDefinition,
  opts: { page?: string | null } = {},
): { definition: AppDefinition; name: string } {
  const name = nextName(def, 'transformer')
  const transformer: Transformer = { name, ...(opts.page && { page: opts.page }), code: 'return null' }
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

/** `page1`, `page2`, …: the first name no page has. */
function nextPageName(def: AppDefinition): string {
  const used = new Set((def.pages ?? []).map((p) => p.name))
  for (let n = 1; ; n++) if (!used.has(`page${n}`)) return `page${n}`
}

/** Why `name` can't name a page of `def` (besides `except`, the page being renamed), or null if it can. */
export function pageNameReason(def: AppDefinition, name: string, except?: string): string | null {
  if (!appNameSchema.safeParse(name).success) {
    return 'Use letters, digits and _, starting with a letter or _ (it goes in the URL and in code)'
  }
  if (RESERVED_PAGES.has(name)) return `"${name}" is taken: /apps/<slug>/${name} is the app's editor`
  if ((def.pages ?? []).some((p) => p.name === name && p.name !== except)) {
    return `Another page is already named "${name}"`
  }
  return null
}

/**
 * Adds a page at the end. An app without pages gets two: `page1`, holding everything it had (its top-level
 * components, queries and transformers move onto it; variables stay global), and the new one. Returns the new
 * page's name.
 */
export function addPage(def: AppDefinition): { definition: AppDefinition; name: string } {
  if (def.pages?.length) {
    const name = nextPageName(def)
    return { definition: { ...def, pages: [...def.pages, { name }] }, name }
  }
  const onFirst = <T extends { page?: string }>(item: T): T => ({ ...item, page: 'page1' })
  const definition: AppDefinition = {
    ...def,
    pages: [{ name: 'page1' }, { name: 'page2' }],
    components: def.components.map((c) => (c.parent === undefined ? onFirst(c) : c)),
    queries: def.queries.map(onFirst),
    ...(def.transformers && { transformers: def.transformers.map(onFirst) }),
  }
  return { definition, name: 'page2' }
}

/**
 * Renames a page: what's on it follows, and Navigation links to it too (`utils.openPage('…')` in code is left for
 * the person to change). Unchanged when the name can't be used (see `pageNameReason`).
 */
export function renamePage(def: AppDefinition, from: string, to: string): AppDefinition {
  if (from === to || !def.pages?.some((p) => p.name === from) || pageNameReason(def, to, from)) return def
  const follow = <T extends { page?: string }>(item: T): T =>
    item.page === from ? { ...item, page: to } : item
  const components = relinkNavigation(def.components.map(follow), from, to)
  return {
    ...def,
    pages: def.pages.map((p) => (p.name === from ? { ...p, name: to } : p)),
    components,
    queries: def.queries.map(follow),
    ...(def.transformers && { transformers: def.transformers.map(follow) }),
  }
}

/** Navigation links to page `from` point at `to` instead, or with `to` null are dropped. */
function relinkNavigation(components: AppComponent[], from: string, to: string | null): AppComponent[] {
  return components.map((c) => {
    const items = c.type === 'navigation' ? c.props?.items : undefined
    if (!Array.isArray(items)) return c
    const links = (item: JsonValue) =>
      !!item && typeof item === 'object' && !Array.isArray(item) && item.page === from
    if (!items.some(links)) return c
    const relinked = items.flatMap((item) =>
      !links(item) ? [item] : to === null ? [] : [{ ...(item as Record<string, JsonValue>), page: to }],
    )
    return { ...c, props: { ...c.props, items: relinked } }
  })
}

/**
 * Sets a page's title, as typed (the panel sets it on each keystroke: trimming here would eat the space before the
 * next word); blank shows its name.
 */
export function setPageTitle(def: AppDefinition, name: string, title: string): AppDefinition {
  if (!def.pages) return def
  return {
    ...def,
    pages: def.pages.map((p) => {
      if (p.name !== name) return p
      const { title: _old, ...rest } = p
      return title.trim() ? { ...rest, title: title.slice(0, 80) } : rest
    }),
  }
}

/** Moves a page one place earlier (-1) or later (1); the first page is the one the app opens on. */
export function movePage(def: AppDefinition, name: string, by: -1 | 1): AppDefinition {
  const pages = [...(def.pages ?? [])]
  const at = pages.findIndex((p) => p.name === name)
  const to = at + by
  if (at === -1 || to < 0 || to >= pages.length) return def
  ;[pages[at], pages[to]] = [pages[to]!, pages[at]!]
  return { ...def, pages }
}

/** What deleting a page takes with it: its components (with what's inside them), queries and transformers. */
export function onPage(def: AppDefinition, page: string): Set<string> {
  const names = new Set<string>()
  for (const c of def.components) if (c.parent === undefined && c.page === page) names.add(c.name)
  for (const name of [...names]) for (const inside of withDescendants(def, name)) names.add(inside)
  for (const item of [...def.queries, ...(def.transformers ?? [])])
    if (item.page === page) names.add(item.name)
  return names
}

/** Deletes a page with what's on it (see `onPage`). The app keeps at least one page. */
export function removePage(def: AppDefinition, page: string): AppDefinition {
  if (!def.pages || def.pages.length < 2 || !def.pages.some((p) => p.name === page)) return def
  const gone = onPage(def, page)
  return {
    ...def,
    pages: def.pages.filter((p) => p.name !== page),
    // Navigation links to it go too (they'd be errors).
    components: relinkNavigation(
      def.components.filter((c) => !gone.has(c.name)),
      page,
      null,
    ),
    queries: def.queries.filter((q) => !gone.has(q.name)),
    ...(def.transformers && { transformers: def.transformers.filter((t) => !gone.has(t.name)) }),
    layout: Object.fromEntries(Object.entries(def.layout ?? {}).filter(([k]) => !gone.has(k))),
  }
}

/**
 * Puts a top-level component, a query or a transformer on a page, or on every page (null). A component moves to
 * the bottom of that page's grid. Components inside containers are on their container's page: unchanged.
 */
export function setEntityPage(def: AppDefinition, name: string, page: string | null): AppDefinition {
  const set = <T extends { name: string; page?: string }>(item: T): T => {
    if (item.name !== name || (item.page ?? null) === page) return item
    const { page: _old, ...rest } = item
    return (page === null ? rest : { ...rest, page }) as T
  }
  const component = def.components.find((c) => c.name === name)
  if (component) {
    if (component.parent !== undefined || (component.page ?? null) === page) return def
    const position = def.layout?.[name]
    const moved = { ...def, components: def.components.map(set) }
    if (!position) return moved
    return {
      ...moved,
      layout: { ...moved.layout, [name]: { ...position, y: bottomOf(def, undefined, page) } },
    }
  }
  const queries = def.queries.map(set)
  const transformers = def.transformers?.map(set)
  return { ...def, queries, ...(transformers && { transformers }) }
}

/** A part of a module's interface (M14). */
export type ModulePart = 'inputs' | 'outputs' | 'events'

const MODULE_ITEM_BASE = { inputs: 'input', outputs: 'output', events: 'event' } as const

/** Adds an input, output or event to a module, with the next free name in its list (`input1`, …). */
export function addModuleItem(
  def: AppDefinition,
  part: ModulePart,
): { definition: AppDefinition; name: string } {
  const spec = def.module ?? { inputs: [], outputs: [], events: [] }
  const taken = new Set<string>(spec[part].map((i) => i.name))
  let n = 1
  while (taken.has(`${MODULE_ITEM_BASE[part]}${n}`)) n++
  const name = `${MODULE_ITEM_BASE[part]}${n}`
  const item = part === 'outputs' ? { name, value: '' } : { name }
  return { definition: { ...def, module: { ...spec, [part]: [...spec[part], item] } }, name }
}

/**
 * Replaces a module's input, output or event. Renaming an event re-points the `moduleEvent` actions firing it;
 * renaming an input rewrites the module's reads of it (`inputs.<old>`, M21). Apps passing the old input aren't
 * changed (they're other objects): publishing warns about them.
 */
export function updateModuleItem<P extends ModulePart>(
  def: AppDefinition,
  part: P,
  name: string,
  next: ModuleSpec[P][number],
): AppDefinition {
  const spec = def.module
  if (!spec) return def
  const items = spec[part] as ModuleSpec[P][number][]
  const updated: AppDefinition = {
    ...def,
    module: { ...spec, [part]: items.map((i) => (i.name === name ? next : i)) },
  }
  if (next.name === name || part === 'outputs') return updated
  if (part === 'inputs') return renameModuleInputReads(updated, name, next.name).definition
  const repoint = (handlers: EventHandler[] | undefined) =>
    handlers?.map((h) =>
      h.action.type === 'moduleEvent' && h.action.event === name
        ? { ...h, action: { ...h.action, event: next.name } }
        : h,
    )
  return {
    ...updated,
    components: updated.components.map((c) => (c.events ? { ...c, events: repoint(c.events)! } : c)),
    queries: updated.queries.map((q) => (q.events ? { ...q, events: repoint(q.events)! } : q)),
  }
}

/** Removes a module's input, output or event (handlers firing a removed event show up as problems). */
export function removeModuleItem(def: AppDefinition, part: ModulePart, name: string): AppDefinition {
  const spec = def.module
  if (!spec) return def
  return { ...def, module: { ...spec, [part]: spec[part].filter((i) => i.name !== name) } }
}

/**
 * Places a module (M14): an instance of it named after it (`customer_picker1`), following its latest release,
 * where `addComponent` would put a component.
 */
export function addModuleInstance(
  def: AppDefinition,
  slug: string,
  opts: { parent?: string; position?: Partial<Position>; page?: string | null } = {},
): { definition: AppDefinition; name: string } {
  const added = addComponent(def, 'module', { ...opts, base: slug.replace(/[^A-Za-z0-9_]/g, '_') })
  return {
    name: added.name,
    definition: {
      ...added.definition,
      components: added.definition.components.map((c) =>
        c.name === added.name ? { ...c, props: { module: slug } } : c,
      ),
    },
  }
}
