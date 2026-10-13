import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Keyring } from './keyring'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Thrown when a token is malformed, uses an unknown key, was tampered with, or belongs to another row. */
export class DecryptionError extends Error {
  override name = 'DecryptionError'
}

/**
 * Additional authenticated data binding a ciphertext to where it is stored, so a ciphertext copied into another
 * row (or environment) fails to decrypt. Values that aren't environment-specific pass `null`.
 */
export function secretAad(table: string, rowId: string, environmentId: string | null): string {
  const parts = [table, rowId, environmentId ?? '-']
  if (parts.some((p) => !p || p.includes(':')))
    throw new Error('secretAad: parts must be non-empty and colon-free')
  return parts.join(':')
}

/** Encrypts with the current key. The token is `<version>.<iv>.<ciphertext>.<tag>` (base64url parts). */
export function encrypt(keyring: Keyring, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyring.keys.get(keyring.current)!, iv, {
    authTagLength: TAG_BYTES,
  })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [keyring.current, iv, ciphertext, cipher.getAuthTag()]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.')
}

export function decrypt(keyring: Keyring, token: string, aad: string): string {
  const parts = token.split('.')
  if (parts.length !== 4) throw new DecryptionError('Malformed ciphertext')
  const [version, iv, ciphertext, tag] = parts as [string, string, string, string]
  const key = keyring.keys.get(version)
  if (!key) throw new DecryptionError(`Unknown encryption key version "${version}"`)
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'), {
      authTagLength: TAG_BYTES,
    })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    throw new DecryptionError('Ciphertext failed authentication')
  }
}

export function encryptJson(keyring: Keyring, value: unknown, aad: string): string {
  return encrypt(keyring, JSON.stringify(value), aad)
}

export function decryptJson<T = unknown>(keyring: Keyring, token: string, aad: string): T {
  return JSON.parse(decrypt(keyring, token, aad)) as T
}

export function keyVersionOf(token: string): string {
  return token.slice(0, token.indexOf('.'))
}

/** Re-encrypts a token under the current key, or returns `null` if it already uses it (used by the rekey CLI). */
export function rekey(keyring: Keyring, token: string, aad: string): string | null {
  if (keyVersionOf(token) === keyring.current) return null
  return encrypt(keyring, decrypt(keyring, token, aad), aad)
}
