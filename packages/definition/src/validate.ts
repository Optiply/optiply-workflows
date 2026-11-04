import { analyzePython, PYTHON_KEYWORDS, type TemplateError } from '@ow/expressions'
import type { z } from 'zod'
import { isValidTimeZone, nextCronFire, parseCron } from './cron'
import { codeFields, fieldRefs } from './fields'
import { buildGraph } from './graph'
import { checkLibraryReference, type LibraryInfo } from './library'
import { CODE_ONLY_GLOBALS, isGlobalName, PARAMS_NAME, RUN_GLOBALS, reservedNameReason } from './names'
import { MAX_REQUIREMENTS, requirementProblems } from './requirements'
import {
  type Block,
  type BlockOf,
  blockPorts,
  type FunctionDefinition,
  isTrigger,
  MAX_WAIT_MS,
  MIN_SCHEDULE_INTERVAL_MS,
  suspends,
  type WebhookTrigger,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from './schema'
import {
  CONFIG_VAR_NAME,
  DEFAULT_SIGNED_PAYLOAD,
  isHeaderName,
  MAX_BODY_SCHEMA_BYTES,
  parseSignedPayload,
  parseWebhookAlias,
  WEBHOOK_PRESETS,
} from './triggers'
import {
  type BlockGraphSource,
  blockGraphs,
  calledFunctions,
  functionReturnBlock,
  libraryCall,
  pythonFields,
} from './walk'

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
  /** A webhook's signature settings (secret name, header names, preset-only fields, the signed payload). */
  | 'invalid_webhook_auth'
  /** A webhook's body schema doesn't compile, or is too large. */
  | 'invalid_body_schema'
  /** A webhook's other settings: allowed environments, the idempotency header. */
  | 'invalid_webhook'
  | 'invalid_schedule'
  | 'invalid_cron'
  | 'invalid_timezone'
  | 'duplicate_schedule'
  /** A Pub/Sub trigger's settings: its resource (a `pubsub` one) or subscription name (M19). */
  | 'invalid_pubsub'
  | 'duplicate_pubsub'
  /** An SQS trigger's settings (M26): its resource (an `sqs` one) or queue. */
  | 'invalid_sqs'
  | 'duplicate_sqs'
  /** A Kafka trigger's settings (M26): its resource (a `kafka` one), topics, group or dead-letter topic. */
  | 'invalid_kafka'
  | 'duplicate_kafka'
  | 'error_trigger'
  | 'handler_overlap'
  | 'not_in_function'
  | 'unknown_function'
  | 'unknown_param'
  | 'duplicate_param'
  | 'function_return'
  | 'function_call'
  | 'recursive_function'
  | 'invalid_wait'
  | 'invalid_task'
  | 'unknown_assignee'
  | 'task_in_handler'
  | 'unknown_workflow'
  | 'unpublished_workflow'
  /** A Library query block's or runner's library query (M21): see `checkLibraryReference`. */
  | 'unknown_library'
  | 'no_use_access'
  | 'unpublished_library'
  | 'unknown_version'
  | 'missing_param'
  | 'python_unsupported'
  | 'python_builtin'
  /** Python code assigns a block's or run global's name: there it's the code's own variable (a warning). */
  | 'python_shadowed'
  /** A block named like a Python keyword, in a workflow with Python: Python can't read it (a warning). */
  | 'python_keyword'
  /** The server's: no code executor for Python (or it couldn't be reached to check the code). */
  | 'python_unavailable'
  /** A workflow's Python package (M23): not a plain requirement, a duplicate, or too many. */
  | 'invalid_requirement'
  /** The server's: packages declared, no package builder to install them (M23). */
  | 'python_packages_unavailable'

export interface Diagnostic {
  severity: 'error' | 'warning'
  code: DiagnosticCode
  message: string
  /** Path into the definition, e.g. `['blocks', 2, 'config', 'sql']`. */
  path: (string | number)[]
  /** The block the problem belongs to, for the editor to highlight. */
  block?: string
  /** Set when the problem is inside a function (`block` is then that function's block). */
  function?: string
  /** Offsets into the string at `path`, for code and template problems. */
  start?: number
  end?: number
  hint?: string
}

/** What the validator needs from a connector; `AnyConnector` from @ow/connectors fits. */
export interface QueryValidator {
  /** The resource type (`postgres`, `pubsub`, …): a Pub/Sub trigger needs a `pubsub` resource. */
  type?: string
  querySchema: z.ZodType
  validateQuery(query: never): TemplateError[]
}

export interface ValidateOptions {
  /**
   * Server side: the connector for a resource slug, or undefined if no such resource exists. When given, every
   * resource query is checked against its connector. The browser can leave this out.
   */
  resolveResource?: (slug: string) => QueryValidator | undefined
  /**
   * Server side: whether a child workflow slug names a workflow, and whether it has a live release (what child runs
   * execute). When given, every Workflow block and loop workflow runner is checked.
   */
  resolveWorkflow?: (slug: string) => 'published' | 'unpublished' | undefined
  /**
   * The library queries the workflow may use (M21), by slug; undefined for none with that slug. When given, every
   * Library query block and library loop runner is checked (`checkLibraryReference`).
   */
  resolveLibrary?: (slug: string) => LibraryInfo | undefined
  /**
   * Whether a User Task assignee written out in full (no `{{ }}`) exists: a user by email, a group by name. When
   * given, each one is checked; templated ones are checked when the task opens.
   */
  resolveAssignee?: (kind: 'user' | 'group', name: string) => boolean
  /**
   * Why a webhook's body schema doesn't compile, or null when it does: `checkBodySchema` from
   * `@ow/definition/body-schema`. Without it only the schema's size is checked.
   */
  checkBodySchema?: (schema: unknown) => string | null
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
  const report: Report = (d) => diagnostics.push({ severity: 'error', ...d })

  const functions = new Map<string, FunctionDefinition>()
  checkFunctions(def, functions, report)
  let start: string | undefined
  const usesPython = pythonFields(def).length > 0
  for (const source of blockGraphs(def)) {
    const found = checkGraph(source, functions, report, usesPython)
    if (!source.function) start = found
  }
  checkRecursion(def, functions, report)
  checkTriggers(def, start, report, options)
  checkRequirements(def, report)

  // User Task assignees written out in full exist.
  if (options.resolveAssignee) {
    for (const { blocks, path, function: fn } of blockGraphs(def)) {
      blocks.forEach((block, i) => {
        if (block.type !== 'userTask') return
        for (const kind of ['users', 'groups'] as const) {
          block.config.assignees[kind]?.forEach((entry, j) => {
            const name = entry.trim()
            if (!name || name.includes('{{')) return
            if (options.resolveAssignee!(kind === 'users' ? 'user' : 'group', name)) return
            report({
              code: 'unknown_assignee',
              message: kind === 'users' ? `No user has the email ${name}` : `No group is named "${name}"`,
              path: [...path, 'blocks', i, 'config', 'assignees', kind, j],
              block: block.name,
              ...(fn && { function: fn.name }),
            })
          })
        }
      })
    }
  }

  // Child workflows exist and are published.
  if (options.resolveWorkflow) {
    for (const { blocks, path, function: fn } of blockGraphs(def)) {
      blocks.forEach((block, i) => {
        const call =
          block.type === 'workflow'
            ? { slug: block.config.workflow, at: ['config', 'workflow'] }
            : block.type === 'loop' && block.config.runner.kind === 'workflow'
              ? { slug: block.config.runner.workflow, at: ['config', 'runner', 'workflow'] }
              : undefined
        if (!call) return
        const state = options.resolveWorkflow!(call.slug)
        if (state === 'published') return
        report({
          code: state === undefined ? 'unknown_workflow' : 'unpublished_workflow',
          message:
            state === undefined
              ? `No workflow has the slug "${call.slug}"`
              : `Workflow "${call.slug}" isn't published; publish it so this one can call it`,
          path: [...path, 'blocks', i, ...call.at],
          block: block.name,
          ...(fn && { function: fn.name }),
        })
      })
    }
  }

  // Library queries exist, may be used, have the release named, and get the parameters they declare (M21).
  if (options.resolveLibrary) {
    for (const { blocks, path, function: fn } of blockGraphs(def)) {
      blocks.forEach((block, i) => {
        const use = libraryCall(block)
        if (!use) return
        for (const problem of checkLibraryReference(use.call, options.resolveLibrary!)) {
          report({
            ...problem,
            path: [...path, 'blocks', i, ...use.at, ...problem.path],
            block: block.name,
            ...(fn && { function: fn.name }),
          })
        }
      })
    }
  }

  // Queries against their connectors.
  if (options.resolveResource) {
    for (const { blocks, path, function: fn } of blockGraphs(def)) {
      blocks.forEach((block, i) => {
        const at = { block: block.name, ...(fn && { function: fn.name }) }
        if (block.type === 'resourceQuery') {
          checkQuery(block.config, [...path, 'blocks', i, 'config'], at, options.resolveResource!, report)
        }
        if (block.type === 'loop' && block.config.runner.kind === 'query') {
          const base = [...path, 'blocks', i, 'config', 'runner']
          checkQuery(block.config.runner, base, at, options.resolveResource!, report)
        }
      })
    }
  }

  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    definition: def,
    diagnostics,
  }
}

