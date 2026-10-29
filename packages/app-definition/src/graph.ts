import { type FieldRef, fieldRefs } from '@ow/definition'
import type { TemplateError } from '@ow/expressions'
import { customComponentSpec } from './component-library'
import {
  type ComponentSpec,
  componentSpec,
  moduleComponentSpec,
  QUERY_METHODS,
  QUERY_STATE,
  URL_STATE,
  VARIABLE_METHODS,
  VARIABLE_STATE,
} from './components'
import { type AppField, appFields, nodeKey } from './fields'
import {
  type AppComponent,
  type AppDefinition,
  type AppQuery,
  runsAutomatically,
  type Transformer,
  type Variable,
} from './schema'

/**
 * The app's reactive graph, spreadsheet-style: one node per value code can read (`textInput1.value`,
 * `query1.data`, `table1.columns`), with edges from each node to the nodes its templates read. A change to a node
 * re-evaluates only what depends on it, in topological order.
 *
 * Dependencies are per property where the code says which (`table1.selectedRow`), and on the whole entity where it
 * doesn't (`f(table1)`, `table1[key]`).
 */

export type Entity =
  | { kind: 'component'; name: string; index: number; component: AppComponent; spec?: ComponentSpec }
  | { kind: 'query'; name: string; index: number; query: AppQuery }
  | { kind: 'transformer'; name: string; index: number; transformer: Transformer }
  | { kind: 'variable'; name: string; index: number; variable: Variable }
  /** In a module (M14): what the app passes, `inputs.<name>`. Built in, like `url`. */
  | { kind: 'inputs'; name: 'inputs'; index: -1; names: readonly string[] }
  /** `url`, built in: the page shown and its query parameters. */
  | { kind: 'url'; name: 'url'; index: -1 }

export type NodeKind =
  /** A component prop: its template, or its default. */
  | 'prop'
  /** Component state set at run time; restarts from its `from` prop whenever that changes. */
  | 'state'
  /** A form's `data`, collected from the inputs inside it. */
  | 'formData'
  /** A table's `pagination`: `{ page, pageSize, offset }` from its `page` and `pageSize`. */
  | 'pagination'
  /** A table's `$rows` (M24): `data` with its computed columns, what the table shows. */
  | 'rows'
  /** A transformer's value. */
  | 'transformer'
  /** A variable's initial value, evaluated once when the app opens. */
  | 'initial'
  /** A module's output (M14): its template, evaluated in the module and passed to the app placing it. */
  | 'output'
  /** Set at run time only (query results, variable values, state without a `from` prop). */
  | 'source'
  /** What an automatic query reads; when it changes, the query runs again. */
  | 'trigger'

export interface GraphNode {
  key: string
  entity: string
  /** The property name (`value`, `data`, `$deps`). Internal nodes start with `$`. */
  property: string
  kind: NodeKind
  /** Nodes this one reads, without duplicates. */
  deps: string[]
  /** The fields computing it (a prop holding an array of templates has several). */
  fields: AnalysedField[]
  /** For `state`: the prop node it restarts from. */
  from?: string
  /** For `formData`: the input components it collects. */
  inputs?: string[]
}

export interface AnalysedField extends AppField {
  refs: FieldRef[]
  errors: TemplateError[]
}

export interface AppGraph {
  entities: ReadonlyMap<string, Entity>
  nodes: ReadonlyMap<string, GraphNode>
  /** Every field, analysed. */
  fields: readonly AnalysedField[]
  /** Nodes in evaluation order; nodes on a cycle come last. */
  order: readonly string[]
  /** Groups of nodes that depend on each other in a loop. */
  cycles: readonly string[][]
  /** Position of each node in `order`. */
  rank: ReadonlyMap<string, number>
  /** The nodes reading each node directly. */
  dependents: ReadonlyMap<string, readonly string[]>
  /** The node keys an entity has, in property order. */
  entityNodes(name: string): readonly string[]
  /** The nodes a reference reads: one property, the whole entity, or none (a method, a global). */
  resolve(ref: { name: string; property?: string }): string[]
  /** Every node depending on `keys`, directly or not, in evaluation order (the keys themselves excluded). */
  affected(keys: Iterable<string>): string[]
}

