// Loads @fastify/cookie's `request.cookies` type augmentation for consumers that only see this router.
import type {} from '@fastify/cookie'
import type { Db } from '@ow/db'
import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import superjson from 'superjson'
import type { AuditInput } from '../audit'
import { recordAudit } from '../audit'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import type { Config } from '../config'

export function contextFactory(deps: { db: Db; config: Config }) {
  return async ({ req }: CreateFastifyContextOptions) => {
    const user = await lookupSession(deps.db, req.cookies[SESSION_COOKIE])
    const requestMeta = { ip: req.ip, userAgent: req.headers['user-agent'] }
    return {
      db: deps.db,
      config: deps.config,
      user,
      /** Records an audit event attributed to the current user and request. */
      audit: (event: Omit<AuditInput, 'actorUserId' | 'ip' | 'userAgent'>) =>
        recordAudit(deps.db, { ...event, actorUserId: user?.id ?? null, ...requestMeta }),
    }
  }
}

export type Context = Awaited<ReturnType<ReturnType<typeof contextFactory>>>

const t = initTRPC.context<Context>().create({ transformer: superjson })

export const router = t.router
export const publicProcedure = t.procedure

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not signed in' })
  return next({ ctx: { ...ctx, user: ctx.user } })
})

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (!ctx.user.isAdmin) throw new TRPCError({ code: 'FORBIDDEN', message: 'Admins only' })
  return next()
})
