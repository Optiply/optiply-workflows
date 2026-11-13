import { type AiRunContext, type AiToolHost, ConnectorError, runQuery } from '@ow/connectors'
import type { LogLevel } from '@ow/db'
import {
  type Block,
  type BlockOf,
  calledFunctions,
  type LibraryReference,
  libraryScope,
  MAX_WAIT_MS,
  taskOutcomes,
} from '@ow/definition'
import {
  type Evaluate,
  parseImports,
  renderJson,
  renderTemplate,
  renderText,
  rewriteImports,
  TemplateError,
} from '@ow/expressions'
import { type HostFunction, SandboxError, type SandboxModules } from '@ow/sandbox'
import { aiLogLine } from './ai'
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
  /** See `ExecuteRunOptions.currentUserId` (M21). */
  currentUserId: string | null
  services: EngineServices
  /** Aborted on timeout, run failure or interruption. */
  signal: AbortSignal
  timeoutMs: number
  /** See `Work.ownTimeout`. */
  ownTimeout?: boolean
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
  /** What AI queries get from the run (M35): its token budget. */
  ai?: AiRunContext
}

/** One piece of work: a block attempt, or a loop iteration (whose scope adds `value` and `index`). */
export interface Work {
  scope: Record<string, unknown>
  signal: AbortSignal
  timeoutMs: number
  /**
   * `timeoutMs` is the block's (or iteration's) own setting, not a default: a query then gets all of it, past the
   * resource's statement timeout.
   */
  ownTimeout?: boolean
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
        ...(input.message ? { message: input.message } : {}),
      },
    }
  },

  async code(block, ctx) {
    return { data: await runCode(block, block.config.code, ctx, ctx, block.config.language) }
  },

  async resourceQuery(block, ctx) {
    const { data, metadata } = await runResourceQuery(block.config.resource, block.config.query, ctx, ctx, {
      key: `${block.name}:${ctx.attempt}`,
    })
    return { data, metadata }
  },

  async libraryQuery(block, ctx) {
    return runLibraryQuery(block.config, ctx, ctx)
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
export async function runCode(
  block: Block,
  code: string,
  work: Work,
  ctx: BlockContext,
  language?: 'python',
): Promise<unknown> {
  if (language === 'python') return runPython(code, work, ctx)
  // Import lines (JavaScript packages) become consts reading the bundle, which this code then needs.
  let imports: ReturnType<typeof parseImports>
  try {
    imports = parseImports(code)
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err
    throw new SandboxError('syntax', `SyntaxError: ${err.message}`)
  }
  let modules: SandboxModules | undefined
  if (imports.length) {
    code = rewriteImports(code, imports)
    if (ctx.services.jsModules) modules = await waitForInstall(ctx.services.jsModules(), work, 'JavaScript')
  }
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
      ...(modules && { modules }),
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

/**
 * Runs Python code in the code executor: the same scope as JavaScript's (the blocks it reads, the run's globals,
 * `value`/`index` in a loop, `params` in a function), as JSON; its prints become the block's logs. Aborting the
 * work (timeout, run failure, cancel) hangs up, and the executor kills the jail.
 */
async function runPython(code: string, work: Work, ctx: BlockContext): Promise<unknown> {
  const python = ctx.services.python
  if (!python) {
    throw new BlockFailure('python_unavailable', "Python isn't set up on this instance (PYTHON_EXECUTOR_URL)")
  }
  const envId = ctx.services.pythonEnv
    ? await waitForInstall(ctx.services.pythonEnv(), work, 'Python')
    : undefined
  // As JSON (the client serializes it once; results already are JSON).
  return python.run(code, work.scope, {
    timeoutMs: work.timeoutMs,
    signal: work.signal,
    ...(envId && { envId }),
    onLog: (level, args) => work.log(level, formatLogArgs(args)),
  })
}

/**
 * The run's Python or JavaScript packages, saying so in the block's log when they take a while (a first install): a
 * block timeout then reads in context (the install goes on, for a retry or the next run). Leaves early when the work
 * stops.
 */
function waitForInstall<T>(env: Promise<T>, work: Work, language: 'Python' | 'JavaScript'): Promise<T> {
  if (work.signal.aborted) return Promise.reject(work.signal.reason)
  return new Promise((resolve, reject) => {
    let waiting = false
    const timer = setTimeout(() => {
      waiting = true
      work.log('info', `Waiting for the workflow's ${language} packages to install…`)
    }, ENV_WAIT_LOG_MS)
    const stop = () => reject(work.signal.reason)
    work.signal.addEventListener('abort', stop, { once: true })
    env
      .then((id) => {
        if (waiting) work.log('info', `The workflow's ${language} packages are installed`)
        resolve(id)
      }, reject)
      .finally(() => {
        clearTimeout(timer)
        work.signal.removeEventListener('abort', stop)
      })
  })
}

/** A Python block waiting this long for its packages says so in its log. */
const ENV_WAIT_LOG_MS = 1000

/** Runs a query (a query block, or a loop's query runner) against a resource in the run's environment. */
export async function runResourceQuery(
  slug: string,
  query: Record<string, unknown>,
  work: Work,
  ctx: BlockContext,
  opts: {
    evaluate?: Evaluate
    timeoutMs?: number
    /** Whether `timeoutMs` is the query's own (see `Work.ownTimeout`); default: the work's. */
    ownTimeout?: boolean
    labels?: Record<string, string>
    /** Keys an AI agent's child runs (M35): the block attempt or loop iteration. None: no agent tools. */
    key?: string
  } = {},
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
  let result: Awaited<ReturnType<typeof runQuery>>
  try {
    result = await runQuery(ctx.services.pool, target.connector, target.resource, query, {
      evaluate: opts.evaluate ?? evaluatorFor(work, ctx),
      signal: work.signal,
      timeoutMs: opts.timeoutMs ?? work.timeoutMs,
      ownTimeout: opts.ownTimeout ?? work.ownTimeout ?? false,
      ...(target.credentials && { credentials: target.credentials }),
      ...(ctx.ai && {
        ai: {
          ...ctx.ai,
          ...(opts.key && ctx.services.children && { tools: aiToolHost(work, ctx, opts.key) }),
        },
      }),
      labels: {
        ow_source: 'workflow',
        ow_run: ctx.runId,
        ...(workflow?.workflowId && { ow_workflow: workflow.workflowId }),
        ...(workflow?.environment && { ow_environment: workflow.environment }),
        ...(workflow?.triggerType && { ow_trigger: workflow.triggerType }),
        ...opts.labels,
      },
    })
  } catch (err) {
    // An AI call that answered and then failed (refused, cut off, not matching the schema) still gets its line.
    const line = err instanceof ConnectorError ? aiLogLine(err.details) : null
    if (line) work.log('warn', line)
    throw err
  }
  const line = aiLogLine(result.metadata)
  if (line) work.log('info', line)
  return { data: result.data, metadata: { ...result.metadata, resource: slug } }
}

/**
 * An AI agent's tools (M35): the workflows it names, each call a child run of this run (keyed by the work and the
 * model's call id), waited for within the work's signal. A failed or cancelled child is a failed tool call, not a
 * failed block: the model reads the error and carries on.
 */
function aiToolHost(work: Work, ctx: BlockContext, key: string): AiToolHost {
  const children = requireChildren(ctx)
  return {
    async describe(slugs) {
      const found = children.describe
        ? await children.describe(slugs)
        : slugs.map((slug) => ({ slug, name: slug, description: null, bodySchema: null }))
      return found.map((w) => ({
        name: w.slug,
        description:
          w.description?.trim() || `Runs the workflow "${w.name}". Its result is the workflow's response.`,
        inputSchema:
          w.bodySchema?.type === 'object' ? w.bodySchema : { type: 'object', additionalProperties: true },
      }))
    },
    async run(slug, input, signal, callId) {
      const runId = await children.start({
        workflow: slug,
        input: input ?? null,
        key: `child:${ctx.runId}:${key}:tool:${callId}`,
        parentRunId: ctx.runId,
        environmentId: ctx.environmentId,
      })
      work.log('info', `Agent: calling workflow "${slug}" (run ${runId})`)
      let state: Awaited<ReturnType<typeof waitForChild>>
      try {
        state = await waitForChild(children, runId, Number.POSITIVE_INFINITY, signal)
      } catch (err) {
        if (signal.aborted) await children.cancel(runId).catch(() => {})
        throw err
      }
      if (state?.status === 'succeeded') return { ok: true, data: state.response?.body ?? null, runId }
      work.log('warn', `Agent: workflow "${slug}" (run ${runId}) ${state?.status ?? 'failed'}`)
      return {
        ok: false,
        data: { error: state?.error?.message ?? `The workflow run was ${state?.status ?? 'lost'}` },
        runId,
      }
    },
  }
}

/** What a block attempt looked up for its library queries (M21): releases and the user, by key. */
const attemptCaches = new WeakMap<BlockContext, Map<string, Promise<unknown>>>()

/**
 * Runs a library query (a Library query block, or a loop's library runner; M21): the release's resource and query,
 * resolved now (so `latest` follows the live release on every attempt). The parameters are rendered in the work's
 * scope; the library query's own `{{ }}`s see only them, `current_user` (whoever started the run) and the stdlib.
 */
export async function runLibraryQuery(
  ref: LibraryReference & { params?: Record<string, string> | undefined },
  work: Work,
  ctx: BlockContext,
): Promise<{ data: unknown; metadata: Record<string, unknown> }> {
  const library = ctx.services.library
  if (!library) throw new BlockFailure('library', "Library queries aren't available here")
  // Looked up once per attempt: the release (a loop's iterations share it; a retry resolves `latest` again) and
  // the user.
  const cache = attemptCaches.get(ctx) ?? new Map<string, Promise<unknown>>()
  attemptCaches.set(ctx, cache)
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load())
    return cache.get(key) as Promise<T>
  }
  const { version, definition } = await once(`release:${ref.library}@${ref.version}`, () =>
    library.resolve(ref.library, ref.version),
  )
  const evaluate = evaluatorFor(work, ctx)
  const values: Record<string, unknown> = {}
  for (const [name, template] of Object.entries(ref.params ?? {})) {
    try {
      values[name] = (await renderTemplate(template, evaluate)) ?? null
    } catch (err) {
      if (err instanceof BlockFailure) {
        throw new BlockFailure(err.code, `Parameter ${name}: ${err.message}`)
      }
      throw err
    }
  }
  const userId = ctx.currentUserId
  const user = userId ? await once(`user:${userId}`, () => library.user(userId)) : null
  const scope = libraryScope(definition, values, user)
  const evaluateLibrary: Evaluate = async (code) => {
    try {
      return await ctx.services.sandbox.evalExpression(code, scope, { timeoutMs: work.timeoutMs })
    } catch (err) {
      throw new BlockFailure(
        'expression',
        `Error in {{ ${code.trim()} }} of library query "${ref.library}": ${(err as Error).message}`,
      )
    }
  }
  const { data, metadata } = await runResourceQuery(definition.resource, definition.query, work, ctx, {
    evaluate: evaluateLibrary,
    timeoutMs: Math.min(work.timeoutMs, definition.timeoutMs ?? work.timeoutMs),
    ownTimeout: work.ownTimeout === true || definition.timeoutMs !== undefined,
    labels: { ow_library: ref.library },
  })
  return { data, metadata: { ...metadata, library: { slug: ref.library, version } } }
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
