import { createHash } from 'node:crypto'
import {
  type AuthVariables,
  ConnectorError,
  type CredentialSource,
  type FlowSandbox,
  type RestConfig,
  type RestSecrets,
  runAuthFlow,
} from '@ow/connectors'
import { type Keyring, scrubSecrets, secretStrings } from '@ow/crypto'
import { type Db, type OAuthToken, oauthTokens } from '@ow/db'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { type Tx, withRefreshLock } from './refresh-lock'
import { decryptForRow, encryptForRow } from './secrets'

type CustomAuth = Extract<RestConfig['auth'], { type: 'custom' }>

/** What a custom flow's row in `oauth_tokens` holds once decrypted. */
interface StoredVariables {
  variables: Record<string, unknown>
}

/** Variables this close to their `ttlSeconds` are signed in for again before use. */
const EXPIRY_MARGIN_MS = 5_000
const EXPRESSION_TIMEOUT_MS = 5_000

/** After a failed sign-in, the next waits this long, doubling per failure up to the maximum. */
const BACKOFF_START_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000
const BACKOFF_KEYS = 1000

/**
 * Sign-in failures per flow, in this process: until `until`, sign-ins aren't tried again and fail with the last
 * error, so a wrong password isn't sent on every query (and doesn't lock the account at the provider). Keyed by the
 * config, the flow and its secrets: a fixed password or a changed flow tries again at once. Test connection
 * (`store: false`) always tries.
 */
const failures = new Map<string, { count: number; until: number; error: ConnectorError }>()

function backoffKey(resourceConfigId: string, flowHash: string, secrets: RestSecrets): string {
  const secretsHash = createHash('sha256').update(JSON.stringify(secrets)).digest('base64url')
  return `${resourceConfigId}:${flowHash}:${secretsHash}`
}

/** Throws the last error while a flow's back-off lasts. */
function checkBackoff(key: string): void {
  const failed = failures.get(key)
  if (!failed || failed.until <= Date.now()) return
  const seconds = Math.ceil((failed.until - Date.now()) / 1000)
  throw new ConnectorError(
    failed.error.code,
    `${failed.error.message} (failed ${failed.count} time${failed.count === 1 ? '' : 's'} in a row; signing in again in ${seconds} s)`,
    { ...failed.error.details, retryAt: new Date(failed.until).toISOString() },
  )
}

function recordFailure(key: string, err: unknown): void {
  const previous = failures.get(key)
  const count = (previous?.count ?? 0) + 1
  const error =
    err instanceof ConnectorError
      ? err
      : new ConnectorError('auth_required', (err as Error).message ?? String(err))
  failures.delete(key)
  if (failures.size >= BACKOFF_KEYS) failures.delete(failures.keys().next().value!)
  failures.set(key, {
    count,
    until: Date.now() + Math.min(BACKOFF_START_MS * 2 ** (count - 1), BACKOFF_MAX_MS),
    error,
  })
}

/**
 * Identifies a custom flow: its steps and the base URL its requests go to. Variables signed in for with another
 * flow aren't used (the next query signs in again).
 */
export function customFlowHash(config: RestConfig): string {
  const auth = config.auth as CustomAuth
  // Where the variables go is part of it too: someone who may edit the resource can't point it elsewhere and
  // receive them.
  const hosts = config.allowedHosts.map((h) => h.trim().toLowerCase()).sort()
  const flow = [config.baseUrl, hosts, auth.steps, auth.refreshSteps]
  return createHash('sha256').update(JSON.stringify(flow)).digest('base64url')
}

/** Which resource config a custom flow signs in for, and with what. */
export interface CustomFlowTarget {
  resourceConfigId: string
  environmentId: string
  config: RestConfig
  secrets: RestSecrets
}

/** Failure messages kept on the row are cut to this length. */
const LAST_ERROR_MAX = 1000

/**
 * A custom auth flow's variables for one resource config, shared by every query (flows run without a person, so
 * there are no per-user variables).
 *
 * Signed in on first use, again when `ttlSeconds` runs out, and refreshed when an API answers 401: the refresh steps
 * when there are some (starting from the current variables, merged over them), otherwise (or if they fail) the
 * sign-in steps. Signing in happens under an advisory lock per config (`withRefreshLock`: waiters hold no database
 * connection), so processes don't sign in at once; whoever waited uses what the other stored. A refresh after a
 * 401 is skipped when the stored variables are no longer the ones this query used (someone refreshed already). The
 * variables are stored encrypted like OAuth tokens. Variables marked `secret: false` aren't scrubbed from results.
 *
 * A sign-in that fails backs off (`failures`): the next ones fail at once with its error for 5 s, then 10 s, …
 * up to 5 minutes, until one succeeds or the flow or its secrets change. It is also kept on the stored row
 * (`last_error`, status `reconnect`) for the resource's status card, whichever process ran it.
 *
 * `store: false` keeps the variables in this source only (Test connection with unsaved settings).
 */
