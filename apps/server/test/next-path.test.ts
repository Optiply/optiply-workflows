import { describe, expect, it } from 'vitest'
import { safeNextPath } from '../src/auth/next-path'

const SITE = 'https://workflows.example.com'

describe('safeNextPath: where a sign-in may send someone back to', () => {
  it('keeps a page of the web app, with its query and fragment', () => {
    expect(safeNextPath('/apps/abc', SITE)).toBe('/apps/abc')
    expect(safeNextPath('/workflows/w1?env=staging#runs', SITE)).toBe('/workflows/w1?env=staging#runs')
    // Resolved as the browser would: dot segments fold, still on this site.
    expect(safeNextPath('/apps/../workflows', SITE)).toBe('/workflows')
  })

  it('drops other sites and the tricks that reach one', () => {
    for (const raw of [
      'https://evil.example.com/x',
      'evil.example.com',
      '//evil.example.com/x',
      '/\\evil.example.com',
      '\\\\evil.example.com',
      'javascript:alert(1)',
      '/apps\n//evil.example.com',
      '/apps\t',
    ]) {
      expect(safeNextPath(raw, SITE), raw).toBeUndefined()
    }
  })

  it('drops the API, the sign-in page, the home page and anything not a short string', () => {
    for (const raw of [
      '/api/auth/logout',
      '/api/trpc/me',
      '/login',
      '/login?pending=1',
      '/',
      '',
      'x'.repeat(10),
    ]) {
      expect(safeNextPath(raw, SITE), raw).toBeUndefined()
    }
    expect(safeNextPath(`/${'a'.repeat(2000)}`, SITE)).toBeUndefined()
    expect(safeNextPath(undefined, SITE)).toBeUndefined()
    expect(safeNextPath(['/apps'], SITE)).toBeUndefined()
  })
})
