import {
  type BlockOf,
  DEFAULT_LOOP_BATCH_SIZE,
  DEFAULT_LOOP_CONCURRENCY,
  MAX_LOOP_ITERATIONS,
  resolveIterationSettings,
} from '@ow/definition'
import { renderTemplate } from '@ow/expressions'
import {
  type BlockContext,
  type BlockOutput,
  callWorkflowFunction,
  describe,
  evaluatorFor,
  type LoopIterations,
  runChild,
  runCode,
  runResourceQuery,
  type Work,
} from './blocks'
import { BlockFailure, toEngineError } from './errors'
import { toJsonData } from './results'
import { retryDelayMs, sleep } from './retry'
import type { BlockResult, EngineError } from './types'

/** Failed iterations listed in the loop's metadata; the rest are in their own rows. */
const MAX_LISTED_FAILURES = 100

type LoopBlock = BlockOf<'loop'>

/**
 * Runs a loop block: its runner once per item of the input array, as `value` and `index`, `parallel` (up to
 * `concurrency` at once), `sequential`, or in batches (`batchSize` at once, `batchDelayMs` apart). Each iteration has
 * its own timeout and retries, and is checkpointed as `<loop>[<index>]` when it finishes, so a resumed run only runs
 * the iterations that weren't committed. The data is an array in input order. A failed iteration fails the loop
 * (`onError: stop`, the others are aborted) or leaves `null` in its slot (`continue`).
 */
