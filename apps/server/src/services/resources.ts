import type { ResolvedResource } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import { configVars, configVarValues, type Db, type ResourceConfig } from '@ow/db'
import { and, eq } from 'drizzle-orm'
import { decryptForRow } from './secrets'

/** What the browser sees instead of a secret value. */
export type SecretMask = { set: true } | { [key: string]: SecretMask }

/** Replaces every value with `{ set: true }`, keeping the shape (e.g. `headers: { 'x-token': { set: true } }`). */
export function maskSecrets(secrets: unknown): Record<string, SecretMask> {
  const mask = (value: unknown): SecretMask =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]))
      : { set: true }
  if (!secrets || typeof secrets !== 'object') return {}
  return Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, mask(v)]))
}

/**
 * Applies a write-only patch from the browser: a string sets a value, `null` removes it, an object patches a nested
 * record (e.g. secret headers), and keys that are absent stay as they are. The browser never needs the old values.
 */
export function applySecretPatch(
  current: unknown,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete base[key]
    else if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = applySecretPatch(base[key], value as Record<string, unknown>)
      if (Object.keys(nested).length) base[key] = nested
      else delete base[key]
    } else if (value !== undefined) base[key] = value
  }
  return base
}

/** Names of the top-level secret fields a patch touches (for the audit log; never values). */
export function patchedSecretFields(patch: Record<string, unknown> | undefined): string[] {
  return Object.keys(patch ?? {}).sort()
}

export function decryptConfigSecrets(keyring: Keyring, row: ResourceConfig): Record<string, unknown> {
  return row.secrets
    ? decryptForRow<Record<string, unknown>>(keyring, 'resource_configs', row, row.secrets)
    : {}
}

/** A config row as connectors need it. The version changes on every save, so pooled clients are replaced. */
export function toResolved(keyring: Keyring, row: ResourceConfig): ResolvedResource {
  return {
    id: row.id,
    resourceId: row.resourceId,
    environmentId: row.environmentId,
    version: row.updatedAt.toISOString(),
    config: row.config,
    secrets: decryptConfigSecrets(keyring, row),
  }
}

/**
 * Non-secret config var values for one environment, as exposed to `{{ configVars.NAME }}` in the query playground.
 * Secret values are left out: anyone who can run a query could otherwise read them back
 * (`select {{ configVars.TOKEN }}`). They become available to released workflows in a later milestone.
 */
export async function publicConfigVars(db: Db, environmentId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ name: configVars.name, value: configVarValues.value })
    .from(configVars)
    .innerJoin(
      configVarValues,
      and(eq(configVarValues.configVarId, configVars.id), eq(configVarValues.environmentId, environmentId)),
    )
    .where(eq(configVars.isSecret, false))
  return Object.fromEntries(rows.flatMap((r) => (r.value === null ? [] : [[r.name, r.value]])))
}
