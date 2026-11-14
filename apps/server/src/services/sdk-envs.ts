import { createHash } from 'node:crypto'
import { ConnectorError, configureSdkEnvs, type SdkEnvProvider, type SdkEnvSpec } from '@ow/connectors'
import type { Keyring } from '@ow/crypto'
import type { Db } from '@ow/db'
import { parseJsPackage, parseRequirement } from '@ow/definition'
import { BlockFailure } from '@ow/engine'
import type { Config } from '../config'
import { type NpmRegistryAccess, npmRegistryAccess } from './components/registries'
import { envForRequirements, type PythonBuilderClient, pythonBuilder } from './python-envs'

// SDK resources' packages (M37, docs/architecture.md §2.41): installed by the package builder, Python through M23's
// `python_envs` (resolved once, then the lock installed again), JavaScript through its npm install (`/build-npm`,
// cached by the builder by its inputs). A process keeps what it installed for a few minutes, so queries don't ask the
// builder each time; a JavaScript install is remembered with the npm registries it came from, so changing one in
// Settings → npm registries installs again.

const REMEMBER_MS = 10 * 60_000
type Env = { envId: string; versions: Record<string, string> }
const remembered = new Map<string, { at: number; env: Env }>()
/** One install per spec at a time: a second query waits for the first's. */
const pending = new Map<string, Promise<Env>>()

type SdkConfig = Pick<Config, 'NPM_REGISTRY_URL'> & { keyring?: Keyring }

/**
 * Sets the connectors' provider. The builder is the one Python packages use (`configurePythonPackages`), looked up
 * when a call needs it, so the order processes configure them in doesn't matter.
 */
export function configureSdkPackages(db: Db, config: SdkConfig): void {
  configureSdkEnvs(sdkEnvProvider(db, () => pythonBuilder(), config))
}

export function sdkEnvProvider(
  db: Db,
  builder: () => PythonBuilderClient | null,
  config: SdkConfig,
): SdkEnvProvider {
  return async (spec) => {
    const client = builder()
    if (!client) {
      throw new ConnectorError(
        'sdk_install',
        "This instance has no package builder (PYTHON_BUILDER_URL): an SDK's packages can't be installed here",
      )
    }
    const registries = spec.language === 'javascript' ? await registriesFor(db, config) : []
    const key = JSON.stringify([
      spec.language,
      [...spec.packages].sort(),
      spec.pythonIndex ?? null,
      // The registries' scopes, URLs and tokens (hashed): a changed one is another install.
      registries.map((r) => [
        r.scope,
        r.url,
        r.token ? createHash('sha256').update(r.token).digest('hex') : null,
      ]),
    ])
    const now = Date.now()
    const known = remembered.get(key)
    if (known && now - known.at < REMEMBER_MS) return known.env
    let install = pending.get(key)
    if (!install) {
      install = (
        spec.language === 'python' ? python(db, client, spec) : javascript(client, spec, registries)
      ).finally(() => pending.delete(key))
      pending.set(key, install)
    }
    const env = await install
    for (const [k, v] of remembered) if (now - v.at >= REMEMBER_MS) remembered.delete(k)
    remembered.set(key, { at: Date.now(), env })
    return env
  }
}

/** Forgets what this process installed (tests). */
export function forgetSdkEnvs(): void {
  remembered.clear()
}

async function python(db: Db, builder: PythonBuilderClient, spec: SdkEnvSpec): Promise<Env> {
  for (const line of spec.packages) {
    const parsed = parseRequirement(line)
    if ('error' in parsed) throw new ConnectorError('invalid_config', `Packages: "${line}": ${parsed.error}`)
  }
  try {
    const { envId, lock } = await envForRequirements(
      db,
      builder,
      spec.packages,
      { workflowId: spec.resourceId, actorUserId: null, objectType: 'resource', label: "The SDK's packages" },
      spec.pythonIndex,
    )
    return { envId, versions: Object.fromEntries(lock.packages.map((p) => [p.name, p.version])) }
  } catch (err) {
    if (err instanceof BlockFailure) {
      throw new ConnectorError('sdk_install', err.message, err.details as Record<string, unknown> | undefined)
    }
    throw err
  }
}

/** Settings → npm registries, and the instance's default unless an admin set one for every package. */
async function registriesFor(db: Db, config: SdkConfig): Promise<NpmRegistryAccess[]> {
  const access = await npmRegistryAccess(db, config.keyring)
  if (!access.ok) throw new ConnectorError('sdk_install', access.message)
  return access.registries.some((r) => r.scope === null)
    ? access.registries
    : [{ scope: null, url: config.NPM_REGISTRY_URL }, ...access.registries]
}

async function javascript(
  builder: PythonBuilderClient,
  spec: SdkEnvSpec,
  registries: NpmRegistryAccess[],
): Promise<Env> {
  const dependencies: Record<string, string> = {}
  for (const line of spec.packages) {
    const parsed = parseJsPackage(line)
    if ('error' in parsed) throw new ConnectorError('invalid_config', `Packages: "${line}": ${parsed.error}`)
    dependencies[parsed.package.name] = parsed.package.range || 'latest'
  }
  const answer = await builder.buildNpm(dependencies, registries)
  if (!answer.ok) {
    throw new ConnectorError(
      'sdk_install',
      `The SDK's packages couldn't be installed: ${answer.error.message}`,
      {
        kind: answer.error.kind,
        ...(answer.log && { log: answer.log }),
      },
    )
  }
  return { envId: answer.envId, versions: answer.lock.packages }
}
