import { describe, expect, it } from 'vitest'
import { Watchdog } from './watchdog'

const options = { intervalMs: 1000, stallMs: 5000 }

/** Ticks every second from `from` to `to` (inclusive), answering each ping when `answer` says so. */
function run(dog: Watchdog, from: number, to: number, answer: boolean) {
  const actions = []
  for (let now = from; now <= to; now += 1000) {
    const action = dog.tick(now)
    actions.push(action)
    if (action?.type === 'ping' && answer) dog.pong(action.id)
  }
  return actions
}

describe('watchdog', () => {
  it('pings every tick while the sandbox answers', () => {
    const dog = new Watchdog(options)
    const actions = run(dog, 0, 60_000, true)
    expect(actions.every((a) => a?.type === 'ping')).toBe(true)
    expect(new Set(actions.map((a) => a?.type === 'ping' && a.id)).size).toBe(actions.length)
  })

  it('reports a stall once a ping has gone unanswered for stallMs', () => {
    const dog = new Watchdog(options)
    expect(dog.tick(0)).toEqual({ type: 'ping', id: 1 })
    // Waiting for the pong: no new pings in the meantime.
    for (const now of [1000, 2000, 3000, 4000]) expect(dog.tick(now)).toBeNull()
    expect(dog.tick(5000)).toEqual({ type: 'stalled' })
  })

  it('a slow answer within stallMs is fine', () => {
    const dog = new Watchdog(options)
    const ping = dog.tick(0)
    for (const now of [1000, 2000, 3000, 4000]) dog.tick(now)
    if (ping?.type === 'ping') dog.pong(ping.id)
    expect(dog.tick(5000)?.type).toBe('ping')
  })

  it('a late tick (a background tab, a sleeping laptop) starts a new ping instead of reporting a stall', () => {
    const dog = new Watchdog(options)
    const first = dog.tick(0)
    // The page was throttled to one tick a minute, and the sandbox's pong hasn't come through yet.
    const second = dog.tick(60_000)
    expect(second?.type).toBe('ping')
    // The pong of the overtaken ping doesn't count…
    if (first?.type === 'ping') dog.pong(first.id)
    for (const now of [61_000, 62_000, 63_000, 64_000]) expect(dog.tick(now)).toBeNull()
    // …only the new one's would have.
    expect(dog.tick(65_000)).toEqual({ type: 'stalled' })
  })

  it('throttled ticks never report a stall, however long the sandbox is stuck', () => {
    const dog = new Watchdog(options)
    for (let now = 0; now <= 3_600_000; now += 60_000) expect(dog.tick(now)?.type).toBe('ping')
    // Back in the foreground, the stall shows within stallMs.
    const actions = run(dog, 3_601_000, 3_606_000, false)
    expect(actions.at(-1)).toEqual({ type: 'stalled' })
  })
})