export function customAuthCredentials(
  deps: { db: Db; keyring: Keyring; sandbox: FlowSandbox },
  target: CustomFlowTarget & { store: boolean },
): CredentialSource {
  return customFlow(deps, target).source
}

/**
 * Signs the flow in now with its sign-in steps (the status card's Sign in now): without waiting out a back-off,
 * and stored for the queries that follow. A failure is thrown and kept on the row as its last error, but variables
 * stored before stay in use (they may still work).
 */
export function signInCustomFlow(
  deps: { db: Db; keyring: Keyring; sandbox: FlowSandbox },
  target: CustomFlowTarget,
  signal: AbortSignal,
): Promise<void> {
  return customFlow(deps, { ...target, store: true }).signInNow(signal)
}

function customFlow(
  deps: { db: Db; keyring: Keyring; sandbox: FlowSandbox },
  target: CustomFlowTarget & { store: boolean },
): { source: CredentialSource; signInNow: (signal: AbortSignal) => Promise<void> } {
  const { db, keyring, sandbox } = deps
  const auth = target.config.auth as CustomAuth
  const flowHash = customFlowHash(target.config)
  const backoff = backoffKey(target.resourceConfigId, flowHash, target.secrets)
  const resource = { config: target.config, secrets: target.secrets }

  // A variable defined anywhere in the flow as secret stays secret.
  const variableSteps = [...auth.steps, ...auth.refreshSteps].filter((s) => s.type === 'variable')
  const notSecret = new Set(
    variableSteps
      .filter(
        (s) => s.secret === false && !variableSteps.some((t) => t.name === s.name && t.secret !== false),
      )
      .map((s) => s.name),
  )
  const view = (variables: Record<string, unknown>): AuthVariables => ({
    evaluate: (code) =>
      sandbox.evalExpression(code, { auth: variables }, { timeoutMs: EXPRESSION_TIMEOUT_MS }),
    secrets: secretStrings(
      Object.entries(variables)
        .filter(([name]) => !notSecret.has(name))
        .map(([, v]) => v),
    ),
  })
  const expiresAt = () => (auth.ttlSeconds ? new Date(Date.now() + auth.ttlSeconds * 1000) : null)

  /** Signs in again: the refresh steps from `previous` when asked and possible, else (or if they fail) the steps. */
  async function signIn(
    signal: AbortSignal,
    previous: Record<string, unknown> | undefined,
    refresh: boolean,
  ) {
    if (refresh && previous && auth.refreshSteps.length) {
      try {
        const renewed = await runAuthFlow(resource, auth.refreshSteps, { sandbox, signal, previous })
        return { ...previous, ...renewed }
      } catch (err) {
        if (signal.aborted) throw err
        // The refresh didn't work (its token expired too, say): sign in from scratch.
      }
    }
    return runAuthFlow(resource, auth.steps, { sandbox, signal })
  }

  const notStored = async () => {
    throw new Error('Signing in now needs a stored flow')
  }

  if (!target.store) {
    let memory: { variables: Record<string, unknown>; until: Date | null } | undefined
    return {
      source: {
        async authVariables({ signal, force }) {
          const fresh = memory && (!memory.until || memory.until.getTime() > Date.now() + EXPIRY_MARGIN_MS)
          if (!memory || force || !fresh) {
            memory = { variables: await signIn(signal, memory?.variables, !!force), until: expiresAt() }
          }
          return view(memory.variables)
        },
      },
      signInNow: notStored,
    }
  }

  const usable = (row: OAuthToken | undefined): row is OAuthToken =>
    !!row &&
    row.consentHash === flowHash &&
    row.status === 'active' &&
    (!row.expiresAt || row.expiresAt.getTime() > Date.now() + EXPIRY_MARGIN_MS)
  const decrypt = (row: OAuthToken) =>
    decryptForRow<StoredVariables>(keyring, 'oauth_tokens', row, row.tokens).variables
  /** When the variables this source last handed out were stored (`updated_at`): a refresh replaces only those. */
  let handedOut: number | undefined
  const lock = `ow_custom_auth:${target.resourceConfigId}`
  const load = async (q: Db | Tx) => {
    const [row] = await q
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.resourceConfigId, target.resourceConfigId), isNull(oauthTokens.userId)))
    return row
  }

  /** Stores freshly signed-in variables (the row is created the first time); returns when, as `updated_at`. */
  async function store(tx: Tx, row: OAuthToken | undefined, next: Record<string, unknown>) {
    const now = new Date()
    const values = {
      expiresAt: expiresAt(),
      status: 'active' as const,
      lastError: null,
      consentHash: flowHash,
      refreshedAt: now,
      updatedAt: now,
    }
    const id = row?.id ?? uuidv7()
    const tokens = encryptForRow(keyring, 'oauth_tokens', { id, environmentId: target.environmentId }, {
      variables: next,
    } satisfies StoredVariables)
    if (row) {
      await tx
        .update(oauthTokens)
        .set({ ...values, tokens })
        .where(eq(oauthTokens.id, row.id))
    } else {
      await tx.insert(oauthTokens).values({
        id,
        resourceConfigId: target.resourceConfigId,
        environmentId: target.environmentId,
        userId: null,
        tokens,
        ...values,
      })
    }
    return now.getTime()
  }

  /**
   * Keeps a failed sign-in on the row (when there is one) for the status card: the message without the secret
   * values or the variables it held. `unusable` also stops queries using its variables (a query needed them signed
   * in again). `updated_at` stays: it says when the variables were stored, which refreshes compare.
   */
  async function storeFailure(tx: Tx, row: OAuthToken | undefined, err: unknown, unusable: boolean) {
    if (!row) return
    const message = err instanceof Error ? err.message : String(err)
    const scrub = [
      ...secretStrings(target.secrets.values),
      ...(row.consentHash === flowHash ? secretStrings(decrypt(row)) : []),
    ]
    await tx
      .update(oauthTokens)
      .set({
        lastError: scrubSecrets(message, scrub).slice(0, LAST_ERROR_MAX),
        ...(unusable && { status: 'reconnect' as const }),
        updatedAt: row.updatedAt,
      })
      .where(eq(oauthTokens.id, row.id))
  }

  return {
    source: {
      async authVariables({ signal, force }) {
        if (!force) {
          const seen = await load(db)
          if (usable(seen)) {
            handedOut = seen.updatedAt.getTime()
            return view(decrypt(seen))
          }
        }

        // A failure is returned, not thrown, so what `storeFailure` wrote isn't rolled back.
        const outcome = await withRefreshLock(db, lock, signal, async (tx) => {
          const row = await load(tx)
          // Someone signed in while this waited; for a refresh, someone already replaced the variables it used.
          if (usable(row) && (!force || row.updatedAt.getTime() !== handedOut)) {
            handedOut = row.updatedAt.getTime()
            return { variables: decrypt(row) }
          }

          const previous = row && row.consentHash === flowHash ? decrypt(row) : undefined
          checkBackoff(backoff)
          let next: Record<string, unknown>
          try {
            next = await signIn(signal, previous, !!force)
          } catch (err) {
            if (signal.aborted) throw err
            recordFailure(backoff, err)
            await storeFailure(tx, row, err, true)
            return { error: err }
          }
          failures.delete(backoff)
          handedOut = await store(tx, row, next)
          return { variables: next }
        })
        if ('error' in outcome) throw outcome.error
        return view(outcome.variables)
      },
    },

    async signInNow(signal) {
      const outcome = await withRefreshLock(db, lock, signal, async (tx) => {
        const row = await load(tx)
        let next: Record<string, unknown>
        try {
          next = await runAuthFlow(resource, auth.steps, { sandbox, signal })
        } catch (err) {
          if (signal.aborted) throw err
          await storeFailure(tx, row, err, false)
          return { error: err }
        }
        failures.delete(backoff)
        await store(tx, row, next)
        return { ok: true as const }
      })
      if ('error' in outcome) throw outcome.error
    },
  }
}

