import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { v7 as uuidv7 } from 'uuid'
import { startEmbeddedPostgres } from './embedded'
import { runMigrations } from './migrate'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}

/**
 * Migrated and seeded; Staging is for everyone unless `adminOnlyStaging` (session 56 made it admins-only): most
 * tests use it as just a second environment, the tests of admins-only environments keep it as seeded.
 */
async function prepare(url: string, adminOnlyStaging: boolean): Promise<void> {
  await runMigrations(url)
  if (adminOnlyStaging) return
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql`update environments set admin_only = false where slug = 'staging'`
  } finally {
    await sql.end()
  }
}

/**
 * A fresh, migrated database for a test file. Uses TEST_DATABASE_URL (a server we create a throwaway database
 * on) when set — e.g. in CI with a service container — otherwise boots an embedded Postgres in a temp dir.
 */
export async function startTestDatabase(
  opts: { adminOnlyStaging?: boolean } = {},
): Promise<{ url: string; stop: () => Promise<void> }> {
  const adminOnlyStaging = opts.adminOnlyStaging ?? false
  const external = process.env.TEST_DATABASE_URL
  if (external) {
    const name = `ow_test_${uuidv7().replaceAll('-', '')}`
    const admin = postgres(external, { max: 1, onnotice: () => {} })
    await admin.unsafe(`create database ${name}`)
    const url = new URL(external)
    url.pathname = `/${name}`
    await prepare(url.toString(), adminOnlyStaging)
    return {
      url: url.toString(),
      stop: async () => {
        await admin.unsafe(`drop database if exists ${name} with (force)`)
        await admin.end()
      },
    }
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'ow-pg-'))
  const pg = await startEmbeddedPostgres({
    dataDir,
    port: await freePort(),
    database: 'test',
    persistent: false,
  })
  await prepare(pg.url, adminOnlyStaging)
  return {
    url: pg.url,
    stop: async () => {
      await pg.stop()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
