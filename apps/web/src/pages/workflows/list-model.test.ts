import { describe, expect, it } from 'vitest'
import { isSortKey, matchesSearch, sortWorkflows, timeAgo, triggerLabel } from './list-model'

const wf = (name: string, updatedAt: string, lastRun: string | null, description: string | null = null) => ({
  name,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  description,
  updatedAt,
  lastRun: lastRun ? { createdAt: lastRun } : null,
})

describe('the Workflows page model', () => {
  it('matches every word of a search in the name, slug or description, any case', () => {
    const sync = wf('Sync orders', '2026-11-01', null, 'Pulls orders from the webshop')
    expect(matchesSearch(sync, '')).toBe(true)
    expect(matchesSearch(sync, 'ORDERS sync')).toBe(true)
    expect(matchesSearch(sync, 'sync-orders')).toBe(true)
    expect(matchesSearch(sync, 'webshop')).toBe(true)
    expect(matchesSearch(sync, 'sync refunds')).toBe(false)
  })

  it('sorts by name, last edited and last run (never run last, ties by name)', () => {
    const items = [
      wf('beta', '2026-11-02T10:00:00Z', null),
      wf('Alpha', '2026-11-01T10:00:00Z', '2026-11-04T10:00:00Z'),
      wf('gamma', '2026-11-03T10:00:00Z', '2026-11-05T10:00:00Z'),
      wf('delta', '2026-11-03T10:00:00Z', null),
    ]
    const names = (key: Parameters<typeof sortWorkflows>[1]) => sortWorkflows(items, key).map((w) => w.name)
    expect(names('name')).toEqual(['Alpha', 'beta', 'delta', 'gamma'])
    expect(names('edited')).toEqual(['delta', 'gamma', 'beta', 'Alpha'])
    expect(names('lastRun')).toEqual(['gamma', 'Alpha', 'beta', 'delta'])
    expect(items[0]!.name).toBe('beta')
    expect(isSortKey('lastRun')).toBe(true)
    expect(isSortKey('size')).toBe(false)
  })

  it('says how long ago, then the date', () => {
    const now = new Date('2026-11-05T12:00:00Z')
    expect(timeAgo('2026-11-05T11:59:30Z', now)).toBe('just now')
    expect(timeAgo('2026-11-05T11:55:00Z', now)).toBe('5 min ago')
    expect(timeAgo('2026-11-05T09:00:00Z', now)).toBe('3 h ago')
    expect(timeAgo('2026-11-03T12:00:00Z', now)).toBe('2 d ago')
    expect(timeAgo('2026-09-01T12:00:00Z', now)).toMatch(/2026/)
  })

  it('names triggers with their counts', () => {
    expect(triggerLabel('schedule', 2)).toBe('2 schedules')
    expect(triggerLabel('webhook', 1)).toBe('1 webhook')
  })
})
