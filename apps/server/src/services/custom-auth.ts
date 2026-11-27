import { createHash } from 'node:crypto'
import {
  type AuthFormValues,
  type AuthVariables,
  ConnectorError,
  type CredentialSource,
  type FlowSandbox,
  flowAsksEachPerson,
  type RestConfig,
  type RestSecrets,
  runAuthFlow,
} from '@ow/connectors'
import { type Keyring, scrubSecrets, secretStrings } from '@ow/crypto'
import { type Db, type OAuthToken, oauthTokens } from '@ow/db'
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm'
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
 * A person's own sign-in failures count until this long has passed without one, whatever succeeds in between: someone
 * with their own working login can't sign in between guesses at another person's password to keep the wait at 5 s.
 */
const PERSONAL_WINDOW_MS = 60 * 60_000

/**
 * Sign-in failures per flow, in this process: until `until`, sign-ins aren't tried again and fail with the last
 * error, so a wrong password isn't sent on every query (and doesn't lock the account at the provider). Keyed by the
 * config, the flow and its secrets: a fixed password or a changed flow tries again at once. Test connection
 * (`store: false`) always tries.
 */
const failures = new Map<string, { count: number; until: number; error: ConnectorError; personal: boolean }>()

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
    `${failed.error.message} (failed ${failed.count} time${failed.count === 1 ? '' : 's'} ${failed.personal ? 'in the last hour' : 'in a row'}; signing in again in ${seconds} s)`,
    { ...failed.error.details, retryAt: new Date(failed.until).toISOString() },
  )
}

/** `personal`: a person's own sign-in, whose failures count within `PERSONAL_WINDOW_MS` (a success doesn't reset them). */
function recordFailure(key: string, err: unknown, personal = false): void {
  const fresh = failures.get(key)
  const previous = fresh && (!personal || Date.now() - fresh.until < PERSONAL_WINDOW_MS) ? fresh : undefined
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
    personal,
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
  resourceId: string
  resourceConfigId: string
  environmentId: string
  config: RestConfig
  secrets: RestSecrets
  /**
   * Whose variables: null for the shared ones. A flow with a form step (`flowAsksEachPerson`) keeps each person's
   * own, so this is the person behind the query, and null means nobody is (a workflow running on its own).
   */
  userId: string | null
}

/** Failure messages kept on the row are cut to this length. */
const LAST_ERROR_MAX = 1000

/** Rows owned by `userId`: the shared one for null. */
const ownedBy = (userId: string | null) =>
  userId === null ? isNull(oauthTokens.userId) : eq(oauthTokens.userId, userId)

/**
 * A custom auth flow's variables for one resource config: shared by every query, or (a flow with a form step) each
 * person's own.
 *
 * Shared variables are signed in for on first use, again when `ttlSeconds` runs out, and refreshed when an API
 * answers 401: the refresh steps when there are some (starting from the current variables, merged over them),
 * otherwise (or if they fail) the sign-in steps. Signing in happens under an advisory lock per config and owner
 * (`withRefreshLock`: waiters hold no database connection), so processes don't sign in at once; whoever waited uses
 * what the other stored. A refresh after a 401 is skipped when the stored variables are no longer the ones this
 * query used (someone refreshed already). The variables are stored encrypted like OAuth tokens. Variables marked
 * `secret: false` aren't scrubbed from results.
 *
 * A shared sign-in that fails backs off (`failures`): the next ones fail at once with its error for 5 s, then
 * 10 s, … up to 5 minutes, until one succeeds or the flow or its secrets change. It is also kept on the stored row
 * (`last_error`, status `reconnect`) for the resource's status card, whichever process ran it.
 *
 * A person's own variables come only from them signing in (`signInCustomFlow` with what they typed; nothing they
 * typed is stored). Queries use them, refresh them with the refresh steps when they run out or an API answers 401,
 * and otherwise fail with `auth_required` (`account: 'user'`, `flow: 'form'`), which the UI answers with the form.
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
 * Signs the flow in now with its sign-in steps and stores the variables for the queries that follow: the shared
 * ones (the status card's Sign in now: without waiting out a back-off), or a person's own with what they typed into
 * the form (`form`; a failure starts a back-off for them, so passwords can't be tried quickly through here). A
 * failure is thrown and kept on the row as its last error, but variables stored before stay in use (they may still
 * work).
 */
