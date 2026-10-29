import { checkLibraryReference, type LibraryInfo, type QueryValidator } from '@ow/definition'
import { parseTemplate } from '@ow/expressions'
import type { z } from 'zod'
import {
  constantFits,
  MODULE_PROPS,
  type ModuleInterface,
  moduleComponentSpec,
  QUERY_EVENTS,
} from './components'
import {
  buildAppGraph,
  defaultSpecFor,
  type Entity,
  entityMethods,
  entityProperties,
  type SpecFor,
} from './graph'
import { appNameReason, isAppGlobalName } from './names'
import { entityPages, pageVisible, RESERVED_PAGES } from './pages'
import { expressionSide } from './query-values'
import {
  type AppComponent,
  type AppDefinition,
  appDefinitionSchema,
  appNameSchema,
  type EventHandler,
  type LibraryAppQuery,
} from './schema'
import { CONTAINER_SLOTS, containerViews, FRAME_SLOTS } from './slots'

export type AppDiagnosticCode =
  | 'schema'
  | 'invalid_name'
  | 'duplicate_name'
  | 'unknown_type'
  | 'unknown_prop'
  | 'invalid_prop'
  | 'unknown_parent'
  | 'invalid_parent'
  /** A slot its parent doesn't have (M24), or a container's views written wrong. */
  | 'invalid_slot'
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
  | 'unknown_library'
  | 'unpublished_library'
  /** A library query (or, M21, module) exists but the person lacks Use on it. */
  | 'no_use_access'
  | 'unknown_version'
  | 'unknown_param'
  | 'missing_param'
  | 'module_pages'
  /** A module instance reaching the module it's in (M21). */
  | 'module_cycle'
  /** Module instances nested deeper than `MAX_MODULE_DEPTH` (M21). */
  | 'module_depth'
  | 'not_in_module'
  | 'unknown_module'
  | 'unpublished_module'

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
  /**
   * The library queries the app may use, by slug; undefined for none with that slug (or none the person can see).
   * Without it, library queries aren't checked against the library.
   */
  resolveLibrary?: (slug: string) => LibraryInfo | undefined
  /**
   * The modules the app may place (M14), by slug; undefined for none with that slug. Without it, module instances
   * take any props and events (their module isn't known).
   */
  resolveModule?: (slug: string) => ModuleInfo | undefined
  /** The slug of the module being checked (M21): an instance reaching it back is a cycle. */
  self?: string
}

/** How deep modules nest below an app (M21): an app holds a module holding a module holding a module, no deeper. */
export const MAX_MODULE_DEPTH = 3

/** How a module release nests (M21): 1 plus the deepest module it holds, and every module it reaches. */
export interface ModuleNesting {
  depth: number
  /** Slugs of the modules it holds, and those they hold, and so on (`latest` as the live release). */
  reaches: readonly string[]
}

/** What the validator needs to know about a module an app places (M14). */
export interface ModuleInfo {
  /** The live release's version, or null when it has none. */
  liveVersion: string | null
  /** Each release's inputs, outputs and events, by version. */
  versions: Record<string, ModuleInterface>
  /** Each release's nesting, by version (M21); without it, depth and cycles through it aren't checked. */
  nesting?: Record<string, ModuleNesting>
  /** The module exists but the person may not use it (M21): reported as needing use access, nothing else shown. */
  noUse?: boolean
}

/**
 * How a module definition nests (M21), from how the releases its instances run nest (`nesting(slug, version)`,
 * undefined when unknown: counted as holding nothing).
 */
export function moduleNesting(
  def: AppDefinition,
  nesting: (slug: string, version: string) => ModuleNesting | undefined,
): ModuleNesting {
  let depth = 1
  const reaches = new Set<string>()
  for (const { slug, version } of placed(def)) {
    const inner = nesting(slug, version)
    depth = Math.max(depth, 1 + (inner?.depth ?? 1))
    reaches.add(slug)
    for (const s of inner?.reaches ?? []) reaches.add(s)
  }
  return { depth, reaches: [...reaches].sort() }
}

/**
 * A module instance on a query's path, and the module release the page runs for it (M14; a path of them for
 * modules inside modules, outermost first: M21). The browser sends it; the server walks it.
 */
export interface InstanceStep {
  instance: string
  releaseId: string
}

/**
 * The release a module instance names, from its `module` and `version` props (`latest` when missing), and the
 * `slug@version` key the app's module releases are looked up by; null when they aren't plain strings.
 */
