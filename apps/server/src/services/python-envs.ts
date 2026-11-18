import { createHash } from 'node:crypto'
import type { Keyring } from '@ow/crypto'
import {
  configVars,
  configVarValues,
  type Db,
  environments,
  type PythonIndex,
  pythonEnvs,
  pythonIndexes,
  type WorkflowRun,
  workflowReleases,
} from '@ow/db'
import { type PythonLock, pythonFields, type WorkflowDefinition } from '@ow/definition'
import { BlockFailure, type PythonEnvProvider } from '@ow/engine'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { recordAudit } from '../audit'
import type { Config } from '../config'
import { defaultEnvSecret as sharedDefaultEnvSecret } from './default-env-secrets'

/**
 * Workflows' Python packages (M23, docs/architecture.md §2.26): the package builder (`python-builder`, from
 * PYTHON_BUILDER_URL) installs them into envs the code executor mounts. A draft run's requirements resolve once into
 * a lock (`python_envs`, reused while they stay the same); a release keeps its lock, so live runs install exactly
 * what was published. Set up once at startup, like the executor (`configurePython`).
 */
let builder: PythonBuilderClient | null = null
/** For package indexes' passwords (M32), kept beside the builder. */
let keyring: Keyring | null = null

type PackagesConfig = Pick<Config, 'PYTHON_BUILDER_URL' | 'PYTHON_BUILDER_TOKEN'> & { keyring?: Keyring }

export function configurePythonPackages(config: PackagesConfig) {
  if (config.keyring) keyring = config.keyring
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
export function pythonEnvProvider(db: Db, config: PackagesConfig): PythonEnvProvider | undefined {
  const client = configurePythonPackages(config)
  return client ? dbPythonEnvs(db, client) : undefined
}

/** A package index as the builder takes it (M32): its credentials for this request only. */
export interface BuilderIndex {
  name: string
  url: string
  username?: string
  password?: string
  mode: 'primary' | 'extra'
}

export type CheckIndexAnswer = { ok: boolean; status: number | null; message?: string }

export type BuildAnswer =
  | { ok: true; envId: string; lock?: PythonLock; sizeBytes: number; cached: boolean; log: string }
  | { ok: false; error: { kind: string; message: string }; log: string }

export type NpmBuildAnswer =
  | {
      ok: true
      envId: string
      lock: { node: string; dependencies: Record<string, string>; packages: Record<string, string> }
      sizeBytes: number
      cached: boolean
      log: string
    }
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
  build(requirements: string[], indexes: BuilderIndex[] = []): Promise<BuildAnswer> {
    return this.post('/build', { requirements, ...(indexes.length && { indexes }) })
  }

  /** Installs a lock made before (a release's), unless its env is there; never resolves. */
  install(lock: PythonLock, indexes: BuilderIndex[] = []): Promise<BuildAnswer> {
    return this.post('/install', { lock, ...(indexes.length && { indexes }) })
  }

  /**
   * An SDK resource's JavaScript packages (M37): npm installs them into `envs/node/<envId>` (no install scripts), from
   * the registries given (their tokens for this request only), or finds them there.
   */
  buildNpm(
    dependencies: Record<string, string>,
    registries: { scope: string | null; url: string; token?: string }[],
  ): Promise<NpmBuildAnswer> {
    return this.post('/build-npm', { dependencies, registries }) as Promise<NpmBuildAnswer>
  }

  /** Whether a package index answers and takes its sign-in (M32, Settings → Python's Test); at a package's page. */
  async checkIndex(index: BuilderIndex, testPackage?: string | null): Promise<CheckIndexAnswer> {
    const answer = (await this.post('/check-index', {
      index,
      ...(testPackage && { package: testPackage }),
    })) as unknown as CheckIndexAnswer | Extract<BuildAnswer, { ok: false }>
    if ('error' in answer) return { ok: false, status: null, message: answer.error.message }
    return answer
  }

  /** The platform the builder installs for (`cp312-linux-aarch64`), asked once; null while it can't be reached. */
  async platform(): Promise<string | null> {
    if (this.knownPlatform) return this.knownPlatform
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(10_000) })
      const health = (await res.json()) as { platform?: string }
      this.knownPlatform = health.platform ?? null
    } catch {
      return null
    }
    return this.knownPlatform
  }

  private knownPlatform: string | null = null

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

