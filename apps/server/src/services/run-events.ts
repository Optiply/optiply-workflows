import { RUN_EVENTS_CHANNEL, type RunEvent } from '@ow/engine'
import type postgres from 'postgres'

type Listener = (event: RunEvent) => void

/**
 * Fans run events out to subscribers: one LISTEN connection per process, started on first use, with events
 * routed by run id. postgres.js re-listens by itself after a reconnect.
 */
export class RunEventHub {
  private readonly subscribers = new Map<string, Set<Listener>>()
  private listening: Promise<{ unlisten: () => Promise<void> }> | undefined

  constructor(private readonly sql: postgres.Sql) {}

  /** Calls `listener` with each event of the run; resolves once events are flowing. Returns an unsubscribe. */
  async subscribe(runId: string, listener: Listener): Promise<() => void> {
    this.listening ??= this.sql.listen(RUN_EVENTS_CHANNEL, (payload) => this.dispatch(payload))
    try {
      await this.listening
    } catch (err) {
      this.listening = undefined
      throw err
    }
    const set = this.subscribers.get(runId) ?? new Set<Listener>()
    this.subscribers.set(runId, set)
    set.add(listener)
    return () => {
      set.delete(listener)
      if (!set.size) this.subscribers.delete(runId)
    }
  }

  async close() {
    const listening = this.listening
    this.listening = undefined
    this.subscribers.clear()
    if (listening) await (await listening.catch(() => undefined))?.unlisten()
  }

  private dispatch(payload: string) {
    let event: RunEvent
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    for (const listener of this.subscribers.get(event.runId) ?? []) listener(event)
  }
}
