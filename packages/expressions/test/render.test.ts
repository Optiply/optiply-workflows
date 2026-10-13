import { describe, expect, it } from 'vitest'
import { renderJson, renderTemplate, renderText, stringifyValue, TemplateError } from '../src'

const scope: Record<string, unknown> = {
  id: 42,
  name: 'Ada "the first" Lovelace',
  tags: ['a', 'b'],
  user: { id: 7 },
  nothing: null,
  missing: undefined,
  yes: true,
}
// A stand-in for the sandbox: looks the trimmed code up in `scope`.
const evaluate = (code: string) => scope[code.trim()]

describe('stringifyValue', () => {
  it('formats values for text', () => {
    expect([null, undefined, 'x', 1, true, [1], { a: 1 }].map(stringifyValue)).toEqual([
      '',
      '',
      'x',
      '1',
      'true',
      '[1]',
      '{"a":1}',
    ])
  })
})

describe('renderTemplate / renderText', () => {
  it('returns a lone expression as its raw value', async () => {
    expect(await renderTemplate('{{ user }}', evaluate)).toEqual({ id: 7 })
    expect(await renderTemplate(' {{ id }} ', evaluate)).toBe(42)
    expect(await renderTemplate('plain', evaluate)).toBe('plain')
  })

  it('stringifies mixed templates', async () => {
    expect(await renderTemplate('/users/{{ id }}/tags/{{ tags }}', evaluate)).toBe('/users/42/tags/["a","b"]')
    expect(await renderText('{{ id }}', evaluate)).toBe('42')
    expect(await renderText('x{{ nothing }}y{{ missing }}z', evaluate)).toBe('xyz')
  })

  it('evaluates in order, one at a time', async () => {
    const seen: string[] = []
    await renderText('{{ a }}{{ b }}{{ c }}', async (code) => {
      seen.push(`start ${code}`)
      await new Promise((r) => setTimeout(r, 1))
      seen.push(`end ${code}`)
    })
    expect(seen).toEqual(['start  a ', 'end  a ', 'start  b ', 'end  b ', 'start  c ', 'end  c '])
  })
})

describe('renderJson', () => {
  it('inserts values as JSON outside strings and as escaped text inside them', async () => {
    const body = `{
      "id": {{ id }},
      "name": {{ name }},
      "greeting": "Hello {{ name }}!",
      "tags": {{ tags }},
      "user": {{ user }},
      "none": {{ missing }},
      "flag": {{ yes }}
    }`
    expect(await renderJson(body, evaluate)).toEqual({
      id: 42,
      name: 'Ada "the first" Lovelace',
      greeting: 'Hello Ada "the first" Lovelace!',
      tags: ['a', 'b'],
      user: { id: 7 },
      none: null,
      flag: true,
    })
  })

  it('handles escaped quotes in the surrounding JSON', async () => {
    expect(await renderJson('{"q": "say \\"{{ id }}\\"", "n": {{ id }}}', evaluate)).toEqual({
      q: 'say "42"',
      n: 42,
    })
  })

  it('returns a lone expression as-is', async () => {
    expect(await renderJson('{{ user }}', evaluate)).toEqual({ id: 7 })
    expect(await renderJson('{{ missing }}', evaluate)).toBeNull()
  })

  it('reports invalid JSON', async () => {
    await expect(renderJson('{"a": {{ id }},}', evaluate)).rejects.toThrow(TemplateError)
  })
})
