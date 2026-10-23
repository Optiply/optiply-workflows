import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { matchWebhookAlias, nextScheduleFire, parseWebhookAlias, validateDefinition } from '../src'
import { start, wf } from './helpers'

describe('parseWebhookAlias', () => {
  it('splits an alias into fixed text and params, with its shape', () => {
    const parsed = parseWebhookAlias('orders/:orderId/refunds')
    expect(parsed).toEqual({
      ok: true,
      segments: [{ text: 'orders' }, { param: 'orderId' }, { text: 'refunds' }],
      shape: 'orders/:/refunds',
    })
    expect(parseWebhookAlias('shopify.v2/order-created')).toMatchObject({ ok: true })
  })

  it('refuses aliases that are ambiguous or malformed', () => {
    const error = (alias: string) => {
      const parsed = parseWebhookAlias(alias)
      return parsed.ok ? null : parsed.error
    }
    expect(error('/orders')).toBe("An alias can't start or end with /")
    expect(error('orders/')).toBe("An alias can't start or end with /")
    expect(error(':id')).toBe('An alias must start with fixed text, not a :param')
    expect(error('orders/:id/:id')).toBe('The parameter ":id" appears twice')
    expect(error('orders//x')).toBe('An alias has an empty segment (//)')
    expect(error('Orders')).toBe('Invalid alias segment "Orders"')
    expect(error('')).toBe('An alias has an empty segment (//)')
    expect(error('a/b/c/d/e/f/g/h/i/j/k')).toBe('An alias can have at most 10 segments')
  })
})

describe('matchWebhookAlias', () => {
  const segments = (alias: string) => {
    const parsed = parseWebhookAlias(alias)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.segments
  }

  it('captures params and needs every fixed segment and the same length', () => {
    const alias = segments('orders/:orderId/refunds')
    expect(matchWebhookAlias(alias, ['orders', '42', 'refunds'])).toEqual({ orderId: '42' })
    expect(matchWebhookAlias(alias, ['orders', '42'])).toBeNull()
    expect(matchWebhookAlias(alias, ['orders', '42', 'refunds', 'x'])).toBeNull()
    expect(matchWebhookAlias(alias, ['invoices', '42', 'refunds'])).toBeNull()
    expect(matchWebhookAlias(alias, ['orders', '', 'refunds'])).toBeNull()
  })
})

describe('nextScheduleFire', () => {
  const after = new Date('2026-10-14T10:00:00Z')

  it('fires cron schedules on their zone, Amsterdam by default', () => {
    expect(nextScheduleFire({ cron: '0 3 * * *' }, after)?.toISOString()).toBe('2026-10-15T01:00:00.000Z')
    expect(nextScheduleFire({ cron: '0 3 * * *', timezone: 'UTC' }, after)?.toISOString()).toBe(
      '2026-10-15T03:00:00.000Z',
    )
  })

  it('fires interval schedules one interval on, or on the grid of the previous fire', () => {
    expect(nextScheduleFire({ intervalMs: 60_000 }, after)?.toISOString()).toBe('2026-10-14T10:01:00.000Z')
    expect(
      nextScheduleFire({ intervalMs: 600_000 }, after, new Date('2026-10-14T09:55:00Z'))?.toISOString(),
    ).toBe('2026-10-14T10:05:00.000Z')
  })

  it('gives null for schedules that are invalid or never fire', () => {
    expect(nextScheduleFire({}, after)).toBeNull()
    expect(nextScheduleFire({ cron: '* * * * *', intervalMs: 60_000 }, after)).toBeNull()
    expect(nextScheduleFire({ cron: 'nonsense' }, after)).toBeNull()
    expect(nextScheduleFire({ cron: '0 0 30 2 *' }, after)).toBeNull()
    expect(nextScheduleFire({ cron: '* * * * *', timezone: 'Nowhere/Land' }, after)).toBeNull()
  })
})

