import { type AnyConnector, ConnectorError, type ResolvedResource } from './types'

interface Entry {
  key: string
  resourceConfigId: string
  connector: AnyConnector
  client: Promise<unknown>
  users: number
  lastUsed: number
  /** Superseded by a newer version or invalidated: closed as soon as nobody uses it. */
  stale: boolean
}

export interface PoolOptions {
  /** Most clients kept open; the least recently used idle ones are closed beyond this. Default 50. */
  maxClients?: number
  /** Idle clients are closed after this long. Default 5 minutes. */
  idleMs?: number
  /** How often to look for idle clients; 0 disables the timer (call `sweep()` yourself). Default 30s. */
  sweepIntervalMs?: number
}

/**
 * Caches one client (a Postgres pool, an HTTP agent, …) per resource config version. Clients in use are never
 * closed underneath a query: eviction and invalidation only close them once their last user releases them.
 */
export class PoolManager {
  private readonly entries = new Map<string, Entry>()
  private readonly maxClients: number
  private readonly idleMs: number
  private readonly timer?: NodeJS.Timeout

  constructor(opts: PoolOptions = {}) {
    this.maxClients = opts.maxClients ?? 50
    this.idleMs = opts.idleMs ?? 5 * 60_000
    const interval = opts.sweepIntervalMs ?? 30_000
    if (interval > 0) {
      this.timer = setInterval(() => void this.sweep(), interval)
      this.timer.unref()
    }
  }

  get size(): number {
    return this.entries.size
  }

  async withClient<T>(
    connector: AnyConnector,
    resource: ResolvedResource,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> {
    const entry = this.acquire(connector, resource)
    try {
      return await fn(await entry.client)
    } finally {
      entry.users--
      entry.lastUsed = Date.now()
      if (entry.stale && entry.users === 0) await this.close(entry)
    }
  }

  /** Closes a resource's clients (all environments) once they're idle, e.g. after its config changed. */
  async invalidate(resourceConfigIds: string | string[]): Promise<void> {
    const ids = new Set([resourceConfigIds].flat())
    const closing: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      if (!ids.has(entry.resourceConfigId)) continue
      entry.stale = true
      if (entry.users === 0) closing.push(this.close(entry))
    }
    await Promise.all(closing)
  }

  /** Closes idle clients past `idleMs`, and stale ones. */
  async sweep(now = Date.now()): Promise<void> {
    const closing: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      if (entry.users === 0 && (entry.stale || now - entry.lastUsed >= this.idleMs))
        closing.push(this.close(entry))
    }
    await Promise.all(closing)
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await Promise.all([...this.entries.values()].map((e) => this.close(e)))
  }

  private acquire(connector: AnyConnector, resource: ResolvedResource): Entry {
    const key = `${connector.type}:${resource.id}:${resource.version}`
    let entry = this.entries.get(key)
    if (entry) {
      // Re-insert to mark it most recently used (Map iterates in insertion order).
      this.entries.delete(key)
      this.entries.set(key, entry)
    } else {
      // A new version supersedes the old ones for this config.
      for (const other of this.entries.values()) {
        if (other.resourceConfigId === resource.id) {
          other.stale = true
          if (other.users === 0) void this.close(other)
        }
      }
      const created: Entry = {
        key,
        resourceConfigId: resource.id,
        connector,
        client: createClient(connector, resource),
        users: 0,
        lastUsed: Date.now(),
        stale: false,
      }
      // A client that fails to connect isn't cached, so the next call retries.
      created.client.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key)
      })
      entry = created
      this.entries.set(key, entry)
      this.evictOverflow()
    }
    entry.users++
    return entry
  }

  private evictOverflow(): void {
    let excess = this.entries.size - this.maxClients
    for (const entry of this.entries.values()) {
      if (excess <= 0) break
      if (entry.users === 0) {
        void this.close(entry)
        excess--
      }
    }
  }

  private async close(entry: Entry): Promise<void> {
    if (this.entries.get(entry.key) !== entry) return
    this.entries.delete(entry.key)
    const client = await entry.client.catch(() => undefined)
    if (client !== undefined) await entry.connector.destroyClient(client).catch(() => {})
  }
}

async function createClient(connector: AnyConnector, resource: ResolvedResource): Promise<unknown> {
  return connector.createClient(parseResource(connector, resource))
}

/** Validates (and applies defaults to) stored config and secrets before a client is built from them. */
export function parseResource(connector: AnyConnector, resource: ResolvedResource): ResolvedResource {
  const config = connector.configSchema.safeParse(resource.config)
  if (!config.success) {
    throw new ConnectorError('invalid_config', 'The resource configuration is invalid', {
      issues: config.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  // Secret issues report paths only: the message could quote the value.
  const secrets = connector.secretsSchema.safeParse(resource.secrets ?? {})
  if (!secrets.success) {
    throw new ConnectorError('invalid_config', 'The resource credentials are invalid', {
      issues: secrets.error.issues.map((i) => ({ path: i.path.join('.') })),
    })
  }
  return { ...resource, config: config.data, secrets: secrets.data }
}