type Report = (d: Omit<Diagnostic, 'severity'> & { severity?: Diagnostic['severity'] }) => void

/** Function names, parameters and return blocks. Fills `functions` with the first function of each name. */
function checkFunctions(def: WorkflowDefinition, functions: Map<string, FunctionDefinition>, report: Report) {
  def.functions?.forEach((fn, i) => {
    const at = (...path: (string | number)[]) => ({ path: ['functions', i, ...path], function: fn.name })
    const reason = reservedNameReason(fn.name)
    if (reason) report({ code: 'invalid_name', message: reason, ...at('name') })
    if (functions.has(fn.name)) {
      report({
        code: 'duplicate_name',
        message: `Another function is already named "${fn.name}"`,
        ...at('name'),
      })
    } else {
      functions.set(fn.name, fn)
    }
    const params = new Set<string>()
    fn.params?.forEach((param, j) => {
      if (params.has(param.name)) {
        report({
          code: 'duplicate_param',
          message: `Another parameter is already named "${param.name}"`,
          ...at('params', j, 'name'),
        })
      }
      params.add(param.name)
    })
    if (!functionReturnBlock(fn)) {
      report({
        code: 'function_return',
        message:
          fn.returns !== undefined
            ? `No block in "${fn.name}" is named "${fn.returns}"`
            : fn.blocks.length === 0
              ? `"${fn.name}" has no blocks yet`
              : `Choose the block whose result "${fn.name}" returns`,
        ...at(...(fn.returns !== undefined ? ['returns'] : [])),
      })
    }
  })
}

