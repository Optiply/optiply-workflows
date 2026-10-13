// Servers run in UTC: isolates inherit the process TZ and date math (dayjs tz, cron) must not depend on the host.
process.env.TZ = 'UTC'

import { createDb, runMigrations } from '@ow/db'
import pino from 'pino'
import { buildApp } from './api/app'
import { loadConfig } from './config'
import { startWorker } from './worker'

const config = loadConfig()
const log = pino({
  level: config.LOG_LEVEL,
  transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
})

async function main() {
  if (config.ROLE === 'migrate') {
    log.info('running migrations')
    await runMigrations(config.DATABASE_URL, process.env.MIGRATIONS_DIR)
    log.info('migrations complete')
    return
  }

  if (config.AUTO_MIGRATE) await runMigrations(config.DATABASE_URL, process.env.MIGRATIONS_DIR)

  const { db, sql, close } = createDb(config.DATABASE_URL)
  const stops: (() => Promise<void>)[] = []

  if (config.ROLE === 'api' || config.ROLE === 'all') {
    const app = await buildApp({ db, config, logger: log, listener: sql })
    await app.listen({ port: config.PORT, host: config.HOST })
    stops.push(() => app.close())
  }
  if (config.ROLE === 'worker' || config.ROLE === 'all') {
    const worker = await startWorker({ db, sql, config, log })
    stops.push(worker.stop)
  }

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'shutting down')
    for (const stop of stops.reverse()) await stop()
    await close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  log.fatal({ err }, 'fatal startup error')
  process.exit(1)
})
