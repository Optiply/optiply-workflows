import type { Keyring } from '@ow/crypto'
import { type Db, type WorkflowRun, workflowReleases } from '@ow/db'
import type { WorkflowDefinition } from '@ow/definition'
import { BlockFailure, type JsModulesProvider } from '@ow/engine'
import type { SandboxModules } from '@ow/sandbox'
import { eq } from 'drizzle-orm'
import { recordAudit } from '../audit'
import {
  buildJsBundle,
  type JsBundleConfig,
  type JsBundleOutcome,
  type JsBundleReady,
  jsBundleByHash,
  jsBundleConfig,
} from './js-bundles'

/**
 * JavaScript packages for runs and releases (docs/architecture.md, JS packages): the bundle a run's code loads (a
 * release's, or the draft's package list's), and the lock and bundle a release keeps. Configured once at start
 * (`configureJsBundles`), like Python's executor.
 */

let configured: JsBundleConfig | null = null

export function configureJsBundles(config: {
  NPM_REGISTRY_URL: string
  COMPONENT_BUILD_DIR?: string
  JS_BUNDLE_MAX_MB: number
  keyring?: Keyring
}): JsBundleConfig {
  configured = jsBundleConfig(config)
  return configured
}

function bundleConfig(): JsBundleConfig {
  if (!configured) throw new Error('JavaScript packages are not configured (configureJsBundles)')
  return configured
}

/** Whose packages they are, for the audit of a new bundle. */
export interface JsBundleOwner {
  objectType: 'workflow' | 'app'
  objectId: string
  actorUserId: string | null
}

/** `buildJsBundle`, auditing a new bundle as `js.bundle_built`. */
export async function buildAudited(
  db: Db,
  packages: readonly string[],
  who: JsBundleOwner,
  lock: string | null = null,
  config: JsBundleConfig = bundleConfig(),
): Promise<JsBundleOutcome> {
  const outcome = await buildJsBundle(db, config, packages, { lock })
  if (outcome.ok && !outcome.cached) {
    await recordAudit(db, {
      actorUserId: who.actorUserId,
      action: 'js.bundle_built',
      objectType: who.objectType,
      objectId: who.objectId,
      metadata: {
        packages: [...packages],
        versions: outcome.versions,
        bundleHash: outcome.bundleHash,
        sizeBytes: outcome.sizeBytes,
        ...(outcome.warnings.length && { warnings: outcome.warnings }),
        ...(lock && { fromLock: true }),
      },
    })
  }
  return outcome
}

/**
 * The bundle for `packages` (from `lock`, a release's, when given), built or found, audited when new. Throws a
 * `BlockFailure` (`js_packages`, npm's log in its details) when it can't be made.
 */
export async function bundleFor(
  db: Db,
  packages: readonly string[],
  who: JsBundleOwner,
  lock: string | null = null,
): Promise<JsBundleReady> {
  const outcome = await buildAudited(db, packages, who, lock)
  if (!outcome.ok) {
    throw new BlockFailure(
      'js_packages',
      `The JavaScript packages couldn't be installed: ${outcome.message}`,
      {
        kind: outcome.kind,
        ...(outcome.log && { log: outcome.log }),
      },
    )
  }
  return outcome
}

export interface ReleaseJsBundle {
  jsLock: string | null
  jsBundleHash: string
}

/**
 * What a release keeps for its JavaScript packages: null without packages. A release that has a bundle still kept
 * keeps it (a rollback); one that lost it is rebuilt from its lock; otherwise the package list's bundle (the one
 * draft runs used, when they did). Throws the `BlockFailure` of a failed build, for publishing to refuse with.
 */
export async function releaseJsBundle(
  db: Db,
  packages: readonly string[] | undefined,
  existing: { jsLock: string | null; jsBundleHash: string | null } | null,
  who: JsBundleOwner,
): Promise<ReleaseJsBundle | null> {
  if (!packages?.length) return null
  if (existing?.jsBundleHash && (await jsBundleByHash(db, existing.jsBundleHash))) {
    return { jsLock: existing.jsLock, jsBundleHash: existing.jsBundleHash }
  }
  const built = await bundleFor(db, packages, who, existing?.jsLock ?? null)
  return { jsLock: built.lock, jsBundleHash: built.bundleHash }
}

/**
 * The bundle a release keeps, loaded for a run: by its hash, else rebuilt from its lock (bundles unused for a while
 * may be gone). Null when the release has none (published before its packages had a bundle).
 */
async function releaseModules(
  db: Db,
  packages: readonly string[],
  release: { jsLock: string | null; jsBundleHash: string | null },
  who: JsBundleOwner,
): Promise<SandboxModules | null> {
  if (release.jsBundleHash) {
    const found = await jsBundleByHash(db, release.jsBundleHash)
    if (found) return { hash: release.jsBundleHash, js: found.js }
  }
  if (!release.jsLock) return null
  const built = await bundleFor(db, packages, who, release.jsLock)
  return { hash: built.bundleHash, js: built.js }
}

/** The engine's `JsModulesProvider`: a release's bundle when it has one, else the definition's package list's. */
export function dbJsModules(db: Db): JsModulesProvider {
  return {
    async modulesFor(run: WorkflowRun, definition: WorkflowDefinition) {
      const packages = definition.settings?.javascript?.packages ?? []
      const who = { objectType: 'workflow' as const, objectId: run.workflowId, actorUserId: run.createdBy }
      if (run.releaseId) {
        const [release] = await db
          .select({ jsLock: workflowReleases.jsLock, jsBundleHash: workflowReleases.jsBundleHash })
          .from(workflowReleases)
          .where(eq(workflowReleases.id, run.releaseId))
        const modules = release && (await releaseModules(db, packages, release, who))
        if (modules) return modules
      }
      const built = await bundleFor(db, packages, who)
      return { hash: built.bundleHash, js: built.js }
    },
  }
}
