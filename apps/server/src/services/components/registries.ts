import type { Keyring } from '@ow/crypto'
import { type Db, npmRegistries } from '@ow/db'
import { asc } from 'drizzle-orm'
import { defaultEnvSecret } from '../default-env-secrets'

/** A registry as a build's npm gets it (M33): its scope (null: every other package), URL and token. */
export interface NpmRegistryAccess {
  scope: string | null
  url: string
  token?: string
}

/**
 * The admins' npm registries for a build, their tokens read from their config vars in the default environment. A
 * token var without a value there fails the build, naming it (a registry asking for a token would only say 401).
 */
export async function npmRegistryAccess(
  db: Db,
  keyring: Keyring | undefined,
): Promise<{ ok: true; registries: NpmRegistryAccess[] } | { ok: false; message: string }> {
  const rows = await db.select().from(npmRegistries).orderBy(asc(npmRegistries.scope))
  const registries: NpmRegistryAccess[] = []
  for (const row of rows) {
    const entry: NpmRegistryAccess = { scope: row.scope, url: row.url }
    if (row.tokenConfigVar) {
      const token = keyring ? await defaultEnvSecret(db, keyring, row.tokenConfigVar) : null
      if (!token) {
        return {
          ok: false,
          message: `The npm registry for ${row.scope ?? 'all packages'} takes its token from the config var ${row.tokenConfigVar}, which isn't a secret with a value in the default environment`,
        }
      }
      entry.token = token
    }
    registries.push(entry)
  }
  return { ok: true, registries }
}

/** npm's key for a registry's credentials: its URL without the protocol, ending in `/` (`//npm.acme.com/path/`). */
export function npmAuthKey(url: string): string {
  const u = new URL(url)
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`
  return `//${u.host}${path}`
}
