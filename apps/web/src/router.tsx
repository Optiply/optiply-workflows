import type { AppRouter } from '@ow/server/trpc'
import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { z } from 'zod'
import { queryClient, trpcClient } from './lib/trpc'
import { AppShell } from './pages/app-shell'
import { InboxPage } from './pages/inbox/list'
import { TaskPage } from './pages/inbox/task'
import { LoginPage } from './pages/login'
import { ResourceDetailPage } from './pages/resources/detail'
import { ResourcesPage } from './pages/resources/list'
import { RunsPage } from './pages/runs/list'
import { ApiKeysPage } from './pages/settings/api-keys'
import { AuditPage } from './pages/settings/audit'
import { ConfigVarsPage } from './pages/settings/config-vars'
import { EnvironmentsPage } from './pages/settings/environments'
import { GroupDetailPage } from './pages/settings/group-detail'
import { GroupsPage } from './pages/settings/groups'
import { SettingsLayout } from './pages/settings/layout'
import { UsersPage } from './pages/settings/users'
import { WorkflowsPage } from './pages/workflows/list'

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
  component: WorkflowsPage,
})
/** The editor (canvas, validator, later Monaco) is its own chunk, loaded when a workflow is opened. */
const workflowEditorRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workflows/$workflowId',
  staticData: { fullBleed: true },
  /** `run` opens that run in the run panel (links from /runs). */
  validateSearch: z.object({ run: z.string().uuid().optional() }),
  component: lazyRouteComponent(() => import('./pages/workflows/editor'), 'WorkflowEditorPage'),
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
/** The managed database: its own chunk (the grid and its libraries load when it's opened). */
const databaseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/database',
  staticData: { fullBleed: true },
  validateSearch: z.object({ env: z.string().optional(), table: z.string().optional() }),
  component: lazyRouteComponent(() => import('./pages/database'), 'DatabasePage'),
})
/** Someone using an app: its live release, in its own chunk (the sandbox's script travels with it). */
const appViewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/apps/$slug',
  staticData: { fullBleed: true },
  validateSearch: z.object({ env: z.string().optional() }),
  component: lazyRouteComponent(() => import('./pages/apps/view'), 'AppViewPage'),
})
const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs',
  component: RunsPage,
})
const inboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/inbox',
  component: InboxPage,
})
const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/inbox/$taskId',
  component: TaskPage,
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
const apiKeysRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/api-keys',
  component: ApiKeysPage,
})
const auditRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/audit', component: AuditPage })

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    workflowsRoute,
    workflowEditorRoute,
    resourcesRoute,
    resourceDetailRoute,
    databaseRoute,
    appViewRoute,
    runsRoute,
    inboxRoute,
    taskRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      usersRoute,
      groupsRoute,
      groupDetailRoute,
      environmentsRoute,
      configVarsRoute,
      apiKeysRoute,
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
  interface StaticDataRouteOption {
    /** The page fills the whole content area instead of the centred, padded column. */
    fullBleed?: boolean
  }
}
