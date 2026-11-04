import { environments } from '@ow/db'
import { asc, desc } from 'drizzle-orm'
import { authedProcedure, publicProcedure, router } from './init'
import { accessTokensRouter } from './routers/access-tokens'
import { apiKeysRouter } from './routers/api-keys'
import { appsRouter } from './routers/apps'
import { auditRouter } from './routers/audit'
import { branchDraftsRouter } from './routers/branch-drafts'
import { componentLibrariesRouter } from './routers/component-libraries'
import { configVarsRouter } from './routers/config-vars'
import { databaseRouter } from './routers/database'
import { foldersRouter } from './routers/folders'
import { gitRouter } from './routers/git'
import { groupsRouter } from './routers/groups'
import { libraryQueriesRouter } from './routers/library-queries'
import { modulesRouter } from './routers/modules'
import { npmRegistriesRouter } from './routers/npm-registries'
import { permissionsRouter } from './routers/permissions'
import { pythonIndexesRouter } from './routers/python-indexes'
import { releasesRouter } from './routers/releases'
import { resourcesRouter } from './routers/resources'
import { tasksRouter } from './routers/tasks'
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
  database: databaseRouter,
  folders: foldersRouter,
  npmRegistries: npmRegistriesRouter,
  permissions: permissionsRouter,
  tasks: tasksRouter,
  configVars: configVarsRouter,
  workflows: workflowsRouter,
  releases: releasesRouter,
  accessTokens: accessTokensRouter,
  apiKeys: apiKeysRouter,
  apps: appsRouter,
  libraryQueries: libraryQueriesRouter,
  modules: modulesRouter,
  componentLibraries: componentLibrariesRouter,
  git: gitRouter,
  pythonIndexes: pythonIndexesRouter,
  branchDrafts: branchDraftsRouter,
})

export type AppRouter = typeof appRouter
