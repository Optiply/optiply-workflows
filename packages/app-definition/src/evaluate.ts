import { fieldRefs } from '@ow/definition'
import {
  parseTemplate,
  singleExpression,
  stringifyValue,
  TemplateError,
  type TemplatePart,
} from '@ow/expressions'
import { coerceProp, type PropSpec, pageSizeOf } from './components'
import { type AppGraph, buildAppGraph, type Entity, type GraphNode, type SpecFor } from './graph'
import { resolvePage } from './pages'
import type { AppDefinition } from './schema'

/**
 * Evaluates an app's reactive graph. Pure TypeScript with the code runner injected, so it runs the same in the
 * browser runtime and in tests.
 *
 * `init()` evaluates every node in order; `set()` takes run-time values (what the user typed, query results) and
 * re-evaluates only the nodes depending on them, stopping where a value comes out the same.
 */

export type RunKind = 'expression' | 'sync-function-body' | 'function-body'

/**
 * Runs code with `scope` as its variables: an expression's value, a synchronous body's return value, or (for
 * `function-body`) the promise an async body returns.
 */
export type CodeRunner = (kind: RunKind, code: string, scope: Record<string, unknown>) => unknown

/** A runner compiling code with `new Function`, cached per code and scope names. */
export function functionRunner(): CodeRunner {
  const cache = new Map<string, (...args: unknown[]) => unknown>()
  return (kind, code, scope) => {
    const names = Object.keys(scope)
    const id = `${kind}\u0000${names.join(',')}\u0000${code}`
    let fn = cache.get(id)
    if (!fn) {
      const body =
        kind === 'expression'
          ? `"use strict";\nreturn (\n${code}\n);`
          : kind === 'sync-function-body'
            ? `"use strict";\n${code}\n`
            : `"use strict";\nreturn (async () => {\n${code}\n})();`
      fn = new Function(...names, body) as (...args: unknown[]) => unknown
      cache.set(id, fn)
    }
    return fn(...names.map((n) => scope[n]))
  }
}

export interface AppModelOptions {
  runner?: CodeRunner
  /** Values for the runtime globals and the stdlib (`current_user`, `utils`, `_`, …), passed to code reading them. */
  globals?: Record<string, unknown>
  /** Methods to add to an entity as code sees it (`query1.trigger`, `modal1.open`), supplied by the runtime. */
  methods?: (entity: Entity) => Record<string, unknown> | undefined
  /** What `url` starts as: the page shown (the app's first when missing) and its query parameters. */
  url?: { page?: string | null; params?: Record<string, string> }
  /** What `localStorage.values` starts as: what the app kept in this browser before (session 41). */
  storage?: Record<string, unknown>
  /** Module instances' specs from their releases (M14); see `buildAppGraph`. */
  specFor?: SpecFor
  /** In a module (M14): what `inputs.<name>` starts as; an input not given takes its default. */
  inputs?: Record<string, unknown>
}

/** What the model holds for a node. */
export interface NodeState {
  value: unknown
  error?: string
}

const ANY_PROP: PropSpec = { type: 'any', default: null, label: '' }

export class AppModel {
  readonly graph: AppGraph
  private readonly runner: CodeRunner
  private readonly values = new Map<string, unknown>()
  private readonly errors = new Map<string, string>()
  private readonly views = new Map<string, Record<string, unknown>>()
  private readonly templates = new Map<string, TemplatePart[] | TemplateError>()
  private readonly refNames = new Map<string, string[] | TemplateError>()
  private readonly onCycle: Map<string, string[]>
  /** Props set at run time (`setHidden`), which take the place of their templates from then on. */
  private readonly overrides = new Map<string, unknown>()

  constructor(
    readonly definition: AppDefinition,
    private readonly options: AppModelOptions = {},
  ) {
    this.graph = buildAppGraph(definition, { specFor: options.specFor })
    this.runner = options.runner ?? functionRunner()
    this.onCycle = new Map(this.graph.cycles.flatMap((group) => group.map((key) => [key, group])))
  }

  /** Evaluates every node in order. */
  init(): void {
    for (const key of this.graph.order) this.compute(this.graph.nodes.get(key)!, true)
  }

