import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client'
import { environments, groups } from './schema'

/** Arbitrary constant so concurrent `migrate` containers serialize instead of racing. */
const MIGRATION_LOCK_ID = 727_001

export const defaultMigrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations')

export async function runMigrations(url: string, migrationsFolder = defaultMigrationsFolder) {
  const { db, sql, close } = createDb(url, { max: 1 })
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
    try {
      await migrate(db, { migrationsFolder })
      await seed(db)
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`
    }
  } finally {
    await close()
  }
}

/** Idempotent bootstrap data every installation needs. */
async function seed(db: ReturnType<typeof createDb>['db']) {
  await db
    .insert(environments)
    .values([
      { slug: 'production', name: 'Production', color: '#16a34a', isDefault: true },
      { slug: 'staging', name: 'Staging', color: '#d97706' },
    ])
    .onConflictDoNothing({ target: environments.slug })

  await db
    .insert(groups)
    .values([
      { name: 'Admins', description: 'Full access to everything', systemKind: 'admins' },
      { name: 'All Users', description: 'Every user is a member', systemKind: 'all_users' },
    ])
    .onConflictDoNothing()
}