/**
 * How the graph learns a component's spec. By default the registry's, and for a module instance an open spec (M14);
 * `specFor` gives a module instance its release's interface (`moduleComponentSpec`), and a custom component (M25)
 * its library release's (`customComponentSpec`).
 */
export type SpecFor = (component: AppComponent) => ComponentSpec | undefined

export const defaultSpecFor: SpecFor = (c) =>
  c.type === 'module'
    ? moduleComponentSpec(null)
    : c.type === 'custom'
      ? customComponentSpec(null)
      : componentSpec(c.type)

/** The node key of a module's output (M14); not readable by code (`$` names aren't). */
export const outputKey = (name: string) => nodeKey(OUTPUTS, name)
/** The owner of a module's output fields, and the entity part of their nodes. */
export const OUTPUTS = '$outputs'

/** The entities of an app by name. The first of two entities with the same name wins (the validator reports it). */
export function appEntities(def: AppDefinition, specFor: SpecFor = defaultSpecFor): Map<string, Entity> {
  const entities = new Map<string, Entity>()
  const add = (entity: Entity) => {
    if (!entities.has(entity.name)) entities.set(entity.name, entity)
  }
  def.components.forEach((component, index) => {
    const spec = specFor(component) ?? defaultSpecFor(component)
    add({ kind: 'component', name: component.name, index, component, ...(spec && { spec }) })
  })
  def.queries.forEach((query, index) => {
    add({ kind: 'query', name: query.name, index, query })
  })
  def.transformers?.forEach((transformer, index) => {
    add({ kind: 'transformer', name: transformer.name, index, transformer })
  })
  def.variables?.forEach((variable, index) => {
    add({ kind: 'variable', name: variable.name, index, variable })
  })
  return entities
}

/** Readable properties of an entity (the nodes code can read), without internal ones. */
export function entityProperties(entity: Entity): string[] {
  switch (entity.kind) {
    case 'component':
      return entity.spec ? [...Object.keys(entity.spec.props), ...Object.keys(entity.spec.state)] : []
    case 'query':
      return [...QUERY_STATE]
    case 'transformer':
      return ['value']
    case 'variable':
      return [...VARIABLE_STATE]
    case 'url':
      return [...URL_STATE]
    case 'inputs':
      return [...entity.names]
  }
}

/** Methods code can call on an entity. */
export function entityMethods(entity: Entity): string[] {
  switch (entity.kind) {
    case 'component':
      return entity.spec ? Object.keys(entity.spec.methods) : []
    case 'query':
      return Object.keys(QUERY_METHODS)
    case 'transformer':
      return []
    case 'variable':
      return Object.keys(VARIABLE_METHODS)
    case 'url':
    case 'inputs':
      return []
  }
}

/** The input components a form collects: inside it, directly or in containers, but not inside another form. */
export function formInputs(def: AppDefinition, form: string): string[] {
  const children = new Map<string, AppComponent[]>()
  for (const c of def.components) {
    if (c.parent === undefined) continue
    children.set(c.parent, [...(children.get(c.parent) ?? []), c])
  }
  const inputs: string[] = []
  const seen = new Set<string>([form])
  const walk = (parent: string) => {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.name)) continue
      seen.add(child.name)
      const spec = componentSpec(child.type)
      if (spec?.input) inputs.push(child.name)
      if (spec?.container && child.type !== 'form') walk(child.name)
    }
  }
  walk(form)
  return inputs
}

