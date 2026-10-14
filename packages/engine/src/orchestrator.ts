import { scrubSecrets } from '@ow/crypto'
import { type LogLevel, MAX_PAYLOAD_BYTES } from '@ow/db'
import {
  type Block,
  buildGraph,
  referencedNames,
  resolveBlockSettings,
  validateDefinition,
  type WorkflowDefinition,
  type WorkflowGraph,
} from '@ow/definition'
import { type BlockContext, type BlockOutput, executeBlock } from './blocks'
import { BlockFailure, RunCancelledError, toEngineError } from './errors'
import { retryDelayMs, sleep } from './retry'
import type { BlockResult, EngineError, ExecuteRunOptions, RunOutcome, RunResponse } from './types'

const DEFAULT_CONCURRENCY = 10
/** Checkpointed statuses a resumed run treats as done. */
const RESUMABLE = new Set(['succeeded', 'errored', 'skipped'])
/** Waits due sooner than this finish in the process; later ones pause the run. */
const DEFAULT_SUSPEND_AFTER_MS = 1000
/** The error handler's own time limit: it runs after the run failed, perhaps because the run timed out. */
const DEFAULT_HANDLER_TIMEOUT_MS = 60_000
/** setTimeout's limit; a longer wait just wakes early and waits again. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Runs a workflow definition to completion (or interruption), following the semantics in architecture §2.2:
 *
 * - A block is ready once every incoming edge is resolved. It runs if at least one fired; if none did it is
 *   `skipped`, which resolves its own edges as dead (dead-path elimination), so a join after an if/else runs.
 * - An edge fires when its source finished on that port: `out` on success, `cond:<id>`/`else` for the branch
 *   taken, `error` when a block with `finally: continue` failed.
 * - A failure with `finally: stop` fails the run: in-flight blocks are aborted and recorded as `cancelled`, and
 *   nothing else on the main path starts. If the workflow has an error handler, its path runs next (reading the
 *   failure as `<handler>.data`); the run still fails.
 * - A Wait records when it resumes and the run goes on with whatever else can run. Once only Waits are left the
 *   run pauses (`waiting`) until the earliest is due, unless that's under a second away.
 * - Aborting `signal` with a `RunCancelledError` cancels the run; any other abort interrupts it for a later lease.
 * - The first Response block to finish is the run's reply; execution continues and later ones are `ignored`.
 * - Each block's result is committed through the store before its children can start, so a resumed run
 *   (`checkpoints`) skips everything already committed: blocks execute at least once, results commit once.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<RunOutcome> {
  const validation = validateDefinition(opts.definition)
  if (!validation.ok) {
    const errors = validation.diagnostics.filter((d) => d.severity === 'error')
    return {
      status: 'failed',
      error: {
        code: 'invalid_definition',
        message: `The workflow isn't valid: ${errors[0]!.message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`,
        details: { diagnostics: errors },
      },
      response: null,
      results: new Map(),
    }
  }
  return new RunExecution(opts, validation.definition!).run()
}

type Phase = 'main' | 'handler'

class RunExecution {
  private readonly graph: WorkflowGraph
  /** The error handler block, if the workflow has one, and every block on its path. */
  private readonly handler: string | undefined
  private readonly handlerPath = new Set<string>()
  /** The blocks the current phase covers: the main path (or the `only` targets plus their ancestors), then the handler's. */
  private scope: Set<string>
  private phase: Phase = 'main'
  /** Aborts the blocks of the current phase: on failure, cancel or interruption. */
  private phaseAbort = new AbortController()
  /** The current phase is stopping (a failure is being recorded); later failures in it are ignored. */
  private stopping = false
  /** Why the run failed, once it has (the handler phase reports it at the end). */
  private failure: (EngineError & { block?: string }) | null = null
  private readonly results = new Map<string, BlockResult>()
  /** Blocks in their attempts. */
  private readonly executing = new Set<string>()
  /** Blocks whose result (or waiting state) is being written. */
  private readonly committing = new Set<string>()
  private readonly ready: string[] = []
  private readonly queued = new Set<string>()
  private readonly startedAt = new Map<string, Date>()
  private readonly references = new Map<string, Set<string>>()
  /** When each Wait that has started waiting resumes. */
  private readonly waitUntil = new Map<string, Date>()
  /** Waits that are waiting now, with the attempt that started them, and their wake-up timers. */
  private readonly parked = new Map<string, { until: Date; attempt: number; timer: NodeJS.Timeout }>()
  private readonly maxConcurrency: number
  private readonly secrets: readonly string[]
  private readonly suspendAfterMs: number
  private responded: boolean
  private response: RunResponse | null = null
  private done = false
  private resolveOutcome!: (outcome: RunOutcome) => void
  private deadlineTimer: NodeJS.Timeout | undefined
  private readonly onExternalAbort = () => this.externalAbort()

  constructor(
    private readonly opts: ExecuteRunOptions,
    definition: WorkflowDefinition,
  ) {
    this.graph = buildGraph(definition)
    this.handler = definition.blocks.find((b) => b.type === 'errorTrigger')?.name
    if (this.handler) {
      this.handlerPath.add(this.handler)
      for (const name of this.graph.descendants(this.handler)) this.handlerPath.add(name)
    }
    this.scope = opts.only
      ? new Set(opts.only.flatMap((name) => [name, ...this.graph.ancestors(name)]))
      : new Set([...this.graph.blocks.keys()].filter((name) => !this.handlerPath.has(name)))
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_CONCURRENCY
    this.secrets = opts.secrets ?? []
    this.suspendAfterMs = opts.suspendAfterMs ?? DEFAULT_SUSPEND_AFTER_MS
    this.responded = opts.responded ?? false
    for (const [name, until] of opts.waits ?? []) this.waitUntil.set(name, until)
  }

  run(): Promise<RunOutcome> {
    return new Promise((resolve) => {
      this.resolveOutcome = resolve
      let failed: BlockResult | undefined
      for (const checkpoint of this.opts.checkpoints ?? []) {
        if (!this.graph.blocks.has(checkpoint.key)) continue
        if (checkpoint.status === 'failed') {
          this.results.set(checkpoint.key, checkpoint)
          failed ??= checkpoint
        }
        if (RESUMABLE.has(checkpoint.status)) this.results.set(checkpoint.key, checkpoint)
      }

      const unknown = this.opts.only?.filter((name) => !this.graph.blocks.has(name)) ?? []
      if (unknown.length) {
        return this.settle('failed', {
          code: 'invalid_target',
          message: `No block is named ${unknown.map((n) => `"${n}"`).join(', ')}`,
        })
      }

      const { signal, deadline } = this.opts
      if (signal?.aborted) return this.externalAbort()
      signal?.addEventListener('abort', this.onExternalAbort, { once: true })

      // An earlier lease recorded the failure; carry on with the error handler, or end there.
      if (failed) return void this.afterFailure({ ...failed.error!, block: failed.key }, failed)

      if (deadline) {
        const ms = deadline.getTime() - Date.now()
        if (ms <= 0) return void this.stop({ code: 'run_timeout', message: 'The run timed out' })
        this.deadlineTimer = setTimeout(
          () => void this.stop({ code: 'run_timeout', message: 'The run timed out' }),
          ms,
        )
      }
      this.pump()
    })
  }

  /** Starts every block that can start, skips every block that can't run any more, and ends the phase when idle. */
  private pump() {
    if (this.done || this.stopping) return
    for (const name of this.graph.order!) {
      if (!this.scope.has(name)) continue
      if (this.results.has(name) || this.executing.has(name) || this.committing.has(name)) continue
      if (this.queued.has(name) || this.parked.has(name)) continue
      const incoming = this.graph.incoming.get(name)!
      if (!incoming.every((edge) => this.results.has(edge.from))) continue
      const block = this.graph.blocks.get(name)!
      const fired =
        block.type === 'startTrigger' ||
        incoming.some((edge) => this.results.get(edge.from)!.port === edge.port)
      if (fired) {
        this.queued.add(name)
        this.ready.push(name)
      } else {
        this.track(this.skip(name))
      }
    }
    while (this.ready.length && this.executing.size < this.maxConcurrency) {
      const name = this.ready.shift()!
      this.queued.delete(name)
      this.track(this.execute(this.graph.blocks.get(name)!))
    }
    if (this.executing.size || this.committing.size || this.ready.length) return

    if (this.parked.size) {
      // Only waits are left. Pause the run unless the earliest is due very soon (its timer finishes it here).
      const resumeAt = new Date(Math.min(...[...this.parked.values()].map((p) => p.until.getTime())))
      if (resumeAt.getTime() - Date.now() > this.suspendAfterMs) this.settle('waiting', null, resumeAt)
      return
    }
    if (![...this.scope].every((name) => this.results.has(name))) {
      this.settle('failed', { code: 'internal', message: 'The run stopped with blocks left unresolved' })
    } else if (this.phase === 'handler') {
      this.settle('failed', this.failure)
    } else {
      this.settle('succeeded', null)
    }
  }

  private async execute(block: Block) {
    this.executing.add(block.name)
    const signal = this.phaseAbort.signal
    let outcome: BlockResult | { suspendUntil: Date; attempt: number }
    try {
      outcome = await this.attempts(block, signal)
    } catch (err) {
      if (this.done || signal.aborted) return this.leftPhase(block.name)
      throw err
    } finally {
      this.executing.delete(block.name)
    }
    if (this.done || signal.aborted) return this.leftPhase(block.name)
    if ('suspendUntil' in outcome) return this.park(block.name, outcome.suspendUntil, outcome.attempt)

    const result = outcome
    if (result.status === 'failed') return this.stop(result.error!, result)
    this.waitUntil.delete(block.name)

    let extra: { response?: RunResponse } | undefined
    if (block.type === 'response' && result.status === 'succeeded') {
      if (this.responded) {
        result.metadata = { ...result.metadata, ignored: true }
      } else {
        this.responded = true
        this.response = result.data as RunResponse
        result.metadata = { ...result.metadata, sent: true }
        extra = { response: this.response }
      }
    }
    await this.commit(result, extra)
  }

  /**
   * A block of a phase that stopped finished its attempt anyway (or was aborted): whatever stopped the phase records
   * it. The next phase may be waiting for it to leave `executing`.
   */
  private leftPhase(name: string) {
    this.executing.delete(name)
    if (!this.done) this.pump()
  }

  /** A Wait that isn't due: record it as waiting, and wake it in the process when it's due (if still here). */
  private async park(name: string, until: Date, attempt: number) {
    this.committing.add(name)
    try {
      await this.opts.store.blockWaiting(name, attempt, until)
    } finally {
      this.committing.delete(name)
    }
    if (this.done) return
    this.waitUntil.set(name, until)
    const timer = setTimeout(
      () => {
        if (this.done || this.parked.get(name)?.timer !== timer) return
        this.parked.delete(name)
        this.pump()
      },
      Math.min(Math.max(0, until.getTime() - Date.now()), MAX_TIMER_MS),
    )
    this.parked.set(name, { until, attempt, timer })
    this.pump()
  }

  private async skip(name: string) {
    await this.commit({
      key: name,
      status: 'skipped',
      data: null,
      sizeBytes: 0,
      error: null,
      metadata: {},
      port: null,
      attempt: 1,
      startedAt: null,
      finishedAt: new Date(),
    })
  }

  private async commit(result: BlockResult, extra?: { response?: RunResponse }) {
    this.committing.add(result.key)
    try {
      await this.opts.store.blockFinished(result, extra)
    } finally {
      this.committing.delete(result.key)
    }
    if (this.done) return
    this.results.set(result.key, result)
    this.pump()
  }

  /**
   * Runs a block with retries. Returns its final result, or when a Wait isn't due yet; throws only when the
   * phase is ending.
   */
  private async attempts(
    block: Block,
    signal: AbortSignal,
  ): Promise<BlockResult | { suspendUntil: Date; attempt: number }> {
    const settings = resolveBlockSettings(block)
    const startedAt = new Date()
    this.startedAt.set(block.name, startedAt)
    const resuming = this.waitUntil.has(block.name)
    for (let attempt = 1; ; attempt++) {
      // A Wait resuming is already shown as waiting; it just finishes now.
      if (!resuming)
        await this.opts.store.blockStarted(block.name, attempt, attempt === 1 ? startedAt : new Date())
      try {
        const output = await this.attempt(block, settings.timeoutMs, signal)
        if (output.suspendUntil) return { suspendUntil: output.suspendUntil, attempt }
        const { data, sizeBytes } = toJsonData(output.data)
        return {
          key: block.name,
          status: 'succeeded',
          data,
          sizeBytes,
          error: null,
          metadata: output.metadata ?? {},
          port: output.port ?? 'out',
          attempt,
          startedAt,
          finishedAt: new Date(),
        }
      } catch (err) {
        if (signal.aborted) throw err
        const error = toEngineError(err, this.secrets)
        if (attempt > settings.retry.count) {
          const status = settings.finally === 'continue' ? 'errored' : 'failed'
          return {
            key: block.name,
            status,
            data: null,
            sizeBytes: 0,
            error,
            metadata: {},
            port: status === 'errored' ? 'error' : null,
            attempt,
            startedAt,
            finishedAt: new Date(),
          }
        }
        const delay = retryDelayMs(settings.retry, attempt)
        this.log(block.name, 'warn', `Attempt ${attempt} failed: ${error.message}. Retrying in ${delay} ms.`)
        await sleep(delay, signal)
      }
    }
  }

  /** One attempt, bounded by the block's timeout and aborted with the phase. */
  private async attempt(block: Block, timeoutMs: number, phaseSignal: AbortSignal): Promise<BlockOutput> {
    const timeout = new AbortController()
    const ctx: BlockContext = {
      scope: this.scopeFor(block),
      input: this.opts.input,
      environmentId: this.opts.environmentId,
      services: this.opts.services,
      signal: AbortSignal.any([phaseSignal, timeout.signal]),
      timeoutMs,
      log: (level, message) => this.log(block.name, level, message),
      waitingUntil: this.waitUntil.get(block.name),
    }
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    const work = executeBlock(block, ctx)
    work.catch(() => {}) // It may lose the race below.
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new BlockFailure('timeout', `The block timed out after ${timeoutMs} ms`))
            timeout.abort()
          }, timeoutMs)
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(phaseSignal.reason)
          if (phaseSignal.aborted) onAbort()
          else phaseSignal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) phaseSignal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Globals plus the results of the blocks this block's code references. The error handler's blocks may read
   * main-path blocks that never finished: those read as skipped.
   */
  private scopeFor(block: Block): Record<string, unknown> {
    let names = this.references.get(block.name)
    if (!names) {
      names = referencedNames(block)
      this.references.set(block.name, names)
    }
    const scope: Record<string, unknown> = { ...this.opts.globals }
    for (const name of names) {
      const result = this.results.get(name)
      if (result) scope[name] = scopeView(this.graph.blocks.get(name)!, result)
      else if (this.handlerPath.has(block.name) && this.graph.blocks.has(name)) {
        scope[name] = { data: null, error: null, metadata: { status: 'skipped' } }
      }
    }
    return scope
  }

  /**
   * Ends the current phase because of `error`: aborts its in-flight blocks and records them (and any waiting ones)
   * as cancelled, then runs the error handler if there is one, or fails the run.
   */
  private async stop(error: EngineError, failed?: BlockResult) {
    if (this.done || this.stopping) return
    this.stopping = true
    clearTimeout(this.deadlineTimer)
    this.phaseAbort.abort()
    const why = failed ? `"${failed.key}" failed` : error.message
    try {
      await this.recordCancelled(`Stopped because ${why.charAt(0).toLowerCase()}${why.slice(1)}`, failed)
    } catch (err) {
      return this.finishInterrupted(err)
    }
    await this.afterFailure({ ...error, ...(failed && { block: failed.key }) }, failed)
  }

  /** The main path failed: start the error handler's path, or fail the run. A failing handler fails the run too. */
  private async afterFailure(error: EngineError & { block?: string }, failed?: BlockResult) {
    if (this.phase === 'handler' || !this.handler) {
      return this.settle('failed', this.failure ?? error)
    }
    this.failure = error
    this.phase = 'handler'
    this.phaseAbort = new AbortController()
    this.stopping = false
    this.scope = this.handlerPath
    this.deadlineTimer = setTimeout(
      () => void this.stop({ code: 'handler_timeout', message: 'The error handler timed out' }),
      this.opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    )
    if (this.results.has(this.handler)) return this.pump() // Resumed: the handler had already started.
    const now = new Date()
    const data = { block: failed?.key ?? null, code: error.code, message: error.message }
    await this.track(
      this.commit({
        key: this.handler,
        status: 'succeeded',
        data,
        sizeBytes: JSON.stringify(data).length,
        error: null,
        metadata: {},
        port: 'out',
        attempt: 1,
        startedAt: now,
        finishedAt: now,
      }),
    )
  }

  /** Records the phase's in-flight and waiting blocks as cancelled (after `failed`, when a block failed). */
  private async recordCancelled(message: string, failed?: BlockResult) {
    for (const { timer } of this.parked.values()) clearTimeout(timer)
    const now = new Date()
    const cancelled = [...this.executing, ...this.parked.keys()].map(
      (key): BlockResult => ({
        key,
        status: 'cancelled',
        data: null,
        sizeBytes: 0,
        error: { code: 'cancelled', message },
        metadata: {},
        port: null,
        attempt: this.parked.get(key)?.attempt ?? 1,
        startedAt: this.startedAt.get(key) ?? null,
        finishedAt: now,
      }),
    )
    this.parked.clear()
    for (const result of failed ? [failed, ...cancelled] : cancelled) {
      await this.opts.store.blockFinished(result)
      this.results.set(result.key, result)
    }
  }

  /** The run's signal aborted: cancel it (a `RunCancelledError`), or interrupt it for a later lease. */
  private externalAbort() {
    const reason: unknown = this.opts.signal?.reason
    if (reason instanceof RunCancelledError) void this.cancel(reason)
    else this.interrupt(null)
  }

  /** Cancels the run: in-flight and waiting blocks are recorded as cancelled, and the error handler doesn't run. */
  private async cancel(reason: RunCancelledError) {
    if (this.done) return
    this.done = true
    clearTimeout(this.deadlineTimer)
    this.phaseAbort.abort(reason)
    try {
      await this.recordCancelled(reason.message)
    } catch (err) {
      return this.finishInterrupted(err)
    }
    this.settle('cancelled', { code: 'cancelled', message: reason.message })
  }

  /** Stops without finishing the run; the next lease resumes from the committed checkpoints. */
  private interrupt(err: unknown) {
    if (this.done) return
    this.done = true
    this.phaseAbort.abort()
    this.finishInterrupted(err)
  }

  private finishInterrupted(err: unknown) {
    this.settle('interrupted', err === null ? null : toEngineError(err, this.secrets))
  }

  /** Unexpected failures (store errors, lease lost) interrupt the run instead of failing it. */
  private track(work: Promise<void>): Promise<void> {
    return work.catch((err) => this.interrupt(err))
  }

  private settle(status: RunOutcome['status'], error: RunOutcome['error'], resumeAt?: Date) {
    this.done = true
    clearTimeout(this.deadlineTimer)
    for (const { timer } of this.parked.values()) clearTimeout(timer)
    this.opts.signal?.removeEventListener('abort', this.onExternalAbort)
    this.resolveOutcome({
      status,
      error,
      response: this.response,
      results: this.results,
      ...(resumeAt && { resumeAt }),
    })
  }

  private log(blockKey: string | null, level: LogLevel, message: string) {
    try {
      this.opts.store.log({ blockKey, level, message: scrubSecrets(message, this.secrets) })
    } catch {
      // Logs are best effort.
    }
  }
}

/** What `{{ name }}` evaluates to. A skipped block reads as `{ data: null, error: null, metadata: { status } }`. */
function scopeView(block: Block, result: BlockResult): Record<string, unknown> {
  const view = {
    data: result.data,
    error: result.error,
    metadata: { ...result.metadata, status: result.status },
  }
  if (block.type !== 'startTrigger') return view
  const { headers = {}, pathParams = {}, urlParams = {} } = result.metadata
  return { ...view, headers, pathParams, urlParams }
}

/** Block data is plain JSON (dates become strings), so a resumed run reads exactly what a fresh one did. */
function toJsonData(value: unknown): { data: unknown; sizeBytes: number } {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (err) {
    throw new BlockFailure('serialization', `The result isn't JSON-serializable: ${(err as Error).message}`)
  }
  if (text === undefined) return { data: null, sizeBytes: 4 }
  const sizeBytes = Buffer.byteLength(text)
  if (sizeBytes > MAX_PAYLOAD_BYTES) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1)
    throw new BlockFailure('too_large', `The result is ${mb} MB; blocks can return at most 10 MB`)
  }
  return { data: JSON.parse(text), sizeBytes }
}
