import { PoolManager } from '@ow/connectors'
import type { Db } from '@ow/db'
import { Dispatcher } from '@ow/engine'
import type { Logger } from 'pino'
import type postgres from 'postgres'
import type { Config } from '../config'
import { dbResourceProvider, dbRunContext } from '../services/workflow-runs'

/**
 * The workflow worker: claims queued runs and executes them (see `Dispatcher` in @ow/engine), renews their
 * leases and recovers runs whose worker died. `stop()` hands in-flight runs back to the queue. The scheduler tick
 * (M4) and retention (M6) join it later.
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
  return {
    dispatcher,
    stop: async () => {
      await dispatcher.stop()
      await pool.closeAll()
    },
  }
}