export async function runLoop(block: LoopBlock, ctx: BlockContext): Promise<BlockOutput> {
  const items = await renderTemplate(block.config.input, evaluatorFor(ctx, ctx))
  if (!Array.isArray(items)) {
    throw new BlockFailure('invalid_input', `The loop input must be an array, not ${describe(items)}`)
  }
  if (items.length > MAX_LOOP_ITERATIONS) {
    throw new BlockFailure(
      'too_many_iterations',
      `The input has ${items.length} items; a loop runs at most ${MAX_LOOP_ITERATIONS}`,
    )
  }
  const iterations = ctx.iterations ?? inMemoryIterations()
  const onError = block.config.onError ?? 'stop'

  const data: unknown[] = new Array(items.length).fill(null)
  const failures: { index: number; error: EngineError }[] = []
  let resumed = 0
  const todo: number[] = []
  for (let i = 0; i < items.length; i++) {
    const done = iterations.done.get(i)
    if (!done) {
      todo.push(i)
      continue
    }
    resumed++
    if (done.status === 'succeeded') data[i] = done.data
    else failures.push({ index: i, error: done.error! })
  }

  // Aborted when an iteration fails the loop, to stop the others.
  const stopLoop = new AbortController()
  const signal = AbortSignal.any([ctx.signal, stopLoop.signal])
  let failed: { index: number; error: EngineError } | undefined
  const runOne = async (index: number) => {
    let result: BlockResult
    try {
      result = await iteration(block, ctx, items[index], index, signal)
    } catch (err) {
      // Stopped because another iteration failed the loop: that failure is reported.
      if (stopLoop.signal.aborted && !ctx.signal.aborted) return
      throw err
    }
    if (result.status === 'succeeded') {
      data[index] = result.data
    } else if (onError === 'continue') {
      result = { ...result, status: 'errored', port: 'error' }
      failures.push({ index, error: result.error! })
    } else {
      failed ??= { index, error: result.error! }
      stopLoop.abort()
    }
    iterations.record(result)
  }

  const mode = block.config.mode ?? 'parallel'
  if (mode === 'batch') {
    const size = block.config.batchSize ?? DEFAULT_LOOP_BATCH_SIZE
    for (let start = 0; start < todo.length && !signal.aborted; start += size) {
      if (start > 0 && block.config.batchDelayMs) {
        await sleep(block.config.batchDelayMs, signal).catch((err) => {
          if (!stopLoop.signal.aborted) throw err
        })
      }
      if (signal.aborted) break
      await Promise.all(todo.slice(start, start + size).map(runOne))
    }
  } else {
    const concurrency = mode === 'sequential' ? 1 : (block.config.concurrency ?? DEFAULT_LOOP_CONCURRENCY)
    let next = 0
    const worker = async () => {
      while (next < todo.length && !signal.aborted) await runOne(todo[next++]!)
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  }
  ctx.signal.throwIfAborted()
  await iterations.flush()

  if (failed) {
    throw new BlockFailure('iteration_failed', `Iteration ${failed.index} failed: ${failed.error.message}`, {
      index: failed.index,
      error: failed.error,
    })
  }
  failures.sort((a, b) => a.index - b.index)
  return {
    data,
    metadata: {
      iterations: {
        total: items.length,
        succeeded: items.length - failures.length,
        failed: failures.length,
        resumed,
      },
      ...(failures.length && { failures: failures.slice(0, MAX_LISTED_FAILURES) }),
    },
  }
}

/**
 * One iteration with its retries: the runner's result as `succeeded`, or `failed` with the last error. Throws only
 * when `signal` aborts (the loop stopping, the block timing out, the run ending).
 */
async function iteration(
  block: LoopBlock,
  ctx: BlockContext,
  value: unknown,
  index: number,
  signal: AbortSignal,
): Promise<BlockResult> {
  const settings = resolveIterationSettings(block)
  const key = `${block.name}[${index}]`
  const startedAt = new Date()
  const scope = { ...ctx.scope, value, index }
  const log: Work['log'] = (level, message) => ctx.log(level, `[${index}] ${message}`)
  for (let attempt = 1; ; attempt++) {
    try {
      const output = await withTimeout(settings.timeoutMs, signal, (timeoutSignal) =>
        runner(
          block,
          ctx,
          { scope, signal: timeoutSignal, timeoutMs: settings.timeoutMs, log },
          `${key}:${attempt}`,
        ),
      )
      const { data, sizeBytes } = toJsonData(output)
      return {
        key,
        status: 'succeeded',
        data,
        sizeBytes,
        error: null,
        metadata: {},
        port: 'out',
        attempt,
        startedAt,
        finishedAt: new Date(),
      }
    } catch (err) {
      if (signal.aborted) throw err
      const error = toEngineError(err, ctx.secrets)
      if (attempt > settings.retry.count) {
        return {
          key,
          status: 'failed',
          data: null,
          sizeBytes: 0,
          error,
          metadata: {},
          port: null,
          attempt,
          startedAt,
          finishedAt: new Date(),
        }
      }
      const delay = retryDelayMs(settings.retry, attempt)
      log('warn', `Attempt ${attempt} failed: ${error.message}. Retrying in ${delay} ms.`)
      await sleep(delay, signal)
    }
  }
}

/** Runs one iteration's runner; `key` (`loop[i]:attempt`) keys a child run so a re-run doesn't start another. */
async function runner(block: LoopBlock, ctx: BlockContext, work: Work, key: string): Promise<unknown> {
  const { runner } = block.config
  switch (runner.kind) {
    case 'code':
      return runCode(block, runner.code, work, ctx, runner.language)
    case 'query':
      return (await runResourceQuery(runner.resource, runner.query, work, ctx)).data
    case 'library':
      throw new BlockFailure('library', "Library query runners can't run yet")
    case 'function':
      return callWorkflowFunction(runner.function, runner.params, work, ctx)
    case 'workflow':
      return runChild(runner.workflow, runner.input, runner.mode, key, work, ctx)
  }
}

/** Runs `work` with a signal that also aborts after `ms`; a timeout rejects with a BlockFailure. */
async function withTimeout<T>(
  ms: number,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const running = work(AbortSignal.any([signal, timeout.signal]))
  running.catch(() => {}) // It may lose the race below.
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new BlockFailure('timeout', `The iteration timed out after ${ms} ms`))
          timeout.abort()
        }, ms)
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** For a loop that nothing checkpoints (inside a function call). */
function inMemoryIterations(): LoopIterations {
  return { done: new Map(), record() {}, flush: async () => {} }
}