/**
 * Checks one graph (the main one or a function's): names, edges, shape, what each block may contain and what its
 * code may read. Returns the start trigger's name, if there's exactly one.
 */
function checkGraph(
  source: BlockGraphSource,
  functions: ReadonlyMap<string, FunctionDefinition>,
  report: Report,
  usesPython = false,
): string | undefined {
  const fn = source.function
  const { blocks, edges } = source
  const inFunction = fn && { function: fn.name }
  const blockPath = (i: number, ...rest: (string | number)[]) => [...source.path, 'blocks', i, ...rest]

  // Names.
  const indexOf = new Map<string, number>()
  blocks.forEach((block, i) => {
    const at = { path: blockPath(i, 'name'), block: block.name, ...inFunction }
    const reason = reservedNameReason(block.name)
    if (reason) report({ code: 'invalid_name', message: reason, ...at })
    else if (usesPython && PYTHON_KEYWORDS.has(block.name)) {
      // Not reserved (older JavaScript workflows may use such names), but Python can't read the block.
      report({
        severity: 'warning',
        code: 'python_keyword',
        message: `"${block.name}" is a Python keyword: Python code can't read this block`,
        hint: 'Rename it to read its result from Python',
        ...at,
      })
    } else if (functions.has(block.name)) {
      report({ code: 'duplicate_name', message: `A function is already named "${block.name}"`, ...at })
    }
    if (indexOf.has(block.name)) {
      report({ code: 'duplicate_name', message: `Another block is already named "${block.name}"`, ...at })
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
            path: blockPath(i, 'config', 'conditions', j, 'id'),
            block: block.name,
            ...inFunction,
          })
        }
        seen.add(c.id)
      })
    }
  })

  // Triggers, and what a function may contain.
  const starts = blocks.flatMap((b, i) => (b.type === 'startTrigger' ? [i] : []))
  const handlers = blocks.flatMap((b, i) => (b.type === 'errorTrigger' ? [i] : []))
  if (fn) {
    blocks.forEach((block, i) => {
      const why = notInFunction(block)
      if (why) {
        report({
          code: 'not_in_function',
          message: why,
          path: blockPath(i),
          block: block.name,
          ...inFunction,
        })
      }
    })
  } else {
    if (starts.length !== 1) {
      report({
        code: 'start_trigger',
        message:
          starts.length === 0
            ? 'The workflow needs a start trigger'
            : 'A workflow can only have one start trigger',
        path: starts.length === 0 ? ['blocks'] : ['blocks', starts[1]!],
        ...(starts.length > 1 && { block: blocks[starts[1]!]!.name }),
      })
    }
    if (handlers.length > 1) {
      report({
        code: 'error_trigger',
        message: 'A workflow can only have one error handler',
        path: ['blocks', handlers[1]!],
        block: blocks[handlers[1]!]!.name,
      })
    }
  }

  // Edges.
  const byName = new Map(blocks.map((b) => [b.name, b]))
  const edgeKeys = new Set<string>()
  edges.forEach((edge, i) => {
    const path = (...rest: (string | number)[]) => [...source.path, 'edges', i, ...rest]
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
          path: path(side),
          ...inFunction,
        })
      }
    }
    if (from && !blockPorts(from).includes(edge.port)) {
      report({
        code: 'invalid_port',
        message: `"${from.name}" has no "${edge.port}" output`,
        path: path('port'),
        block: from.name,
        ...inFunction,
        ...(edge.port === 'error' && {
          hint: 'Set the block to continue on failure (finally: continue) to get an error output',
        }),
      })
    }
    if (to && isTrigger(to)) {
      report({
        code: 'edge_into_start',
        message:
          to.type === 'startTrigger'
            ? 'Nothing can connect into the start trigger'
            : 'Nothing can connect into the error handler',
        path: path('to'),
        block: to.name,
        ...inFunction,
      })
    }
    const key = `${edge.from}\0${edge.port}\0${edge.to}`
    if (edgeKeys.has(key)) {
      report({
        code: 'duplicate_edge',
        message: 'This connection already exists',
        path: path(),
        ...inFunction,
      })
    }
    edgeKeys.add(key)
  })

  // Graph shape.
  const graph = buildGraph({ blocks: [...blocks], edges: [...edges] })
  if (graph.cycle) {
    const loop = [...graph.cycle, graph.cycle[0]].join(' → ')
    report({
      code: 'cycle',
      message: `Blocks can't form a loop: ${loop}`,
      path: blockPath(indexOf.get(graph.cycle[0]!)!),
      block: graph.cycle[0]!,
      ...inFunction,
      hint: 'Use a Loop block to repeat work',
    })
  }
  // The main path (from the start trigger) and the error handler's path. A function has no triggers.
  const mainPath = new Set<string>()
  const handlerPath = new Set<string>()
  if (!fn && graph.start) {
    mainPath.add(graph.start)
    for (const name of graph.descendants(graph.start)) mainPath.add(name)
  }
  // Every handler counts here, so a second one is reported once (above) rather than also as unreachable.
  for (const i of fn ? [] : handlers) {
    const handler = blocks[i]!.name
    handlerPath.add(handler)
    for (const name of graph.descendants(handler)) handlerPath.add(name)
  }
  if (!fn && graph.start) {
    blocks.forEach((block, i) => {
      if (indexOf.get(block.name) !== i) return
      // An edge into a trigger is reported above.
      if (mainPath.has(block.name) && handlerPath.has(block.name) && !isTrigger(block)) {
        report({
          code: 'handler_overlap',
          message: `"${block.name}" can't run both after the start trigger and in the error handler`,
          path: blockPath(i),
          block: block.name,
        })
      } else if (!mainPath.has(block.name) && !handlerPath.has(block.name)) {
        report({
          severity: 'warning',
          code: 'unreachable',
          message: `"${block.name}" isn't connected to the start trigger, so it never runs`,
          path: blockPath(i),
          block: block.name,
        })
      }
    })
  }

  // What each block's settings name, and its code reads.
  blocks.forEach((block, i) => {
    const at = { block: block.name, ...inFunction }
    checkCalls(block, functions, (rest) => blockPath(i, ...rest), at, report)
    if (block.type === 'wait') checkWait(block, blockPath(i, 'config'), at, report)
    if (block.type === 'userTask') {
      checkUserTask(block, blockPath(i, 'config'), at, report)
      if (handlerPath.has(block.name)) {
        report({
          code: 'task_in_handler',
          message: "The error handler can't wait for a person: it has 60 seconds to finish",
          path: blockPath(i),
          ...at,
        })
      }
    }

    const ancestors = graph.ancestors(block.name)
    // The error handler may read anything on the main path: it runs after the run failed, and whatever didn't run
    // reads as skipped.
    const readable = (name: string) =>
      ancestors.has(name) || (handlerPath.has(block.name) && mainPath.has(name))
    for (const field of codeFields(block)) {
      const path = blockPath(i, ...field.path)
      const { refs, errors } = fieldRefs(field)
      for (const err of errors) {
        report({
          code: 'syntax',
          message: err.message,
          path,
          ...at,
          start: err.start,
          end: err.end,
          ...(err.hint && { hint: err.hint }),
        })
      }
      const python = field.kind === 'python-body'
      if (python) {
        // Assigning a name makes it the code's own in Python: reading the block (or `value`, `params`, …) before
        // the assignment fails with UnboundLocalError.
        const hidden = new Set([
          ...byName.keys(),
          ...RUN_GLOBALS,
          ...(field.locals ?? []),
          ...(fn ? [PARAMS_NAME] : []),
        ])
        for (const binding of analyzePython(field.source).bindings) {
          if (!hidden.has(binding.name)) continue
          report({
            severity: 'warning',
            code: 'python_shadowed',
            message: `"${binding.name}" is assigned in this code, so in Python it's the code's own variable here`,
            hint: `Use another name: reading ${byName.has(binding.name) ? 'the block' : `"${binding.name}"`} before this assignment fails with UnboundLocalError`,
            path,
            ...at,
            start: binding.start,
            end: binding.end,
          })
        }
        // A block named like a Python builtin can't be read from Python: the builtin wins.
        for (const ref of analyzePython(field.source).builtins) {
          if (!byName.has(ref.name)) continue
          report({
            severity: 'warning',
            code: 'python_builtin',
            message: `In Python, "${ref.name}" is the builtin, not the block "${ref.name}"`,
            hint: `Rename the block to read its result from Python`,
            path,
            ...at,
            start: ref.start,
            end: ref.end,
          })
        }
      }
      for (const ref of refs) {
        const where = { path, ...at, start: ref.start, end: ref.end }
        if (python && (functions.has(ref.name) || CODE_ONLY_GLOBALS.has(ref.name)) && !byName.has(ref.name)) {
          report({
            code: 'python_unsupported',
            message: functions.has(ref.name)
              ? `Python code can't call the function "${ref.name}"`
              : `Python code can't use ${ref.name}: it has no network`,
            hint: functions.has(ref.name)
              ? 'Use a Function block, or a JavaScript code block'
              : 'Make the request with a REST resource query, or in a JavaScript code block',
            ...where,
          })
        } else if (byName.has(ref.name)) {
          if (ref.name === block.name) {
            report({ code: 'self_reference', message: `"${block.name}" can't read its own result`, ...where })
          } else if (!readable(ref.name)) {
            report({
              code: 'not_ancestor',
              message: `"${ref.name}" doesn't run before "${block.name}"`,
              hint: `Connect "${ref.name}" upstream of "${block.name}" to use its result`,
              ...where,
            })
          }
        } else if (functions.has(ref.name)) {
          if (field.kind !== 'function-body') {
            report({
              code: 'function_call',
              message: `Functions can only be called from code, as await ${ref.name}({ ... })`,
              hint: 'Use a Function block, or call it from a code block',
              ...where,
            })
          }
        } else if (CODE_ONLY_GLOBALS.has(ref.name) && field.kind !== 'function-body') {
          report({
            code: 'function_call',
            message: `${ref.name} can only be used in code, as await ${ref.name}(...)`,
            hint: 'Call it from a code block',
            ...where,
          })
        } else if (!python && !(isGlobalName(ref.name) || (fn && ref.name === PARAMS_NAME))) {
          // Python's other names are its own business (imports, variables): a NameError says what's missing.
          report({ code: 'unknown_identifier', message: `"${ref.name}" is not defined`, ...where })
        }
      }
    }
  })

  return fn ? undefined : graph.start
}

