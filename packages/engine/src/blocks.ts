import { runQuery } from '@ow/connectors'
import type { LogLevel } from '@ow/db'
import { type Block, type BlockOf, calledFunctions, MAX_WAIT_MS, taskOutcomes } from '@ow/definition'
import { type Evaluate, renderJson, renderTemplate, renderText } from '@ow/expressions'
import type { HostFunction } from '@ow/sandbox'
import { childResult, waitForChild } from './children'
import { BlockFailure } from './errors'
import { runLoop } from './loop'
import type {
  BlockResult,
  ChildRuns,
  EngineServices,
  RunInput,
  TaskState,
  UserTasks,
  WaitState,
} from './types'

export interface BlockContext {
  /** Globals plus the results of the blocks this one references. */
  scope: Record<string, unknown>
  input: RunInput
  environmentId: string
  /** See `ExecuteRunOptions.actingUserId`. */
  actingUserId: string | null
  services: EngineServices
  /** Aborted on timeout, run failure or interruption. */
  signal: AbortSignal
  timeoutMs: number
  log: (level: LogLevel, message: string) => void
  /** The run, and this attempt of the block (child runs are keyed by them). */
  runId: string
  attempt: number
  /**
   * Why the block is already waiting, from an earlier execution: a Wait's time (stored, so re-running the block
   * doesn't move it), or the child run a Workflow block waits for.
   */
  waiting?: WaitState
  /** Scrubbed from error messages. */
  secrets: readonly string[]
  /** The workflow's function names (code can call the ones it references). */
  functions: ReadonlySet<string>
  /**
   * Calls a workflow function: named arguments, or positional ones in the order of its parameters. Resolves to
   * the data of its return block; rejects with a BlockFailure when it fails.
   */
  callFunction(name: string, args: Record<string, unknown> | unknown[], signal: AbortSignal): Promise<unknown>
  /** A loop's iterations: those committed by an earlier lease, and where to record new ones. */
  iterations?: LoopIterations
}

/** One piece of work: a block attempt, or a loop iteration (whose scope adds `value` and `index`). */
export interface Work {
  scope: Record<string, unknown>
  signal: AbortSignal
  timeoutMs: number
  log: (level: LogLevel, message: string) => void
}

/** A loop's view of its iteration checkpoints. */
export interface LoopIterations {
  /** Results committed earlier (succeeded or errored), by index. */
  done: ReadonlyMap<number, BlockResult>
  /** Records a finished iteration; buffered and written in batches. */
  record(result: BlockResult): void
  /** Writes everything recorded so far. */
  flush(): Promise<void>
}

export interface BlockOutput {
  data: unknown
  metadata?: Record<string, unknown>
  /** Defaults to `out`. */
  port?: string
  /** The block has to wait instead of finishing: a Wait not due yet, a child run still going. */
  suspend?: Suspension
}

/** Why a block waits, and how often to look again while the run is still in the process. */
export interface Suspension extends WaitState {
  recheckMs?: number
}

type Executor<T extends Block['type']> = (block: BlockOf<T>, ctx: BlockContext) => Promise<BlockOutput>

