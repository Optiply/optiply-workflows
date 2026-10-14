import { runQuery } from '@ow/connectors'
import type { LogLevel } from '@ow/db'
import type { Block, BlockOf } from '@ow/definition'
import { type Evaluate, renderJson, renderTemplate, renderText } from '@ow/expressions'
import type { RunOptions } from '@ow/sandbox'
import { BlockFailure } from './errors'
import type { EngineServices, RunInput } from './types'

export interface BlockContext {
  /** Globals plus the results of the blocks this one references. */
  scope: Record<string, unknown>
  input: RunInput
  environmentId: string
  services: EngineServices
  /** Aborted on timeout, run failure or interruption. */
  signal: AbortSignal
  timeoutMs: number
  log: (level: LogLevel, message: string) => void
}

export interface BlockOutput {
  data: unknown
  metadata?: Record<string, unknown>
  /** Defaults to `out`. */
  port?: string
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
    const data = await withHostCalls(ctx, (host) =>
      ctx.services.sandbox.runCode(block.config.code, ctx.scope, {
        timeoutMs: ctx.timeoutMs,
        onLog: (level, args) => ctx.log(level, formatLogArgs(args)),
        ...host,
      }),
    )
    return { data }
  },

  async resourceQuery(block, ctx) {
    const slug = block.config.resource
    let target: Awaited<ReturnType<EngineServices['resources']['resolve']>>
    try {
      target = await ctx.services.resources.resolve(slug, ctx.environmentId)
    } catch (err) {
      if (err instanceof BlockFailure) throw err
      throw new BlockFailure('resource', `Resource "${slug}" is unavailable: ${(err as Error).message}`)
    }
    const result = await runQuery(ctx.services.pool, target.connector, target.resource, block.config.query, {
      evaluate: templateEvaluator(ctx),
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    })
    return { data: result.data, metadata: { ...result.metadata, resource: slug } }
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

  // M5: these are defined (step 1) but run from later steps. The error handler never runs as a regular block.
  loop: notYet('Loop'),
  function: notYet('Function'),
  workflow: notYet('Workflow'),
  wait: notYet('Wait'),
  errorTrigger: notYet('Error handler'),
}

function notYet<T extends Block['type']>(label: string): Executor<T> {
  return async () => {
    throw new BlockFailure('unsupported', `${label} blocks can't run yet`)
  }
}

/**
 * What code may call outside the sandbox: `fetch`, aborted with the block (timeout, run failure, cancel) and also
 * once the code finishes, so a request it didn't await doesn't outlive it.
 */
async function withHostCalls<T>(
  ctx: BlockContext,
  run: (host: Pick<RunOptions, 'fetch'>) => Promise<T>,
): Promise<T> {
  const done = new AbortController()
  const signal = AbortSignal.any([ctx.signal, done.signal])
  const fetcher = ctx.services.fetcher
  try {
    return await run({
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

export function executeBlock(block: Block, ctx: BlockContext): Promise<BlockOutput> {
  return (executors[block.type] as Executor<Block['type']>)(block, ctx)
}

/** Evaluates `{{ }}` in the sandbox; failures name the expression, like resource queries do. */
function templateEvaluator(ctx: BlockContext): Evaluate {
  return async (code) => {
    try {
      return await ctx.services.sandbox.evalExpression(code, ctx.scope, { timeoutMs: ctx.timeoutMs })
    } catch (err) {
      throw new BlockFailure('expression', `Error in {{ ${code.trim()} }}: ${(err as Error).message}`)
    }
  }
}

/** `console.log('a', {b: 1})` → `a {"b":1}`. */
export function formatLogArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`
  return typeof value === 'object' ? 'an object' : String(value)
}