/** Why a block can't be part of a function, or null if it can. */
export function notInFunction(block: Block): string | null {
  switch (block.type) {
    case 'startTrigger':
      return "A function doesn't have a start trigger; it starts with the blocks nothing connects into"
    case 'errorTrigger':
      return "A function can't have an error handler"
    case 'response':
      return "A function can't reply to a webhook; it returns the data of a block"
  }
  if (suspends(block)) {
    if (block.type === 'wait') return "A function can't wait: function calls aren't checkpointed"
    if (block.type === 'userTask')
      return "A function can't wait for a person: function calls aren't checkpointed"
    return "A function can't wait for a child workflow; use the async mode"
  }
  return null
}

/** The function a Function block or a loop's function runner calls, and the parameters it passes. */
function checkCalls(
  block: Block,
  functions: ReadonlyMap<string, FunctionDefinition>,
  path: (rest: (string | number)[]) => (string | number)[],
  at: { block: string; function?: string },
  report: Report,
) {
  const call =
    block.type === 'function'
      ? { name: block.config.function, params: block.config.params, base: ['config'] }
      : block.type === 'loop' && block.config.runner.kind === 'function'
        ? {
            name: block.config.runner.function,
            params: block.config.runner.params,
            base: ['config', 'runner'],
          }
        : undefined
  if (!call) return
  const fn = functions.get(call.name)
  if (!fn) {
    report({
      code: 'unknown_function',
      message: `No function is named "${call.name}"`,
      path: path([...call.base, 'function']),
      ...at,
    })
    return
  }
  const declared = new Set(fn.params?.map((p) => p.name))
  for (const name of Object.keys(call.params ?? {})) {
    if (!declared.has(name)) {
      report({
        code: 'unknown_param',
        message: `"${fn.name}" has no parameter named "${name}"`,
        path: path([...call.base, 'params', name]),
        ...at,
      })
    }
  }
}