const executors: { [T in Block['type']]: Executor<T> } = {
  async startTrigger(_block, { input }) {
    return {
      data: input.data ?? null,
      metadata: {
        headers: input.headers ?? {},
        pathParams: input.pathParams ?? {},
        urlParams: input.urlParams ?? {},
      },
    }
  },

  async code(block, ctx) {
    return { data: await runCode(block, block.config.code, ctx, ctx) }
  },

  async resourceQuery(block, ctx) {
    const { data, metadata } = await runResourceQuery(block.config.resource, block.config.query, ctx, ctx)
    return { data, metadata }
  },

  async branch(block, ctx) {
    for (const condition of block.config.conditions) {
      let value: unknown
      try {
        value = await ctx.services.sandbox.evalExpression(condition.expression, ctx.scope, {
          timeoutMs: ctx.timeoutMs,
        })
      } catch (err) {
        throw new BlockFailure('expression', `Condition "${condition.id}" failed: ${(err as Error).message}`)
      }
      if (value) return { data: condition.id, port: `cond:${condition.id}` }
    }
    return { data: null, port: 'else' }
  },

  async filter(block, ctx) {
    const items = await renderTemplate(block.config.input, templateEvaluator(ctx))
    if (!Array.isArray(items)) {
      throw new BlockFailure('invalid_input', `The filter input must be an array, not ${describe(items)}`)
    }
    // One sandbox call for the whole array. The condition was checked to be exactly one expression.
    const data = await ctx.services.sandbox.runCode(
      `return __owItems.filter((value, index) => (\n${block.config.condition}\n))`,
      { ...ctx.scope, __owItems: items },
      { timeoutMs: ctx.timeoutMs },
    )
    return { data, metadata: { inputCount: items.length, outputCount: (data as unknown[]).length } }
  },

  async response(block, ctx) {
    const evaluate = templateEvaluator(ctx)
    const raw = await renderTemplate(block.config.status ?? '200', evaluate)
    const status = typeof raw === 'string' ? Number(raw.trim()) : raw
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new BlockFailure(
        'invalid_response',
        `The status must be an HTTP status code, not ${describe(raw)}`,
      )
    }
    const headers: Record<string, string> = {}
    for (const { key, value } of block.config.headers ?? []) {
      if (key.trim()) headers[key.trim().toLowerCase()] = await renderText(value, evaluate)
    }
    const body = block.config.body?.trim() ? await renderJson(block.config.body, evaluate) : null
    return { data: { status, headers, body } }
  },

  loop: runLoop,

  async function(block, ctx) {
    return { data: await callWorkflowFunction(block.config.function, block.config.params, ctx, ctx) }
  },

  async workflow(block, ctx) {
    const children = requireChildren(ctx)
    const slug = block.config.workflow
    const sync = (block.config.mode ?? 'sync') === 'sync'
    let runId = ctx.waiting?.childRunId
    const since = ctx.waiting?.since ?? new Date()
    if (!runId) {
      runId = await startChild(slug, block.config.input, `${block.name}:${ctx.attempt}`, ctx, ctx)
      if (!sync) return { data: { runId }, metadata: { runId, workflow: slug } }
    }
    // Most children finish quickly: wait here a moment before pausing the run (never past the block's timeout,
    // which also bounds this attempt).
    const deadline = since.getTime() + ctx.timeoutMs
    const inline = Math.min(CHILD_INLINE_WAIT_MS, deadline - Date.now() - CHILD_TIMEOUT_MARGIN_MS)
    const state = await waitForChild(children, runId, Math.max(0, inline), ctx.signal)
    if (state) return childResult(slug, state)
    if (Date.now() >= deadline) {
      await children.cancel(runId).catch(() => {})
      throw new BlockFailure('timeout', `Workflow "${slug}" didn't finish within ${ctx.timeoutMs} ms`, {
        runId,
      })
    }
    // Woken when the child ends; otherwise at the timeout, or an hour from now to look again.
    const until = new Date(Math.min(deadline, Date.now() + CHILD_RECHECK_MS))
    return { data: null, suspend: { until, childRunId: runId, since, recheckMs: CHILD_INLINE_RECHECK_MS } }
  },
  async wait(block, ctx) {
    const until = ctx.waiting?.until ?? (await waitUntil(block, ctx))
    if (until.getTime() > Date.now()) return { data: null, suspend: { until } }
    return { data: null, metadata: { until: until.toISOString() } }
  },
  async userTask(block, ctx) {
    const tasks = ctx.services.tasks
    if (!tasks) throw new BlockFailure('unsupported', "User Tasks can't run here")
    const known = ctx.waiting?.taskId ? await tasks.get(ctx.waiting.taskId) : null
    return taskOutput(known ?? (await openTask(block, tasks, ctx)), tasks)
  },
  // The orchestrator commits the error handler's data itself when the run fails.
  async errorTrigger() {
    throw new BlockFailure('internal', 'The error handler only starts when the run fails')
  },
}

