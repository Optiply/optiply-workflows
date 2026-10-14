import type { TemplateError } from '@ow/expressions'
import type { z } from 'zod'
import { isValidTimeZone, nextCronFire, parseCron } from './cron'
import { codeFields, fieldRefs } from './fields'
import { buildGraph } from './graph'
import { isGlobalName, reservedNameReason } from './names'
import {
  type Block,
  blockPorts,
  MIN_SCHEDULE_INTERVAL_MS,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from './schema'
import { parseWebhookAlias } from './triggers'

export type DiagnosticCode =
  | 'schema'
  | 'invalid_name'
  | 'duplicate_name'
  | 'start_trigger'
  | 'unknown_block'
  | 'invalid_port'
  | 'edge_into_start'
  | 'duplicate_edge'
  | 'duplicate_condition'
  | 'cycle'
  | 'unreachable'
  | 'syntax'
  | 'not_ancestor'
  | 'self_reference'
  | 'unknown_identifier'
  | 'unknown_resource'
  | 'invalid_query'
  | 'invalid_alias'
  | 'invalid_schedule'
  | 'invalid_cron'
  | 'invalid_timezone'
  | 'duplicate_schedule'

export interface Diagnostic {
  severity: 'error' | 'warning'
  code: DiagnosticCode
  message: string
  /** Path into the definition, e.g. `['blocks', 2, 'config', 'sql']`. */
  path: (string | number)[]
  /** The block the problem belongs to, for the editor to highlight. */
  block?: string
  /** Offsets into the string at `path`, for code and template problems. */
  start?: number
  end?: number
  hint?: string
}

/** What the validator needs from a connector; `AnyConnector` from @ow/connectors fits. */
export interface QueryValidator {
  querySchema: z.ZodType
  validateQuery(query: never): TemplateError[]
}

export interface ValidateOptions {
  /**
   * Server side: the connector for a resource slug, or undefined if no such resource exists. When given, every
   * resource query is checked against its connector. The browser can leave this out.
   */
  resolveResource?: (slug: string) => QueryValidator | undefined
}

export interface ValidationResult {
  /** No error diagnostics (warnings are allowed). */
  ok: boolean
  /** The parsed definition, when it matched the schema. */
  definition?: WorkflowDefinition
  diagnostics: Diagnostic[]
}

/**
 * Checks a workflow definition and returns every problem found, for the editor to show and for saving or
 * releasing to refuse. Schema problems are reported alone, since the other checks need a well-formed definition.
 */
export function validateDefinition(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const parsed = workflowDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, diagnostics: parsed.error.issues.map((issue) => schemaDiagnostic(issue, input)) }
  }
  const def = parsed.data
  const diagnostics: Diagnostic[] = []
  const report = (d: Omit<Diagnostic, 'severity'> & { severity?: Diagnostic['severity'] }) =>
    diagnostics.push({ severity: 'error', ...d })

  // Names.
  const indexOf = new Map<string, number>()
  def.blocks.forEach((block, i) => {
    const reason = reservedNameReason(block.name)
    if (reason)
      report({ code: 'invalid_name', message: reason, path: ['blocks', i, 'name'], block: block.name })
    if (indexOf.has(block.name)) {
      report({
        code: 'duplicate_name',
        message: `Another block is already named "${block.name}"`,
        path: ['blocks', i, 'name'],
        block: block.name,
      })
    } else {
      indexOf.set(block.name, i)
    }
    if (block.type === 'branch') {
      const seen = new Set<string>()
      block.config.conditions.forEach((c, j) => {
        if (seen.has(c.id)) {
          report({
            code: 'duplicate_condition',
            message: `Condition id "${c.id}" is used twice`,
            path: ['blocks', i, 'config', 'conditions', j, 'id'],
            block: block.name,
          })
        }
        seen.add(c.id)
      })
    }
  })

  const starts = def.blocks.flatMap((b, i) => (b.type === 'startTrigger' ? [i] : []))
  if (starts.length !== 1) {
    report({
      code: 'start_trigger',
      message:
        starts.length === 0
          ? 'The workflow needs a start trigger'
          : 'A workflow can only have one start trigger',
      path: starts.length === 0 ? ['blocks'] : ['blocks', starts[1]!],
      ...(starts.length > 1 && { block: def.blocks[starts[1]!]!.name }),
    })
  }

  // Edges.
  const byName = new Map(def.blocks.map((b) => [b.name, b]))
  const edgeKeys = new Set<string>()
  def.edges.forEach((edge, i) => {
    const from = byName.get(edge.from)
    const to = byName.get(edge.to)
    for (const [side, block] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (!block) {
        report({
          code: 'unknown_block',
          message: `No block is named "${edge[side]}"`,
          path: ['edges', i, side],
        })
      }
    }
    if (from && !blockPorts(from).includes(edge.port)) {
      report({
        code: 'invalid_port',
        message: `"${from.name}" has no "${edge.port}" output`,
        path: ['edges', i, 'port'],
        block: from.name,
        ...(edge.port === 'error' && {
          hint: 'Set the block to continue on failure (finally: continue) to get an error output',
        }),
      })
    }
    if (to?.type === 'startTrigger') {
      report({
        code: 'edge_into_start',
        message: 'Nothing can connect into the start trigger',
        path: ['edges', i, 'to'],
        block: to.name,
      })
    }
    const key = `${edge.from}\0${edge.port}\0${edge.to}`
    if (edgeKeys.has(key)) {
      report({ code: 'duplicate_edge', message: 'This connection already exists', path: ['edges', i] })
    }
    edgeKeys.add(key)
  })

  // Graph shape.
  const graph = buildGraph(def)
  if (graph.cycle) {
    const loop = [...graph.cycle, graph.cycle[0]].join(' → ')
    report({
      code: 'cycle',
      message: `Blocks can't form a loop: ${loop}`,
      path: ['blocks', indexOf.get(graph.cycle[0]!)!],
      block: graph.cycle[0]!,
      hint: 'Use a Loop block to repeat work',
    })
  }
  if (graph.start) {
    const reachable = graph.descendants(graph.start)
    def.blocks.forEach((block, i) => {
      if (block.name === graph.start || reachable.has(block.name) || indexOf.get(block.name) !== i) return
      report({
        severity: 'warning',
        code: 'unreachable',
        message: `"${block.name}" isn't connected to the start trigger, so it never runs`,
        path: ['blocks', i],
        block: block.name,
      })
    })
  }

  // Code and references.
  def.blocks.forEach((block, i) => {
    const ancestors = graph.ancestors(block.name)
    for (const field of codeFields(block)) {
      const path = ['blocks', i, ...field.path]
      const { refs, errors } = fieldRefs(field)
      for (const err of errors) {
        report({
          code: 'syntax',
          message: err.message,
          path,
          block: block.name,
          start: err.start,
          end: err.end,
          ...(err.hint && { hint: err.hint }),
        })
      }
      for (const ref of refs) {
        const at = { path, block: block.name, start: ref.start, end: ref.end }
        if (byName.has(ref.name)) {
          if (ref.name === block.name) {
            report({ code: 'self_reference', message: `"${block.name}" can't read its own result`, ...at })
          } else if (!ancestors.has(ref.name)) {
            report({
              code: 'not_ancestor',
              message: `"${ref.name}" doesn't run before "${block.name}"`,
              hint: `Connect "${ref.name}" upstream of "${block.name}" to use its result`,
              ...at,
            })
          }
        } else if (!isGlobalName(ref.name)) {
          report({ code: 'unknown_identifier', message: `"${ref.name}" is not defined`, ...at })
        }
      }
    }
  })

  checkTriggers(def, graph.start, report)

  // Queries against their connectors.
  if (options.resolveResource) {
    def.blocks.forEach((block, i) => {
      if (block.type === 'resourceQuery') checkQuery(block, i, options.resolveResource!, report)
    })
  }

  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    definition: def,
    diagnostics,
  }
}

