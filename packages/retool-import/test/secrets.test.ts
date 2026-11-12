import { describe, expect, it } from 'vitest'
import { findSecret, replaceSecret } from '../src'

describe('findSecret', () => {
  it.each([
    ['Bearer abcdefgh12345678', 'Authorization', 'abcdefgh12345678'],
    ['Basic dXNlcjpwYXNzd29yZA==', undefined, 'dXNlcjpwYXNzd29yZA=='],
    ['plainpassword', 'password', 'plainpassword'],
    ['f3a9c2e71b4d4e0a9c8b7a6f5e4d3c2b', 'X-Custom', 'f3a9c2e71b4d4e0a9c8b7a6f5e4d3c2b'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlMTIz',
      undefined,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlMTIz',
    ],
    ['https://x.example.com/a?api_key=secretvalue1&b=2', undefined, 'secretvalue1'],
    ['xoxb-1234567890-abcdefghij', undefined, 'xoxb-1234567890-abcdefghij'],
  ])('finds the secret in %s', (value, name, found) => {
    expect(findSecret(value, name)).toBe(found)
  })

  it.each([
    ['{{ configVars.TOKEN }}', 'Authorization'],
    ['Bearer {{ get_token.data.access_token }}', 'Authorization'],
    ['https://api.example.com/v1/items/3f2b8c1e-9d4a-4e6b-8f0c-1a2b3c4d5e6f', undefined],
    ['application/json', 'Content-Type'],
    ['12345', 'X-Shop-Id'],
    ['short', 'token'],
    ['', 'Authorization'],
  ])('leaves %s alone', (value, name) => {
    expect(findSecret(value, name)).toBeNull()
  })

  it('replaces only the secret', () => {
    expect(replaceSecret('Bearer abcdefgh12345678', 'abcdefgh12345678', 'RETOOL_SECRET_1')).toBe(
      'Bearer {{ configVars.RETOOL_SECRET_1 }}',
    )
  })
})