export function buildAppGraph(def: AppDefinition, opts: { specFor?: SpecFor } = {}): AppGraph {
  const entities = appEntities(def, opts.specFor)
  // Built in; an entity of the app named `url` is invalid (and keeps the name here, for the validator to report).
  if (!entities.has('url')) entities.set('url', { kind: 'url', name: 'url', index: -1 })
  // Likewise `inputs` in a module.
  if (def.module && !entities.has('inputs')) {
    entities.set('inputs', {
      kind: 'inputs',
      name: 'inputs',
      index: -1,
      names: def.module.inputs.map((i) => i.name),
    })
  }
  const fields: AnalysedField[] = appFields(def).map((field) => ({
    ...field,
    ...fieldRefs(field, { properties: true }),
  }))

  const nodes = new Map<string, GraphNode>()
  const byEntity = new Map<string, string[]>()
  const add = (entity: string, property: string, kind: NodeKind, extra: Partial<GraphNode> = {}) => {
    const key = nodeKey(entity, property)
    nodes.set(key, { key, entity, property, kind, deps: [], fields: [], ...extra })
    pushTo(byEntity, entity, key)
  }

  for (const entity of entities.values()) {
    const { name } = entity
    switch (entity.kind) {
      case 'component': {
        const spec = entity.spec
        if (!spec) break
        for (const prop of Object.keys(spec.props)) add(name, prop, 'prop')
        if (spec.openProps) {
          for (const prop of Object.keys(entity.component.props ?? {})) {
            if (!Object.hasOwn(spec.props, prop)) add(name, prop, 'prop')
          }
        }
        for (const [state, s] of Object.entries(spec.state)) {
          if (entity.component.type === 'form' && state === 'data') {
            add(name, state, 'formData', { inputs: formInputs(def, name) })
          } else if (entity.component.type === 'table' && state === 'pagination') {
            add(name, state, 'pagination')
          } else if (s.from) {
            add(name, state, 'state', { from: nodeKey(name, s.from) })
          } else {
            add(name, state, 'source')
          }
        }
        if (entity.component.type === 'table') add(name, '$rows', 'rows')
        break
      }
      case 'query':
        for (const state of QUERY_STATE) add(name, state, 'source')
        if (runsAutomatically(entity.query)) add(name, '$deps', 'trigger')
        break
      case 'transformer':
        add(name, 'value', 'transformer')
        break
      case 'variable':
        add(name, '$initial', 'initial')
        add(name, 'value', 'source')
        break
      case 'url':
        for (const state of URL_STATE) add(name, state, 'source')
        break
      case 'inputs':
        for (const input of entity.names) add(name, input, 'source')
        break
    }
  }
  for (const output of def.module?.outputs ?? []) add(OUTPUTS, output.name, 'output')

  const resolve = (ref: { name: string; property?: string }): string[] => {
    const own = byEntity.get(ref.name)
    if (!own) return []
    if (ref.property === undefined) return own.filter((k) => !nodes.get(k)!.property.startsWith('$'))
    const key = nodeKey(ref.name, ref.property)
    return !ref.property.startsWith('$') && nodes.has(key) ? [key] : []
  }

  // Dependencies: from the fields computing each node, plus the structural ones.
  for (const field of fields) {
    // Only fields of entities that won the name (a duplicate's fields would attach to the wrong nodes).
    const owner = entities.get(field.owner)
    const ownsIt =
      field.owner === OUTPUTS ||
      (owner !== undefined && entityPath(owner) === field.path.slice(0, 2).join('.'))
    if (!field.node || !ownsIt) continue
    const node = nodes.get(field.node)
    if (!node) continue
    node.fields.push(field)
    const locals = new Set(field.locals)
    for (const ref of field.refs) if (!locals.has(ref.name)) node.deps.push(...resolve(ref))
  }
  for (const node of nodes.values()) {
    if (node.from) node.deps.push(node.from)
    if (node.kind === 'pagination')
      node.deps.push(nodeKey(node.entity, 'page'), nodeKey(node.entity, 'pageSize'))
    if (node.kind === 'rows') node.deps.push(nodeKey(node.entity, 'data'), nodeKey(node.entity, 'columns'))
    if (node.inputs) {
      for (const input of node.inputs) node.deps.push(nodeKey(input, 'value'), nodeKey(input, 'formDataKey'))
    }
    if (node.kind === 'source' && node.property === 'value' && nodes.has(nodeKey(node.entity, '$initial'))) {
      node.deps.push(nodeKey(node.entity, '$initial'))
    }
    node.deps = [...new Set(node.deps)].filter((d) => nodes.has(d))
  }

  const dependents = new Map<string, string[]>()
  for (const node of nodes.values()) {
    for (const dep of node.deps) pushTo(dependents, dep, node.key)
  }

  const cycles = findCycles(nodes)
  const order = topologicalOrder(nodes, dependents)
  const rank = new Map(order.map((key, i) => [key, i]))

  return {
    entities,
    nodes,
    fields,
    order,
    cycles,
    rank,
    dependents,
    entityNodes: (name) => byEntity.get(name) ?? [],
    resolve,
    affected(keys) {
      const seen = new Set<string>()
      const start = new Set(keys)
      const stack = [...start]
      while (stack.length) {
        for (const next of dependents.get(stack.pop()!) ?? []) {
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(next)
        }
      }
      for (const key of start) seen.delete(key)
      return [...seen].sort((a, b) => rank.get(a)! - rank.get(b)!)
    },
  }
}

