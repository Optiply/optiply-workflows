import { describe, expect, it } from 'vitest'
import {
  DecryptionError,
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  generateKey,
  keyVersionOf,
  parseKeyring,
  rekey,
  secretAad,
} from '../src'

const k1 = generateKey()
const k2 = generateKey()
const ring = parseKeyring(`v1:${k1}`)
const aadA = secretAad('resource_configs', 'row-a', 'env-prod')

describe('parseKeyring', () => {
  it('defaults the current key to the last one listed', () => {
    expect(parseKeyring(`v1:${k1},v2:${k2}`).current).toBe('v2')
    expect(parseKeyring(`v1:${k1}, v2:${k2}`, 'v1').current).toBe('v1')
  })

  it('accepts base64url keys', () => {
    const url = Buffer.from(k1, 'base64').toString('base64url')
    expect(parseKeyring(`v1:${url}`).keys.get('v1')).toEqual(Buffer.from(k1, 'base64'))
  })

  it.each([
    ['', /at least one key/],
    ['v1', /<version>:<base64 key>/],
    ['v.1:abc', /<version>:<base64 key>/],
    ['v1:c2hvcnQ=', /32 bytes encoded as base64/],
    [`v1:${k1}AAAA`, /32 bytes encoded as base64/],
    [`v1:${k1.slice(0, 40)}!!!=`, /32 bytes encoded as base64/],
    [`v1:${k1},v1:${k2}`, /duplicate/],
  ])('rejects %j', (spec, error) => {
    expect(() => parseKeyring(spec)).toThrow(error)
  })

  it('rejects an unknown current version', () => {
    expect(() => parseKeyring(`v1:${k1}`, 'v9')).toThrow(/no key with version "v9"/)
  })

  it('never puts key material in errors', () => {
    const bad = `v1:${k1}AAAA`
    expect(() => parseKeyring(bad)).toThrow()
    try {
      parseKeyring(bad)
    } catch (e) {
      expect((e as Error).message).not.toContain(k1)
    }
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips text and JSON', () => {
    expect(decrypt(ring, encrypt(ring, 'hunter2 ✓', aadA), aadA)).toBe('hunter2 ✓')
    const secrets = { password: 'p@ss', nested: { token: 't' } }
    expect(decryptJson(ring, encryptJson(ring, secrets, aadA), aadA)).toEqual(secrets)
  })

  it('uses a fresh IV per encryption', () => {
    expect(encrypt(ring, 'same', aadA)).not.toBe(encrypt(ring, 'same', aadA))
  })

  it('tags tokens with the key version and does not leak the plaintext', () => {
    const token = encrypt(ring, 'super-secret-password', aadA)
    expect(keyVersionOf(token)).toBe('v1')
    expect(token).not.toContain('super-secret-password')
  })

  it('fails when a ciphertext is swapped into another row or environment', () => {
    const token = encrypt(ring, 'secret', aadA)
    expect(() => decrypt(ring, token, secretAad('resource_configs', 'row-b', 'env-prod'))).toThrow(
      DecryptionError,
    )
    expect(() => decrypt(ring, token, secretAad('resource_configs', 'row-a', 'env-staging'))).toThrow(
      DecryptionError,
    )
    expect(() => decrypt(ring, token, secretAad('config_var_values', 'row-a', 'env-prod'))).toThrow(
      DecryptionError,
    )
  })

  it('fails on tampering', () => {
    const [v, iv, ct, tag] = encrypt(ring, 'secret value', aadA).split('.') as [
      string,
      string,
      string,
      string,
    ]
    const flip = (s: string) => {
      const b = Buffer.from(s, 'base64url')
      b[0]! ^= 1
      return b.toString('base64url')
    }
    for (const token of [
      [v, flip(iv), ct, tag],
      [v, iv, flip(ct), tag],
      [v, iv, ct, flip(tag)],
      [v, iv, ct, tag.slice(0, 8)],
    ]) {
      expect(() => decrypt(ring, token.join('.'), aadA)).toThrow(DecryptionError)
    }
    expect(() => decrypt(ring, 'garbage', aadA)).toThrow(/Malformed/)
  })

  it('fails with the wrong key or an unknown version', () => {
    const token = encrypt(ring, 'secret', aadA)
    expect(() => decrypt(parseKeyring(`v1:${k2}`), token, aadA)).toThrow(DecryptionError)
    expect(() => decrypt(parseKeyring(`v2:${k1}`), token, aadA)).toThrow(
      /Unknown encryption key version "v1"/,
    )
  })

  it('validates AAD parts', () => {
    expect(secretAad('config_vars', 'id', null)).toBe('config_vars:id:-')
    expect(() => secretAad('t', 'a:b', null)).toThrow()
    expect(() => secretAad('t', '', 'env')).toThrow()
  })
})

describe('rekey', () => {
  it('re-encrypts old tokens under the current key and skips current ones', () => {
    const old = encrypt(ring, 'secret', aadA)
    const rotated = parseKeyring(`v1:${k1},v2:${k2}`)
    const fresh = rekey(rotated, old, aadA)!
    expect(keyVersionOf(fresh)).toBe('v2')
    expect(decrypt(parseKeyring(`v2:${k2}`), fresh, aadA)).toBe('secret')
    expect(rekey(rotated, fresh, aadA)).toBeNull()
  })

  it('refuses to rekey a token bound to a different row', () => {
    const rotated = parseKeyring(`v1:${k1},v2:${k2}`)
    expect(() =>
      rekey(rotated, encrypt(ring, 's', aadA), secretAad('resource_configs', 'other', null)),
    ).toThrow(DecryptionError)
  })
})
