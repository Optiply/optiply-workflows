import { z } from 'zod'
import { readPrivateKey, type SshKey, SshKeyError } from './keys'

/** The SSH server and at most two jump hosts before it. */
export const SSH_MAX_HOPS = 3

const hopSchema = z.object({
  /** Stable within the config: the hop's secrets are kept under it, so removing a jump host shifts nothing. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1),
  auth: z.enum(['key', 'password']).default('key'),
  /** The server's host key as trusted in Test connection; without one, connecting is refused. */
  hostKey: z
    .object({ algorithm: z.string().min(1), fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/) })
    .optional(),
})

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

/** Per hop id: its private key (and passphrase) or password. Write-only, like every secret. */
export const sshSecretsSchema = z.record(
  z.string(),
  z.object({
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    password: z.string().optional(),
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
    readonly field: 'privateKey' | 'passphrase' | 'password',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Settings as they're saved: a hop whose host or port changed loses its trusted host key (it's another server), and
 * secrets are kept only for hops that are still there, and only those their way of signing in uses.
 */
export function normalizeSsh(
  before: SshConfig | undefined,
  ssh: SshConfig | undefined,
  secrets: SshSecrets | undefined,
): { ssh: SshConfig | undefined; secrets: SshSecrets | undefined } {
  if (!ssh) return { ssh: undefined, secrets: undefined }
  const previous = new Map((before?.hops ?? []).map((h) => [h.id, h]))
  const hops = ssh.hops.map((hop) => {
    const old = previous.get(hop.id)
    const moved = old !== undefined && (old.host !== hop.host || old.port !== hop.port)
    // The pin it had was the old server's; one trusted since (another fingerprint) is the new server's.
    return moved && hop.hostKey && old?.hostKey?.fingerprint === hop.hostKey.fingerprint
      ? withoutPin(hop)
      : hop
  })
  const kept: SshSecrets = {}
  for (const hop of hops) {
    const s = secrets?.[hop.id]
    if (!s) continue
    const used =
      hop.auth === 'key' ? { privateKey: s.privateKey, passphrase: s.passphrase } : { password: s.password }
    const defined = Object.fromEntries(Object.entries(used).filter(([, v]) => v !== undefined))
    if (Object.keys(defined).length) kept[hop.id] = defined
  }
  return { ssh: { hops }, secrets: Object.keys(kept).length ? kept : undefined }
}

function withoutPin(hop: SshHop): SshHop {
  const { hostKey: _, ...rest } = hop
  return rest
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
