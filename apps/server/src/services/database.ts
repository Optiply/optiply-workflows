import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { Keyring } from '@ow/crypto'
import {
  type Db,
  environments,
  managedDatabases,
  type ResourceConfig,
  resourceConfigs,
  resources,
} from '@ow/db'
import { and, eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { decryptConfigSecrets } from './resources'
import { encryptForRow } from './secrets'

/** The built-in resource workflows query the managed database through. */
export const DATABASE_RESOURCE_SLUG = 'optiply_db'
const DATABASE_RESOURCE_NAME = 'Optiply Database'

/** Serializes provisioning across API and migrate processes starting at once. */
const PROVISION_LOCK_ID = 727_002

/** Provisioning can't go ahead (e.g. the platform's database user may not create roles); the message says why. */
export class DatabaseSetupError extends Error {
  override name = 'DatabaseSetupError'
}

export interface ProvisionReport {
  environments: { slug: string; schemaName: string; roleName: string; created: boolean }[]
}

/**
 * Gives every environment its managed database, and repairs it when something drifted:
 * - a schema `owdb_<environment>` in the platform database, owned by a login role that has no rights on anything
 *   else (not the platform's tables, not other environments' schemas, and no role it could switch to);
 * - the built-in `optiply_db` resource, configured per environment to log in as that role.
 *
 * Idempotent and run at every start (migrate and API). It also repairs what a restore onto another server leaves
 * behind: roles aren't part of a database dump, so a missing role is created again with the stored password, and
 * objects in the schema that the restore gave to another owner are handed back to the role.
 *
 * The role logs in with its own password rather than the platform connecting and running `SET ROLE`: a query could
 * switch back with `set_config('role', …)` in the same statement, since the session user may always do that.
 */
export async function provisionDatabases(
  db: Db,
  keyring: Keyring,
  databaseUrl: string,
): Promise<ProvisionReport> {
  const target = connectionTarget(databaseUrl)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROVISION_LOCK_ID})`)

    const [me] = await tx.execute<{ superuser: boolean; createrole: boolean; database: string }>(sql`
      select rolsuper as superuser, rolcreaterole as createrole, current_database() as database
      from pg_roles where rolname = current_user`)
    if (!me || (!me.superuser && !me.createrole)) {
      throw new DatabaseSetupError(
        "The platform's database user can't create roles. Grant it CREATEROLE (ALTER ROLE <user> CREATEROLE) and restart.",
      )
    }

    const resourceId = await ensureResource(tx as unknown as Db)
    const tag = createHash('md5').update(me.database).digest('hex').slice(0, 6)
    const report: ProvisionReport = { environments: [] }

    for (const env of await tx.select().from(environments).orderBy(environments.createdAt)) {
      const [existing] = await tx
        .select()
        .from(managedDatabases)
        .where(eq(managedDatabases.environmentId, env.id))
      let schemaName = existing?.schemaName
      let roleName = existing?.roleName
      if (!schemaName || !roleName) {
        // Slugs that differ only in characters an identifier can't hold (eu-west, eu_west) would share a
        // schema: a name already taken gets a piece of the environment's id.
        let part = identifierPart(env.slug)
        const taken = await tx.select().from(managedDatabases)
        if (taken.some((m) => m.schemaName === `owdb_${part}` || m.roleName === `owdb_${tag}_${part}`)) {
          part = `${part.slice(0, 33)}_${env.id.replaceAll('-', '').slice(-6)}`
        }
        schemaName = `owdb_${part}`
        roleName = `owdb_${tag}_${part}`
      }
      if (!existing) {
        await tx.insert(managedDatabases).values({ environmentId: env.id, schemaName, roleName })
      }

      const [configRow] = await tx
        .select()
        .from(resourceConfigs)
        .where(and(eq(resourceConfigs.resourceId, resourceId), eq(resourceConfigs.environmentId, env.id)))
      const stored = configRow ? decryptConfigSecrets(keyring, configRow).password : undefined
      const password = typeof stored === 'string' && stored ? stored : randomBytes(24).toString('base64url')

      const role = sql.identifier(roleName)
      const schema = sql.identifier(schemaName)
      const [roleRow] = await tx.execute(sql`select 1 from pg_roles where rolname = ${roleName}`)
      const created = !roleRow
      // Whether the role existed or not, its attributes and password are (re)set: a restored or tampered role
      // gets back to exactly this. The password goes as a SCRAM verifier, never in plain text.
      // Without superuser, attributes like CREATEDB can't even be mentioned unless the platform user has them; new
      // roles start without any, and a role that has them is refused below.
      const restrictions = me.superuser
        ? 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS '
        : ''
      const attributes = sql.raw(
        `LOGIN ${restrictions}NOINHERIT CONNECTION LIMIT 50 PASSWORD ${literal(scramVerifier(password))}`,
      )
      await tx.execute(
        created ? sql`create role ${role} ${attributes}` : sql`alter role ${role} ${attributes}`,
      )
      const [flags] = await tx.execute<{ elevated: boolean }>(sql`
        select rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls as elevated
        from pg_roles where rolname = ${roleName}`)
      if (flags?.elevated) {
        throw new DatabaseSetupError(
          `The role ${roleName} can do more than its schema needs. As a superuser, run ALTER ROLE ${roleName} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS, then restart.`,
        )
      }
      // A role that was granted other roles (by hand, or in an earlier life) loses them: it must not reach further.
      const memberships = await tx.execute<{ name: string }>(sql`
        select r.rolname as name from pg_auth_members m join pg_roles r on r.oid = m.roleid
        where m.member = (select oid from pg_roles where rolname = ${roleName})`)
      for (const m of memberships) await tx.execute(sql`revoke ${sql.identifier(m.name)} from ${role}`)
      // Without superuser, owning things on the role's behalf needs membership in it. (That way round only: the
      // platform user gains the role's rights, never the role the platform's.)
      if (!me.superuser) await tx.execute(sql`grant ${role} to current_user`)
      await tx.execute(sql`alter role ${role} set search_path = ${schema}`)

      await tx.execute(sql`create schema if not exists ${schema} authorization ${role}`)
      await tx.execute(sql`alter schema ${schema} owner to ${role}`)
      await tx.execute(sql`revoke all on schema ${schema} from public`)
      await reassignToRole(tx as unknown as Db, schemaName, roleName)
      // Before Postgres 15, everyone could create tables in `public`; the role must not put things there.
      const [publicCreate] = await tx.execute<{ yes: boolean }>(
        sql`select has_schema_privilege(${roleName}, 'public', 'CREATE') as yes`,
      )
      if (publicCreate?.yes) {
        await tx.execute(sql`revoke create on schema public from public`)
        await tx.execute(sql`revoke create on schema public from ${role}`)
        // Without owning `public`, Postgres only warns and keeps the grant: check it took.
        const [still] = await tx.execute<{ yes: boolean }>(
          sql`select has_schema_privilege(${roleName}, 'public', 'CREATE') as yes`,
        )
        if (still?.yes) {
          throw new DatabaseSetupError(
            `${roleName} can still create objects in the schema public. As public's owner or a superuser, run REVOKE CREATE ON SCHEMA public FROM PUBLIC, then restart.`,
          )
        }
      }

      const config = {
        host: target.host,
        port: target.port,
        database: me.database,
        user: roleName,
        ssl: target.ssl,
        poolSize: 5,
        readOnly: false,
        maxRows: 10_000,
        statementTimeoutMs: 120_000,
      }
      if (!configRow) {
        const id = uuidv7()
        await tx.insert(resourceConfigs).values({
          id,
          resourceId,
          environmentId: env.id,
          config,
          secrets: encryptForRow(keyring, 'resource_configs', { id, environmentId: env.id }, { password }),
        })
      } else if (stored !== password || !sameConfig(configRow, config)) {
        // Only on a real change: a new updatedAt makes the pools reconnect.
        await tx
          .update(resourceConfigs)
          .set({
            config,
            secrets: encryptForRow(keyring, 'resource_configs', configRow, { password }),
            updatedAt: new Date(),
          })
          .where(eq(resourceConfigs.id, configRow.id))
      }
      report.environments.push({ slug: env.slug, schemaName, roleName, created })
    }
    return report
  })
}

