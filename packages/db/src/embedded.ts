import { existsSync } from 'node:fs'
import EmbeddedPostgres from 'embedded-postgres'

export interface EmbeddedInstance {
  url: string
  stop: () => Promise<void>
}

/**
 * Boots a local Postgres from the `embedded-postgres` npm binaries — used for dev and tests so contributors
 * don't need Docker. Production always uses a real Postgres via DATABASE_URL.
 */
export async function startEmbeddedPostgres(opts: {
  dataDir: string
  port: number
  database: string
  persistent: boolean
}): Promise<EmbeddedInstance> {
  const user = 'ow'
  const password = 'ow'
  const pg = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    user,
    password,
    port: opts.port,
    persistent: opts.persistent,
    onLog: () => {},
  })
  if (!existsSync(`${opts.dataDir}/PG_VERSION`)) await pg.initialise()
  await pg.start()
  try {
    await pg.createDatabase(opts.database)
  } catch (err) {
    if (!String(err).includes('already exists')) throw err
  }
  return {
    url: `postgres://${user}:${password}@127.0.0.1:${opts.port}/${opts.database}`,
    stop: () => pg.stop(),
  }
}