  get(key: string): unknown {
    return this.values.get(key)
  }

  error(key: string): string | undefined {
    return this.errors.get(key)
  }

  /** Every node with an error. */
  allErrors(): Map<string, string> {
    return new Map(this.errors)
  }

  /** An entity as code sees it: its readable values plus the runtime's methods. Rebuilt when a value changes. */
  view(name: string): Record<string, unknown> | undefined {
    const cached = this.views.get(name)
    if (cached) return cached
    const entity = this.graph.entities.get(name)
    if (!entity) return undefined
    const view: Record<string, unknown> = {}
    for (const key of this.graph.entityNodes(name)) {
      const node = this.graph.nodes.get(key)!
      if (!node.property.startsWith('$')) view[node.property] = this.values.get(key)
    }
    Object.assign(view, this.options.methods?.(entity))
    this.views.set(name, view)
    return view
  }

  /**
   * Sets run-time values and re-evaluates what depends on them. Returns every node whose value changed, the ones set
   * included; an automatic query's `$deps` among them means it should run again. `source` and `state` nodes take
   * the value; a prop is overridden (`setHidden`): it keeps the value instead of its template from then on.
   */
  set(updates: Record<string, unknown> | Iterable<[string, unknown]>): Set<string> {
    const changed = new Set<string>()
    const entries = Symbol.iterator in updates ? [...updates] : Object.entries(updates)
    for (const [key, value] of entries) {
      const node = this.graph.nodes.get(key)
      if (!node) throw new Error(`No value named ${key}`)
      if (node.kind !== 'source' && node.kind !== 'state' && node.kind !== 'prop') {
        throw new Error(`${key} can't be set`)
      }
      if (node.kind === 'prop') this.overrides.set(key, value)
      if (this.write(key, value)) changed.add(key)
    }
    for (const key of this.graph.affected(changed)) {
      const node = this.graph.nodes.get(key)!
      if (
        node.kind === 'source' ||
        node.kind === 'initial' ||
        this.onCycle.has(key) ||
        this.overrides.has(key)
      ) {
        continue
      }
      if (!node.deps.some((d) => changed.has(d))) continue
      if (this.compute(node, false)) changed.add(key)
    }
    return changed
  }

