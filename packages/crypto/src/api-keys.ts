import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const PREFIX = 'ow_'

export interface GeneratedApiKey {
  /** Shown to the user once; never stored. */
  key: string
  /** Stored and displayed so users can tell keys apart (`ow_` plus the first 8 characters). */
  prefix: string
  /** Stored; lookups go by hash. */
  hash: string
}

export function generateApiKey(): GeneratedApiKey {
  const key = PREFIX + randomBytes(32).toString('base64url')
  return { key, prefix: key.slice(0, PREFIX.length + 8), hash: hashApiKey(key) }
}

/** sha256 hex. Keys are 256 random bits, so a fast unsalted hash is enough and allows indexed lookup. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function verifyApiKey(key: string, hash: string): boolean {
  const actual = Buffer.from(hashApiKey(key), 'hex')
  const expected = Buffer.from(hash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
