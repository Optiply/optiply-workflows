import { createHash } from 'node:crypto'
import {
  ConnectorError,
  checkSshIap,
  normalizeSsh,
  parseServiceAccountKey,
  type ResolvedResource,
  readPrivateKey,
  type SshConfig,
  SshKeyError,
  type SshSecrets,
  sshCredentials,
} from '@ow/connectors'
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

/**
 * A config's SSH tunnel as it's saved or tested (M17): a hop moved to another host or port loses its trusted host key,
 * secrets are kept only for hops still there (and only what each signs in with), and every hop's key or password is
 * checked (a key that's missing, unreadable or locked by another passphrase is refused: `SshSettingsError`), and so is
 * the way through Google IAP (M18: a service account key that is one, or the server's identity where it's allowed).
 */
export function settleSsh(
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
): { config: Record<string, unknown>; secrets: Record<string, unknown> } {
  if (config.ssh === undefined && secrets.ssh === undefined) return { config, secrets }
  const settled = normalizeSsh(config.ssh as SshConfig | undefined, secrets.ssh as SshSecrets | undefined)
  const { ssh: _c, ...restConfig } = config
  const { ssh: _s, ...restSecrets } = secrets
  if (settled.ssh) {
    sshCredentials(settled.ssh, settled.secrets)
    checkSshIap(settled.ssh, settled.secrets)
  }
  return {
    config: settled.ssh ? { ...restConfig, ssh: settled.ssh } : restConfig,
    secrets: settled.secrets ? { ...restSecrets, ssh: settled.secrets } : restSecrets,
  }
}

/** What the settings show of an SSH key (M17): never the key, only what identifies it. */
export type SshKeyInfo = { type: string; fingerprint: string; publicKey: string } | { error: string }

/**
 * Each hop's key, as the settings show it: its type, fingerprint and public half (the `authorized_keys` line), or
 * why it can't be read. Hops signing in with a password have none.
 */
export function sshKeyInfo(secrets: Record<string, unknown>): Record<string, SshKeyInfo> | null {
  const hops = secrets.ssh as Record<string, { privateKey?: string; passphrase?: string }> | undefined
  if (!hops) return null
  const out: Record<string, SshKeyInfo> = {}
  for (const [hop, s] of Object.entries(hops)) {
    if (s.privateKey) out[hop] = keyInfo(s.privateKey, s.passphrase)
  }
  return out
}

/** What the settings show of a hop's IAP key (M18): the service account it signs in as, or why it can't be read. */
export type IapKeyInfo = { clientEmail: string } | { error: string }

export function iapKeyInfo(secrets: Record<string, unknown>): Record<string, IapKeyInfo> | null {
  const hops = secrets.ssh as Record<string, { iapKey?: string }> | undefined
  if (!hops) return null
  const out: Record<string, IapKeyInfo> = {}
  for (const [hop, s] of Object.entries(hops)) {
    if (!s.iapKey) continue
    try {
      out[hop] = { clientEmail: parseServiceAccountKey(s.iapKey, `ssh.${hop}.iapKey`).client_email }
    } catch (err) {
      if (!(err instanceof ConnectorError)) throw err
      out[hop] = { error: err.message }
    }
  }
  return out
}

/**
 * What a config reaches with the server's own Google identity or AWS credentials, or null when it doesn't use them: the
 * VM its first SSH server is reached at through IAP (M18), as `project/zone/instance/interface:port`, or an AWS
 * resource's region and role (M26), as `aws:<region>:<role>`. Only admins may choose it or point it elsewhere: the
 * server's identity may reach what no one's key does.
 */