const WAIT_UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const

/** A wait needs a duration or a time. Constant values are checked now; templates when the block runs. */
function checkWait(
  block: BlockOf<'wait'>,
  base: (string | number)[],
  at: { block: string; function?: string },
  report: Report,
) {
  const { config } = block
  const field = config.kind === 'duration' ? 'amount' : 'until'
  const text = (config.kind === 'duration' ? config.amount : config.until).trim()
  const problem = (message: string) =>
    report({ code: 'invalid_wait', message, path: [...base, field], ...at })
  if (!text) return problem(config.kind === 'duration' ? 'Enter how long to wait' : 'Enter when to resume')
  if (text.includes('{{')) return
  if (config.kind === 'duration') {
    const amount = Number(text)
    if (!Number.isFinite(amount) || amount < 0) return problem(`"${text}" isn't a number of ${config.unit}`)
    if (amount * WAIT_UNIT_MS[config.unit] > MAX_WAIT_MS) return problem('A wait can last at most 60 days')
  } else if (Number.isNaN(Date.parse(text))) {
    problem(`"${text}" isn't a date and time`)
  }
}

/** A task needs a title, someone to do it, well-formed fields and outcomes, and a sensible due time. */
function checkUserTask(
  block: BlockOf<'userTask'>,
  base: (string | number)[],
  at: { block: string; function?: string },
  report: Report,
) {
  const { title, assignees, fields = [], outcomes = [], due } = block.config
  const problem = (message: string, ...path: (string | number)[]) =>
    report({ code: 'invalid_task', message, path: [...base, ...path], ...at })
  if (!title.trim()) problem('Give the task a title', 'title')
  const people = [...(assignees.users ?? []), ...(assignees.groups ?? [])]
  if (!people.some((p) => p.trim())) problem('Assign the task to at least one user or group', 'assignees')
  assignees.users?.forEach((u, i) => {
    const text = u.trim()
    if (text && !text.includes('{{') && !/^[^\s@]+@[^\s@]+$/.test(text)) {
      problem(`"${text}" isn't an email address`, 'assignees', 'users', i)
    }
  })
  const names = new Set<string>()
  fields.forEach((f, i) => {
    if (names.has(f.name)) problem(`Two fields are named "${f.name}"`, 'fields', i, 'name')
    names.add(f.name)
    if (!f.label.trim()) problem('Give the field a label', 'fields', i, 'label')
    if (f.type === 'select' && !f.options?.some((o) => o.trim())) {
      problem('A choice needs at least one option', 'fields', i, 'options')
    }
  })
  const ids = new Set<string>()
  outcomes.forEach((o, i) => {
    if (ids.has(o.id)) problem(`Two outcomes have the id "${o.id}"`, 'outcomes', i, 'id')
    ids.add(o.id)
    if (!o.label.trim()) problem('Give the button a label', 'outcomes', i, 'label')
  })
  if (due) {
    const text = due.amount.trim()
    if (!text) problem('Enter when the task is due', 'due', 'amount')
    else if (!text.includes('{{')) {
      const amount = Number(text)
      if (!Number.isFinite(amount) || amount <= 0)
        problem(`"${text}" isn't a number of ${due.unit}`, 'due', 'amount')
      else if (amount * WAIT_UNIT_MS[due.unit] > MAX_WAIT_MS)
        problem('A task can be due at most 60 days out', 'due', 'amount')
    }
  }
}

