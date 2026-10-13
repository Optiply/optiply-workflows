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
import { BlockFailure, toEngineError } from './errors'
import { retryDelayMs, sleep } from './retry'
import type { BlockResult, EngineError, ExecuteRunOptions, RunOutcome, RunResponse } from './types'

const DEFAULT_CONCURRENCY = 10
/** Checkpointed statuses a resumed run treats as done. */
const RESUMABLE = new Set(['succeeded', 'errored', 'skipped'])

/**
 * Runs a workflow definition to completion (or interruption), following the semantics in architecture §2.2:
 *
 * - A block is ready once every incoming edge is resolved. It runs if at least one fired; if none did it is
 *   `skipped`, which resolves its own edges as dead (dead-path elimination), so a join after an if/else runs.
 * - An edge fires when its source finished on that port: `out` on success, `cond:<id>`/`else` for the branch
 *   taken, `error` when a block with `finally: continue` failed.
 * - A failure with `finally: stop` fails the run: in-flight blocks are aborted and recorded as `cancelled`, and
 *   nothing else starts.
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

class RunExecution {
  private readonly graph: WorkflowGraph
  private readonly results = new Map<string, BlockResult>()
  /** Blocks in their attempts (aborted through `runAbort`). */
  private readonly executing = new Set<string>()
  /** Blocks whose result is being written. */
  private readonly committing = new Set<string>()
  private readonly ready: string[] = []
  private readonly queued = new Set<string>()
  private readonly startedAt = new Map<string, Date>()
  private readonly references = new Map<string, Set<string>>()
  private readonly runAbort = new AbortController()
  private readonly maxConcurrency: number
  private readonly secrets: readonly string[]
  private responded: boolean
  private response: RunResponse | null = null
  private done = false
  private resolveOutcome!: (outcome: RunOutcome) => void
  private deadlineTimer: NodeJS.Timeout | undefined
  private readonly onExternalAbort = () => this.interrupt(null)

  constructor(
    private readonly opts: ExecuteRunOptions,
    definition: WorkflowDefinition,
  ) {
    this.graph = buildGraph(definition)
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_CONCURRENCY
    this.secrets = opts.secrets ?? []
    this.responded = opts.responded ?? false
  }

  run(): Promise<RunOutcome> {
    return new Promise((resolve) => {
      this.resolveOutcome = resolve
      for (const checkpoint of this.opts.checkpoints ?? []) {
        if (!this.graph.blocks.has(checkpoint.key)) continue
        if (checkpoint.status === 'failed') {
          this.results.set(checkpoint.key, checkpoint)
          return this.settle('failed', { ...checkpoint.error!, block: checkpoint.key })
        }
        if (RESUMABLE.has(checkpoint.status)) this.results.set(checkpoint.key, checkpoint)
      }

      const { signal, deadline } = this.opts
      if (signal?.aborted) return this.interrupt(null)
      signal?.addEventListener('abort', this.onExternalAbort, { once: true })
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

  /** Starts every block that can start and skips every block that can't run any more. */
  private pump() {
    if (this.done) return
    for (const name of this.graph.order!) {
      if (this.results.has(name) || this.executing.has(name) || this.committing.has(name)) continue
      if (this.queued.has(name)) continue
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
    if (!this.executing.size && !this.committing.size && !this.ready.length) {
      if (this.results.size === this.graph.blocks.size) this.settle('succeeded', null)
      else this.settle('failed', { code: 'internal', message: 'The run stopped with blocks left unresolved' })
    }
  }

  private async execute(block: Block) {
    this.executing.add(block.name)
    let result: BlockResult
    try {
      result = await this.attempts(block, this.runAbort.signal)
    } catch (err) {
      if (this.done) return
      throw err
    } finally {
      this.executing.delete(block.name)
    }
    if (this.done) return
    if (result.status === 'failed') return this.stop(result.error!, result)

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

  /** Runs a block with retries. Returns its final result; throws only when the run is ending. */
  private async attempts(block: Block, signal: AbortSignal): Promise<BlockResult> {
    const settings = resolveBlockSettings(block)
    const startedAt = new Date()
    this.startedAt.set(block.name, startedAt)
    for (let attempt = 1; ; attempt++) {
      await this.opts.store.blockStarted(block.name, attempt, attempt === 1 ? startedAt : new Date())
      try {
        const output = await this.attempt(block, settings.timeoutMs, signal)
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

  /** One attempt, bounded by the block's timeout and aborted with the run. */
  private async attempt(block: Block, timeoutMs: number, runSignal: AbortSignal): Promise<BlockOutput> {
    const timeout = new AbortController()
    const ctx: BlockContext = {
      scope: this.scopeFor(block),
      input: this.opts.input,
      environmentId: this.opts.environmentId,
      services: this.opts.services,
      signal: AbortSignal.any([runSignal, timeout.signal]),
      timeoutMs,
      log: (level, message) => this.log(block.name, level, message),
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
          onAbort = () => reject(runSignal.reason)
          if (runSignal.aborted) onAbort()
          else runSignal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) runSignal.removeEventListener('abort', onAbort)
    }
  }

  /** Globals plus the results of the blocks this block's code references. */
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
    }
    return scope
  }

  /** Fails the run: in-flight blocks are aborted and recorded as cancelled. */
  private async stop(error: EngineError, failed?: BlockResult) {
    if (this.done) return
    this.done = true
    this.runAbort.abort()
    const why = failed ? `"${failed.key}" failed` : error.message
    const cancelled = [...this.executing].map(
      (key): BlockResult => ({
        key,
        status: 'cancelled',
        data: null,
        sizeBytes: 0,
        error: {
          code: 'cancelled',
          message: `Stopped because ${why.charAt(0).toLowerCase()}${why.slice(1)}`,
        },
        metadata: {},
        port: null,
        attempt: 1,
        startedAt: this.startedAt.get(key) ?? null,
        finishedAt: new Date(),
      }),
    )
    try {
      for (const result of failed ? [failed, ...cancelled] : cancelled) {
        await this.opts.store.blockFinished(result)
        this.results.set(result.key, result)
      }
    } catch (err) {
      return this.finishInterrupted(err)
    }
    this.settle('failed', { ...error, ...(failed && { block: failed.key }) })
  }

  /** Stops without finishing the run; the next lease resumes from the committed checkpoints. */
  private interrupt(err: unknown) {
    if (this.done) return
    this.done = true
    this.runAbort.abort()
    this.finishInterrupted(err)
  }

  private finishInterrupted(err: unknown) {
    this.settle('interrupted', err === null ? null : toEngineError(err, this.secrets))
  }

  /** Unexpected failures (store errors, lease lost) interrupt the run instead of failing it. */
  private track(work: Promise<void>) {
    work.catch((err) => this.interrupt(err))
  }

  private settle(status: RunOutcome['status'], error: RunOutcome['error']) {
    this.done = true
    clearTimeout(this.deadlineTimer)
    this.opts.signal?.removeEventListener('abort', this.onExternalAbort)
    this.resolveOutcome({ status, error, response: this.response, results: this.results })
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