export function serverIdentityTarget(config: unknown, type?: string): string | null {
  if (type === 's3') {
    // M26: the server's own AWS credentials: the region and any role assumed with them
    // (they may be allowed to assume roles no one's key is).
    const c = config as { identity?: unknown; region?: unknown; roleArn?: unknown } | null
    if (c?.identity !== 'server') return null
    return `aws:${String(c.region ?? '')}:${String(c.roleArn ?? '')}`
  }
  if (type === 'sdk') {
    // M37: an SDK whose hosts may be on the private network reaches what the instance does; an admin's call.
    return (config as { allowPrivateNetwork?: unknown } | null)?.allowPrivateNetwork === true
      ? 'sdk:private'
      : null
  }
  if (type === 'gmail') {
    // M37: a key with domain-wide delegation acts as any mailbox of the domain; choosing it is an admin's call.
    const c = config as { auth?: { type?: unknown } } | null
    return c?.auth?.type === 'delegation' ? 'gmail:delegation' : null
  }
  if (type === 'gemini') {
    // M37: Vertex AI billed to a project the server's identity can use; choosing it is the admin's call.
    const c = config as {
      platform?: unknown
      identity?: unknown
      project?: unknown
      location?: unknown
    } | null
    return c?.platform === 'vertex' && c.identity === 'server'
      ? `vertex:${String(c.project ?? '')}:${String(c.location ?? 'global')}`
      : null
  }
  if (type === 'googlesheets') {
    // M27: any spreadsheet shared with the server's identity; choosing it is the admin's call.
    const c = config as { auth?: { type?: unknown } } | null
    return c?.auth?.type === 'server' ? 'google:sheets' : null
  }
  const hop = (config as { ssh?: SshConfig } | null)?.ssh?.hops[0]
  if (hop?.reach !== 'iap' || hop.iap?.identity !== 'server') return null
  const { project, zone, instance, interface: nic } = hop.iap
  return `${project}/${zone}/${instance}/${nic}:${hop.port}`
}

/**
 * What's shown of a key, remembered by a hash of the key and passphrase: reading a PuTTY v3 key runs Argon2, and every
 * settings page would otherwise pay it for each environment and hop. Only public details are kept.
 */
const keyInfos = new Map<string, SshKeyInfo>()
const KEY_INFOS_MAX = 100

function keyInfo(privateKey: string, passphrase: string | undefined): SshKeyInfo {
  const id = createHash('sha256')
    .update(privateKey)
    .update('\0')
    .update(passphrase ?? '')
    .digest('base64')
  const known = keyInfos.get(id)
  if (known) return known
  let info: SshKeyInfo
  try {
    const key = readPrivateKey(privateKey, passphrase)
    info = { type: key.type, fingerprint: key.fingerprint, publicKey: key.publicKey }
  } catch (err) {
    if (!(err instanceof SshKeyError)) throw err
    info = { error: err.message }
  }
  if (keyInfos.size >= KEY_INFOS_MAX) keyInfos.delete(keyInfos.keys().next().value!)
  keyInfos.set(id, info)
  return info
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

/** An override's path: a config field, or one inside nested settings (`ssh.host`). */
export const OVERRIDE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/

/** Keys a path never walks: they'd reach the prototype (an override of `__proto__.x` would change every object). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Whether `path` names a setting an override may set: `OVERRIDE_PATH`, no prototype keys. */
export function isOverridePath(path: string): boolean {
  return OVERRIDE_PATH.test(path) && !path.split('.').some((key) => UNSAFE_KEYS.has(key))
}

/**
 * `config` with this instance's overrides on top (M22): each value set at its path, making objects on the way (a
 * value that isn't an object there is replaced). `config` itself is left alone.
 */
export function applyOverrides(
  config: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const paths = Object.keys(overrides)
  if (paths.length === 0) return config
  const out = structuredClone(config)
  for (const path of paths.sort()) {
    // Stored overrides were checked when saved; skipping unsafe ones here too keeps a bad row from reaching them.
    if (!isOverridePath(path)) continue
    const keys = path.split('.')
    let target = out
    for (const key of keys.slice(0, -1)) {
      const next = Object.hasOwn(target, key) ? target[key] : undefined
      if (typeof next !== 'object' || next === null || Array.isArray(next)) target[key] = {}
      target = target[key] as Record<string, unknown>
    }
    target[keys.at(-1)!] = overrides[path]
  }
  return out
}

/** The config a resource runs with in an environment: the stored one (Git's, when protected) and the overrides. */
export function effectiveConfig(row: Pick<ResourceConfig, 'config' | 'overrides'>): Record<string, unknown> {
  return applyOverrides(row.config, row.overrides)
}

/** A config row as connectors need it. The version changes on every save, so pooled clients are replaced. */
export function toResolved(keyring: Keyring, row: ResourceConfig): ResolvedResource {
  return {
    id: row.id,
    resourceId: row.resourceId,
    environmentId: row.environmentId,
    version: row.updatedAt.toISOString(),
    config: effectiveConfig(row),
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
