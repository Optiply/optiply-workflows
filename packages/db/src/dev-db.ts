import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startEmbeddedPostgres } from './embedded'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const dataDir = resolve(repoRoot, '.data/pg')
const port = Number(process.env.DEV_DB_PORT ?? 5433)

mkdirSync(dirname(dataDir), { recursive: true })
const pg = await startEmbeddedPostgres({ dataDir, port, database: 'optiply_workflows', persistent: true })
console.log(`Dev Postgres running.\n  DATABASE_URL=${pg.url}\nPress Ctrl+C to stop.`)

const shutdown = async () => {
  await pg.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
