import { CodeFetcher, PoolManager } from '@ow/connectors'
import type { Db } from '@ow/db'
import { Dispatcher, QueueConsumer, RetentionJob, Scheduler } from '@ow/engine'
import { IvmRuntime } from '@ow/sandbox'
import type { Logger } from 'pino'
import type postgres from 'postgres'
import type { Config } from '../config'
import { Metrics } from '../metrics'
import { configureAwsServer } from '../services/aws'
import { deleteUnusedBundles } from '../services/component-libraries'
import { configureConnectors } from '../services/connectors'
import { GitDeployer } from '../services/git/deployer'
import { configureGoogle } from '../services/google'
import { configureJsBundles, dbJsModules } from '../services/js-modules'
import { engineLibrary } from '../services/library-queries'
import { configurePython, pythonConfigWarning } from '../services/python'
import { pythonEnvProvider } from '../services/python-envs'
import { useRe2ForPatterns } from '../services/regexp'
import { dbResourceProvider, dbRunContext } from '../services/workflow-runs'

/**
 * The workflow worker: claims queued runs and executes them (see `Dispatcher` in @ow/engine), renews their
 * leases and recovers runs whose worker died, and fires due schedules every 5 s (`Scheduler`; every worker ticks,
 * and each due schedule is fired by one of them), and once a day deletes runs older than `RUN_RETENTION_DAYS`
 * (`RetentionJob`; one worker a day wins the job), and deploys from Git every `GIT_POLL_SECONDS`, re-checking problem objects every `GIT_RETRY_MINUTES` (`GitDeployer`; one
 * process at a time). `stop()` stops firing and hands in-flight runs back to the queue.
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
  const pythonWarning = pythonConfigWarning(config)
  if (pythonWarning) log.warn(pythonWarning)
  configureGoogle(config)
  configureAwsServer(config)
  configureConnectors(config)
  useRe2ForPatterns()
  configureJsBundles(config)
  const dispatcher = new Dispatcher({
    db,
    listener: sql,
    pool,
    fetcher,
    resources: dbResourceProvider(db, config.keyring, authSandbox),
    context: dbRunContext(db, config.keyring),
    concurrency: config.WORKER_CONCURRENCY,
    python: configurePython(config) ?? undefined,
    pythonEnvs: pythonEnvProvider(db, config),
    jsModules: dbJsModules(db),
    library: engineLibrary(db),
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
    also: async () => ({ componentBundles: await deleteUnusedBundles(db) }),
  })
  retention.start()
  const git = new GitDeployer({
    db,
    config,
    log: log.child({ component: 'git' }),
    pollMs: config.GIT_POLL_SECONDS * 1000,
    retryMs: config.GIT_RETRY_MINUTES * 60_000,
  })
  git.start()
  // Queue triggers (Pub/Sub M19, SQS and Kafka M26): received by one worker at a time each, under the dispatcher's name.
  const queues = new QueueConsumer({
    db,
    resources: dbResourceProvider(db, config.keyring, authSandbox),
    workerId: dispatcher.workerId,
    log: log.child({ component: 'queue' }),
  })
  queues.start()
  return {
    dispatcher,
    scheduler,
    retention,
    git,
    queues,
    stop: async () => {
      // First, so held messages are nacked to the next worker while this one can still finish runs.
      await queues.stop()
      await git.stop()
      await retention.stop()
      await scheduler.stop()
      await dispatcher.stop()
      await pool.closeAll()
      await fetcher.close()
      authSandbox.dispose()
    },
  }
}
