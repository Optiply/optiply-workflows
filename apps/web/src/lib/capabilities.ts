import { getRouteApi } from '@tanstack/react-router'

const appRoute = getRouteApi('/app')

type CreateKey = 'workflows' | 'apps' | 'library' | 'modules' | 'componentLibraries' | 'resources'

/** Whether the signed-in person may create things of a kind (Edit on all of them, or an admin): the New buttons. */
export function useCanCreate(key: CreateKey): boolean {
  return appRoute.useRouteContext().me.canCreate[key]
}
