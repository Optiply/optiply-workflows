import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Db } from '@ow/db'
import type { RunObserver, ScheduleFire } from '@ow/engine'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import client from 'prom-client'

/**
 * Prometheus metrics for one process (`/metrics`): Node's own (`ow_process_*`, `ow_nodejs_*`), what this process did
 * (HTTP requests, runs and blocks it finished, schedule fires), and gauges read from the database at scrape time
 * (runs by status, queue lag, open tasks, retention). The database gauges are the same in every process: aggregate
 * them with `max`, not `sum`. If the database can't be read, they keep their last values.
 */
export class Metrics {
  readonly registry = new client.Registry()
  private readonly httpRequests: client.Counter<'method' | 'route' | 'status'>
  private readonly httpDuration: client.Histogram<'method' | 'route'>
  private readonly runsSettled: client.Counter<'status' | 'trigger'>
  private readonly runDuration: client.Histogram<'status'>
  private readonly blocksFinished: client.Counter<'type' | 'status'>
  private readonly blockDuration: client.Histogram<'type'>
  private readonly scheduleFires: client.Counter<'result'>

  constructor(db: Db) {
    const registers = [this.registry]
    client.collectDefaultMetrics({ register: this.registry, prefix: 'ow_' })
    this.httpRequests = new client.Counter({
      name: 'ow_http_requests_total',
      help: 'HTTP requests answered, by route pattern and status',
      labelNames: ['method', 'route', 'status'],
      registers,
    })
    this.httpDuration = new client.Histogram({
      name: 'ow_http_request_duration_seconds',
      help: 'Time to answer HTTP requests, by route pattern',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    })
    this.runsSettled = new client.Counter({
      name: 'ow_runs_settled_total',
      help: 'Runs this process finished (succeeded, failed, cancelled) or paused (waiting), by trigger',
      labelNames: ['status', 'trigger'],
      registers,
    })
    this.runDuration = new client.Histogram({
      name: 'ow_run_duration_seconds',
      help: 'Time from a run first starting to it finishing or pausing here',
      labelNames: ['status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600, 21600],
      registers,
    })
    this.blocksFinished = new client.Counter({
      name: 'ow_blocks_finished_total',
      help: 'Block results this process committed, by block type and status',
      labelNames: ['type', 'status'],
      registers,
    })
    this.blockDuration = new client.Histogram({
      name: 'ow_block_duration_seconds',
      help: 'How long blocks took, by block type',
      labelNames: ['type'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers,
    })
    this.scheduleFires = new client.Counter({
      name: 'ow_schedule_fires_total',
      help: 'Schedule fires this process handled: a run started, or skipped because one was still going',
      labelNames: ['result'],
      registers,
    })

    // Read from the database when scraped: one query shared by the gauges of one scrape (prom-client collects them
    // all at once), fresh for the next. A failed read keeps their last values rather than failing the scrape.
    let snapshot: Promise<Snapshot | null> | undefined
    const read = () => {
      snapshot ??= readSnapshot(db)
        .catch(() => null)
        .finally(() => setImmediate(() => (snapshot = undefined)))
      return snapshot
    }
    new client.Gauge({
      name: 'ow_runs',
      help: 'Runs that are queued, running or waiting, across the database',
      labelNames: ['status'],
      registers,
      async collect() {
        const s = await read()
        if (!s) return
        for (const status of ['queued', 'running', 'waiting'] as const) this.set({ status }, s[status])
      },
    })
    new client.Gauge({
      name: 'ow_queue_lag_seconds',
      help: 'How long the oldest run that is due (queued, or waiting and due) has been waiting for a worker',
      registers,
      async collect() {
        const s = await read()
        if (s) this.set(s.lagSeconds)
      },
    })
    new client.Gauge({
      name: 'ow_user_tasks_open',
      help: 'User Tasks waiting for someone to complete them',
      registers,
      async collect() {
        const s = await read()
        if (s) this.set(s.openTasks)
      },
    })
    new client.Gauge({
      name: 'ow_retention_last_finished_timestamp_seconds',
      help: 'When retention last finished (0: never)',
      registers,
      async collect() {
        const s = await read()
        if (s) this.set(s.retentionFinishedAt)
      },
    })
    new client.Gauge({
      name: 'ow_retention_last_deleted_runs',
      help: 'Runs the last retention deleted',
      registers,
      async collect() {
        const s = await read()
        if (s) this.set(s.retentionDeletedRuns)
      },
    })
  }

  /** For the run executor (workers, and sync webhooks in the API). */
  readonly observer: RunObserver = {
    runSettled: ({ status, triggerType, durationMs }) => {
      this.runsSettled.inc({ status, trigger: triggerType })
      this.runDuration.observe({ status }, durationMs / 1000)
    },
    blockFinished: ({ type, status, durationMs }) => {
      this.blocksFinished.inc({ type, status })
      this.blockDuration.observe({ type }, durationMs / 1000)
    },
  }

  scheduleFired(fire: ScheduleFire) {
    this.scheduleFires.inc({ result: fire.runId ? 'started' : 'skipped' })
  }

  /** Counts every request by its route pattern (`/api/v1/runs/:id`), never the raw URL. */
  instrument(app: FastifyInstance) {
    app.addHook('onResponse', async (request, reply) => {
      const route = request.routeOptions.url ?? 'unmatched'
      const method = request.method
      this.httpRequests.inc({ method, route, status: String(reply.statusCode) })
      this.httpDuration.observe({ method, route }, reply.elapsedTime / 1000)
    })
  }

  async text(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() }
  }
}

interface Snapshot {
  queued: number
  running: number
  waiting: number
  lagSeconds: number
  openTasks: number
  retentionFinishedAt: number
  retentionDeletedRuns: number
}

async function readSnapshot(db: Db): Promise<Snapshot> {
  const [row] = await db.execute<{
    queued: number
    running: number
    waiting: number
    lag: number | null
    open_tasks: number
    retention_at: number | null
    retention_runs: number | null
  }>(sql`
    select
      (select count(*)::int from workflow_runs where status = 'queued') as queued,
      (select count(*)::int from workflow_runs where status = 'running') as running,
      (select count(*)::int from workflow_runs where status = 'waiting') as waiting,
      (select extract(epoch from now() - min(available_at))::float8 from workflow_runs
        where status in ('queued', 'waiting') and available_at <= now()) as lag,
      (select count(*)::int from user_tasks where status = 'open') as open_tasks,
      (select extract(epoch from last_finished_at)::float8 from maintenance_jobs where name = 'retention') as retention_at,
      (select (last_result->>'runs')::int from maintenance_jobs where name = 'retention') as retention_runs`)
  return {
    queued: row!.queued,
    running: row!.running,
    waiting: row!.waiting,
    lagSeconds: Math.max(0, row!.lag ?? 0),
    openTasks: row!.open_tasks,
    retentionFinishedAt: row!.retention_at ?? 0,
    retentionDeletedRuns: row!.retention_runs ?? 0,
  }
}

/** `METRICS_TOKEN`, when set, must come as `Authorization: Bearer <token>`. */
export function metricsAllowed(token: string | undefined, authorization: string | undefined): boolean {
  if (!token) return true
  const presented = Buffer.from(authorization?.replace(/^Bearer\s+/i, '') ?? '')
  const expected = Buffer.from(token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/** Serves `/metrics` (and `/health`) on its own port, for workers, which have no HTTP server otherwise. */
export async function serveMetrics(
  metrics: Metrics,
  opts: { port: number; host: string; token?: string },
): Promise<Server> {
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0]
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
    if (path !== '/metrics') {
      res.writeHead(404).end()
      return
    }
    if (!metricsAllowed(opts.token, req.headers.authorization)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
      return
    }
    metrics.text().then(
      ({ contentType, body }) => res.writeHead(200, { 'content-type': contentType }).end(body),
      () => res.writeHead(500).end(),
    )
  })
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve))
  return server
}
