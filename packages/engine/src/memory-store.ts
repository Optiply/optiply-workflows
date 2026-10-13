import type { LogLevel } from '@ow/db'
import type { BlockResult, RunResponse, RunStore } from './types'

export type StoreEvent =
  | { type: 'started'; key: string; attempt: number }
  | { type: 'finished'; key: string; status: BlockResult['status'] }
  | { type: 'response'; key: string; response: RunResponse }

/**
 * Keeps a run's progress in memory: for tests, and for runs that don't need to survive a crash. `beforeWrite`
 * can throw to simulate a failing or fenced-off database.
 */
export class MemoryRunStore implements RunStore {
  readonly events: StoreEvent[] = []
  readonly results = new Map<string, BlockResult>()
  readonly logs: { blockKey: string | null; level: LogLevel; message: string }[] = []
  response: RunResponse | null = null

  constructor(private readonly beforeWrite?: (event: StoreEvent) => void) {}

  async blockStarted(key: string, attempt: number) {
    this.write({ type: 'started', key, attempt })
  }

  async blockFinished(result: BlockResult, extra?: { response?: RunResponse }) {
    this.write({ type: 'finished', key: result.key, status: result.status })
    if (this.results.has(result.key)) throw new Error(`"${result.key}" was committed twice`)
    this.results.set(result.key, result)
    if (extra?.response) {
      this.events.push({ type: 'response', key: result.key, response: extra.response })
      this.response = extra.response
    }
  }

  log(entry: { blockKey: string | null; level: LogLevel; message: string }) {
    this.logs.push(entry)
  }

  /** Committed results, as a resumed run would load them. */
  checkpoints(): BlockResult[] {
    return [...this.results.values()]
  }

  private write(event: StoreEvent) {
    this.beforeWrite?.(event)
    this.events.push(event)
  }
}