/** A paused run with an open task looks at it again after this long even if nothing woke it. */
const TASK_RECHECK_MS = 60 * 60_000
/** While the run still has other blocks running here, it looks at the task this often. */
const TASK_INLINE_RECHECK_MS = 2000

/** Renders the block's templates and opens its task (or finds the one this run's block opened before). */
async function openTask(block: BlockOf<'userTask'>, tasks: UserTasks, ctx: BlockContext): Promise<TaskState> {
  const { config } = block
  const evaluate = templateEvaluator(ctx)
  const title = (await renderText(config.title, evaluate)).trim()
  if (!title) throw new BlockFailure('invalid_task', 'The task title came out empty')
  const description = config.description?.trim() ? await renderText(config.description, evaluate) : null
  const fields = []
  for (const { default: template, ...field } of config.fields ?? []) {
    fields.push(template?.trim() ? { ...field, default: await renderTemplate(template, evaluate) } : field)
  }
  let dueAt: Date | null = null
  if (config.due) {
    const raw = await renderTemplate(config.due.amount, evaluate)
    const amount = typeof raw === 'string' ? Number(raw.trim()) : raw
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new BlockFailure(
        'invalid_task',
        `The due time must be a number of ${config.due.unit}, not ${describe(raw)}`,
      )
    }
    const ms = amount * WAIT_UNIT_MS[config.due.unit]
    if (ms > MAX_WAIT_MS) throw new BlockFailure('invalid_task', 'A task can be due at most 60 days out')
    dueAt = new Date(Date.now() + ms)
  }
  const workflowId = (ctx.scope.workflowContext as { workflowId?: string } | undefined)?.workflowId
  if (!workflowId) throw new BlockFailure('unsupported', 'User Tasks need the run to belong to a workflow')
  return tasks.open({
    runId: ctx.runId,
    blockKey: block.name,
    workflowId,
    environmentId: ctx.environmentId,
    title,
    description,
    fields,
    outcomes: taskOutcomes(config.outcomes),
    assignees: {
      users: await assigneeList(config.assignees.users, 'users', evaluate),
      groups: await assigneeList(config.assignees.groups, 'groups', evaluate),
    },
    dueAt,
  })
}

/** Each entry is a template for one name or a list of them (`{{ team.data.map(u => u.email) }}`). */
async function assigneeList(
  entries: string[] | undefined,
  what: string,
  evaluate: Evaluate,
): Promise<string[]> {
  const out: string[] = []
  for (const entry of entries ?? []) {
    if (!entry.trim()) continue
    const value = await renderTemplate(entry, evaluate)
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || item === undefined || item === '') continue
      if (typeof item !== 'string') {
        throw new BlockFailure('invalid_task', `Assignee ${what} must be text, not ${describe(item)}`)
      }
      out.push(item.trim())
    }
  }
  return out
}

/** The block's result from its task: the answer, a failure, or a pause until it's answered or due. */
async function taskOutput(task: TaskState, tasks: UserTasks): Promise<BlockOutput> {
  const metadata = { taskId: task.id }
  if (task.status === 'completed') {
    return {
      data: {
        outcome: task.outcome,
        values: task.values ?? {},
        completedBy: task.completedBy,
        completedAt: task.completedAt?.toISOString() ?? null,
      },
      metadata,
    }
  }
  if (task.status === 'cancelled')
    throw new BlockFailure('task_cancelled', 'The task was cancelled', metadata)
  if (task.status === 'expired' || (task.dueAt && task.dueAt.getTime() <= Date.now())) {
    const now = task.status === 'open' ? await tasks.expire(task.id) : task
    // Completed at the last moment, before it could expire.
    if (now?.status === 'completed') return taskOutput(now, tasks)
    throw new BlockFailure(
      'task_expired',
      `Nobody completed the task by ${task.dueAt?.toISOString()}`,
      metadata,
    )
  }
  const until = new Date(
    Math.min(task.dueAt?.getTime() ?? Number.POSITIVE_INFINITY, Date.now() + TASK_RECHECK_MS),
  )
  return { data: null, metadata, suspend: { until, taskId: task.id, recheckMs: TASK_INLINE_RECHECK_MS } }
}

