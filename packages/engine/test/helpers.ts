import { type Connector, ConnectorError, PoolManager } from '@ow/connectors'
import type { WorkflowDefinition } from '@ow/definition'
import { renderTemplate } from '@ow/expressions'
import { IvmRuntime } from '@ow/sandbox'
import { z } from 'zod'
import {
  BlockFailure,
  type ChildRunState,
  type ChildRuns,
  type ExecuteRunOptions,
  executeRun,
  MemoryRunStore,
  sleep,
} from '../src'

const fakeQuery = z.object({
  /** Call counter key. */
  id: z.string(),
  /** Template rendered into the result's data. Without it, data is the call number. */
  value: z.string().optional(),
  delayMs: z.number().optional(),
  /** The first `failTimes` calls throw. */
  failTimes: z.number().optional(),
  /** Return a Date, to check results are normalised to JSON. */
  date: z.boolean().optional(),
})

/** Observes everything the fake connector did. */
export class FakeLog {
  calls = new Map<string, number>()
  active = 0
  maxActive = 0
  aborted: string[] = []
  timeline: string[] = []
  /** The labels each call was given (see QueryContext.labels). */
  labels: (Record<string, string> | undefined)[] = []
  count(id: string) {
    return this.calls.get(id) ?? 0
  }
}

/** A connector with controllable latency and failures, to observe the orchestrator from outside. */
export function fakeConnector(log: FakeLog): Connector<object, object, z.output<typeof fakeQuery>, object> {
  return {
    type: 'fake',
    label: 'Fake',
    configSchema: z.object({}),
    secretsSchema: z.object({ token: z.string() }),
    querySchema: fakeQuery,
    createClient: () => ({}),
    destroyClient: async () => {},
    testConnection: async () => ({}),
    validateQuery: () => [],
    async execute(_client, query, ctx) {
      const n = log.count(query.id) + 1
      log.calls.set(query.id, n)
      log.labels.push(ctx.labels)
      log.active++
      log.maxActive = Math.max(log.maxActive, log.active)
      log.timeline.push(`start ${query.id}`)
      try {
        if (query.delayMs) {
          try {
            await sleep(query.delayMs, ctx.signal)
          } catch (err) {
            log.aborted.push(query.id)
            throw err
          }
        }
        if (query.failTimes && n <= query.failTimes) {
          // The resource's secret appears in the message; runQuery must scrub it.
          throw new ConnectorError('query', `call ${n} failed (token sekret-token)`)
        }
        if (query.date) return { data: { at: new Date(0) }, metadata: { call: n } }
        const data = query.value === undefined ? n : await renderTemplate(query.value, ctx.evaluate)
        return { data, metadata: { call: n } }
      } finally {
        log.active--
        log.timeline.push(`end ${query.id}`)
      }
    },
  }
}

/** Shared services for a test file; call `close` in afterAll. */
export function testServices() {
  const fake = new FakeLog()
  const connector = fakeConnector(fake)
  const sandbox = new IvmRuntime()
  const pool = new PoolManager({ sweepIntervalMs: 0 })
  const services: ExecuteRunOptions['services'] = {
    sandbox,
    pool,
    resources: {
      async resolve(slug, environmentId) {
        if (slug !== 'fake') throw new Error(`no resource "${slug}"`)
        return {
          connector,
          resource: {
            id: 'rc-fake',
            resourceId: 'r-fake',
            environmentId,
            version: '1',
            config: {},
            secrets: { token: 'sekret-token' },
          },
        }
      },
    },
  }
  return {
    services,
    fake,
    reset() {
      Object.assign(fake, new FakeLog())
    },
    async close() {
      sandbox.dispose()
      await pool.closeAll()
    },
  }
}

// Definition builders (validated by executeRun itself).

type Edge = [from: string, to: string, port?: string]

export function wf(blocks: object[], edges: Edge[]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    blocks: [{ name: 'startTrigger', type: 'startTrigger' }, ...blocks],
    edges: edges.map(([from, to, port = 'out']) => ({ from, port, to })),
  } as WorkflowDefinition
}

export const code = (name: string, src: string, settings?: object) => ({
  name,
  type: 'code',
  config: { code: src },
  ...(settings && { settings }),
})

