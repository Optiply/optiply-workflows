import { z } from 'zod'
import { readPrivateKey, type SshKey, SshKeyError } from './keys'

/** The SSH server and at most two jump hosts before it. */
export const SSH_MAX_HOPS = 3

/** A VM reached through Google Cloud IAP (M18), and whose Google identity opens the tunnel. */
const iapSchema = z.object({
  project: z.string().trim().min(1),
  zone: z.string().trim().min(1),
  instance: z.string().trim().min(1),
  interface: z.string().trim().min(1).default('nic0'),
  /** A service account key kept with the settings (`iapKey`), or the server's own identity (if the instance allows). */
  identity: z.enum(['key', 'server']).default('key'),
})

const hopSchema = z.preprocess(
  // Through IAP the server is the VM: its name is the host the messages and the form show.
  (hop) => {
    const h = hop as { reach?: unknown; host?: unknown; iap?: { instance?: unknown } } | null
    return h && h.reach === 'iap' && !h.host && h.iap?.instance ? { ...h, host: h.iap.instance } : hop
  },
  z.object({
    /** Stable within the config: the hop's secrets are kept under it, so removing a jump host shifts nothing. */
    id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    /** How the first server is reached: at `host:port` (left out), or through Google Cloud IAP to the VM's `port` (M18). */
    reach: z.enum(['direct', 'iap']).optional(),
    iap: iapSchema.optional(),
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().trim().min(1),
    auth: z.enum(['key', 'password']).default('key'),
    /** The server's host key as trusted in Test connection; without one, connecting is refused. */
    hostKey: z
      .object({ algorithm: z.string().min(1), fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/) })
      .optional(),
  }),
)

/**
 * A resource configuration's SSH tunnel (M17, architecture §2.20): `hops` in the order they're connected to; the first
 * is reached directly, each next one through the one before, and the last connects to the resource's host and port.
 */
export const sshConfigSchema = z
  .object({ hops: z.array(hopSchema).min(1).max(SSH_MAX_HOPS) })
  .refine((ssh) => new Set(ssh.hops.map((h) => h.id)).size === ssh.hops.length, {
    message: 'Each SSH server needs its own id',
    path: ['hops'],
  })
  .superRefine((ssh, ctx) => {
    for (const [i, hop] of ssh.hops.entries()) {
      if (hop.reach !== 'iap') continue
      // Only the first server is reached from here; the others through the one before.
      if (i > 0)
        ctx.addIssue({
          code: 'custom',
          message: 'Only the first SSH server can be reached through Google IAP',
          path: ['hops', i, 'reach'],
        })
      else if (!hop.iap)
        ctx.addIssue({
          code: 'custom',
          message: 'Name the VM: its project, zone and instance',
          path: ['hops', i, 'iap'],
        })
    }
  })

/** Per hop id: its private key (and passphrase) or password. Write-only, like every secret. */
export const sshSecretsSchema = z.record(
  z.string(),
  z.object({
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    password: z.string().optional(),
    /** The service account key (JSON) that opens the IAP tunnel to this hop (M18). */
    iapKey: z.string().optional(),
  }),
)

export type SshConfig = z.output<typeof sshConfigSchema>
export type SshHop = SshConfig['hops'][number]
export type SshSecrets = z.output<typeof sshSecretsSchema>

/** What one hop signs in with. */
export type SshCredential = { key: SshKey } | { password: string }

/** Wrong SSH settings, with the hop they're about; never a secret's value. */
export class SshSettingsError extends Error {
  override name = 'SshSettingsError'
  constructor(
    readonly hopId: string,
    readonly field: 'privateKey' | 'passphrase' | 'password' | 'iapKey',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Settings as they're saved: secrets are kept only for hops that are still there, and only those their way of signing
 * in uses. A hop's trusted host key stays as sent, even if its host or port changed: what's trusted is the key, and
 * another server presents another one (refused); the settings form clears it on such an edit anyway.
 */
export function normalizeSsh(
  ssh: SshConfig | undefined,
  secrets: SshSecrets | undefined,
): { ssh: SshConfig | undefined; secrets: SshSecrets | undefined } {
  if (!ssh) return { ssh: undefined, secrets: undefined }
  const { hops } = ssh
  const kept: SshSecrets = {}
  for (const hop of hops) {
    const s = secrets?.[hop.id]
    if (!s) continue
    const used = {
      ...(hop.auth === 'key'
        ? { privateKey: s.privateKey, passphrase: s.passphrase }
        : { password: s.password }),
      ...(hop.reach === 'iap' && hop.iap?.identity === 'key' ? { iapKey: s.iapKey } : {}),
    }
    const defined = Object.fromEntries(Object.entries(used).filter(([, v]) => v !== undefined))
    if (Object.keys(defined).length) kept[hop.id] = defined
  }
  return { ssh: { hops }, secrets: Object.keys(kept).length ? kept : undefined }
}

/**
 * Each hop's credential, read and checked: a key that's there and opens with its passphrase, or a password. Throws
 * `SshSettingsError` naming the hop.
 */
export function sshCredentials(ssh: SshConfig, secrets: SshSecrets | undefined): Map<string, SshCredential> {
  const out = new Map<string, SshCredential>()
  for (const hop of ssh.hops) {
    const s = secrets?.[hop.id]
    const where = `SSH server ${hop.host}`
    if (hop.auth === 'password') {
      if (!s?.password) throw new SshSettingsError(hop.id, 'password', `${where}: enter the password`)
      out.set(hop.id, { password: s.password })
      continue
    }
    if (!s?.privateKey) throw new SshSettingsError(hop.id, 'privateKey', `${where}: add a private key`)
    try {
      out.set(hop.id, { key: readPrivateKey(s.privateKey, s.passphrase) })
    } catch (err) {
      if (!(err instanceof SshKeyError)) throw err
      const field =
        err.code === 'passphrase_needed' || err.code === 'wrong_passphrase' ? 'passphrase' : 'privateKey'
      throw new SshSettingsError(hop.id, field, `${where}: ${err.message}`)
    }
  }
  return out
}
