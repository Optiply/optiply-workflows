import { createHash } from 'node:crypto'
import { configureJdbcDrivers } from '@ow/connectors'
import { type Db, jdbcDrivers, resourceConfigs, resources } from '@ow/db'
import { and, eq, sql } from 'drizzle-orm'

// JDBC drivers admins upload (M38, docs/architecture.md §2.42): stored in the database, sent to the JDBC runner the
// first time a resource needs one (by its SHA-256).

export const JDBC_DRIVER_MAX_BYTES = 100 * 1024 * 1024
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/

export class JdbcDriverError extends Error {
  override name = 'JdbcDriverError'
}

/** Lets JDBC resources find their uploaded driver; the jar is read only when the runner asks for it. */
export function configureJdbcDriverLookup(db: Db): void {
  configureJdbcDrivers(async (id) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const [row] = await db
      .select({ sha256: jdbcDrivers.sha256, className: jdbcDrivers.className })
      .from(jdbcDrivers)
      .where(eq(jdbcDrivers.id, id))
    if (!row) return null
    return {
      ...row,
      jar: async () => {
        const [found] = await db
          .select({ jar: jdbcDrivers.jar })
          .from(jdbcDrivers)
          .where(eq(jdbcDrivers.id, id))
        if (!found) throw new JdbcDriverError('The driver was deleted')
        return found.jar
      },
    }
  })
}

/** Checks and keeps an uploaded jar: a zip, a driver class name, a name of its own. */
export async function storeJdbcDriver(
  db: Db,
  input: { name: string; className: string; fileName: string; jar: Uint8Array; uploadedBy: string },
): Promise<{ id: string; sha256: string; size: number }> {
  const name = input.name.trim()
  const className = input.className.trim()
  if (!name || name.length > 100) throw new JdbcDriverError('Give the driver a name (at most 100 characters)')
  if (!CLASS_NAME.test(className) || className.length > 300) {
    throw new JdbcDriverError('The driver class is a Java class name, e.g. com.ibm.db2.jcc.DB2Driver')
  }
  if (!input.jar.length) throw new JdbcDriverError('The jar is empty')
  if (input.jar.length > JDBC_DRIVER_MAX_BYTES) throw new JdbcDriverError('A driver jar is at most 100 MB')
  // A jar is a zip: it starts with a local file header.
  if (input.jar[0] !== 0x50 || input.jar[1] !== 0x4b || input.jar[2] !== 0x03 || input.jar[3] !== 0x04) {
    throw new JdbcDriverError("That file isn't a jar")
  }
  const sha256 = createHash('sha256').update(input.jar).digest('hex')
  const fileName = (input.fileName.trim() || 'driver.jar').slice(0, 200)
  try {
    const [row] = await db
      .insert(jdbcDrivers)
      .values({
        name,
        className,
        fileName,
        sha256,
        size: input.jar.length,
        jar: input.jar,
        uploadedBy: input.uploadedBy,
      })
      .returning({ id: jdbcDrivers.id })
    return { id: row!.id, sha256, size: input.jar.length }
  } catch (err) {
    // A unique-constraint violation, possibly wrapped by drizzle.
    const code =
      (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code
    if (code === '23505') throw new JdbcDriverError(`A driver named "${name}" exists already`)
    throw err
  }
}

/** The JDBC resources whose settings (in any environment) use this driver. */
export async function jdbcDriverUsers(db: Db, id: string): Promise<{ id: string; name: string }[]> {
  return db
    .selectDistinct({ id: resources.id, name: resources.name })
    .from(resourceConfigs)
    .innerJoin(resources, eq(resources.id, resourceConfigs.resourceId))
    .where(and(eq(resources.type, 'jdbc'), sql`${resourceConfigs.config}->>'driverId' = ${id}`))
}