/** How long a sync Workflow block waits for its child in the process before pausing the run. */
const CHILD_INLINE_WAIT_MS = 2000
/** Leaves the attempt time to pause before the block's own timeout fires. */
const CHILD_TIMEOUT_MARGIN_MS = 200
/** A paused parent looks at its child again after this long even if nothing woke it. */
const CHILD_RECHECK_MS = 60 * 60_000
/** While the parent still has other blocks running here, it looks at the child this often. */
const CHILD_INLINE_RECHECK_MS = 2000

function requireChildren(ctx: BlockContext): ChildRuns {
  if (!ctx.services.children) throw new BlockFailure('unsupported', "Child workflows can't run here")
  return ctx.services.children
}

/**
 * Starts a child run (a Workflow block, or a loop's workflow runner) with its input template rendered as JSON. The
 * key makes it idempotent: the same block attempt (or iteration attempt) of the same run starts one child.
 */
export async function startChild(
  workflow: string,
  input: string | undefined,
  key: string,
  work: Work,
  ctx: BlockContext,
): Promise<string> {
  const data = input?.trim() ? await renderJson(input, evaluatorFor(work, ctx)) : null
  return requireChildren(ctx).start({
    workflow,
    input: data,
    key: `child:${ctx.runId}:${key}`,
    parentRunId: ctx.runId,
    environmentId: ctx.environmentId,
  })
}

/** Starts a child and, in sync mode, waits for it within `work`'s signal (a loop iteration's timeout). */
export async function runChild(
  workflow: string,
  input: string | undefined,
  mode: 'sync' | 'async' | undefined,
  key: string,
  work: Work,
  ctx: BlockContext,
): Promise<unknown> {
  const runId = await startChild(workflow, input, key, work, ctx)
  if (mode === 'async') return { runId }
  const children = requireChildren(ctx)
  try {
    const state = await waitForChild(children, runId, Number.POSITIVE_INFINITY, work.signal)
    return childResult(workflow, state!).data
  } catch (err) {
    // Timed out or stopped: don't leave the child running for nobody.
    if (work.signal.aborted) await children.cancel(runId).catch(() => {})
    throw err
  }
}

const WAIT_UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const

/** When a Wait resumes: now plus its duration, or its date and time. At most 60 days ahead. */
async function waitUntil(block: BlockOf<'wait'>, ctx: BlockContext): Promise<Date> {
  const evaluate = templateEvaluator(ctx)
  const { config } = block
  let until: Date
  if (config.kind === 'duration') {
    const raw = await renderTemplate(config.amount, evaluate)
    const amount = typeof raw === 'string' && raw.trim() ? Number(raw) : raw
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new BlockFailure(
        'invalid_wait',
        `The duration must be a number of ${config.unit}, not ${describe(raw)}`,
      )
    }
    until = new Date(Date.now() + amount * WAIT_UNIT_MS[config.unit])
  } else {
    const raw = await renderTemplate(config.until, evaluate)
    until = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : new Date(Number.NaN)
    if (Number.isNaN(until.getTime())) {
      throw new BlockFailure(
        'invalid_wait',
        `The time to resume must be a date and time, not ${describe(raw)}`,
      )
    }
  }
  if (until.getTime() - Date.now() > MAX_WAIT_MS) {
    throw new BlockFailure('invalid_wait', 'A wait can last at most 60 days')
  }
  return until
}

/**
 * Runs code (a code block, or a loop's code runner) in the sandbox with what it may call outside: `fetch`, and the
 * workflow functions it references (`await name(...)`). Host calls are aborted with the work (timeout, run
 * failure, cancel) and once the code finishes, so a request it didn't await doesn't outlive it.
 */