/**
 * The key of a set of requirements: their SHA-256, trimmed and sorted (pip doesn't care about their order); with a
 * package index (M32), of the requirements and the index's id (so M23's keys stay as they were).
 */
export function requirementsHash(requirements: readonly string[], indexId: string | null = null): string {
  const sorted = [...requirements.map((r) => r.trim())].sort()
  const canonical = JSON.stringify(indexId ? { requirements: sorted, index: indexId } : sorted)
  return createHash('sha256').update(canonical).digest('hex')
}

/** A package index's row by its slug (M32), or a `python_packages` failure naming it. */
export async function pythonIndexBySlug(db: Db, slug: string): Promise<PythonIndex> {
  const [row] = await db.select().from(pythonIndexes).where(eq(pythonIndexes.slug, slug))
  if (!row) {
    throw new BlockFailure(
      'python_packages',
      `The workflow's Python packages come from the package index "${slug}", which doesn't exist on this instance (Settings → Python)`,
    )
  }
  return row
}

/**
 * An index as the builder takes it: its password read from its secret config var in the default environment (an
 * env serves every environment, so what fetches it does too). A missing value is a `python_packages` failure.
 */
export async function builderIndex(db: Db, row: PythonIndex): Promise<BuilderIndex> {
  const index: BuilderIndex = { name: row.slug, url: row.url, mode: row.mode }
  if (row.username) index.username = row.username
  if (row.passwordConfigVar) {
    const password = await defaultEnvSecret(db, row.passwordConfigVar)
    if (password === null) {
      throw new BlockFailure(
        'python_packages',
        `The package index "${row.slug}" takes its password from the config var ${row.passwordConfigVar}, which isn't a secret with a value in the default environment`,
      )
    }
    index.password = password
  }
  return index
}

async function defaultEnvSecret(db: Db, name: string): Promise<string | null> {
  return keyring ? sharedDefaultEnvSecret(db, keyring, name) : null
}

/** The indexes a lock's packages name (M32), as the builder takes them. */
async function lockIndexes(db: Db, lock: PythonLock): Promise<BuilderIndex[]> {
  const slugs = [...new Set(lock.packages.flatMap((p) => (p.index ? [p.index] : [])))]
  if (!slugs.length) return []
  const rows = await db.select().from(pythonIndexes).where(inArray(pythonIndexes.slug, slugs))
  const missing = slugs.find((slug) => !rows.some((r) => r.slug === slug))
  if (missing) await pythonIndexBySlug(db, missing) // throws, naming it
  return Promise.all(rows.map((row) => builderIndex(db, row)))
}

/** A failed build or install as the Python block's failure, pip's output in its details. */
function packagesFailure(
  answer: Extract<BuildAnswer, { ok: false }>,
  /** Whose packages they are, for the message (an SDK resource's, M37). */
  label = "The workflow's Python packages",
): BlockFailure {
  return new BlockFailure('python_packages', `${label} couldn't be installed: ${answer.error.message}`, {
    kind: answer.error.kind,
    ...(answer.log && { log: answer.log }),
  })
}

/**
 * The env for a set of requirements, through `python_envs`: their lock installed again when they've been resolved
 * (cheap when the env is there; it comes back if the builder removed it), else resolved and recorded. A failure is
 * recorded too (the editor shows it) and thrown; the next run tries again.
 */
