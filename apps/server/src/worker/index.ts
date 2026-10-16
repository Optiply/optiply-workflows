import { CodeFetcher, PoolManager } from '@ow/connectors'
import type { Db } from '@ow/db'
import { Dispatcher, RetentionJob, Scheduler } from '@ow/engine'
import { IvmRuntime } from '@ow/sandbox'
import type { Logger } from 'pino'
import type postgres from 'postgres'
import type { Config } from '../config'
import { Metrics } from '../metrics'
import { dbResourceProvider, dbRunContext } from '../services/workflow-runs'

/**
 * The workflow worker: claims queued runs and executes them (see `Dispatcher` in @ow/engine), renews their
 * leases and recovers runs whose worker died, and fires due schedules every 5 s (`Scheduler`; every worker ticks,
 * and each due schedule is fired by one of them), and once a day deletes runs older than `RUN_RETENTION_DAYS`
 * (`RetentionJob`; one worker a day wins the job). `stop()` stops firing and hands in-flight runs back to the queue.
 */
export async function startWorker(deps: {
  db: Db
  sql: postgres.Sql
  config: Config
  log: Logger
  /** The process's metrics (see main.ts). Default: the worker's own. */
  metrics?: Metrics
}) {
  const { db, sql, config, log } = deps
  const metrics = deps.metrics ?? new Metrics(db)
  const pool = new PoolManager()
  const fetcher = new CodeFetcher({ allowPrivateNetwork: config.CODE_FETCH_ALLOW_PRIVATE_NETWORK })
  // For custom auth flows (sign-in steps' code and templates); runs get sandboxes of their own.
  const authSandbox = new IvmRuntime()
  const dispatcher = new Dispatcher({
    db,
    listener: sql,
    pool,
    fetcher,
    resources: dbResourceProvider(db, config.keyring, authSandbox),
    context: dbRunContext(db, config.keyring),
    concurrency: config.WORKER_CONCURRENCY,
    log: log.child({ component: 'dispatcher' }),
    observer: metrics.observer,
  })
  await dispatcher.start()
  const scheduler = new Scheduler({
    db,
    log: log.child({ component: 'scheduler' }),
    onFire: (fire) => metrics.scheduleFired(fire),
  })
  scheduler.start()
  const retention = new RetentionJob({
    db,
    days: config.RUN_RETENTION_DAYS,
    log: log.child({ component: 'retention' }),
  })
  retention.start()
  return {
    dispatcher,
    scheduler,
    retention,
    stop: async () => {
      await retention.stop()
      await scheduler.stop()
      await dispatcher.stop()
      await pool.closeAll()
      await fetcher.close()
      authSandbox.dispose()
    },
  }
}