/** Functions that call themselves, directly or through others, would never finish. */
function checkRecursion(
  def: WorkflowDefinition,
  functions: ReadonlyMap<string, FunctionDefinition>,
  report: Report,
) {
  const names = new Set(functions.keys())
  const calls = new Map<string, string[]>()
  for (const [name, fn] of functions) {
    const called = new Set<string>()
    for (const block of fn.blocks) for (const c of calledFunctions(block, names)) called.add(c)
    calls.set(name, [...called])
  }
  const state = new Map<string, 'open' | 'done'>()
  const path: string[] = []
  const reported = new Set<string>()
  const visit = (name: string) => {
    state.set(name, 'open')
    path.push(name)
    for (const next of calls.get(name) ?? []) {
      const s = state.get(next)
      if (s === 'open') {
        const cycle = path.slice(path.indexOf(next))
        if (!cycle.some((n) => reported.has(n))) {
          for (const n of cycle) reported.add(n)
          const index = def.functions!.findIndex((f) => f.name === next)
          report({
            code: 'recursive_function',
            message:
              cycle.length === 1
                ? `"${next}" calls itself`
                : `Functions can't call each other in a circle: ${[...cycle, next].join(' → ')}`,
            path: ['functions', index],
            function: next,
          })
        }
      } else if (s === undefined) {
        visit(next)
      }
    }
    path.pop()
    state.set(name, 'done')
  }
  for (const name of functions.keys()) if (!state.has(name)) visit(name)
}

/** Trigger problems are pinned to the start trigger, whose inspector edits them. */
/** M23's Python packages: each a plain requirement (`requirementProblems`), at most MAX_REQUIREMENTS. */
function checkRequirements(def: WorkflowDefinition, report: Report) {
  const requirements = def.settings?.python?.requirements
  if (!requirements) return
  const path = ['settings', 'python', 'requirements']
  if (requirements.length > MAX_REQUIREMENTS) {
    report({ code: 'invalid_requirement', message: `At most ${MAX_REQUIREMENTS} packages`, path })
  }
  for (const { index, message } of requirementProblems(requirements)) {
    report({ code: 'invalid_requirement', message, path: [...path, index] })
  }
}