export function signInCustomFlow(
  deps: { db: Db; keyring: Keyring; sandbox: FlowSandbox },
  target: CustomFlowTarget,
  signal: AbortSignal,
  form?: AuthFormValues,
): Promise<void> {
  return customFlow(deps, { ...target, store: true }).signInNow(signal, form)
}

function customFlow(
  deps: { db: Db; keyring: Keyring; sandbox: FlowSandbox },
  target: CustomFlowTarget & { store: boolean },
): {
  source: CredentialSource
  signInNow: (signal: AbortSignal, form?: AuthFormValues) => Promise<void>
} {
  const { db, keyring, sandbox } = deps
  const auth = target.config.auth as CustomAuth
  const perUser = flowAsksEachPerson(auth.steps)
  const flowHash = customFlowHash(target.config)
  // A person's back-off is theirs (and doesn't depend on the secrets: they type their own).
  const backoff =
    perUser && target.userId !== null
      ? `${target.resourceConfigId}:${flowHash}:user:${target.userId}`
      : backoffKey(target.resourceConfigId, flowHash, target.secrets)
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

  /** What the UI needs to ask the person to sign in: whose sign-in, why, and for which resource and environment. */
  const needSignIn = (reason: string, message: string) =>
    new ConnectorError('auth_required', message, {
      reason,
      account: 'user',
      flow: 'form',
      resourceId: target.resourceId,
      environmentId: target.environmentId,
    })

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
    if (perUser) {
      // Test connection: nobody typed anything, and a person's stored sign-in belongs to the saved settings.
      return {
        source: {
          async authVariables() {
            throw new ConnectorError(
              'auth_required',
              'This flow asks each person to sign in: save it, then sign in on the Sign-in card to try it.',
              { reason: 'form_needed' },
            )
          },
        },
        signInNow: notStored,
      }
    }
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

  if (perUser && target.userId === null) {
    const nobody = needSignIn(
      'no_user',
      'This resource asks each person to sign in, and nobody is behind this run: a live run uses the sign-in of whoever published the workflow, and this release has none (published before that, from Git, or that person can no longer sign in). Make it live again as you (Publish ▾ → Make live again), or use a resource that signs in on its own.',
    )
    return {
      source: {
        async authVariables() {
          throw nobody
        },
      },
      signInNow: async () => {
        throw nobody
      },
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
  const lock = `ow_custom_auth:${target.resourceConfigId}:${target.userId ?? 'shared'}`
  const load = async (q: Db | Tx) => {
    const [row] = await q
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.resourceConfigId, target.resourceConfigId), ownedBy(target.userId)))
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
        userId: target.userId,
        tokens,
        ...values,
      })
    }
    return now.getTime()
  }

  /**
   * Keeps a failed sign-in on the row (when there is one) for the status card: the message without the secret
   * values, what was typed or the variables it held. `unusable` also stops queries using its variables (a query
   * needed them signed in again). `updated_at` stays: it says when the variables were stored, which refreshes
   * compare.
   */
  async function storeFailure(
    tx: Tx,
    row: OAuthToken | undefined,
    err: unknown,
    unusable: boolean,
    typed: AuthFormValues = {},
  ) {
    if (!row) return
    // After a person typed their details, only which step failed and how: an API or a step may quote what they typed
    // in a form no scrubbing matches (encoded, escaped, cut short), and this is kept.
    const details = err instanceof ConnectorError ? err.details : undefined
    const message = Object.keys(typed).length
      ? `Signing in failed${typeof details?.step === 'string' ? ` at step "${details.step}"` : ''}${typeof details?.status === 'number' ? `: HTTP ${details.status}` : ''}`
      : err instanceof Error
        ? err.message
        : String(err)
    const scrub = [
      ...secretStrings(target.secrets),
      ...secretStrings(typed),
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

  /**
   * A person's variables when a query can't use the stored ones: renewed with the refresh steps when there are some
   * and the last ones worked (a failed refresh marks them so queries stop trying), else they sign in again.
   */
  async function renewOwn(tx: Tx, row: OAuthToken | undefined, signal: AbortSignal, force: boolean) {
    if (!row) {
      return {
        error: needSignIn('not_connected', 'Sign in to this resource with your own details to use it.'),
      }
    }
    if (row.consentHash !== flowHash) {
      return {
        error: needSignIn(
          'settings_changed',
          'Sign in to this resource again: its sign-in settings changed since you signed in.',
        ),
      }
    }
    if (row.status !== 'active' || !auth.refreshSteps.length) {
      // An API refused variables still in date: they're dead, so queries stop sending them and the card says so.
      if (force && row.status === 'active') {
        await storeFailure(tx, row, new Error('An API refused the stored sign-in.'), true)
      }
      return {
        error: needSignIn(
          'expired',
          force
            ? 'An API refused your sign-in to this resource: sign in again.'
            : 'Your sign-in to this resource ran out: sign in again.',
        ),
      }
    }
    const previous = decrypt(row)
    try {
      const renewed = await runAuthFlow(resource, auth.refreshSteps, { sandbox, signal, previous })
      const next = { ...previous, ...renewed }
      handedOut = await store(tx, row, next)
      return { variables: next }
    } catch (err) {
      if (signal.aborted) throw err
      await storeFailure(tx, row, err, true)
      // The refresh's error may quote the variables it started from (a refresh token): never in the query's error.
      const why = scrubSecrets(err instanceof Error ? err.message : String(err), [
        ...secretStrings(target.secrets),
        ...secretStrings(previous),
      ])
      return {
        error: needSignIn(
          'expired',
          `Your sign-in to this resource ran out and couldn't be renewed: sign in again. (${why})`,
        ),
      }
    }
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
          if (perUser) return renewOwn(tx, row, signal, !!force)

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

    async signInNow(signal, form) {
      if (perUser) checkBackoff(backoff)
      const outcome = await withRefreshLock(db, lock, signal, async (tx) => {
        // Again under the lock: attempts that were waiting for it see a failure the one before them just had, so
        // sending many at once doesn't try many passwords.
        if (perUser) {
          try {
            checkBackoff(backoff)
          } catch (err) {
            return { error: err }
          }
        }
        const row = await load(tx)
        let next: Record<string, unknown>
        try {
          next = await runAuthFlow(resource, auth.steps, { sandbox, signal, ...(perUser && { form }) })
        } catch (err) {
          if (signal.aborted) throw err
          // Not having typed anything isn't a failed attempt.
          const attempted = !(err instanceof ConnectorError && err.details?.reason === 'form_needed')
          if (perUser && attempted) recordFailure(backoff, err, true)
          if (attempted) await storeFailure(tx, row, err, false, form)
          return { error: err }
        }
        // A person's failures keep counting for the hour (see PERSONAL_WINDOW_MS); a shared flow's start over.
        if (!perUser) failures.delete(backoff)
        await store(tx, row, next)
        return { ok: true as const }
      })
      if ('error' in outcome) throw outcome.error
    },
  }
}

/**
 * What the status card shows about one sign-in (the shared one, or a person's own); never the variables. `state`:
 * `none` (not signed in yet), `signedIn`, `expired` (its time ran out: the next query signs in, or renews a
 * person's), `settingsChanged` (the flow changed since), or `failed` (the last sign-in a query needed failed:
 * `lastError`). A failed Sign in now leaves the variables in use, with its `lastError`.
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
  userId: string | null = null,
): Promise<CustomFlowStatus> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.resourceConfigId, resourceConfigId), ownedBy(userId)))
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

/** How many people have signed in with their own details (a flow with a form step), for people with Edit. */
export async function countSignedInPeople(db: Db, resourceConfigId: string): Promise<number> {
  const [counted] = await db
    .select({ n: count() })
    .from(oauthTokens)
    .where(and(eq(oauthTokens.resourceConfigId, resourceConfigId), isNotNull(oauthTokens.userId)))
  return counted?.n ?? 0
}

/**
 * Forgets a sign-in (Sign out): the shared one (the next query signs in again) or a person's own (they sign in
 * again). Returns whether there was one.
 */
export async function signOutCustomFlow(
  db: Db,
  resourceConfigId: string,
  userId: string | null = null,
): Promise<boolean> {
  const removed = await db
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.resourceConfigId, resourceConfigId), ownedBy(userId)))
    .returning({ id: oauthTokens.id })
  return removed.length > 0
}
