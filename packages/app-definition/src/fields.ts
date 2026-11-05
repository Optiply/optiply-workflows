import type { FieldKind } from '@ow/definition'
import { type AppDefinition, type EventHandler, runsAutomatically } from './schema'

/** One piece of user code in an app. */
export interface AppField {
  /** Path from the definition's root, e.g. `['components', 2, 'props', 'label']`. */
  path: (string | number)[]
  kind: FieldKind
  source: string
  /** Names defined for this field only (`data` in a query's transform). */
  locals?: string[]
  /** The component, query, transformer or variable the field belongs to. */
  owner: string
  /**
   * The graph node whose value the field computes: `comp.prop`, `transformer.value`, `variable.$initial`, or
   * `query.$deps` for what makes an automatic query run again. Missing for code that only runs on demand (event
   * handlers, JS queries, confirmations, transforms).
   */
  node?: string
}

/** Locals of a query's `transform`. */
export const TRANSFORM_LOCALS = ['data']

/** Locals of a table column's `value` (M24): the row it computes a cell of, and the row's index in `data`. */
export const ROW_LOCALS = ['currentRow', 'i']

/**
 * Whether `path` (under a component's `base`) is a table column's `value`: a template evaluated per row into the
 * table's `$rows`, not with its `columns` prop.
 */
export function isColumnValue(
  type: string,
  base: readonly (string | number)[],
  path: readonly (string | number)[],
) {
  const n = base.length
  return (
    type === 'table' &&
    path.length === n + 4 &&
    path[n] === 'props' &&
    path[n + 1] === 'columns' &&
    typeof path[n + 2] === 'number' &&
    path[n + 3] === 'value'
  )
}

/** The node key for `name.key`. */
export const nodeKey = (name: string, key: string) => `${name}.${key}`

/** Every field of the app that holds code or templates, in a stable order. */
export function appFields(def: AppDefinition): AppField[] {
  const fields: AppField[] = []
  def.components.forEach((c, i) => {
    const base = ['components', i]
    for (const prop of Object.keys(c.props ?? {}).sort()) {
      templateStrings(c.props![prop], [...base, 'props', prop], (path, source) => {
        if (isColumnValue(c.type, base, path)) {
          fields.push({
            path,
            kind: 'template',
            source,
            owner: c.name,
            node: nodeKey(c.name, '$rows'),
            locals: ROW_LOCALS,
          })
        } else fields.push({ path, kind: 'template', source, owner: c.name, node: nodeKey(c.name, prop) })
      })
    }
    handlerFields(c.events, [...base, 'events'], c.name, fields)
  })

  def.queries.forEach((q, i) => {
    const base = ['queries', i]
    const deps = runsAutomatically(q) ? nodeKey(q.name, '$deps') : undefined
    const at = (
      path: (string | number)[],
      kind: FieldKind,
      source: string,
      node?: string,
      locals?: string[],
    ) => {
      fields.push({ path, kind, source, owner: q.name, ...(node && { node }), ...(locals && { locals }) })
    }
    if (q.kind === 'resource') {
      templateStrings(q.query, [...base, 'query'], (path, source) => at(path, 'template', source, deps))
    } else if (q.kind === 'library') {
      templateStrings(q.params ?? {}, [...base, 'params'], (path, source) =>
        at(path, 'template', source, deps),
      )
    } else {
      at([...base, 'code'], 'function-body', q.code)
    }
    if (q.disabled !== undefined) at([...base, 'disabled'], 'template', q.disabled, deps)
    if (q.confirm !== undefined) at([...base, 'confirm'], 'template', q.confirm)
    if (q.transform !== undefined) {
      at([...base, 'transform'], 'sync-function-body', q.transform, undefined, TRANSFORM_LOCALS)
    }
    handlerFields(q.events, [...base, 'events'], q.name, fields)
  })

  def.transformers?.forEach((t, i) => {
    fields.push({
      path: ['transformers', i, 'code'],
      kind: 'sync-function-body',
      source: t.code,
      owner: t.name,
      node: nodeKey(t.name, 'value'),
    })
  })

  def.variables?.forEach((v, i) => {
    if (v.initialValue === undefined) return
    templateStrings(v.initialValue, ['variables', i, 'initialValue'], (path, source) => {
      fields.push({ path, kind: 'template', source, owner: v.name, node: nodeKey(v.name, '$initial') })
    })
  })

  // A module's outputs (M14), owned by `$outputs` (no entity: code can't read them inside the module).
  def.module?.outputs.forEach((o, i) => {
    fields.push({
      path: ['module', 'outputs', i, 'value'],
      kind: 'template',
      source: o.value,
      owner: '$outputs',
      node: nodeKey('$outputs', o.name),
    })
  })
  return fields
}

function handlerFields(
  handlers: EventHandler[] | undefined,
  base: (string | number)[],
  owner: string,
  fields: AppField[],
) {
  handlers?.forEach((h, i) => {
    const at = [...base, i]
    const push = (path: (string | number)[], kind: FieldKind, source: string) => {
      fields.push({ path: [...at, ...path], kind, source, owner })
    }
    if (h.onlyIf !== undefined) push(['onlyIf'], 'template', h.onlyIf)
    const a = h.action
    switch (a.type) {
      case 'controlComponent':
        a.args?.forEach((arg, j) => {
          push(['action', 'args', j], 'template', arg)
        })
        break
      case 'setVariable':
        push(['action', 'value'], 'template', a.value)
        break
      case 'runScript':
        push(['action', 'code'], 'function-body', a.code)
        break
      case 'notify':
        push(['action', 'message'], 'template', a.message)
        break
      case 'openUrl':
        push(['action', 'url'], 'template', a.url)
        break
      case 'openPage':
      case 'setUrlParams':
        for (const [key, value] of Object.entries(a.params ?? {}))
          push(['action', 'params', key], 'template', value)
        break
      case 'copyToClipboard':
        push(['action', 'text'], 'template', a.text)
        break
      case 'download':
        push(['action', 'data'], 'template', a.data)
        push(['action', 'fileName'], 'template', a.fileName)
        break
      case 'setLocalStorage':
        push(['action', 'value'], 'template', a.value)
        break
      case 'controlQuery':
      case 'moduleEvent':
      case 'clearLocalStorage':
        break
    }
  })
}

/** Calls `visit` for every string inside a JSON value, objects' keys in sorted order. */
export function templateStrings(
  value: unknown,
  path: (string | number)[],
  visit: (path: (string | number)[], source: string) => void,
) {
  if (typeof value === 'string') visit(path, value)
  else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      templateStrings(v, [...path, i], visit)
    })
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value).sort()) {
      templateStrings((value as Record<string, unknown>)[k], [...path, k], visit)
    }
  }
}
