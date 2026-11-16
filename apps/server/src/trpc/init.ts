// Loads @fastify/cookie's `request.cookies` type augmentation for consumers that only see this router.
import type {} from '@fastify/cookie'
import type { PoolManager } from '@ow/connectors'
import type { Db } from '@ow/db'
import type { CodeRuntime } from '@ow/sandbox'
import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import superjson from 'superjson'
import type { AuditInput } from '../audit'
import { recordAudit } from '../audit'
import {
  APPS_ONLY_REFUSAL,
  lookupAccessToken,
  lookupSession,
  presentedAccessToken,
  SESSION_COOKIE,
} from '../auth/sessions'
import type { Config } from '../config'
import type { AppWorkflowRuns } from '../services/app-workflow-query'
import { asksForGitRetry, requestGitRetry } from '../services/git/deploy'

/** Long-lived services shared by all requests. */
export interface Services {
  /** Connector clients (DB pools, HTTP agents), keyed by resource config version. */
  pool: PoolManager
  /** Evaluates `{{ }}` in the query playground. */
  sandbox: CodeRuntime
  /** Runs workflows for apps' workflow queries (M36): the API's inline runner and run events. */
  runs?: AppWorkflowRuns
}

export function contextFactory(deps: { db: Db; config: Config; services: Services }) {
  return async ({ req }: CreateFastifyContextOptions) => {
    // A personal access token (M33) when one is presented (the CLI); else the session's cookie (browsers).
    const presented = presentedAccessToken(req.headers)
    const viaToken = presented ? await lookupAccessToken(deps.db, presented) : null
    const user = presented
      ? (viaToken?.user ?? null)
      : await lookupSession(deps.db, req.cookies[SESSION_COOKIE])
    const token = viaToken?.token ?? null
    const requestMeta = { ip: req.ip, userAgent: req.headers['user-agent'] }
    return {
      db: deps.db,
      config: deps.config,
      services: deps.services,
      user,
      /** The access token the request came with (M33), or null for a session. */
      token,
      /** A token was presented but isn't valid (unknown, revoked, expired, its user disabled). */
      badToken: !!presented && !viaToken,
      /**
       * Records an audit event attributed to the current user and request. A change a Git deploy's problem objects
       * may have been waiting for (a resource, config var, library query or module) marks them for a re-check (M22).
       */
      audit: async (event: Omit<AuditInput, 'actorUserId' | 'ip' | 'userAgent'>) => {
        const metadata = token ? { ...(event.metadata ?? {}), via: token.prefix } : event.metadata
        await recordAudit(deps.db, { ...event, metadata, actorUserId: user?.id ?? null, ...requestMeta })
        if (asksForGitRetry(event.action)) await requestGitRetry(deps.db)
      },
    }
  }
}

export type Context = Awaited<ReturnType<ReturnType<typeof contextFactory>>>

const t = initTRPC.context<Context>().create({ transformer: superjson })

export const router = t.router
/** Calls a router's procedures in-process with a request's context (M36: the Retool import reuses create and save). */
export const createCallerFactory = t.createCallerFactory
export const publicProcedure = t.procedure

/**
 * What an access token's scope reaches (M33): `component-libraries` is the component library procedures and what
 * the CLI reads besides (who it is, folders). Anything else answers 403 to a token.
 */
const TOKEN_PROCEDURES: Record<string, (path: string) => boolean> = {
  'component-libraries': (path) =>
    path.startsWith('componentLibraries.') || path === 'me' || path === 'folders.list',
}

/**
 * All someone whose access is apps only may call: what opening and using a live app needs, and the list of their apps
 * (their own page). Their grants reach only apps anyway (`loadAccess`); this keeps the rest of the platform shut too,
 * the lists and settings everyone signed in may otherwise read. REST checks objects through `loadAccess` the same way.
 */
export const APPS_ONLY_PROCEDURES: ReadonlySet<string> = new Set([
  'apps.list',
  'apps.access',
  'apps.open',
  'apps.runQuery',
  'environments.list',
])

export const authedProcedure = t.procedure.use(({ ctx, next, path }) => {
  if (ctx.badToken) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This access token is unknown, revoked or expired' })
  }
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not signed in' })
  if (ctx.user.appsOnly && !APPS_ONLY_PROCEDURES.has(path)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: APPS_ONLY_REFUSAL })
  }
  if (ctx.token && !ctx.token.scopes.some((scope) => TOKEN_PROCEDURES[scope]?.(path))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `An access token can't call ${path}: it's outside its scope`,
    })
  }
  return next({ ctx: { ...ctx, user: ctx.user } })
})

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (!ctx.user.isAdmin) throw new TRPCError({ code: 'FORBIDDEN', message: 'Admins only' })
  return next()
})