function checkTriggers(
  def: WorkflowDefinition,
  start: string | undefined,
  report: Report,
  options: ValidateOptions,
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
  if (def.triggers?.webhook)
    checkWebhook(def.triggers.webhook, (path) => at(['webhook', ...path]), report, options)
  checkQueueTriggers('pubsub', def.triggers?.pubsub, at, report, options)
  checkQueueTriggers('sqs', def.triggers?.sqs, at, report, options)
  checkQueueTriggers('kafka', def.triggers?.kafka, at, report, options)

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

/** A subscription id (Pub/Sub's rule: a letter, then 2–254 of letters, digits and `-_.~+%`), or a full name. */
const PUBSUB_SUBSCRIPTION = /^(projects\/[^/]+\/subscriptions\/)?[A-Za-z][\w.~+%-]{2,254}$/
/** A queue name (SQS's rule: up to 80 of letters, digits, `-` and `_`, `.fifo` for FIFO queues), or an https URL. */
const SQS_QUEUE = /^(https?:\/\/[^\s/]+\/[^\s]+|[\w-]{1,80}(\.fifo)?)$/
/** A topic name (Kafka's rule: up to 249 of letters, digits, `.`, `_` and `-`; not `.` or `..`). */
const KAFKA_TOPIC = /^(?!\.{1,2}$)[\w.-]{1,249}$/
/** A consumer group id: printable, no spaces at the ends. */
const KAFKA_GROUP = /^\S(.*\S)?$/

const QUEUE_LABELS = { pubsub: 'Pub/Sub', sqs: 'SQS', kafka: 'Kafka' } as const
type QueueTriggers = NonNullable<WorkflowDefinition['triggers']>

/**
 * Queue triggers (Pub/Sub M19, SQS and Kafka M26): unique names per kind, a resource of the kind (where resources are
 * known), and the kind's own settings: a subscription name, a queue, topics and a group.
 */
function checkQueueTriggers<K extends 'pubsub' | 'sqs' | 'kafka'>(
  kind: K,
  triggers: QueueTriggers[K],
  at: (path: (string | number)[]) => { path: (string | number)[]; block?: string },
  report: Report,
  options: ValidateOptions,
) {
  const label = QUEUE_LABELS[kind]
  const invalid = `invalid_${kind}` as const
  const names = new Set<string>()
  triggers?.forEach((trigger, i) => {
    const where = `${label} trigger "${trigger.name}"`
    if (names.has(trigger.name))
      report({
        code: `duplicate_${kind}`,
        message: `Another ${label} trigger is already named "${trigger.name}"`,
        ...at([kind, i, 'name']),
      })
    names.add(trigger.name)
    if (options.resolveResource) {
      const connector = options.resolveResource(trigger.resource)
      if (!connector)
        report({
          code: 'unknown_resource',
          message: `${where}: no resource has the slug "${trigger.resource}"`,
          ...at([kind, i, 'resource']),
        })
      else if (connector.type !== kind)
        report({
          code: invalid,
          message: `${where}: "${trigger.resource}" isn't ${kind === 'sqs' ? 'an' : 'a'} ${label} resource`,
          ...at([kind, i, 'resource']),
        })
    }
    if ('subscription' in trigger && !PUBSUB_SUBSCRIPTION.test(trigger.subscription))
      report({
        code: invalid,
        message: `${where}: "${trigger.subscription}" isn't a subscription id or projects/…/subscriptions/… name`,
        ...at([kind, i, 'subscription']),
      })
    if ('queue' in trigger && !SQS_QUEUE.test(trigger.queue))
      report({
        code: invalid,
        message: `${where}: "${trigger.queue}" isn't a queue name or URL`,
        hint: 'Use the name (letters, digits, - and _, .fifo for a FIFO queue) or the https:// URL',
        ...at([kind, i, 'queue']),
      })
    if ('topics' in trigger) {
      trigger.topics.forEach((topic, t) => {
        if (!KAFKA_TOPIC.test(topic))
          report({
            code: invalid,
            message: `${where}: "${topic}" isn't a topic name`,
            hint: 'Letters, digits, ., _ and -',
            ...at([kind, i, 'topics', t]),
          })
      })
      if (new Set(trigger.topics).size !== trigger.topics.length)
        report({ code: invalid, message: `${where} names a topic twice`, ...at([kind, i, 'topics']) })
      if (trigger.groupId !== undefined && !KAFKA_GROUP.test(trigger.groupId))
        report({
          code: invalid,
          message: `${where}: the group id can't start or end with a space`,
          ...at([kind, i, 'groupId']),
        })
      if (trigger.deadLetterTopic !== undefined) {
        if (!KAFKA_TOPIC.test(trigger.deadLetterTopic))
          report({
            code: invalid,
            message: `${where}: "${trigger.deadLetterTopic}" isn't a topic name`,
            ...at([kind, i, 'deadLetterTopic']),
          })
        else if (trigger.topics.includes(trigger.deadLetterTopic))
          report({
            code: invalid,
            message: `${where}: the dead-letter topic can't be one it reads`,
            hint: 'A failing message would come back to it forever',
            ...at([kind, i, 'deadLetterTopic']),
          })
      }
    }
  })
}

const CUSTOM_SIGNATURE_FIELDS = [
  'header',
  'algorithm',
  'encoding',
  'prefix',
  'timestampHeader',
  'signedPayload',
] as const

/** M15's webhook settings: signature auth, the body schema, allowed environments, the idempotency header. */
function checkWebhook(
  webhook: WebhookTrigger,
  at: (path: (string | number)[]) => { path: (string | number)[]; block?: string },
  report: Report,
  options: ValidateOptions,
) {
  const auth = webhook.auth
  if (auth?.type === 'signature') {
    const authAt = (field: string) => at(['auth', field])
    if (!auth.secret) {
      report({
        code: 'invalid_webhook_auth',
        message: 'Choose the secret config var that holds the signing secret',
        ...authAt('secret'),
      })
    } else if (!CONFIG_VAR_NAME.test(auth.secret)) {
      report({
        code: 'invalid_webhook_auth',
        message: `"${auth.secret}" isn't a config var name`,
        hint: 'Use letters, digits and underscores, not starting with a digit',
        ...authAt('secret'),
      })
    }
    let timestamped: boolean
    if (auth.preset === 'custom') {
      if (!auth.header) {
        report({
          code: 'invalid_webhook_auth',
          message: 'Name the header that carries the signature',
          ...authAt('header'),
        })
      }
      for (const field of ['header', 'timestampHeader'] as const) {
        const name = auth[field]
        if (name && !isHeaderName(name)) {
          report({ code: 'invalid_webhook_auth', message: `"${name}" isn't a header name`, ...authAt(field) })
        }
      }
      const payload = parseSignedPayload(auth.signedPayload ?? DEFAULT_SIGNED_PAYLOAD)
      if (!payload.ok) {
        report({
          code: 'invalid_webhook_auth',
          message: payload.error,
          ...authAt('signedPayload'),
          ...(payload.hint && { hint: payload.hint }),
        })
      }
      const signsTimestamp = payload.ok && payload.pieces.some((p) => 'part' in p && p.part === 'timestamp')
      if (signsTimestamp && !auth.timestampHeader) {
        report({
          code: 'invalid_webhook_auth',
          message: 'The signed payload uses {timestamp}: name the header that carries it',
          ...authAt('timestampHeader'),
        })
      }
      timestamped = auth.timestampHeader !== undefined
    } else {
      const preset = WEBHOOK_PRESETS[auth.preset]
      for (const field of CUSTOM_SIGNATURE_FIELDS) {
        if (auth[field] !== undefined) {
          report({
            code: 'invalid_webhook_auth',
            message: `The ${preset.label} preset sets "${field}" itself; it's for custom signatures only`,
            ...authAt(field),
          })
        }
      }
      timestamped = preset.timestamped
    }
    if (auth.toleranceSeconds !== undefined && !timestamped) {
      report({
        code: 'invalid_webhook_auth',
        message: 'A tolerance only applies to signatures with a timestamp',
        ...authAt('toleranceSeconds'),
      })
    }
  }

  if (webhook.bodySchema !== undefined) {
    const size = new TextEncoder().encode(JSON.stringify(webhook.bodySchema)).length
    const error =
      size > MAX_BODY_SCHEMA_BYTES
        ? `The body schema is larger than ${MAX_BODY_SCHEMA_BYTES / 1024} KB`
        : options.checkBodySchema?.(webhook.bodySchema)
    if (error) report({ code: 'invalid_body_schema', message: error, ...at(['bodySchema']) })
  }

  const seen = new Set<string>()
  webhook.environments?.forEach((slug, i) => {
    if (!slug) {
      report({ code: 'invalid_webhook', message: 'Choose an environment', ...at(['environments', i]) })
    } else if (seen.has(slug)) {
      report({ code: 'invalid_webhook', message: `"${slug}" is listed twice`, ...at(['environments', i]) })
    }
    seen.add(slug)
  })

  if (webhook.idempotencyHeader !== undefined && webhook.auth?.type === 'public') {
    report({
      code: 'invalid_webhook',
      message: "A public webhook doesn't use an idempotency header: any caller could replay another's run",
      ...at(['idempotencyHeader']),
    })
  } else if (webhook.idempotencyHeader !== undefined && !isHeaderName(webhook.idempotencyHeader)) {
    report({
      code: 'invalid_webhook',
      message: `"${webhook.idempotencyHeader}" isn't a header name`,
      ...at(['idempotencyHeader']),
    })
  }
}

function checkQuery(
  config: { resource: string; query: Record<string, unknown> },
  base: (string | number)[],
  at: { block: string; function?: string },
  resolve: NonNullable<ValidateOptions['resolveResource']>,
  report: Report,
) {
  const connector = resolve(config.resource)
  if (!connector) {
    report({
      code: 'unknown_resource',
      message: `No resource has the slug "${config.resource}"`,
      path: [...base, 'resource'],
      ...at,
    })
    return
  }
  const query = connector.querySchema.safeParse(config.query)
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
