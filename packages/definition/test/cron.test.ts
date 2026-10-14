import { describe, expect, it } from 'vitest'
import {
  type CronExpression,
  isValidTimeZone,
  nextCronFire,
  nextIntervalFire,
  parseCron,
  upcomingCronFires,
  wallToInstant,
} from '../src'

const cron = (expression: string): CronExpression => {
  const parsed = parseCron(expression)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.cron
}
const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b)
const iso = (dates: (Date | null)[]) => dates.map((d) => d?.toISOString() ?? null)
const fires = (expression: string, after: string, count: number, timeZone = 'Europe/Amsterdam') =>
  iso(upcomingCronFires(cron(expression), new Date(after), count, timeZone))

describe('parseCron', () => {
  it('parses numbers, ranges, lists and steps', () => {
    const c = cron('*/15 9-17 1,15 * 1-5')
    expect(sorted(c.minutes)).toEqual([0, 15, 30, 45])
    expect(sorted(c.hours)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(sorted(c.daysOfMonth)).toEqual([1, 15])
    expect(c.months.size).toBe(12)
    expect(sorted(c.daysOfWeek)).toEqual([1, 2, 3, 4, 5])
    expect(sorted(cron('0-30/10 * * * *').minutes)).toEqual([0, 10, 20, 30])
    expect(sorted(cron('5/20 * * * *').minutes)).toEqual([5, 25, 45])
  })

  it('accepts month and weekday names in any case, and 7 for Sunday', () => {
    const c = cron('0 0 * JAN-mar Sun,SAT')
    expect(sorted(c.months)).toEqual([1, 2, 3])
    expect(sorted(c.daysOfWeek)).toEqual([0, 6])
    expect(sorted(cron('0 0 * * 5-7').daysOfWeek)).toEqual([0, 5, 6])
    expect(sorted(cron('0 0 * * */2').daysOfWeek)).toEqual([0, 2, 4, 6])
  })

  it('expands the shorthands', () => {
    expect(cron('@daily')).toMatchObject({ source: '@daily' })
    expect(sorted(cron('@hourly').minutes)).toEqual([0])
    expect(cron('@hourly').hours.size).toBe(24)
    expect(sorted(cron('@weekly').daysOfWeek)).toEqual([0])
    expect(sorted(cron('@yearly').months)).toEqual([1])
  })

  it('explains what is wrong', () => {
    const error = (expression: string) => {
      const parsed = parseCron(expression)
      return parsed.ok ? null : parsed.error
    }
    expect(error('* * * *')).toMatch(/Expected 5 fields.*got 4/)
    expect(error('60 * * * *')).toBe('The minute must be between 0 and 59, got 60')
    expect(error('0 0 0 * *')).toBe('The day of month must be between 1 and 31, got 0')
    expect(error('0 5-2 * * *')).toBe('The hour range "5-2" runs backwards')
    expect(error('*/0 * * * *')).toBe('Invalid step "0" in the minute field')
    expect(error('0 0 * foo *')).toBe('Invalid month "foo"')
    expect(error('0 0 1-2-3 * *')).toBe('Invalid day of month range "1-2-3"')
    expect(error('@often')).toBe('Unknown shorthand "@often"')
    expect(error('')).toMatch(/got 0/)
  })
})

describe('nextCronFire', () => {
  it('returns the first matching minute strictly after the given time', () => {
    const every15 = cron('*/15 * * * *')
    const next = (after: string) => nextCronFire(every15, new Date(after), 'UTC')?.toISOString()
    expect(next('2026-10-14T10:07:00Z')).toBe('2026-10-14T10:15:00.000Z')
    expect(next('2026-10-14T10:15:00Z')).toBe('2026-10-14T10:30:00.000Z')
    expect(next('2026-10-14T10:14:59.999Z')).toBe('2026-10-14T10:15:00.000Z')
    expect(next('2026-10-14T23:50:00Z')).toBe('2026-10-15T00:00:00.000Z')
  })

  it('reads the expression on the time zone wall clock', () => {
    // 03:00 in Amsterdam is 01:00 UTC in summer time and 02:00 UTC in winter time.
    expect(fires('0 3 * * *', '2026-10-14T12:00:00Z', 1)).toEqual(['2026-10-15T01:00:00.000Z'])
    expect(fires('0 3 * * *', '2026-11-14T12:00:00Z', 1)).toEqual(['2026-11-15T02:00:00.000Z'])
    expect(fires('0 3 * * *', '2026-10-14T12:00:00Z', 1, 'UTC')).toEqual(['2026-10-15T03:00:00.000Z'])
  })

  it('matches either day field when both are restricted, as Vixie cron does', () => {
    // The 1st of the month or any Monday.
    expect(fires('0 12 1 * mon', '2026-10-27T00:00:00Z', 3, 'UTC')).toEqual([
      '2026-11-01T12:00:00.000Z', // Sunday the 1st
      '2026-11-02T12:00:00.000Z', // Monday
      '2026-11-09T12:00:00.000Z', // Monday
    ])
    // Only one restricted: both must hold (Mondays, any day of month).
    expect(fires('0 12 * * mon', '2026-10-27T00:00:00Z', 1, 'UTC')).toEqual(['2026-11-02T12:00:00.000Z'])
  })

  it('finds rare dates, and gives up on dates that never come', () => {
    // 29 February 00:00 in Amsterdam is 23:00 UTC the day before.
    expect(fires('0 0 29 2 *', '2026-10-14T00:00:00Z', 1)).toEqual(['2028-02-28T23:00:00.000Z'])
    expect(nextCronFire(cron('0 0 30 2 *'), new Date('2026-10-14T00:00:00Z'))).toBeNull()
    expect(nextCronFire(cron('0 0 31 4,6,9,11 *'), new Date('2026-10-14T00:00:00Z'))).toBeNull()
  })

  it('throws on an unknown time zone', () => {
    expect(() => nextCronFire(cron('* * * * *'), new Date(), 'Mars/Olympus_Mons')).toThrow(RangeError)
  })
})

describe('daylight saving time in Europe/Amsterdam', () => {
  // 2026-03-29: clocks jump from 02:00 CET (UTC+1) to 03:00 CEST (UTC+2), at 01:00 UTC.
  // 2026-10-25: clocks fall back from 03:00 CEST to 02:00 CET, at 01:00 UTC, so 02:00–02:59 happens twice.

  it('runs a daily job in the skipped hour once, at the end of the gap', () => {
    expect(fires('30 2 * * *', '2026-03-27T12:00:00Z', 3)).toEqual([
      '2026-03-28T01:30:00.000Z', // 02:30 CET
      '2026-03-29T01:00:00.000Z', // 02:30 doesn't exist: 03:00 CEST, when the gap ends
      '2026-03-30T00:30:00.000Z', // 02:30 CEST
    ])
  })

  it('collapses every time in the skipped hour into one fire', () => {
    expect(fires('*/15 * * * *', '2026-03-29T00:30:00Z', 4)).toEqual([
      '2026-03-29T00:45:00.000Z', // 01:45 CET
      '2026-03-29T01:00:00.000Z', // 02:00–02:45 don't exist; 03:00 CEST fires once for them and itself
      '2026-03-29T01:15:00.000Z', // 03:15 CEST
      '2026-03-29T01:30:00.000Z',
    ])
  })

  it('runs a daily job in the repeated hour once, the first time', () => {
    expect(fires('30 2 * * *', '2026-10-24T12:00:00Z', 3)).toEqual([
      '2026-10-25T00:30:00.000Z', // 02:30 CEST; the second 02:30 (CET) doesn't fire
      '2026-10-26T01:30:00.000Z', // 02:30 CET
      '2026-10-27T01:30:00.000Z',
    ])
  })

  it('never fires twice for the same wall-clock time when the clocks go back', () => {
    expect(fires('0 * * * *', '2026-10-24T23:30:00Z', 3)).toEqual([
      '2026-10-25T00:00:00.000Z', // 02:00 CEST
      '2026-10-25T02:00:00.000Z', // 03:00 CET; 02:00 CET is the same wall-clock time again
      '2026-10-25T03:00:00.000Z',
    ])
    // Starting inside the repeated hour: its times fired the first time round.
    expect(fires('*/5 * * * *', '2026-10-25T01:10:00Z', 1)).toEqual(['2026-10-25T02:00:00.000Z'])
  })

  it('keeps weekday jobs at 09:00 local across both changes', () => {
    expect(fires('0 9 * * mon-fri', '2026-03-27T00:00:00Z', 2)).toEqual([
      '2026-03-27T08:00:00.000Z', // Friday, CET
      '2026-03-30T07:00:00.000Z', // Monday, CEST
    ])
    expect(fires('0 9 * * mon-fri', '2026-10-23T00:00:00Z', 2)).toEqual([
      '2026-10-23T07:00:00.000Z', // Friday, CEST
      '2026-10-26T08:00:00.000Z', // Monday, CET
    ])
  })

  it('fires every day exactly once through a whole year', () => {
    const all = upcomingCronFires(cron('30 2 * * *'), new Date('2025-12-31T12:00:00Z'), 365)
    const days = new Set(
      all.map((d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(d)),
    )
    expect(days.size).toBe(365)
    expect(all.at(-1)!.toISOString()).toBe('2026-12-31T01:30:00.000Z')
  })
})

describe('daylight saving time elsewhere', () => {
  it('handles New York and a 30-minute shift (Lord Howe Island)', () => {
    // New York jumps from 02:00 EST to 03:00 EDT at 07:00 UTC on 2026-03-08.
    expect(fires('30 2 * * *', '2026-03-07T12:00:00Z', 1, 'America/New_York')).toEqual([
      '2026-03-08T07:00:00.000Z',
    ])
    // Lord Howe jumps from 02:00 (UTC+10:30) to 02:30 (UTC+11) at 15:30 UTC on 2026-10-03.
    expect(fires('15 2 * * *', '2026-10-03T00:00:00Z', 2, 'Australia/Lord_Howe')).toEqual([
      '2026-10-03T15:30:00.000Z', // 02:15 doesn't exist: 02:30, when the gap ends
      '2026-10-04T15:15:00.000Z', // 02:15 at UTC+11
    ])
  })
})

describe('wallToInstant', () => {
  const wall = (text: string) => Date.parse(`${text}Z`)
  const at = (text: string) => new Date(wallToInstant(wall(text), 'Europe/Amsterdam')).toISOString()

  it('maps ordinary, skipped and repeated wall-clock times', () => {
    expect(at('2026-07-01T12:00:00')).toBe('2026-07-01T10:00:00.000Z')
    expect(at('2026-03-29T02:30:00')).toBe('2026-03-29T01:00:00.000Z')
    expect(at('2026-10-25T02:30:00')).toBe('2026-10-25T00:30:00.000Z')
    expect(at('2026-10-25T03:00:00')).toBe('2026-10-25T02:00:00.000Z')
  })
})

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects anything else', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Europe/Atlantis')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('nextIntervalFire', () => {
  const next = (previous: string, after: string) =>
    nextIntervalFire(new Date(previous), 5 * 60_000, new Date(after)).toISOString()

  it('stays on the grid of the previous fire', () => {
    expect(next('2026-10-14T10:00:00Z', '2026-10-14T10:00:00Z')).toBe('2026-10-14T10:05:00.000Z')
    expect(next('2026-10-14T10:00:00Z', '2026-10-14T10:04:59Z')).toBe('2026-10-14T10:05:00.000Z')
  })

  it('skips the fires missed during downtime', () => {
    expect(next('2026-10-14T10:00:00Z', '2026-10-14T11:02:00Z')).toBe('2026-10-14T11:05:00.000Z')
    expect(next('2026-10-14T10:00:00Z', '2026-10-14T11:05:00Z')).toBe('2026-10-14T11:10:00.000Z')
  })
})
