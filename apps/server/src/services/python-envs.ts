import { createHash } from 'node:crypto'
import { type Db, pythonEnvs, type WorkflowRun, workflowReleases } from '@ow/db'
import type { PythonLock, WorkflowDefinition } from '@ow/definition'
import { BlockFailure, type PythonEnvProvider } from '@ow/engine'
import { eq, sql } from 'drizzle-orm'
import type { Config } from '../config'

/**
 * Workflows' Python packages (M23, docs/architecture.md §2.26): the package builder (`python-builder`, from
 * PYTHON_BUILDER_URL) installs them into envs the code executor mounts. A draft run's requirements resolve once into
 * a lock (`python_envs`, reused while they stay the same); a release keeps its lock, so live runs install exactly
 * what was published. Set up once at startup, like the executor (`configurePython`).
 */
let builder: PythonBuilderClient | null = null

export function configurePythonPackages(config: Pick<Config, 'PYTHON_BUILDER_URL' | 'PYTHON_BUILDER_TOKEN'>) {
  builder =
    config.PYTHON_BUILDER_URL && config.PYTHON_BUILDER_TOKEN
      ? new PythonBuilderClient({ url: config.PYTHON_BUILDER_URL, token: config.PYTHON_BUILDER_TOKEN })
      : null
  return builder
}

export function pythonBuilder(): PythonBuilderClient | null {
  return builder
}

/** The engine's provider for this process (`configurePythonPackages` once), or none without a builder. */
export function pythonEnvProvider(
  db: Db,
  config: Pick<Config, 'PYTHON_BUILDER_URL' | 'PYTHON_BUILDER_TOKEN'>,
): PythonEnvProvider | undefined {
  const client = configurePythonPackages(config)
  return client ? dbPythonEnvs(db, client) : undefined
}

export type BuildAnswer =
  | { ok: true; envId: string; lock?: PythonLock; sizeBytes: number; cached: boolean; log: string }
  | { ok: false; error: { kind: string; message: string }; log: string }

/** A build or an install takes at most 5 minutes in the builder, which may first wait as long for a slot. */
const BUILDER_TIMEOUT_MS = 11 * 60_000

/** The package builder over HTTP, with its bearer token. Failures to reach it are answers too (`unavailable`). */
export class PythonBuilderClient {
  private readonly url: string

  constructor(private readonly opts: { url: string; token: string; timeoutMs?: number }) {
    this.url = opts.url.replace(/\/$/, '')
  }

  /** Resolves the requirements into a lock and installs it (an env already there answers `cached`). */
  build(requirements: string[]): Promise<BuildAnswer> {
    return this.post('/build', { requirements })
  }

  /** Installs a lock made before (a release's), unless its env is there; never resolves. */
  install(lock: PythonLock): Promise<BuildAnswer> {
    return this.post('/install', { lock })
  }

  private async post(path: string, body: unknown): Promise<BuildAnswer> {
    const unavailable = (message: string): BuildAnswer => ({
      ok: false,
      error: { kind: 'unavailable', message },
      log: '',
    })
    let res: Response
    try {
      res = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? BUILDER_TIMEOUT_MS),
      })
    } catch (err) {
      return unavailable(`The package builder isn't reachable: ${(err as Error).message}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text.slice(0, 200)
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
      } catch {}
      return unavailable(`The package builder refused the request (${res.status}): ${message}`)
    }
    return (await res.json()) as BuildAnswer
  }
}

/** The key of a set of requirements: their SHA-256, trimmed and sorted (pip doesn't care about their order). */
export function requirementsHash(requirements: readonly string[]): string {
  const canonical = JSON.stringify([...requirements.map((r) => r.trim())].sort())
  return createHash('sha256').update(canonical).digest('hex')
}

/** A failed build or install as the Python block's failure, pip's output in its details. */
function packagesFailure(answer: Extract<BuildAnswer, { ok: false }>): BlockFailure {
  return new BlockFailure(
    'python_packages',
    `The workflow's Python packages couldn't be installed: ${answer.error.message}`,
    { kind: answer.error.kind, ...(answer.log && { log: answer.log }) },
  )
}

/**
 * The env for a set of requirements, through `python_envs`: their lock installed again when they've been resolved
 * (cheap when the env is there; it comes back if the builder removed it), else resolved and recorded. A failure is
 * recorded too (the editor shows it) and thrown; the next run tries again.
 */
export async function envForRequirements(db: Db, client: PythonBuilderClient, requirements: string[]) {
  const hash = requirementsHash(requirements)
  const [row] = await db.select().from(pythonEnvs).where(eq(pythonEnvs.requirementsHash, hash))
  if (row?.state === 'ready' && row.lock) {
    const installed = await client.install(row.lock)
    if (installed.ok) {
      await db.update(pythonEnvs).set({ lastUsedAt: new Date() }).where(eq(pythonEnvs.requirementsHash, hash))
      return installed.envId
    }
    // Only a lock for another platform (the builder moved) is worth resolving again; the rest is the failure.
    if (installed.error.kind !== 'platform') throw packagesFailure(installed)
  }
  const built = await client.build(requirements)
  const recorded = built.ok
    ? {
        state: 'ready' as const,
        lock: built.lock ?? null,
        envId: built.envId,
        sizeBytes: built.sizeBytes,
        error: null,
        log: built.log,
        builtAt: new Date(),
      }
    : { state: 'failed' as const, error: built.error, log: built.log }
  await db
    .insert(pythonEnvs)
    .values({ requirementsHash: hash, requirements, ...recorded })
    .onConflictDoUpdate({ target: pythonEnvs.requirementsHash, set: { ...recorded, lastUsedAt: sql`now()` } })
  if (!built.ok) throw packagesFailure(built)
  return built.envId
}

/** The engine's `PythonEnvProvider`: a release's lock when it has one, else the definition's requirements. */
export function dbPythonEnvs(db: Db, client: PythonBuilderClient): PythonEnvProvider {
  return {
    async envFor(run: WorkflowRun, definition: WorkflowDefinition) {
      if (run.releaseId) {
        const [release] = await db
          .select({ lock: workflowReleases.pythonLock })
          .from(workflowReleases)
          .where(eq(workflowReleases.id, run.releaseId))
        if (release?.lock) {
          const installed = await client.install(release.lock)
          if (installed.ok) return installed.envId
          if (installed.error.kind !== 'platform') throw packagesFailure(installed)
          // Made on another platform: the same versions, with this platform's wheels.
          const pinned = release.lock.packages.map((p) => `${p.name}==${p.version}`)
          return envForRequirements(db, client, pinned)
        }
      }
      return envForRequirements(db, client, definition.settings?.python?.requirements ?? [])
    },
  }
}