/**
 * What the status card shows about a config's shared sign-in; never the variables. `state`: `none` (not signed in
 * yet), `signedIn`, `expired` (its time ran out: the next query signs in), `settingsChanged` (the flow changed
 * since: the next query signs in), or `failed` (the last sign-in a query needed failed: `lastError`). A failed
 * Sign in now leaves the variables in use, with its `lastError`.
 */
export interface CustomFlowStatus {
  state: 'none' | 'signedIn' | 'expired' | 'settingsChanged' | 'failed'
  signedInAt: Date | null
  expiresAt: Date | null
  lastError: string | null
}

export async function customFlowStatus(
  db: Db,
  resourceConfigId: string,
  flowHash: string,
): Promise<CustomFlowStatus> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.resourceConfigId, resourceConfigId), isNull(oauthTokens.userId)))
  if (!row) return { state: 'none', signedInAt: null, expiresAt: null, lastError: null }
  const state =
    row.consentHash !== flowHash
      ? 'settingsChanged'
      : row.status !== 'active'
        ? 'failed'
        : row.expiresAt && row.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'signedIn'
  return {
    state,
    signedInAt: row.refreshedAt ?? row.createdAt,
    expiresAt: row.expiresAt,
    lastError: row.lastError,
  }
}

/** Forgets a config's shared sign-in (Sign out): the next query signs in again. Returns whether there was one. */
export async function signOutCustomFlow(db: Db, resourceConfigId: string): Promise<boolean> {
  const removed = await db
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.resourceConfigId, resourceConfigId), isNull(oauthTokens.userId)))
    .returning({ id: oauthTokens.id })
  return removed.length > 0
}
