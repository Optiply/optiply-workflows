/**
 * Notices when an app's sandbox stops responding: the app's code runs in a Worker, so an endless loop there leaves
 * the page running but the app frozen. The host calls `tick` every `intervalMs` and sends a `ping` when told to; the
 * sandbox answers it with `pong` as soon as it's free. A ping still unanswered after `stallMs` means it's stuck.
 *
 * Timers aren't reliable: browsers slow them down in background tabs, and a sleeping laptop stops everything. A tick
 * that comes late only starts a new ping (the sandbox may have been paused too), so neither ends a working app.
 */
export interface WatchdogOptions {
  intervalMs: number
  stallMs: number
}

export type WatchdogAction = { type: 'ping'; id: number } | { type: 'stalled' } | null

export class Watchdog {
  private nextId = 1
  /** The ping waiting for its pong, and when it was sent. */
  private waiting: { id: number; sentAt: number } | null = null
  private lastTick: number | null = null

  constructor(private readonly options: WatchdogOptions) {}

  tick(now: number): WatchdogAction {
    const late = this.lastTick !== null && now - this.lastTick > 2 * this.options.intervalMs
    this.lastTick = now
    if (this.waiting && !late) {
      return now - this.waiting.sentAt >= this.options.stallMs ? { type: 'stalled' } : null
    }
    this.waiting = { id: this.nextId++, sentAt: now }
    return { type: 'ping', id: this.waiting.id }
  }

  /** The sandbox answered; an answer to an older ping (overtaken by a late tick) doesn't count. */
  pong(id: number): void {
    if (this.waiting?.id === id) this.waiting = null
  }
}
