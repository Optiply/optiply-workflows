import { PoolManager } from '@ow/connectors'
import type { Db } from '@ow/db'
import { Dispatcher, Scheduler } from '@ow/engine'
import type { Logger } from 'pino'
import type postgres from 'postgres'
import type { Config } from '../config'
import { dbResourceProvider, dbRunContext } from '../services/workflow-runs'

/**
 * The workflow worker: claims queued runs and executes them (see `Dispatcher` in @ow/engine), renews their
 * leases and recovers runs whose worker died, and fires due schedules every 5 s (`Scheduler`; every worker ticks,
 * and each due schedule is fired by one of them). `stop()` stops firing and hands in-flight runs back to the queue.
 * Retention (M6) joins it later.
 */
export async function startWorker(deps: { db: Db; sql: postgres.Sql; config: Config; log: Logger }) {
  const { db, sql, config, log } = deps
  const pool = new PoolManager()
  const dispatcher = new Dispatcher({
    db,
    listener: sql,
    pool,
    resources: dbResourceProvider(db, config.keyring),
    context: dbRunContext(db, config.keyring),
    concurrency: config.WORKER_CONCURRENCY,
    log: log.child({ component: 'dispatcher' }),
  })
  await dispatcher.start()
  const scheduler = new Scheduler({ db, log: log.child({ component: 'scheduler' }) })
  scheduler.start()
  return {
    dispatcher,
    scheduler,
    stop: async () => {
      await scheduler.stop()
      await dispatcher.stop()
      await pool.closeAll()
    },
  }
}
