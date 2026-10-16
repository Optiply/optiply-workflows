import type { QueryValidator } from '@ow/definition'
import { parseTemplate } from '@ow/expressions'
import type { z } from 'zod'
import { componentSpec, constantFits, QUERY_EVENTS } from './components'
import { buildAppGraph, type Entity, entityMethods, entityProperties } from './graph'
import { appNameReason, isAppGlobalName } from './names'
import { entityPages, pageVisible } from './pages'
import { expressionSide } from './query-values'
import { type AppDefinition, appDefinitionSchema, type EventHandler } from './schema'

export type AppDiagnosticCode =
  | 'schema'
  | 'invalid_name'
  | 'duplicate_name'
  | 'unknown_type'
  | 'unknown_prop'
  | 'invalid_prop'
  | 'unknown_parent'
  | 'invalid_parent'
  | 'invalid_layout'
  | 'unknown_event'
  | 'unknown_query'
  | 'unknown_component'
  | 'unknown_variable'
  | 'unknown_method'
  | 'invalid_args'
  | 'syntax'
  | 'unknown_identifier'
  | 'unknown_property'
  | 'code_only'
  | 'cycle'
  | 'unknown_resource'
  | 'invalid_query'
  | 'mixed_current_user'
  | 'unknown_page'
  | 'duplicate_page'
  | 'invalid_page'
  | 'other_page'

export interface AppDiagnostic {
  severity: 'error' | 'warning'
  code: AppDiagnosticCode
  message: string
  /** Path into the definition, e.g. `['components', 2, 'props', 'label']`. */
  path: (string | number)[]
  /** The component, query, transformer or variable the problem belongs to. */
  entity?: string
  /** Offsets into the string at `path`, for code and template problems. */
  start?: number
  end?: number
  hint?: string
}

export interface AppValidateOptions {
  /** Server side: the connector for a resource slug, or undefined if there is no such resource. */
  resolveResource?: (slug: string) => QueryValidator | undefined
}

export interface AppValidationResult {
  /** No error diagnostics (warnings are allowed). */
  ok: boolean
  definition?: AppDefinition
  diagnostics: AppDiagnostic[]
}

type Report = (d: Omit<AppDiagnostic, 'severity'> & { severity?: AppDiagnostic['severity'] }) => void

const LIST = {
  component: 'components',
  query: 'queries',
  transformer: 'transformers',
  variable: 'variables',
  url: 'url',
}

/**
 * Checks an app definition and returns every problem found, for the editor to show and for publishing to refuse.
 * Schema problems are reported alone, since the other checks need a well-formed definition.
 */
