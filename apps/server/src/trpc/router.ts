import { environments } from '@ow/db'
import { asc, desc } from 'drizzle-orm'
import { authedProcedure, publicProcedure, router } from './init'
import { auditRouter } from './routers/audit'
import { configVarsRouter } from './routers/config-vars'
import { foldersRouter } from './routers/folders'
import { groupsRouter } from './routers/groups'
import { permissionsRouter } from './routers/permissions'
import { releasesRouter } from './routers/releases'
import { resourcesRouter } from './routers/resources'
import { usersRouter } from './routers/users'
import { workflowsRouter } from './routers/workflows'

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
  resources: resourcesRouter,
  folders: foldersRouter,
  permissions: permissionsRouter,
  configVars: configVarsRouter,
  workflows: workflowsRouter,
  releases: releasesRouter,
})

export type AppRouter = typeof appRouter