/** The built-in resource's id, creating it the first time. A user's own resource with the slug blocks it. */
async function ensureResource(db: Db): Promise<string> {
  const [mine] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.systemKind, 'database'))
  if (mine) return mine.id
  const [taken] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.slug, DATABASE_RESOURCE_SLUG))
  if (taken) {
    throw new DatabaseSetupError(
      `A resource already has the slug "${DATABASE_RESOURCE_SLUG}", which the built-in database needs. Delete or recreate that resource under another slug, then restart.`,
    )
  }
  const [created] = await db
    .insert(resources)
    .values({
      slug: DATABASE_RESOURCE_SLUG,
      name: DATABASE_RESOURCE_NAME,
      type: 'postgres',
      systemKind: 'database',
      description: 'Tables managed in Optiply Workflows, one set per environment.',
    })
    .returning({ id: resources.id })
  return created!.id
}

/** Hands every object in the schema that isn't the role's back to it (a restore makes them the restorer's). */
async function reassignToRole(db: Db, schemaName: string, roleName: string): Promise<void> {
  const foreign = await db.execute<{ name: string; kind: string; args: string | null }>(sql`
    select c.relname as name, c.relkind::text as kind, null as args
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName} and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and pg_get_userbyid(c.relowner) <> ${roleName}
      -- Sequences owned by a table move with it.
      and not (c.relkind = 'S' and exists (
        select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i')))
    union all
    select p.proname, 'function', pg_get_function_identity_arguments(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schemaName} and pg_get_userbyid(p.proowner) <> ${roleName}
    union all
    select t.typname, 'type', null
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = ${schemaName} and t.typtype in ('c', 'd', 'e') and pg_get_userbyid(t.typowner) <> ${roleName}
      and not exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind <> 'c')`)
  const role = sql.identifier(roleName)
  for (const object of foreign) {
    const name = sql`${sql.identifier(schemaName)}.${sql.identifier(object.name)}`
    const what: Record<string, string> = {
      r: 'table',
      p: 'table',
      f: 'foreign table',
      v: 'view',
      m: 'materialized view',
      S: 'sequence',
      function: 'routine',
      type: 'type',
    }
    const kind = sql.raw(what[object.kind]!)
    await db.execute(
      object.kind === 'function'
        ? sql`alter ${kind} ${name}(${sql.raw(object.args ?? '')}) owner to ${role}`
        : sql`alter ${kind} ${name} owner to ${role}`,
    )
  }
}