/** Trigger problems are pinned to the start trigger, whose inspector edits them. */
function checkTriggers(
  def: WorkflowDefinition,
  start: string | undefined,
  report: (d: Omit<Diagnostic, 'severity'>) => void,
) {
  const at = (path: (string | number)[]) => ({ path: ['triggers', ...path], ...(start && { block: start }) })
  const alias = def.triggers?.webhook?.alias
  if (alias !== undefined) {
    const parsed = parseWebhookAlias(alias)
    if (!parsed.ok) {
      report({
        code: 'invalid_alias',
        message: parsed.error,
        ...at(['webhook', 'alias']),
        ...(parsed.hint && { hint: parsed.hint }),
      })
    }
  }

  const names = new Set<string>()
  def.triggers?.schedules?.forEach((schedule, i) => {
    if (names.has(schedule.name)) {
      report({
        code: 'duplicate_schedule',
        message: `Another schedule is already named "${schedule.name}"`,
        ...at(['schedules', i, 'name']),
      })
    }
    names.add(schedule.name)

    if ((schedule.cron === undefined) === (schedule.intervalMs === undefined)) {
      report({
        code: 'invalid_schedule',
        message: `Schedule "${schedule.name}" needs either a cron expression or an interval`,
        ...at(['schedules', i]),
      })
      return
    }
    if (schedule.intervalMs !== undefined) {
      if (schedule.intervalMs < MIN_SCHEDULE_INTERVAL_MS) {
        report({
          code: 'invalid_schedule',
          message: 'The interval must be at least 1 minute',
          ...at(['schedules', i, 'intervalMs']),
        })
      }
      return
    }

    const timezoneOk = schedule.timezone === undefined || isValidTimeZone(schedule.timezone)
    if (!timezoneOk) {
      report({
        code: 'invalid_timezone',
        message: `Unknown time zone "${schedule.timezone}"`,
        hint: 'Use an IANA name such as Europe/Amsterdam or UTC',
        ...at(['schedules', i, 'timezone']),
      })
    }
    const cron = parseCron(schedule.cron!)
    if (!cron.ok) {
      report({ code: 'invalid_cron', message: cron.error, ...at(['schedules', i, 'cron']) })
    } else if (timezoneOk && !nextCronFire(cron.cron, new Date(), schedule.timezone)) {
      report({
        code: 'invalid_cron',
        message: `"${schedule.cron}" never fires`,
        ...at(['schedules', i, 'cron']),
      })
    }
  })
}

