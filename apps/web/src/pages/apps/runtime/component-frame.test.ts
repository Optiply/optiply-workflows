import { describe, expect, it, vi } from 'vitest'

vi.mock('virtual:component-frame', () => ({ default: 'window.started = "</script>"' }))
const { componentFrameCsp, componentFrameDocument } = await import('./component-frame')

describe('a custom component frame', () => {
  it('reaches nothing without allowed origins', () => {
    expect(componentFrameCsp([])).toBe(
      "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; " +
        "font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    )
  })

  it('reaches its allowed origins, and drops anything that isn’t an origin', () => {
    const csp = componentFrameCsp([
      'https://api.example.com',
      'https://*.cdn.example.com',
      "x; script-src 'self'",
    ])
    expect(csp).toContain('connect-src https://api.example.com https://*.cdn.example.com;')
    expect(csp).toContain('img-src data: blob: https://api.example.com https://*.cdn.example.com;')
    expect(csp).not.toContain("'self'")
  })

  it('writes the runtime in without letting it end the script early', () => {
    const doc = componentFrameDocument([])
    expect(doc).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(doc).toContain('<div id="root"></div>')
    expect(doc).toContain('window.started = "<\\/script>"')
    expect(doc.match(/<\/script>/g)).toHaveLength(1)
  })
})