export const fakeQ = (name: string, query: Partial<z.input<typeof fakeQuery>> = {}, settings?: object) => ({
  name,
  type: 'resourceQuery',
  config: { resource: 'fake', query: { id: name, ...query } },
  ...(settings && { settings }),
})

export const branch = (name: string, conditions: [id: string, expression: string][], settings?: object) => ({
  name,
  type: 'branch',
  config: { conditions: conditions.map(([id, expression]) => ({ id, expression })) },
  ...(settings && { settings }),
})

export const response = (name: string, body: string, status?: string, headers?: [string, string][]) => ({
  name,
  type: 'response',
  config: {
    body,
    ...(status && { status }),
    ...(headers && { headers: headers.map(([key, value]) => ({ key, value })) }),
  },
})

export const filter = (name: string, input: string, condition: string) => ({
  name,
  type: 'filter',
  config: { input, condition },
})

/** Runs a definition with test defaults; returns the outcome, the store and `{ block: status }`. */
export async function run(
  services: ExecuteRunOptions['services'],
  definition: WorkflowDefinition,
  opts: Partial<ExecuteRunOptions> = {},
) {
  const store = (opts.store as MemoryRunStore | undefined) ?? new MemoryRunStore()
  const outcome = await executeRun({
    runId: 'run-1',
    definition,
    environmentId: 'env-prod',
    input: {},
    globals: {
      configVars: { REGION: 'eu' },
      workflowContext: { runId: 'run-1', environment: 'production' },
      idempotencyKey: 'idem-1',
    },
    services,
    store,
    ...opts,
  })
  const statuses = Object.fromEntries([...outcome.results].map(([key, r]) => [key, r.status]))
  const data = (key: string) => outcome.results.get(key)?.data
  return { outcome, store, statuses, data }
}

/** A Wait of `amount` units (a template), or until a time. */
export const wait = (name: string, amount: string, unit = 'seconds', settings?: object) => ({
  name,
  type: 'wait',
  config: { kind: 'duration', amount, unit },
  ...(settings && { settings }),
})

export const waitUntil = (name: string, until: string) => ({
  name,
  type: 'wait',
  config: { kind: 'until', until },
})

export const errorTrigger = (name = 'onFailure') => ({ name, type: 'errorTrigger' })

/** How a fake child workflow behaves: its result (or failure) after `delayMs`. */
export interface FakeChildBehaviour {
  body?: unknown
  fail?: string
  delayMs?: number
}

/** Child runs that finish on a timer, recording what was started; keys are idempotent like the real thing. */
export class FakeChildren implements ChildRuns {
  started: { workflow: string; input: unknown; key: string; runId: string }[] = []
  cancelled: string[] = []
  private readonly runs = new Map<
    string,
    { finishAt: number; behaviour: FakeChildBehaviour; cancelled?: boolean }
  >()
  private readonly byKey = new Map<string, string>()

  constructor(
    readonly workflows: Record<string, FakeChildBehaviour | ((input: unknown) => FakeChildBehaviour)>,
  ) {}

  async start(request: { workflow: string; input: unknown; key: string }) {
    const existing = this.byKey.get(request.key)
    if (existing) return existing
    const spec = this.workflows[request.workflow]
    if (!spec) throw new BlockFailure('unknown_workflow', `No workflow has the slug "${request.workflow}"`)
    const behaviour = typeof spec === 'function' ? spec(request.input) : spec
    const runId = `child-${this.started.length + 1}`
    this.started.push({ workflow: request.workflow, input: request.input, key: request.key, runId })
    this.byKey.set(request.key, runId)
    this.runs.set(runId, { finishAt: Date.now() + (behaviour.delayMs ?? 0), behaviour })
    return runId
  }

  async get(runId: string): Promise<ChildRunState | null> {
    const run = this.runs.get(runId)
    if (!run) return null
    const base = { runId, response: null, error: null }
    if (run.cancelled) return { ...base, status: 'cancelled' }
    if (Date.now() < run.finishAt) return { ...base, status: 'running' }
    if (run.behaviour.fail)
      return { ...base, status: 'failed', error: { code: 'runtime', message: run.behaviour.fail } }
    return {
      ...base,
      status: 'succeeded',
      response: { status: 200, headers: {}, body: run.behaviour.body ?? null },
    }
  }

  async cancel(runId: string) {
    this.cancelled.push(runId)
    const run = this.runs.get(runId)
    if (run) run.cancelled = true
  }
}