describe('validateDefinition: triggers', () => {
  const diagnostics = (triggers: object) =>
    validateDefinition(wf([start], [], { triggers })).diagnostics.map(({ code, message, path, block }) => ({
      code,
      message,
      path,
      block,
    }))

  it('accepts complete triggers', () => {
    const result = validateDefinition(
      wf([start], [], {
        triggers: {
          webhook: { enabled: true, alias: 'orders/:id', methods: ['POST', 'PUT'], syncTimeoutMs: 10_000 },
          schedules: [
            { name: 'nightly', enabled: true, cron: '0 3 * * *', timezone: 'UTC', overlap: 'queue' },
            { name: 'every-5', enabled: false, intervalMs: 300_000, environment: 'staging' },
          ],
        },
      }),
    )
    expect(result.diagnostics).toEqual([])
  })

  it('pins trigger problems to the start trigger', () => {
    expect(
      diagnostics({
        webhook: { enabled: true, alias: '/orders' },
        schedules: [
          { name: 'a', enabled: true },
          { name: 'a', enabled: true, intervalMs: 1000 },
          { name: 'b', enabled: true, cron: '0 25 * * *' },
          { name: 'c', enabled: true, cron: '0 0 30 2 *' },
          { name: 'd', enabled: true, cron: '0 3 * * *', timezone: 'Europe/Atlantis' },
          { name: 'e', enabled: true, cron: '0 3 * * *', intervalMs: 60_000 },
        ],
      }),
    ).toEqual([
      {
        code: 'invalid_alias',
        message: "An alias can't start or end with /",
        path: ['triggers', 'webhook', 'alias'],
        block: 'startTrigger',
      },
      {
        code: 'invalid_schedule',
        message: 'Schedule "a" needs either a cron expression or an interval',
        path: ['triggers', 'schedules', 0],
        block: 'startTrigger',
      },
      {
        code: 'duplicate_schedule',
        message: 'Another schedule is already named "a"',
        path: ['triggers', 'schedules', 1, 'name'],
        block: 'startTrigger',
      },
      {
        code: 'invalid_schedule',
        message: 'The interval must be at least 1 minute',
        path: ['triggers', 'schedules', 1, 'intervalMs'],
        block: 'startTrigger',
      },
      {
        code: 'invalid_cron',
        message: 'The hour must be between 0 and 23, got 25',
        path: ['triggers', 'schedules', 2, 'cron'],
        block: 'startTrigger',
      },
      {
        code: 'invalid_cron',
        message: '"0 0 30 2 *" never fires',
        path: ['triggers', 'schedules', 3, 'cron'],
        block: 'startTrigger',
      },
      {
        code: 'invalid_timezone',
        message: 'Unknown time zone "Europe/Atlantis"',
        path: ['triggers', 'schedules', 4, 'timezone'],
        block: 'startTrigger',
      },
      {
        code: 'invalid_schedule',
        message: 'Schedule "e" needs either a cron expression or an interval',
        path: ['triggers', 'schedules', 5],
        block: 'startTrigger',
      },
    ])
  })

  it('still saves a draft with a half-typed trigger (only the validator objects)', () => {
    const result = validateDefinition(
      wf([start], [], { triggers: { schedules: [{ name: 'x', enabled: true, cron: '0 3 *' }] } }),
    )
    expect(result.definition).toBeDefined()
    expect(result.ok).toBe(false)
  })
})

describe('Pub/Sub triggers (M19)', () => {
  const resources: Record<string, { type: string }> = {
    events: { type: 'pubsub' },
    shop: { type: 'postgres' },
  }
  const check = (pubsub: object[], withResources = true) =>
    validateDefinition(wf([start], [], { triggers: { pubsub } }), {
      ...(withResources && {
        resolveResource: (slug: string) =>
          resources[slug] && { ...resources[slug], querySchema: z.any(), validateQuery: () => [] },
      }),
    }).diagnostics.map(({ code, message, path }) => ({ code, message, path }))

  it('accepts a subscription by id or full name, with its limits', () => {
    expect(
      check([
        { name: 'orders', enabled: true, resource: 'events', subscription: 'orders-sub', maxInFlight: 10 },
        {
          name: 'other',
          enabled: false,
          resource: 'events',
          subscription: 'projects/elsewhere/subscriptions/their-sub',
          environment: 'staging',
          maxHoldMinutes: 120,
        },
      ]),
    ).toEqual([])
  })

  it('refuses a duplicate name, a resource that is not Pub/Sub or not there, and a bad subscription', () => {
    expect(
      check([
        { name: 'a', enabled: true, resource: 'events', subscription: 'ok-sub' },
        { name: 'a', enabled: true, resource: 'shop', subscription: '9bad' },
        { name: 'b', enabled: true, resource: 'gone', subscription: 'projects/p/topics/t' },
      ]),
    ).toEqual([
      {
        code: 'duplicate_pubsub',
        message: 'Another Pub/Sub trigger is already named "a"',
        path: ['triggers', 'pubsub', 1, 'name'],
      },
      {
        code: 'invalid_pubsub',
        message: 'Pub/Sub trigger "a": "shop" isn\'t a Pub/Sub resource',
        path: ['triggers', 'pubsub', 1, 'resource'],
      },
      {
        code: 'invalid_pubsub',
        message: 'Pub/Sub trigger "a": "9bad" isn\'t a subscription id or projects/…/subscriptions/… name',
        path: ['triggers', 'pubsub', 1, 'subscription'],
      },
      {
        code: 'unknown_resource',
        message: 'Pub/Sub trigger "b": no resource has the slug "gone"',
        path: ['triggers', 'pubsub', 2, 'resource'],
      },
      {
        code: 'invalid_pubsub',
        message:
          'Pub/Sub trigger "b": "projects/p/topics/t" isn\'t a subscription id or projects/…/subscriptions/… name',
        path: ['triggers', 'pubsub', 2, 'subscription'],
      },
    ])
    // The browser has no resources to check against: only the rest.
    expect(check([{ name: 'a', enabled: true, resource: 'gone', subscription: 'ok-sub' }], false)).toEqual([])
  })

  it('bounds the limits in the schema', () => {
    const codes = check([
      { name: 'a', enabled: true, resource: 'events', subscription: 'ok-sub', maxInFlight: 0 },
    ])
    expect(codes).toMatchObject([{ code: 'schema', path: ['triggers', 'pubsub', 0, 'maxInFlight'] }])
  })
})