export function validateApp(input: unknown, options: AppValidateOptions = {}): AppValidationResult {
  const parsed = appDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, diagnostics: parsed.error.issues.map((issue) => schemaDiagnostic(issue, input)) }
  }
  const def = parsed.data
  const diagnostics: AppDiagnostic[] = []
  const report: Report = (d) => diagnostics.push({ severity: 'error', ...d })

  checkNames(def, report)
  const graph = buildAppGraph(def)
  const { entities } = graph
  const pages = entityPages(def)
  checkPages(def, report)

  // Components: type, props, parent, events.
  def.components.forEach((c, i) => {
    const at = { entity: c.name }
    const spec = componentSpec(c.type)
    if (!spec) {
      report({
        code: 'unknown_type',
        message: `Unknown component type "${c.type}"`,
        path: ['components', i, 'type'],
        ...at,
      })
      return
    }
    for (const [prop, value] of Object.entries(c.props ?? {})) {
      const path = ['components', i, 'props', prop]
      const propSpec = Object.hasOwn(spec.props, prop) ? spec.props[prop] : undefined
      if (!propSpec) {
        report({ code: 'unknown_prop', message: `${spec.label} has no property "${prop}"`, path, ...at })
      } else if (!constantFits(propSpec, value)) {
        report({ code: 'invalid_prop', message: `"${prop}" has the wrong type`, path, ...at })
      } else if (typeof propSpec.type === 'object' && typeof value === 'string' && !value.includes('{{')) {
        if (!propSpec.type.enum.includes(value)) {
          report({
            code: 'invalid_prop',
            message: `"${prop}" must be one of ${propSpec.type.enum.join(', ')}`,
            path,
            ...at,
          })
        }
      }
    }
    if (c.parent !== undefined) {
      const path = ['components', i, 'parent']
      const parent = entities.get(c.parent)
      if (spec.overlay) {
        report({
          code: 'invalid_parent',
          message: `A ${spec.label.toLowerCase()} opens over the page; it can't sit inside another component`,
          path,
          ...at,
        })
      } else if (parent?.kind !== 'component') {
        report({ code: 'unknown_parent', message: `No component is named "${c.parent}"`, path, ...at })
      } else if (!parent.spec?.container) {
        report({ code: 'invalid_parent', message: `"${c.parent}" can't hold other components`, path, ...at })
      } else if (insideItself(def, c.name)) {
        report({ code: 'invalid_parent', message: `"${c.name}" would end up inside itself`, path, ...at })
      }
    }
    checkHandlers(c.events, ['components', i, 'events'], spec.events, at.entity, entities, pages, report)
  })

  // Layout entries name components on a grid.
  for (const name of Object.keys(def.layout ?? {})) {
    const entity = entities.get(name)
    const path = ['layout', name]
    if (entity?.kind !== 'component') {
      report({
        severity: 'warning',
        code: 'invalid_layout',
        message: `No component is named "${name}"`,
        path,
      })
    } else if (entity.spec?.overlay) {
      report({
        severity: 'warning',
        code: 'invalid_layout',
        message: `"${name}" opens over the page and has no position`,
        path,
        entity: name,
      })
    }
  }

  // Queries: events and, server side, their connector.
  def.queries.forEach((q, i) => {
    checkHandlers(q.events, ['queries', i, 'events'], QUERY_EVENTS, q.name, entities, pages, report)
    if (q.kind === 'resource' && options.resolveResource) {
      checkQuery(q, ['queries', i], options.resolveResource, report)
    }
  })

  // Code: syntax, names, properties.
  for (const field of graph.fields) {
    const at = { path: field.path, entity: field.owner }
    for (const err of field.errors) {
      report({
        code: 'syntax',
        message: err.message,
        ...at,
        start: err.start,
        end: err.end,
        ...(err.hint && { hint: err.hint }),
      })
    }
    const locals = new Set(field.locals)
    for (const ref of field.refs) {
      if (locals.has(ref.name)) continue
      const where = { ...at, start: ref.start, end: ref.end }
      const entity = entities.get(ref.name)
      if (!entity) {
        if (!isAppGlobalName(ref.name)) {
          report({ code: 'unknown_identifier', message: `"${ref.name}" is not defined`, ...where })
        }
        continue
      }
      const page = pages.get(ref.name) ?? null
      const reader = pages.get(field.owner) ?? null
      if (!pageVisible(page, reader)) {
        report({ code: 'other_page', message: otherPage(ref.name, page!, field.owner, reader), ...where })
        continue
      }
      if (ref.property === undefined) continue
      if (entityMethods(entity).includes(ref.property)) {
        if (field.node) {
          report({
            code: 'code_only',
            message: `${ref.name}.${ref.property}() can only be called from scripts and event handlers`,
            hint: 'Values here are re-evaluated whenever what they read changes, so they must not have side effects',
            ...where,
          })
        }
      } else if (!entityProperties(entity).includes(ref.property) && !isObjectMember(ref.property)) {
        report({
          severity: 'warning',
          code: 'unknown_property',
          message: `"${ref.name}" has no property "${ref.property}"`,
          ...where,
        })
      }
    }
  }

  // Resource query values come from the browser, except those reading only current_user.
  for (const field of graph.fields) {
    if (field.path[0] !== 'queries' || field.path[2] !== 'query' || field.errors.length) continue
    for (const part of parseTemplate(field.source)) {
      if (part.type !== 'expression' || expressionSide(part.code) !== 'mixed') continue
      report({
        code: 'mixed_current_user',
        message: 'current_user is checked on the server only in a {{ }} of its own',
        hint: 'Split it out, e.g. owner = {{ current_user.email }} and status = {{ select1.value }}',
        path: field.path,
        entity: field.owner,
        start: part.start,
        end: part.end,
      })
    }
  }

  // Circular dependencies, once per loop, at the first field computing one of its nodes.
  for (const cycle of graph.cycles) {
    const path = [...cycle, cycle[0]].join(' → ')
    const field = cycle.map((key) => graph.nodes.get(key)!.fields[0]).find(Boolean)
    const entity = graph.nodes.get(cycle[0]!)!.entity
    report({
      code: 'cycle',
      message: `Circular dependency: ${path}`,
      path: field?.path ?? entityPath(entities.get(entity)!),
      entity: field?.owner ?? entity,
    })
  }

  return { ok: !diagnostics.some((d) => d.severity === 'error'), definition: def, diagnostics }
}