export function instanceRelease(
  component: AppComponent,
): { slug: string; version: string; key: string } | null {
  const slug = component.props?.module
  const version = component.props?.version ?? 'latest'
  if (typeof slug !== 'string' || typeof version !== 'string' || !slug) return null
  return { slug, version, key: `${slug}@${version}` }
}

/** The library queries an app's queries use, by slug, sorted (M14; the server and the editor both resolve these). */
export function usedLibraries(def: AppDefinition): string[] {
  return [...new Set(def.queries.flatMap((q) => (q.kind === 'library' ? [q.library] : [])))].sort()
}

const placed = (def: AppDefinition) =>
  def.components.flatMap((c) => {
    const ref = c.type === 'module' ? instanceRelease(c) : null
    return ref ? [ref] : []
  })

/** The modules an app's instances place, by slug, sorted (as `instanceRelease` reads them). */
export const usedModules = (def: AppDefinition): string[] =>
  [...new Set(placed(def).map((r) => r.slug))].sort()

/** The `slug@version` keys of the module releases an app's instances run, sorted. */
export const instanceKeys = (def: AppDefinition): string[] =>
  [...new Set(placed(def).map((r) => r.key))].sort()

/** The interface of the release a module instance names; null when it can't be told. */
export function instanceInterface(
  component: AppComponent,
  resolve: (slug: string) => ModuleInfo | undefined,
): ModuleInterface | null {
  const ref = instanceRelease(component)
  if (!ref) return null
  const { slug, version } = ref
  const info = resolve(slug)
  const at = version === 'latest' ? info?.liveVersion : version
  return (at && info && Object.hasOwn(info.versions, at) ? info.versions[at] : null) ?? null
}