export async function runCode(block: Block, code: string, work: Work, ctx: BlockContext): Promise<unknown> {
  const done = new AbortController()
  const signal = AbortSignal.any([work.signal, done.signal])
  const fetcher = ctx.services.fetcher
  const functions: Record<string, HostFunction> = {}
  for (const name of calledFunctions(block, ctx.functions)) {
    functions[name] = (args) => ctx.callFunction(name, args, signal)
  }
  try {
    return await ctx.services.sandbox.runCode(code, work.scope, {
      timeoutMs: work.timeoutMs,
      onLog: (level, args) => work.log(level, formatLogArgs(args)),
      functions,
      fetch: async (request) => {
        if (!fetcher) throw new Error("fetch isn't available here")
        try {
          return await fetcher.fetch(request, signal)
        } catch (err) {
          // Like fetch's own network errors: a TypeError naming the problem.
          if ((err as Error).name === 'AbortError') throw new TypeError('fetch was aborted')
          throw new TypeError(`fetch failed: ${(err as Error).message}`)
        }
      },
    })
  } finally {
    done.abort()
  }
}

/** Runs a query (a query block, or a loop's query runner) against a resource in the run's environment. */
export async function runResourceQuery(
  slug: string,
  query: Record<string, unknown>,
  work: Work,
  ctx: BlockContext,
): Promise<{ data: unknown; metadata: Record<string, unknown> }> {
  let target: Awaited<ReturnType<EngineServices['resources']['resolve']>>
  try {
    target = await ctx.services.resources.resolve(slug, ctx.environmentId, { actingUserId: ctx.actingUserId })
  } catch (err) {
    if (err instanceof BlockFailure) throw err
    throw new BlockFailure('resource', `Resource "${slug}" is unavailable: ${(err as Error).message}`)
  }
  const workflow = ctx.scope.workflowContext as
    | { workflowId?: string; environment?: string; triggerType?: string }
    | undefined
  const result = await runQuery(ctx.services.pool, target.connector, target.resource, query, {
    evaluate: evaluatorFor(work, ctx),
    signal: work.signal,
    timeoutMs: work.timeoutMs,
    ...(target.credentials && { credentials: target.credentials }),
    labels: {
      ow_source: 'workflow',
      ow_run: ctx.runId,
      ...(workflow?.workflowId && { ow_workflow: workflow.workflowId }),
      ...(workflow?.environment && { ow_environment: workflow.environment }),
      ...(workflow?.triggerType && { ow_trigger: workflow.triggerType }),
    },
  })
  return { data: result.data, metadata: { ...result.metadata, resource: slug } }
}

/** Calls a workflow function with argument templates (a Function block, or a loop's function runner). */
export async function callWorkflowFunction(
  name: string,
  params: Record<string, string> | undefined,
  work: Work,
  ctx: BlockContext,
): Promise<unknown> {
  const evaluate = evaluatorFor(work, ctx)
  const args: Record<string, unknown> = {}
  for (const [param, template] of Object.entries(params ?? {})) {
    args[param] = await renderTemplate(template, evaluate)
  }
  return ctx.callFunction(name, args, work.signal)
}

export function executeBlock(block: Block, ctx: BlockContext): Promise<BlockOutput> {
  return (executors[block.type] as Executor<Block['type']>)(block, ctx)
}

/** Evaluates `{{ }}` in the sandbox; failures name the expression, like resource queries do. */
function templateEvaluator(ctx: BlockContext): Evaluate {
  return evaluatorFor(ctx, ctx)
}

/** Evaluates `{{ }}` against a piece of work's scope (a loop iteration's includes `value` and `index`). */
export function evaluatorFor(work: Work, ctx: BlockContext): Evaluate {
  return async (code) => {
    try {
      return await ctx.services.sandbox.evalExpression(code, work.scope, { timeoutMs: work.timeoutMs })
    } catch (err) {
      throw new BlockFailure('expression', `Error in {{ ${code.trim()} }}: ${(err as Error).message}`)
    }
  }
}

/** `console.log('a', {b: 1})` → `a {"b":1}`. */
export function formatLogArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

export function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`
  return typeof value === 'object' ? 'an object' : String(value)
}