/** Where the platform's own Postgres is, as the built-in resource reaches it (same host, port and TLS setting). */
export function connectionTarget(databaseUrl: string): {
  host: string
  port: number
  ssl: 'disable' | 'prefer' | 'require' | 'verify-full'
} {
  const url = new URL(databaseUrl)
  const host = url.searchParams.get('host') ?? decodeURIComponent(url.hostname)
  const port = Number(url.port || url.searchParams.get('port') || 5432)
  // postgres.js connects without TLS unless the URL asks for it; the resource does the same.
  const sslmode = url.searchParams.get('sslmode') ?? url.searchParams.get('ssl') ?? 'disable'
  const ssl =
    sslmode === 'require' || sslmode === 'true'
      ? 'require'
      : sslmode === 'verify-ca' || sslmode === 'verify-full'
        ? 'verify-full'
        : sslmode === 'prefer' || sslmode === 'allow'
          ? 'prefer'
          : 'disable'
  return { host, port, ssl }
}

function sameConfig(row: ResourceConfig, config: Record<string, unknown>): boolean {
  const current = row.config
  return (
    Object.entries(config).every(([k, v]) => current[k] === v) &&
    Object.keys(current).length === Object.keys(config).length
  )
}

/** An environment slug as part of an identifier: lowercase letters, digits and underscores, kept short. */
function identifierPart(slug: string): string {
  return (
    slug
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 40) || 'env'
  )
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802/7677), so `PASSWORD '…'` never carries the
 * password itself into statement logs or `pg_stat_statements`.
 */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16)
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}
