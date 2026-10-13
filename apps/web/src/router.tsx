import type { AppRouter } from '@ow/server/trpc'
import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { z } from 'zod'
import { queryClient, trpcClient } from './lib/trpc'
import { AppShell } from './pages/app-shell'
import { LoginPage } from './pages/login'
import { ComingSoon } from './pages/placeholders'
import { ResourceDetailPage } from './pages/resources/detail'
import { ResourcesPage } from './pages/resources/list'
import { AuditPage } from './pages/settings/audit'
import { ConfigVarsPage } from './pages/settings/config-vars'
import { EnvironmentsPage } from './pages/settings/environments'
import { GroupDetailPage } from './pages/settings/group-detail'
import { GroupsPage } from './pages/settings/groups'
import { SettingsLayout } from './pages/settings/layout'
import { UsersPage } from './pages/settings/users'

export interface RouterContext {
  queryClient: QueryClient
  trpc: TRPCOptionsProxy<AppRouter>
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: z.object({ error: z.string().optional() }),
  component: LoginPage,
})

/** Everything behind authentication hangs off this pathless layout. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(context.trpc.me.queryOptions())
    if (!me) throw redirect({ to: '/login' })
    return { me }
  },
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/workflows' })
  },
})

const workflowsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workflows',
  component: () => <ComingSoon section="workflows" />,
})
const resourcesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/resources',
  component: ResourcesPage,
})
const resourceDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/resources/$resourceId',
  component: ResourceDetailPage,
})
const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs',
  component: () => <ComingSoon section="runs" />,
})

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: SettingsLayout,
})
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/settings/users' })
  },
})
const usersRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/users', component: UsersPage })
const groupsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/groups',
  component: GroupsPage,
})
export const groupDetailRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/groups/$groupId',
  component: GroupDetailPage,
})
const environmentsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/environments',
  component: EnvironmentsPage,
})
const configVarsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/config-vars',
  component: ConfigVarsPage,
})
const auditRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/audit', component: AuditPage })

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    workflowsRoute,
    resourcesRoute,
    resourceDetailRoute,
    runsRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      usersRoute,
      groupsRoute,
      groupDetailRoute,
      environmentsRoute,
      configVarsRoute,
      auditRoute,
    ]),
  ]),
])

export const router = createRouter({
  routeTree,
  context: { queryClient, trpc: createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient }) },
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
