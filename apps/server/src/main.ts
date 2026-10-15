// Servers run in UTC: isolates inherit the process TZ and date math (dayjs tz, cron) must not depend on the host.
process.env.TZ = 'UTC'

import { createDb, runMigrations } from '@ow/db'
import pino from 'pino'
import { buildApp } from './api/app'
import { loadConfig } from './config'
import { Metrics, serveMetrics } from './metrics'
import { DatabaseSetupError, provisionDatabases } from './services/database'
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
    await provisionManagedDatabase()
    return
  }

  if (config.AUTO_MIGRATE) await runMigrations(config.DATABASE_URL, process.env.MIGRATIONS_DIR)

  const { db, sql, close } = createDb(config.DATABASE_URL)
  const stops: (() => Promise<void>)[] = []
  const metrics = new Metrics(db)

  if (config.ROLE === 'api' || config.ROLE === 'all') {
    const app = await buildApp({ db, config, logger: log, listener: sql, metrics })
    await app.listen({ port: config.PORT, host: config.HOST })
    stops.push(() => app.close())
  }
  if (config.ROLE === 'worker' || config.ROLE === 'all') {
    const worker = await startWorker({ db, sql, config, log, metrics })
    stops.push(worker.stop)
  }
  // A worker on its own has no HTTP server: it serves /metrics on METRICS_PORT.
  if (config.ROLE === 'worker' && config.METRICS_PORT > 0) {
    const server = await serveMetrics(metrics, {
      port: config.METRICS_PORT,
      host: config.HOST,
      token: config.METRICS_TOKEN,
    })
    log.info({ port: config.METRICS_PORT }, 'metrics served')
    stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
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

/** Sets up the managed database's schemas and roles; a missing privilege is reported, not fatal. */
async function provisionManagedDatabase() {
  const { db, close } = createDb(config.DATABASE_URL, { max: 1 })
  try {
    const report = await provisionDatabases(db, config.keyring, config.DATABASE_URL)
    log.info({ environments: report.environments }, 'managed database ready')
  } catch (err) {
    if (!(err instanceof DatabaseSetupError)) throw err
    log.warn(err.message)
  } finally {
    await close()
  }
}

main().catch((err) => {
  log.fatal({ err }, 'fatal startup error')
  process.exit(1)
})
