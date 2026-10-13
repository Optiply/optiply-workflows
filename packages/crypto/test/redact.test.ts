import { describe, expect, it } from 'vitest'
import {
  generateApiKey,
  hashApiKey,
  REDACTED,
  redact,
  scrubSecrets,
  scrubSecretsDeep,
  secretStrings,
  verifyApiKey,
} from '../src'

describe('redact', () => {
  it('replaces values under secret-looking keys, recursively', () => {
    expect(
      redact({
        name: 'db',
        password: 'p',
        nested: [{ apiKey: 'k', api_key: 'k', host: 'h' }],
        Authorization: 'Bearer x',
        clientSecret: 's',
      }),
    ).toEqual({
      name: 'db',
      password: REDACTED,
      nested: [{ apiKey: REDACTED, api_key: REDACTED, host: 'h' }],
      Authorization: REDACTED,
      clientSecret: REDACTED,
    })
  })
})

describe('scrubSecrets', () => {
  it('removes secret values from free text, longest first', () => {
    const msg = 'password authentication failed for "admin" using hunter2hunter2 (hunter2)'
    expect(scrubSecrets(msg, ['hunter2', 'hunter2hunter2'])).toBe(
      `password authentication failed for "admin" using ${REDACTED} (${REDACTED})`,
    )
  })

  it('ignores very short values that would match unrelated text', () => {
    expect(scrubSecrets('a b c', ['a', ''])).toBe('a b c')
  })

  it('collects string leaves and scrubs deep values', () => {
    const secrets = secretStrings({ password: 's3cret-pw', oauth: { clientSecret: 'cs-123456' }, n: 5 })
    expect(secrets).toEqual(['s3cret-pw', 'cs-123456'])
    expect(scrubSecretsDeep({ error: { message: 'bad s3cret-pw', list: ['cs-123456'] } }, secrets)).toEqual({
      error: { message: `bad ${REDACTED}`, list: [REDACTED] },
    })
  })
})

describe('api keys', () => {
  it('generates prefixed keys that verify against their hash only', () => {
    const { key, prefix, hash } = generateApiKey()
    expect(key).toMatch(/^ow_[A-Za-z0-9_-]{43}$/)
    expect(key.startsWith(prefix)).toBe(true)
    expect(prefix).toHaveLength(11)
    expect(hash).toBe(hashApiKey(key))
    expect(verifyApiKey(key, hash)).toBe(true)
    expect(verifyApiKey(`${key}x`, hash)).toBe(false)
    expect(verifyApiKey(key, 'abcd')).toBe(false)
  })
})