export async function envForRequirements(
  db: Db,
  client: PythonBuilderClient,
  requirements: string[],
  /** Whose workflow it is (or an SDK resource's, M37), for the audit of a new install (`python.env_built`). */
  who: {
    workflowId: string
    actorUserId: string | null
    objectType?: 'workflow' | 'resource'
    label?: string
  },
  /** The package index to resolve from (M32: `settings.python.index`), else the builder's default. */
  indexSlug?: string,
): Promise<{ envId: string; lock: PythonLock }> {
  const indexRow = indexSlug ? await pythonIndexBySlug(db, indexSlug) : null
  const indexes = indexRow ? [await builderIndex(db, indexRow)] : []
  const hash = requirementsHash(requirements, indexRow?.id ?? null)
  const [row] = await db.select().from(pythonEnvs).where(eq(pythonEnvs.requirementsHash, hash))
  if (row?.state === 'ready' && row.lock) {
    const installed = await client.install(row.lock, indexes)
    if (installed.ok) {
      await db.update(pythonEnvs).set({ lastUsedAt: new Date() }).where(eq(pythonEnvs.requirementsHash, hash))
      return { envId: installed.envId, lock: row.lock }
    }
    // Only a lock for another platform (the builder moved) is worth resolving again; the rest is the failure.
    if (installed.error.kind !== 'platform') throw packagesFailure(installed, who.label)
  }
  const built = await client.build(requirements, indexes)
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
    .values({ requirementsHash: hash, requirements, indexId: indexRow?.id ?? null, ...recorded })
    .onConflictDoUpdate({ target: pythonEnvs.requirementsHash, set: { ...recorded, lastUsedAt: sql`now()` } })
  if (!built.ok || !built.lock) {
    throw packagesFailure(
      built.ok
        ? { ok: false, error: { kind: 'install', message: 'The builder gave no lock' }, log: built.log }
        : built,
      who.label,
    )
  }
  if (!built.cached) {
    await recordAudit(db, {
      actorUserId: who.actorUserId,
      action: 'python.env_built',
      objectType: who.objectType ?? 'workflow',
      objectId: who.workflowId,
      metadata: {
        requirements,
        ...(indexSlug && { index: indexSlug }),
        packages: built.lock.packages.map(
          (p) => `${p.name}==${p.version}${p.source ? ` (${p.source})` : ''}`,
        ),
        envId: built.envId,
        sizeBytes: built.sizeBytes,
      },
    })
  }
  return { envId: built.envId, lock: built.lock }
}

/**
 * The lock a release keeps (M23): null without packages or Python. A lock it has already (a rollback) is installed
 * again; otherwise the requirements' (the one draft runs used, when they did). Throws the `BlockFailure` of a
 * failed install, for publishing to refuse with.
 */
export async function releaseLock(
  db: Db,
  definition: WorkflowDefinition,
  existing: PythonLock | null,
  who: { workflowId: string; actorUserId: string | null },
): Promise<PythonLock | null> {
  const requirements = definition.settings?.python?.requirements ?? []
  if (!requirements.length || !pythonFields(definition).length) return null
  if (!builder) {
    throw new BlockFailure(
      'python_packages_unavailable',
      "This workflow's Python packages can't be installed here: the instance has no package builder (PYTHON_BUILDER_URL)",
    )
  }
  if (existing) return (await installLock(db, builder, existing, who)).lock
  return (await envForRequirements(db, builder, requirements, who, definition.settings?.python?.index)).lock
}

/**
 * A lock made before (a release's) installed: as it is, or, when it was made on another platform, its exact
 * versions pinned with this platform's wheels (that lock is answered then; the release keeps its own).
 */
async function installLock(
  db: Db,
  client: PythonBuilderClient,
  lock: PythonLock,
  who: { workflowId: string; actorUserId: string | null },
): Promise<{ envId: string; lock: PythonLock }> {
  const pinned = () =>
    envForRequirements(
      db,
      client,
      lock.packages.map((p) => `${p.name}==${p.version}`),
      who,
      lock.packages.find((p) => p.index)?.index,
    )
  // Known to be another platform's: straight to its versions (every live run would ask the builder twice).
  const platform = await client.platform()
  if (platform && platform !== lock.platform) return pinned()
  const installed = await client.install(lock, await lockIndexes(db, lock))
  if (installed.ok) return { envId: installed.envId, lock }
  if (installed.error.kind !== 'platform') throw packagesFailure(installed)
  return pinned()
}

/** The engine's `PythonEnvProvider`: a release's lock when it has one, else the definition's requirements. */
export function dbPythonEnvs(db: Db, client: PythonBuilderClient): PythonEnvProvider {
  return {
    async envFor(run: WorkflowRun, definition: WorkflowDefinition) {
      const who = { workflowId: run.workflowId, actorUserId: run.createdBy }
      if (run.releaseId) {
        const [release] = await db
          .select({ lock: workflowReleases.pythonLock })
          .from(workflowReleases)
          .where(eq(workflowReleases.id, run.releaseId))
        if (release?.lock) return (await installLock(db, client, release.lock, who)).envId
      }
      const python = definition.settings?.python
      return (await envForRequirements(db, client, python?.requirements ?? [], who, python?.index)).envId
    },
  }
}
