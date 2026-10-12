import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LEN = 64

/** Format: `scrypt$N$r$p$salt$hash` (base64url) so parameters can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, KEY_LEN, PARAMS)
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$')
  if (algo !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