/** Appends to the list under `key` in place (copying it on every append made a value read by many quadratic). */
function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** `components.3`, the path prefix of the fields belonging to an entity. */
function entityPath(entity: Entity): string {
  const list = {
    component: 'components',
    query: 'queries',
    transformer: 'transformers',
    variable: 'variables',
    url: 'url',
    inputs: 'module',
  }
  return `${list[entity.kind]}.${entity.index}`
}

/** Kahn's algorithm, ties broken by insertion order, so the order is stable; cycle members go last. */
function topologicalOrder(
  nodes: ReadonlyMap<string, GraphNode>,
  dependents: ReadonlyMap<string, string[]>,
): string[] {
  const waiting = new Map<string, number>()
  for (const node of nodes.values()) waiting.set(node.key, node.deps.length)
  const ready = [...nodes.keys()].filter((k) => waiting.get(k) === 0)
  const order: string[] = []
  for (let i = 0; i < ready.length; i++) {
    const key = ready[i]!
    order.push(key)
    for (const next of dependents.get(key) ?? []) {
      const left = waiting.get(next)! - 1
      waiting.set(next, left)
      if (left === 0) ready.push(next)
    }
  }
  // Nodes on a cycle, and those depending on one, never became ready.
  const placed = new Set(order)
  for (const key of nodes.keys()) if (!placed.has(key)) order.push(key)
  return order
}

/** Tarjan's strongly connected components: each group of two or more nodes, or a node reading itself. */
function findCycles(nodes: ReadonlyMap<string, GraphNode>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []
  let counter = 0

  // Iterative, so a long chain of nodes can't overflow the call stack.
  for (const root of nodes.keys()) {
    if (index.has(root)) continue
    const work: { key: string; next: number }[] = [{ key: root, next: 0 }]
    index.set(root, counter)
    low.set(root, counter++)
    stack.push(root)
    onStack.add(root)
    while (work.length) {
      const frame = work.at(-1)!
      const deps = nodes.get(frame.key)!.deps
      if (frame.next < deps.length) {
        const dep = deps[frame.next++]!
        if (!index.has(dep)) {
          index.set(dep, counter)
          low.set(dep, counter++)
          stack.push(dep)
          onStack.add(dep)
          work.push({ key: dep, next: 0 })
        } else if (onStack.has(dep)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, index.get(dep)!))
        }
        continue
      }
      work.pop()
      const parent = work.at(-1)
      if (parent) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!))
      if (low.get(frame.key) === index.get(frame.key)) {
        const group: string[] = []
        let member: string
        do {
          member = stack.pop()!
          onStack.delete(member)
          group.push(member)
        } while (member !== frame.key)
        if (group.length > 1 || deps.includes(frame.key)) cycles.push(group.reverse())
      }
    }
  }
  return cycles
}
