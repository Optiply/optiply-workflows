import { describe, expect, it } from 'vitest'
import { appDefinitionHash, canonicalizeApp, emptyApp, validateApp } from '../src'
import { app, comp, sqlQuery } from './helpers'

describe('canonical form and hash', () => {
  const a = app({
    components: [
      comp('b', 'text'),
      comp(
        'a',
        'button',
        {},
        {
          events: [
            { id: '2', event: 'click', action: { type: 'notify', message: 'two' } },
            { id: '1', event: 'click', action: { type: 'notify', message: 'one' } },
          ],
        },
      ),
    ],
    queries: [sqlQuery('q2', 'select 2'), sqlQuery('q1', 'select 1')],
    layout: { a: { x: 0, y: 0, w: 2, h: 2 } },
  })

  it('sorts entities by name and keeps handler order', () => {
    const c = canonicalizeApp(a)
    expect(c.components.map((x) => x.name)).toEqual(['a', 'b'])
    expect(c.queries.map((x) => x.name)).toEqual(['q1', 'q2'])
    expect(c.components[0]!.events!.map((h) => h.id)).toEqual(['2', '1'])
  })

  it('hashes the same app the same, whatever the order, and counts the layout', async () => {
    const reordered = { ...a, components: [...a.components].reverse(), queries: [...a.queries].reverse() }
    expect(await appDefinitionHash(reordered)).toBe(await appDefinitionHash(a))
    const moved = { ...a, layout: { a: { x: 1, y: 0, w: 2, h: 2 } } }
    expect(await appDefinitionHash(moved)).not.toBe(await appDefinitionHash(a))
    expect(await appDefinitionHash(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('starts new apps valid', () => {
    expect(validateApp(emptyApp())).toMatchObject({ ok: true, diagnostics: [] })
  })
})