/** What an app sees of a module release: its inputs, outputs and events. */
export function moduleInterface(def: Pick<AppDefinition, 'module'>): ModuleInterface {
  return {
    inputs: def.module?.inputs.map((i) => i.name) ?? [],
    outputs: def.module?.outputs.map((o) => o.name) ?? [],
    events: def.module?.events.map((e) => e.name) ?? [],
  }
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
  inputs: 'module',
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
  const resolveModule = options.resolveModule
  const specFor: SpecFor = (c) =>
    c.type === 'module' && resolveModule
      ? moduleComponentSpec(instanceInterface(c, resolveModule))
      : defaultSpecFor(c)
  const graph = buildAppGraph(def, { specFor })
  const { entities } = graph
  const pages = entityPages(def)
  checkPages(def, report)

  // Components: type, props, parent, events.
  def.components.forEach((c, i) => {
    const at = { entity: c.name }
    const spec = specFor(c)
    if (c.type === 'module') checkModuleInstance(def, c, ['components', i], options, report)
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
        if (spec.openProps) continue
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
    if (c.slot !== undefined) checkSlot(def, c, spec, ['components', i, 'slot'], at, report)
    if (c.type === 'container' && c.props?.views !== undefined) {
      checkViews(c.props.views, ['components', i, 'props', 'views'], at, report)
    }
    const events = spec.openProps ? null : spec.events
    checkHandlers(def, c.events, ['components', i, 'events'], events, at.entity, entities, pages, report)
    if (c.type === 'navigation' && Array.isArray(c.props?.items)) {
      c.props.items.forEach((item, n) => {
        const page = item && typeof item === 'object' && !Array.isArray(item) ? item.page : undefined
        if (typeof page === 'string' && !page.includes('{{') && !def.pages?.some((p) => p.name === page)) {
          report({
            code: 'unknown_page',
            message: `No page is named "${page}"`,
            path: ['components', i, 'props', 'items', n, 'page'],
            ...at,
          })
        }
      })
    }
  })

  if (def.module) checkModule(def, entities, report)

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
    checkHandlers(def, q.events, ['queries', i, 'events'], QUERY_EVENTS, q.name, entities, pages, report)
    if (q.kind === 'resource' && options.resolveResource) {
      checkQuery(q, ['queries', i], options.resolveResource, report)
    }
    if (q.kind === 'library' && options.resolveLibrary) {
      checkLibraryUse(q, ['queries', i], options.resolveLibrary, report)
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
      } else if (
        !entityProperties(entity).includes(ref.property) &&
        !isObjectMember(ref.property) &&
        // A module instance whose module isn't known yet (M14): its outputs aren't either.
        !(entity.kind === 'component' && entity.spec?.openProps)
      ) {
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
    const sent = field.path[2] === 'query' || field.path[2] === 'params'
    if (field.path[0] !== 'queries' || !sent || field.errors.length) continue
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
  def: AppDefinition,
  handlers: EventHandler[] | undefined,
  base: (string | number)[],
  /** The owner's events; null when they aren't known (a module instance before its module is). */
  events: readonly string[] | null,
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
    if (a.type === 'moduleEvent') {
      const declared = def.module?.events.some((e) => e.name === a.event)
      if (!def.module || !declared) {
        report({
          code: def.module ? 'unknown_event' : 'not_in_module',
          message: def.module
            ? `The module has no event "${a.event}"`
            : 'Only a module fires module events; add the event to a module',
          path: [...path, 'action', 'event'],
          ...at,
        })
      }
    }
    if (events && !events.includes(h.event)) {
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

/** A library query's reference (`checkLibraryReference`), reported on the query. */
function checkLibraryUse(
  q: LibraryAppQuery,
  base: (string | number)[],
  resolve: NonNullable<AppValidateOptions['resolveLibrary']>,
  report: Report,
) {
  for (const problem of checkLibraryReference(q, resolve)) {
    report({ ...problem, path: [...base, ...problem.path], entity: q.name })
  }
}

/**
 * A module's own rules (M14): no pages; inputs, outputs and events uniquely named (an input and an output can't
 * share a name, both being the instance's); inputs aren't named like the instance's own props; `inputs` is built in.
 */
function checkModule(def: AppDefinition, entities: ReadonlyMap<string, Entity>, report: Report) {
  const module = def.module!
  if (def.pages?.length) {
    report({
      code: 'module_pages',
      message: 'A module has no pages; it sits on a page of the app',
      path: ['pages'],
    })
  }
  const owned = entities.get('inputs')
  if (owned && owned.kind !== 'inputs') {
    report({
      code: 'invalid_name',
      message: '"inputs" is built into modules (the inputs the app passes)',
      path: [LIST[owned.kind], owned.index, 'name'],
      entity: 'inputs',
    })
  }
  const instanceProps = new Set([...MODULE_PROPS, 'hidden'])
  const seen = new Set<string>()
  const lists = [
    ['inputs', module.inputs],
    ['outputs', module.outputs],
  ] as const
  for (const [list, items] of lists) {
    items.forEach((item: { name: string }, i: number) => {
      const path = ['module', list, i, 'name']
      if (instanceProps.has(item.name)) {
        report({ code: 'invalid_name', message: `"${item.name}" is a prop every module instance has`, path })
      } else if (seen.has(item.name)) {
        report({
          code: 'duplicate_name',
          message: `Another input or output is already named "${item.name}"`,
          path,
        })
      }
      seen.add(item.name)
    })
  }
  const events = new Set<string>()
  module.events.forEach((e, i) => {
    if (events.has(e.name)) {
      report({
        code: 'duplicate_name',
        message: `Another event is already named "${e.name}"`,
        path: ['module', 'events', i, 'name'],
      })
    }
    events.add(e.name)
  })
}

/**
 * A module instance (M14): it names a module by slug (not a template), and with `resolve`, a module and release
 * that exist. In a module (M21), it doesn't reach that module back, and doesn't nest deeper than the limit leaves.
 */
function checkModuleInstance(
  def: AppDefinition,
  c: AppComponent,
  base: (string | number)[],
  { resolveModule: resolve, self }: AppValidateOptions,
  report: Report,
) {
  const at = { entity: c.name }
  const slug = c.props?.module
  if (typeof slug !== 'string' || !slug || slug.includes('{{')) {
    report({
      code: 'unknown_module',
      message: 'Pick a module: its slug, not a {{ }} template',
      path: [...base, 'props', 'module'],
      ...at,
    })
    return
  }
  if (self && slug === self) {
    report({
      code: 'module_cycle',
      message: 'A module can’t hold itself',
      path: [...base, 'props', 'module'],
      ...at,
    })
    return
  }
  if (!resolve) return
  const info = resolve(slug)
  const version = c.props?.version ?? 'latest'
  if (!info) {
    report({
      code: 'unknown_module',
      message: `No module has the slug "${slug}"`,
      path: [...base, 'props', 'module'],
      ...at,
    })
  } else if (info.noUse) {
    report({
      code: 'no_use_access',
      message: `You need use access to module "${slug}"`,
      path: [...base, 'props', 'module'],
      ...at,
    })
  } else if (version === 'latest' && info.liveVersion === null) {
    report({
      code: 'unpublished_module',
      message: `Module "${slug}" has no live release yet`,
      path: [...base, 'props', 'version'],
      ...at,
    })
  } else if (
    typeof version !== 'string' ||
    (version !== 'latest' && !Object.hasOwn(info.versions, version))
  ) {
    report({
      code: 'unknown_version',
      message: `Module "${slug}" has no release ${String(version)}`,
      path: [...base, 'props', 'version'],
      ...at,
    })
  } else {
    const release = version === 'latest' ? info.liveVersion! : version
    const nesting = info.nesting && Object.hasOwn(info.nesting, release) ? info.nesting[release] : undefined
    if (self && nesting?.reaches.includes(self)) {
      report({
        code: 'module_cycle',
        message: `Module "${slug}" holds this module (directly or through others): a module can’t hold itself`,
        path: [...base, 'props', 'module'],
        ...at,
      })
      return
    }
    const limit = def.module ? MAX_MODULE_DEPTH - 1 : MAX_MODULE_DEPTH
    if (nesting && nesting.depth > limit) {
      report({
        code: 'module_depth',
        message: def.module
          ? `Modules nest ${MAX_MODULE_DEPTH} levels deep at most: "${slug}" v${release} is ${nesting.depth} deep, and this module adds one`
          : `Modules nest ${MAX_MODULE_DEPTH} levels deep at most: "${slug}" v${release} is ${nesting.depth} deep`,
        path: [...base, 'props', 'module'],
        ...at,
      })
    }
  }
}

/** A component's `slot` (M24): one its parent has (a container's view, header or footer; the frame's). */
function checkSlot(
  def: AppDefinition,
  c: AppComponent,
  spec: { overlay?: boolean },
  path: (string | number)[],
  at: { entity: string },
  report: Report,
) {
  const parent = c.parent === undefined ? undefined : def.components.find((p) => p.name === c.parent)
  if (spec.overlay) {
    report({ code: 'invalid_slot', message: 'A modal opens over the page; it has no slot', path, ...at })
    return
  }
  if (c.parent === undefined) {
    if (!(FRAME_SLOTS as readonly string[]).includes(c.slot!)) {
      report({
        code: 'invalid_slot',
        message: `At the top, a component is in the frame's ${FRAME_SLOTS.join(' or ')}, not "${c.slot}"`,
        path,
        ...at,
      })
    }
    return
  }
  if (parent?.type !== 'container') {
    if (parent) report({ code: 'invalid_slot', message: `"${c.parent}" has no slots`, path, ...at })
    return
  }
  const allowed = [...CONTAINER_SLOTS, ...containerViews(parent).map((v) => v.name)]
  if (!allowed.includes(c.slot!)) {
    report({
      code: 'invalid_slot',
      message: `"${c.parent}" has no view or slot "${c.slot}": it has ${allowed.join(', ')}`,
      path,
      ...at,
    })
  }
}

/** A container's `views` (M24): a list of `{ name, label? }`, names valid, unused, not a slot's. */
function checkViews(views: unknown, path: (string | number)[], at: { entity: string }, report: Report) {
  if (!Array.isArray(views)) {
    report({
      code: 'invalid_slot',
      message:
        'Views are written as a list of { name, label }, not computed: components are placed in them by name',
      path,
      ...at,
    })
    return
  }
  const seen = new Set<string>()
  views.forEach((v, n) => {
    const name = v && typeof v === 'object' && !Array.isArray(v) ? (v as { name?: unknown }).name : undefined
    const where = [...path, n]
    if (typeof name !== 'string' || !appNameSchema.safeParse(name).success) {
      report({
        code: 'invalid_slot',
        message: 'A view needs a name: a letter, then letters, digits or _',
        path: where,
        ...at,
      })
    } else if ((CONTAINER_SLOTS as readonly string[]).includes(name)) {
      report({
        code: 'invalid_slot',
        message: `"${name}" is the container's ${name}, not a view`,
        path: where,
        ...at,
      })
    } else if (seen.has(name)) {
      report({ code: 'invalid_slot', message: `Two views are named "${name}"`, path: where, ...at })
    }
    if (typeof name === 'string') seen.add(name)
  })
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
