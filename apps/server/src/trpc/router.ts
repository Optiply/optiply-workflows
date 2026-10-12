import { environments } from '@ow/db'
import { asc, desc } from 'drizzle-orm'
import { authedProcedure, publicProcedure, router } from './init'
import { auditRouter } from './routers/audit'
import { groupsRouter } from './routers/groups'
import { usersRouter } from './routers/users'

export const appRouter = router({
  /** What the login page needs to render. */
  authConfig: publicProcedure.query(({ ctx }) => ({
    oidcEnabled: ctx.config.oidcEnabled,
    localLoginEnabled: ctx.config.LOCAL_LOGIN_ENABLED,
    allowedDomain: ctx.config.OIDC_ALLOWED_DOMAIN,
  })),

  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null
    const { sessionId: _sessionId, ...user } = ctx.user
    return user
  }),

  environments: router({
    list: authedProcedure.query(({ ctx }) =>
      ctx.db.select().from(environments).orderBy(desc(environments.isDefault), asc(environments.name)),
    ),
  }),

  users: usersRouter,
  groups: groupsRouter,
  audit: auditRouter,
})

export type AppRouter = typeof appRouter
