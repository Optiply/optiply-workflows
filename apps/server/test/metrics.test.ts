import { sshTunnelStats } from '@ow/connectors'
import { createDb } from '@ow/db'
import { pythonStats } from '@ow/sandbox'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Metrics, metricsAllowed, serveMetrics } from '../src/metrics'
import { startWorker } from '../src/worker'
import { createLocalUser, login, startTestApp, type TestEnv, trpc } from './helpers'

const TOKEN = 'metrics-token-for-tests'
let env: TestEnv
let cookie: string

beforeAll(async () => {
  env = await startTestApp({ METRICS_TOKEN: TOKEN })
  await createLocalUser(env.db, 'admin@optiply.nl', { admin: true })
  cookie = await login(env.app, 'admin@optiply.nl')
})
afterAll(() => env?.stop())

async function scrape(headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return env.app.inject({ method: 'GET', url: '/metrics', headers })
}

/** One sample's value from Prometheus text, e.g. value(text, 'ow_runs{status="queued"}'). */
function value(text: string, sample: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${sample} `))
  return line === undefined ? undefined : Number(line.slice(sample.length + 1))
}

describe('/metrics', () => {
  it('needs the token when METRICS_TOKEN is set', async () => {
    expect((await scrape({})).statusCode).toBe(401)
    expect((await scrape({ authorization: 'Bearer wrong' })).statusCode).toBe(401)
    const ok = await scrape()
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toMatch(/^text\/plain/)
    expect(metricsAllowed(undefined, undefined)).toBe(true)
  })

  it('counts HTTP requests by route pattern, and has Node and database gauges', async () => {
    await env.app.inject({ method: 'GET', url: '/api/health' })
    await env.app.inject({
      method: 'GET',
      url: '/api/v1/runs/0192f000-0000-7000-8000-000000000000',
      headers: { cookie },
    })
    const text = (await scrape()).body
    expect(
      value(text, 'ow_http_requests_total{method="GET",route="/api/health",status="200"}'),
    ).toBeGreaterThanOrEqual(1)
    // The pattern, not the id: no label per run.
    expect(text).toContain('route="/api/v1/runs/:id",status="404"')
    expect(text).not.toContain('0192f000-0000')
    expect(text).toContain('ow_process_cpu_user_seconds_total')
    expect(text).toContain('ow_nodejs_eventloop_lag_seconds')
    expect(value(text, 'ow_runs{status="queued"}')).toBe(0)
    expect(value(text, 'ow_runs{status="waiting"}')).toBe(0)
    expect(value(text, 'ow_queue_lag_seconds')).toBe(0)
    expect(value(text, 'ow_user_tasks_open')).toBe(0)
    expect(value(text, 'ow_retention_last_finished_timestamp_seconds')).toBe(0)
  })

  it("reports this process's SSH tunnels (M17) and IAP resumes (M18)", async () => {
    const before = { ...sshTunnelStats }
    sshTunnelStats.open = 2
    sshTunnelStats.reconnects = 5
    sshTunnelStats.iapResumes = 3
    try {
      const text = (await scrape()).body
      expect(value(text, 'ow_ssh_tunnels_open')).toBe(2)
      expect(value(text, 'ow_ssh_tunnel_reconnects_total')).toBe(5)
      expect(value(text, 'ow_iap_resumes_total')).toBe(3)
      expect(text).toContain('ow_pubsub_messages_total{outcome="acked"}')
      expect(value(text, 'ow_pubsub_in_flight')).toBe(0)
      expect(value(text, 'ow_pubsub_pull_errors_total')).toBe(0)
    } finally {
      Object.assign(sshTunnelStats, before)
    }
  })

  it("reports this process's Python executions by jail (M23)", async () => {
    const before = { ...pythonStats }
    pythonStats.warm = 7
    pythonStats.cold = 2
    try {
      const text = (await scrape()).body
      expect(value(text, 'ow_python_executions_total{jail="warm"}')).toBe(7)
      expect(value(text, 'ow_python_executions_total{jail="cold"}')).toBe(2)
    } finally {
      Object.assign(pythonStats, before)
    }
  })

  it('counts the runs and blocks a worker finishes, and the queue it leaves behind', async () => {
    const metrics = new Metrics(env.db)
    const workerDb = createDb(env.databaseUrl, { max: 5 })
    const admin = trpc(env.app, cookie)
    const created = (await admin.mutate('workflows.create', { slug: 'measured', name: 'Measured' })).body
      .result!.data as { id: string }
    await admin.mutate('workflows.saveDraft', {
      id: created.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        blocks: [
          { name: 'startTrigger', type: 'startTrigger' },
          { name: 'double', type: 'code', config: { code: 'return 2 * 21' } },
        ],
        edges: [{ from: 'startTrigger', port: 'out', to: 'double' }],
      },
    })
    // Queued before any worker runs: the gauge sees it.
    const started = await env.app.inject({
      method: 'POST',
      url: '/api/v1/workflows/measured/runs',
      headers: { cookie },
      payload: {},
    })
    const runId = started.json().run.id
    expect(value((await scrape()).body, 'ow_runs{status="queued"}')).toBe(1)

    const worker = await startWorker({
      db: workerDb.db,
      sql: workerDb.sql,
      config: env.config,
      log: pino({ level: 'silent' }),
      metrics,
    })
    try {
      for (let i = 0; i < 200; i++) {
        const run = await env.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}`, headers: { cookie } })
        if (run.json().run.status === 'succeeded') break
        await new Promise((r) => setTimeout(r, 50))
      }
      const text = (await metrics.text()).body
      expect(value(text, 'ow_runs_settled_total{status="succeeded",trigger="manual"}')).toBe(1)
      expect(value(text, 'ow_blocks_finished_total{type="code",status="succeeded"}')).toBe(1)
      expect(value(text, 'ow_run_duration_seconds_count{status="succeeded"}')).toBe(1)
      expect(value(text, 'ow_runs{status="queued"}')).toBe(0)
      metrics.scheduleFired({
        triggerId: 't',
        workflowId: 'w',
        schedule: 'nightly',
        scheduledFor: new Date(),
        runId: null,
      })
      expect(value((await metrics.text()).body, 'ow_schedule_fires_total{result="skipped"}')).toBe(1)
    } finally {
      await worker.stop()
      await workerDb.close()
    }
  })

  it("serves a worker's metrics on their own port", async () => {
    const metrics = new Metrics(env.db)
    const server = await serveMetrics(metrics, { port: 0, host: '127.0.0.1', token: TOKEN })
    const { port } = server.address() as { port: number }
    try {
      const base = `http://127.0.0.1:${port}`
      expect((await fetch(`${base}/health`)).status).toBe(200)
      expect((await fetch(`${base}/metrics`)).status).toBe(401)
      const ok = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('ow_runs{status="running"}')
      expect((await fetch(`${base}/other`)).status).toBe(404)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
