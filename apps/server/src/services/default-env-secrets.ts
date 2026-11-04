import type { Keyring } from '@ow/crypto'
import { configVars, configVarValues, type Db, environments } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { decryptForRow } from './secrets'

/**
 * A secret config var's value in the default environment, or null when it isn't a secret, or has no value there.
 * For what serves every environment at once: package indexes' passwords (M32), npm registries' tokens (M33).
 */
export async function defaultEnvSecret(db: Db, keyring: Keyring, name: string): Promise<string | null> {
  const [row] = await db
    .select({ isSecret: configVars.isSecret, value: configVarValues })
    .from(configVars)
    .innerJoin(configVarValues, eq(configVarValues.configVarId, configVars.id))
    .innerJoin(
      environments,
      and(eq(environments.id, configVarValues.environmentId), eq(environments.isDefault, true)),
    )
    .where(eq(configVars.name, name))
  if (!row?.isSecret || !row.value.valueEncrypted) return null
  const plain = String(
    decryptForRow<string>(keyring, 'config_var_values', row.value, row.value.valueEncrypted),
  )
  return plain || null
}
