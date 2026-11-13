import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client'
import { environments, groups, permissions, resourceConfigs, resources } from './schema'

/** The built-in REST API resource (M27): any public URL, no settings; workflows and apps name it by this slug. */
export const REST_API_RESOURCE_SLUG = 'rest_api'

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

  await seedRestApi(db)
}

/**
 * The built-in REST API resource, with a config in every environment. Made once, with Use for All Users (admins may
 * narrow that afterwards, so it isn't granted again); a user's own resource with the slug blocks it.
 */
async function seedRestApi(db: ReturnType<typeof createDb>['db']) {
  let [resource] = await db.select().from(resources).where(eq(resources.systemKind, 'rest'))
  if (!resource) {
    const [taken] = await db.select().from(resources).where(eq(resources.slug, REST_API_RESOURCE_SLUG))
    if (taken) {
      console.warn(
        `A resource already has the slug "${REST_API_RESOURCE_SLUG}", which the built-in REST API resource needs: it isn't created. Give that resource another slug, then migrate again.`,
      )
      return
    }
    ;[resource] = await db
      .insert(resources)
      .values({
        slug: REST_API_RESOURCE_SLUG,
        name: 'REST API',
        type: 'restapi',
        systemKind: 'rest',
        description:
          'Any public URL, without setting up a resource. Each query gives its full URL and its own auth.',
      })
      .returning()
    const [allUsers] = await db.select().from(groups).where(eq(groups.systemKind, 'all_users'))
    if (allUsers) {
      await db
        .insert(permissions)
        .values({ groupId: allUsers.id, objectType: 'resource', objectId: resource!.id, level: 'use' })
        .onConflictDoNothing()
    }
  }
  for (const env of await db.select({ id: environments.id }).from(environments)) {
    await db
      .insert(resourceConfigs)
      .values({ resourceId: resource!.id, environmentId: env.id, config: {} })
      .onConflictDoNothing()
  }
}