  /**
   * Evaluates a value on demand (an event handler's argument, a query's fields): strings are templates, arrays and
   * objects are evaluated inside. Throws on the first failing expression.
   */
  evaluateValue(value: unknown, locals: Record<string, unknown> = {}): unknown {
    if (typeof value === 'string') return this.evaluateTemplate(value, locals)
    if (Array.isArray(value)) return value.map((v) => this.evaluateValue(v, locals))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.evaluateValue(v, locals)]))
    }
    return value
  }

  /** Evaluates the code of one `{{ }}` (without the braces). */
  evaluateExpression(code: string, locals: Record<string, unknown> = {}): unknown {
    return this.runSync('expression', code, locals)
  }

  /** Evaluates one template: a lone `{{ x }}` gives x's value as-is, anything else a string. */
  evaluateTemplate(source: string, locals: Record<string, unknown> = {}): unknown {
    if (!source.includes('{{')) return source
    let parts = this.templates.get(source)
    if (!parts) {
      try {
        parts = parseTemplate(source)
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err
        parts = err
      }
      this.templates.set(source, parts)
    }
    if (parts instanceof TemplateError) throw parts
    const single = singleExpression(parts)
    if (single !== null) return this.runSync('expression', single, locals)
    let out = ''
    for (const part of parts) {
      out += part.type === 'text' ? part.value : stringifyValue(this.runSync('expression', part.code, locals))
    }
    return out
  }

  /** Runs a synchronous function body (a transform) with the app in scope. */
  runFunctionBody(code: string, locals: Record<string, unknown> = {}): unknown {
    return this.runSync('sync-function-body', code, locals)
  }

  /** Starts an async function body (a JS query or script) with the app in scope; returns its promise. */
  runScript(code: string, locals: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return Promise.resolve(this.runner('function-body', code, this.scopeFor('function-body', code, locals)))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /** The variables code sees: the app names and globals it reads, plus `locals`. */
  scopeFor(kind: RunKind, code: string, locals: Record<string, unknown> = {}): Record<string, unknown> {
    const scope: Record<string, unknown> = {}
    for (const name of this.namesIn(kind, code)) {
      if (Object.hasOwn(locals, name)) scope[name] = locals[name]
      else if (this.graph.entities.has(name)) scope[name] = this.view(name)
      else if (this.options.globals && Object.hasOwn(this.options.globals, name)) {
        scope[name] = this.options.globals[name]
      }
    }
    for (const [name, value] of Object.entries(locals)) scope[name] = value
    return scope
  }

  private runSync(kind: 'expression' | 'sync-function-body', code: string, locals: Record<string, unknown>) {
    const result = this.runner(kind, code, this.scopeFor(kind, code, locals))
    if (result instanceof Promise) {
      result.catch(() => {})
      throw new Error('Returned a promise; this code runs synchronously, so it can’t await')
    }
    return result
  }

  private namesIn(kind: RunKind, code: string): string[] {
    const id = `${kind}\u0000${code}`
    let names = this.refNames.get(id)
    if (!names) {
      const { refs, errors } = fieldRefs({ kind, source: code })
      names = errors[0] ?? [...new Set(refs.map((r) => r.name))]
      this.refNames.set(id, names)
    }
    if (names instanceof TemplateError) throw names
    return names
  }

  /** Stores a value; returns whether it changed. */
  private write(key: string, value: unknown, error?: string): boolean {
    const hadError = this.errors.get(key)
    if (error === undefined) this.errors.delete(key)
    else this.errors.set(key, error)
    const same = this.values.has(key) && sameValue(this.values.get(key), value)
    if (same && hadError === error) return false
    this.values.set(key, value)
    this.views.delete(this.graph.nodes.get(key)!.entity)
    return !same
  }

  /** Evaluates one node; returns whether its value changed. */
  private compute(node: GraphNode, initial: boolean): boolean {
    if (node.kind === 'output') return this.computeOutput(node)
    const entity = this.graph.entities.get(node.entity)!
    const cycle = this.onCycle.get(node.key)
    if (cycle) {
      const path = [...cycle, cycle[0]].join(' → ')
      return this.write(node.key, this.fallback(node, entity), `Circular dependency: ${path}`)
    }
    try {
      switch (node.kind) {
        case 'prop':
          return this.computeProp(node, entity)
        case 'state':
          return this.write(node.key, this.values.get(node.from!))
        case 'formData': {
          const data: Record<string, unknown> = {}
          for (const input of node.inputs!) {
            const key = this.values.get(`${input}.formDataKey`)
            data[typeof key === 'string' && key ? key : input] = this.values.get(`${input}.value`)
          }
          return this.write(node.key, data)
        }
        case 'pagination': {
          const page = this.values.get(`${node.entity}.page`)
          const pageSize = pageSizeOf(this.values.get(`${node.entity}.pageSize`))
          const at = typeof page === 'number' && Number.isInteger(page) && page >= 0 ? page : 0
          return this.write(node.key, { page: at, pageSize, offset: at * pageSize })
        }
        case 'rows':
          return this.computeRows(node)
        case 'transformer':
          if (entity.kind !== 'transformer') return false
          return this.write(node.key, this.runFunctionBody(entity.transformer.code))
        case 'initial':
          if (entity.kind !== 'variable') return false
          return this.write(node.key, this.evaluateValue(entity.variable.initialValue ?? null))
        case 'source':
          return initial ? this.write(node.key, this.sourceDefault(node, entity)) : false
        case 'trigger':
          // Its value only counts runs of the query's inputs; any re-evaluation is a change.
          return this.write(node.key, ((this.values.get(node.key) as number | undefined) ?? -1) + 1)
      }
    } catch (err) {
      return this.write(node.key, this.fallback(node, entity), (err as Error)?.message ?? String(err))
    }
  }

  /** A module's output (M14): its template's value, null when it fails. */
  private computeOutput(node: GraphNode): boolean {
    try {
      return this.write(node.key, this.evaluateValue(node.fields[0]?.source ?? null))
    } catch (err) {
      return this.write(node.key, null, (err as Error)?.message ?? String(err))
    }
  }

  private computeProp(node: GraphNode, entity: Entity): boolean {
    const spec = this.propSpec(node, entity)
    if (!spec || entity.kind !== 'component') return this.write(node.key, undefined)
    if (this.overrides.has(node.key)) return this.write(node.key, this.overrides.get(node.key))
    const props = entity.component.props
    if (!props || !Object.hasOwn(props, node.property))
      return this.write(node.key, structuredClone(spec.default))
    const raw = props[node.property]
    const value =
      entity.component.type === 'table' && node.property === 'columns' && Array.isArray(raw)
        ? raw.map((column) => {
            // A column's `value` is evaluated per row, into `$rows`; the prop keeps it as written.
            if (!column || typeof column !== 'object' || Array.isArray(column) || !('value' in column)) {
              return this.evaluateValue(column)
            }
            const { value, ...rest } = column as Record<string, unknown>
            return { ...(this.evaluateValue(rest) as Record<string, unknown>), value }
          })
        : this.evaluateValue(raw)
    const result = coerceProp(spec, value)
    return 'error' in result
      ? this.write(node.key, structuredClone(spec.default), result.error)
      : this.write(node.key, result.value)
  }

  /**
   * A table's rows as it shows them (M24): `data`, each row with its computed columns' cells (a column with a key
   * and a `value` template, evaluated with `currentRow` and `i`). The same array when nothing is computed. A cell
   * that fails is null, and the first failure is the node's error.
   */
  private computeRows(node: GraphNode): boolean {
    const data = this.values.get(`${node.entity}.data`)
    const rows = Array.isArray(data) ? data : []
    const columns = this.values.get(`${node.entity}.columns`)
    const computed = (Array.isArray(columns) ? columns : []).flatMap((c) =>
      c && typeof c === 'object' && typeof c.key === 'string' && c.key && typeof c.value === 'string'
        ? [{ key: c.key as string, value: c.value as string }]
        : [],
    )
    if (!computed.length) return this.write(node.key, rows)
    let error: string | undefined
    const out = rows.map((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row
      const next: Record<string, unknown> = { ...row }
      for (const column of computed) {
        try {
          next[column.key] = this.evaluateTemplate(column.value, { currentRow: row, i })
        } catch (err) {
          next[column.key] = null
          error ??= `Column ${column.key}, row ${i}: ${(err as Error)?.message ?? String(err)}`
        }
      }
      return next
    })
    return this.write(node.key, out, error)
  }

  private propSpec(node: GraphNode, entity: Entity): PropSpec | undefined {
    if (entity.kind !== 'component' || !entity.spec) return undefined
    // A module instance whose inputs aren't known yet takes any value (M14).
    return entity.spec.props[node.property] ?? (entity.spec.openProps ? ANY_PROP : undefined)
  }

  /** A node's value before anything sets it. */
  private sourceDefault(node: GraphNode, entity: Entity): unknown {
    switch (entity.kind) {
      case 'component':
        return structuredClone(entity.spec?.state[node.property]?.default ?? null)
      case 'query':
        return node.property === 'isFetching' ? false : null
      case 'variable':
        return this.values.get(`${entity.name}.$initial`) ?? null
      case 'transformer':
        return null
      case 'storage':
        return { ...this.options.storage }
      case 'url':
        return node.property === 'page'
          ? resolvePage(this.definition, this.options.url?.page)
          : { ...this.options.url?.params }
      case 'inputs': {
        const given = this.options.inputs
        const value = given && Object.hasOwn(given, node.property) ? given[node.property] : null
        const input = this.definition.module?.inputs.find((i) => i.name === node.property)
        return structuredClone(value ?? input?.default ?? null)
      }
    }
  }

  /** What a node holds when it can't be evaluated. */
  private fallback(node: GraphNode, entity: Entity): unknown {
    const spec = this.propSpec(node, entity)
    if (spec) return structuredClone(spec.default)
    if (node.kind === 'source' || node.kind === 'state') return this.sourceDefault(node, entity)
    return null
  }
}

/** Same value, or equal plain data (so a recomputed object that came out the same stops the update there). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
