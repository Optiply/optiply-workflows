import { randomBytes } from 'node:crypto'

/** Key versions appear inside ciphertext tokens (`<version>.<iv>.<ct>.<tag>`), so they can't contain dots. */
const VERSION = /^[A-Za-z0-9_-]{1,16}$/
const KEY_BYTES = 32
/** 32 bytes as base64 or base64url, padded or not. Checked up front because Node's decoder skips junk silently. */
const KEY_TEXT = /^[A-Za-z0-9+/_-]{43}=?$/

export interface Keyring {
  /** Version used for new encryptions. */
  readonly current: string
  readonly keys: ReadonlyMap<string, Buffer>
}

/**
 * Parses `ENCRYPTION_KEYS` (`v1:<base64>,v2:<base64>`, each key 32 random bytes) and picks the current version
 * (`ENCRYPTION_KEY_CURRENT`, defaulting to the last one listed). Errors never include key material.
 */
export function parseKeyring(spec: string, current?: string): Keyring {
  const keys = new Map<string, Buffer>()
  for (const entry of spec.split(',').map((s) => s.trim())) {
    if (!entry) continue
    const sep = entry.indexOf(':')
    const version = sep > 0 ? entry.slice(0, sep) : ''
    if (!VERSION.test(version)) {
      throw new Error('ENCRYPTION_KEYS: each entry must look like "<version>:<base64 key>", e.g. "v1:…"')
    }
    if (keys.has(version)) throw new Error(`ENCRYPTION_KEYS: duplicate key version "${version}"`)
    const text = entry.slice(sep + 1)
    if (!KEY_TEXT.test(text)) {
      throw new Error(`ENCRYPTION_KEYS: key "${version}" must be ${KEY_BYTES} bytes encoded as base64`)
    }
    const key = Buffer.from(text, 'base64')
    keys.set(version, key)
  }
  if (keys.size === 0) throw new Error('ENCRYPTION_KEYS: at least one key is required')
  const chosen = current ?? [...keys.keys()].at(-1)!
  if (!keys.has(chosen)) throw new Error(`ENCRYPTION_KEY_CURRENT: no key with version "${chosen}"`)
  return { current: chosen, keys }
}

/** A fresh base64 key for `ENCRYPTION_KEYS`. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64')
}