/** Page addresses the platform uses itself. */
const RESERVED_PAGES = new Set(['edit'])

/** Page names are unique; whatever names a page names one of them; components in containers name none. */
function checkPages(def: AppDefinition, report: Report) {
  const names = new Set<string>()
  def.pages?.forEach((page, i) => {
    if (RESERVED_PAGES.has(page.name)) {
      report({
        code: 'invalid_page',
        message: `"${page.name}" can't name a page: /apps/<slug>/${page.name} is the app's editor`,
        path: ['pages', i, 'name'],
      })
    }
    if (names.has(page.name)) {
      report({
        code: 'duplicate_page',
        message: `Another page is already named "${page.name}"`,
        path: ['pages', i, 'name'],
      })
    }
    names.add(page.name)
  })
  const lists = [
    ['components', def.components],
    ['queries', def.queries],
    ['transformers', def.transformers ?? []],
  ] as const
  for (const [list, items] of lists) {
    items.forEach((item: { name: string; page?: string; parent?: string }, i: number) => {
      if (item.page === undefined) return
      const path = [list, i, 'page']
      if (item.parent !== undefined) {
        report({
          code: 'invalid_page',
          message: `"${item.name}" is on the page of the component it's inside; remove its own page`,
          path,
          entity: item.name,
        })
      } else if (!names.has(item.page)) {
        report({ code: 'unknown_page', message: `No page is named "${item.page}"`, path, entity: item.name })
      }
    })
  }
}

/** Why code on `reader` (null: global) can't read `name`, which is on page `page`. */
function otherPage(name: string, page: string, owner: string, reader: string | null): string {
  return reader === null
    ? `"${name}" is on page ${page}; "${owner}" is global (on every page), so it can only use what's global`
    : `"${name}" is on page ${page}, not on ${reader} with "${owner}"`
}

/** Every name is a valid identifier, not a global, and unique across components, queries, transformers and variables. */
function checkNames(def: AppDefinition, report: Report) {
  const seen = new Set<string>()
  const lists = [
    ['components', def.components],
    ['queries', def.queries],
    ['transformers', def.transformers ?? []],
    ['variables', def.variables ?? []],
  ] as const
  for (const [list, items] of lists) {
    items.forEach((item: { name: string }, i: number) => {
      const path = [list, i, 'name']
      const reason = appNameReason(item.name)
      if (reason) report({ code: 'invalid_name', message: reason, path, entity: item.name })
      if (seen.has(item.name)) {
        report({
          code: 'duplicate_name',
          message: `Something else is already named "${item.name}"`,
          path,
          entity: item.name,
        })
      }
      seen.add(item.name)
    })
  }
}

