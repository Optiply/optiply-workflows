import type { Connection } from 'tedious'
import { ConnectorError } from '../types'

/**
 * A small pool of tedious connections (M38). tedious has none of its own, and the `mssql` package's reshapes rows and
 * merges FOR JSON chunks in ways a query result shouldn't. At most `max` connections, open or opening; one that ends
 * or fails is dropped and replaced on demand; idle ones close after `idleMs`.
 */
export class TdsPool {
  private readonly idle: { conn: Connection; since: number }[] = []
  private readonly waiters: { resolve: (c: Connection) => void; reject: (e: unknown) => void }[] = []
  private readonly dead = new WeakSet<Connection>()
  private size = 0
  private ended = false
  private readonly sweep: NodeJS.Timeout

  constructor(
    private readonly open: () => Promise<Connection>,
    private readonly max: number,
    private readonly idleMs = 60_000,
  ) {
    this.sweep = setInterval(() => this.closeIdle(), Math.min(idleMs, 30_000))
    this.sweep.unref()
  }

  /** A connection for one query; waits for one to be free, giving up when the signal aborts. */
  acquire(signal: AbortSignal): Promise<Connection> {
    if (this.ended) return Promise.reject(new ConnectorError('connection', 'The connection pool is closed'))
    if (signal.aborted) return Promise.reject(new ConnectorError('aborted', 'The query was cancelled'))
    const free = this.idle.pop()
    if (free) return Promise.resolve(free.conn)
    if (this.size < this.max) return this.connect()
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (c: Connection) => {
          signal.removeEventListener('abort', onAbort)
          resolve(c)
        },
        reject: (e: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      }
      const onAbort = () => {
        const at = this.waiters.indexOf(waiter)
        if (at !== -1) this.waiters.splice(at, 1)
        reject(new ConnectorError('aborted', 'The query was cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Back to the pool for the next query (or closed, if it's broken or the pool is gone). */
  release(conn: Connection): void {
    if (this.dead.has(conn) || this.ended) {
      this.destroy(conn)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(conn)
    else this.idle.push({ conn, since: Date.now() })
  }

  /** Closes a connection that mustn't be used again; a waiting query gets a fresh one. */
  destroy(conn: Connection): void {
    this.drop(conn)
    conn.close()
  }

  async end(): Promise<void> {
    this.ended = true
    clearInterval(this.sweep)
    for (const w of this.waiters.splice(0))
      w.reject(new ConnectorError('connection', 'The connection pool is closed'))
    const closing = this.idle.splice(0).map(({ conn }) => closed(conn))
    await Promise.all(closing)
  }

  private async connect(): Promise<Connection> {
    this.size++
    try {
      const conn = await this.open()
      const lost = () => this.drop(conn)
      conn.on('end', lost)
      conn.on('error', lost)
      return conn
    } catch (err) {
      this.size--
      this.serveWaiter()
      throw err
    }
  }

  /** Forgets a connection (it ended, failed or is being closed) and frees its slot for a waiting query. */
  private drop(conn: Connection): void {
    if (this.dead.has(conn)) return
    this.dead.add(conn)
    const at = this.idle.findIndex((i) => i.conn === conn)
    if (at !== -1) this.idle.splice(at, 1)
    this.size--
    this.serveWaiter()
  }

  private serveWaiter(): void {
    if (this.ended || !this.waiters.length || this.size >= this.max) return
    const waiter = this.waiters.shift()!
    this.connect().then(waiter.resolve, waiter.reject)
  }

  private closeIdle(): void {
    const now = Date.now()
    for (const { conn, since } of [...this.idle]) {
      if (now - since >= this.idleMs) this.destroy(conn)
    }
  }
}

function closed(conn: Connection): Promise<void> {
  return new Promise((resolve) => {
    conn.once('end', () => resolve())
    conn.close()
    // A connection that never finished connecting may not emit `end`.
    setTimeout(resolve, 2_000).unref()
  })
}
