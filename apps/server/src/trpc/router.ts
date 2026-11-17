import { environments } from '@ow/db'
import { asc, desc, eq } from 'drizzle-orm'
import { capabilities } from '../services/capabilities'
import { groupsOf } from '../services/tasks'
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
import { jdbcDriversRouter } from './routers/jdbc-drivers'
import { jsPackagesRouter } from './routers/js-packages'
import { libraryQueriesRouter } from './routers/library-queries'
import { modulesRouter } from './routers/modules'
import { npmRegistriesRouter } from './routers/npm-registries'
import { permissionsRouter } from './routers/permissions'
import { pythonIndexesRouter } from './routers/python-indexes'
import { releasesRouter } from './routers/releases'
import { resourcesRouter } from './routers/resources'
import { retoolImportRouter } from './routers/retool-import'
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

  /** The signed-in person, and what they can reach (the sidebar's sections, where they may create). */
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.user) return null
    const { sessionId: _sessionId, ...user } = ctx.user
    const [caps, groups] = await Promise.all([capabilities(ctx.db, ctx.user), groupsOf(ctx.db, ctx.user.id)])
    // Settings are for Optiply's own admins; `isAdmin` already leaves out Admins members from outside the domain.
    return { ...user, ...caps, groups, settings: user.isAdmin }
  }),

  environments: router({
    /** The environments the caller may use: those only admins may use (session 56: Staging) are left out for others. */
    list: authedProcedure.query(({ ctx }) =>
      ctx.db
        .select()
        .from(environments)
        .where(ctx.user.isAdmin ? undefined : eq(environments.adminOnly, false))
        .orderBy(desc(environments.isDefault), asc(environments.name)),
    ),
  }),

  users: usersRouter,
  groups: groupsRouter,
  audit: auditRouter,
  resources: resourcesRouter,
  database: databaseRouter,
  folders: foldersRouter,
  jsPackages: jsPackagesRouter,
  npmRegistries: npmRegistriesRouter,
  permissions: permissionsRouter,
  tasks: tasksRouter,
  configVars: configVarsRouter,
  workflows: workflowsRouter,
  retoolImport: retoolImportRouter,
  releases: releasesRouter,
  accessTokens: accessTokensRouter,
  apiKeys: apiKeysRouter,
  apps: appsRouter,
  libraryQueries: libraryQueriesRouter,
  modules: modulesRouter,
  componentLibraries: componentLibrariesRouter,
  git: gitRouter,
  pythonIndexes: pythonIndexesRouter,
  jdbcDrivers: jdbcDriversRouter,
  branchDrafts: branchDraftsRouter,
})

export type AppRouter = typeof appRouter