function checkHandlers(
  handlers: EventHandler[] | undefined,
  base: (string | number)[],
  events: readonly string[],
  owner: string,
  entities: ReadonlyMap<string, Entity>,
  pages: ReadonlyMap<string, string | null>,
  report: Report,
) {
  const reader = pages.get(owner) ?? null
  handlers?.forEach((h, i) => {
    const path = [...base, i]
    const at = { entity: owner }
    const a = h.action
    const target =
      a.type === 'controlQuery' ? a.query : a.type === 'controlComponent' ? a.component : undefined
    const targetPage = target === undefined ? null : (pages.get(target) ?? null)
    if (target !== undefined && entities.has(target) && !pageVisible(targetPage, reader)) {
      report({
        code: 'other_page',
        message: otherPage(target, targetPage!, owner, reader),
        path: [...path, 'action', a.type === 'controlQuery' ? 'query' : 'component'],
        ...at,
      })
    }
    if (!events.includes(h.event)) {
      report({
        code: 'unknown_event',
        message: events.length
          ? `Unknown event "${h.event}"; expected ${events.join(', ')}`
          : `"${owner}" has no events`,
        path: [...path, 'event'],
        ...at,
      })
    }
    if (a.type === 'controlQuery' && entities.get(a.query)?.kind !== 'query') {
      report({
        code: 'unknown_query',
        message: `No query is named "${a.query}"`,
        path: [...path, 'action', 'query'],
        ...at,
      })
    }
    if (a.type === 'setVariable' && entities.get(a.variable)?.kind !== 'variable') {
      report({
        code: 'unknown_variable',
        message: `No variable is named "${a.variable}"`,
        path: [...path, 'action', 'variable'],
        ...at,
      })
    }
    if (a.type === 'controlComponent') {
      const target = entities.get(a.component)
      if (target?.kind !== 'component') {
        report({
          code: 'unknown_component',
          message: `No component is named "${a.component}"`,
          path: [...path, 'action', 'component'],
          ...at,
        })
      } else if (target.spec) {
        const method = Object.hasOwn(target.spec.methods, a.method)
          ? target.spec.methods[a.method]
          : undefined
        if (!method) {
          report({
            code: 'unknown_method',
            message: `${target.spec.label} has no method "${a.method}"`,
            path: [...path, 'action', 'method'],
            ...at,
          })
        } else if ((a.args?.length ?? 0) > method.params.length) {
          report({
            severity: 'warning',
            code: 'invalid_args',
            message: `${a.method} takes ${method.params.length} argument${method.params.length === 1 ? '' : 's'}`,
            path: [...path, 'action', 'args'],
            ...at,
          })
        }
      }
    }
  })
}

function checkQuery(
  q: Extract<AppDefinition['queries'][number], { kind: 'resource' }>,
  base: (string | number)[],
  resolve: NonNullable<AppValidateOptions['resolveResource']>,
  report: Report,
) {
  const at = { entity: q.name }
  const connector = resolve(q.resource)
  if (!connector) {
    report({
      code: 'unknown_resource',
      message: `No resource has the slug "${q.resource}"`,
      path: [...base, 'resource'],
      ...at,
    })
    return
  }
  const query = connector.querySchema.safeParse(q.query)
  if (!query.success) {
    for (const issue of query.error.issues) {
      report({
        code: 'invalid_query',
        message: issue.message,
        path: [...base, 'query', ...issue.path.map(pathKey)],
        ...at,
      })
    }
    return
  }
  for (const err of connector.validateQuery(query.data as never)) {
    report({
      code: 'invalid_query',
      message: err.message,
      path: [...base, 'query'],
      ...at,
      start: err.start,
      end: err.end,
      ...(err.hint && { hint: err.hint }),
    })
  }
}

/** Walking up from `name` through parents comes back to it. */
function insideItself(def: AppDefinition, name: string): boolean {
  const parents = new Map(def.components.map((c) => [c.name, c.parent]))
  const seen = new Set<string>()
  let at = parents.get(name)
  while (at !== undefined && !seen.has(at)) {
    if (at === name) return true
    seen.add(at)
    at = parents.get(at)
  }
  return false
}

/** Members every value has (`toString`, `length` on arrays, …) aren't typos. */
function isObjectMember(property: string): boolean {
  return property in Object.prototype
}

function entityPath(entity: Entity): (string | number)[] {
  return [LIST[entity.kind], entity.index]
}

function schemaDiagnostic(issue: z.core.$ZodIssue, input: unknown): AppDiagnostic {
  const path = issue.path.map(pathKey)
  const diagnostic: AppDiagnostic = { severity: 'error', code: 'schema', message: issue.message, path }
  const [list, index] = path
  if (input && typeof input === 'object' && typeof list === 'string' && typeof index === 'number') {
    const name = (input as Record<string, { name?: unknown }[] | undefined>)[list]?.[index]?.name
    if (typeof name === 'string') diagnostic.entity = name
  }
  return diagnostic
}

function pathKey(key: PropertyKey): string | number {
  return typeof key === 'number' ? key : String(key)
}