function checkQuery(
  block: Extract<Block, { type: 'resourceQuery' }>,
  index: number,
  resolve: NonNullable<ValidateOptions['resolveResource']>,
  report: (d: Omit<Diagnostic, 'severity'>) => void,
) {
  const base = ['blocks', index, 'config']
  const connector = resolve(block.config.resource)
  if (!connector) {
    report({
      code: 'unknown_resource',
      message: `No resource has the slug "${block.config.resource}"`,
      path: [...base, 'resource'],
      block: block.name,
    })
    return
  }
  const query = connector.querySchema.safeParse(block.config.query)
  if (!query.success) {
    for (const issue of query.error.issues) {
      report({
        code: 'invalid_query',
        message: issue.message,
        path: [...base, 'query', ...issue.path.map(pathKey)],
        block: block.name,
      })
    }
    return
  }
  for (const err of connector.validateQuery(query.data as never)) {
    report({
      code: 'invalid_query',
      message: err.message,
      path: [...base, 'query'],
      block: block.name,
      start: err.start,
      end: err.end,
      ...(err.hint && { hint: err.hint }),
    })
  }
}

function schemaDiagnostic(issue: z.core.$ZodIssue, input: unknown): Diagnostic {
  const path = issue.path.map(pathKey)
  const diagnostic: Diagnostic = { severity: 'error', code: 'schema', message: issue.message, path }
  if (path[0] === 'blocks' && typeof path[1] === 'number') {
    const name = (input as { blocks?: { name?: unknown }[] }).blocks?.[path[1]]?.name
    if (typeof name === 'string') diagnostic.block = name
  }
  return diagnostic
}

function pathKey(key: PropertyKey): string | number {
  return typeof key === 'number' ? key : String(key)
}
