import type { Db } from '@ow/db'
import type { Logger } from 'pino'

/**
 * Placeholder for the workflow worker (claim loop, reaper, scheduler tick, retention) that lands in M2/M4.
 * For now it only proves the role wiring and DB connectivity with a periodic heartbeat.
 */
export function startWorker(deps: { db: Db; log: Logger }) {
  const { db, log } = deps
  const tick = async () => {
    try {
      await db.execute('select 1')
      log.debug('worker heartbeat')
    } catch (err) {
      log.error({ err }, 'worker heartbeat failed')
    }
  }
  const timer = setInterval(tick, 15_000)
  log.info('worker started (engine arrives in M2)')
  return {
    stop: async () => {
      clearInterval(timer)
    },
  }
}
