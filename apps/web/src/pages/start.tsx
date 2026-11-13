import { getRouteApi } from '@tanstack/react-router'
import { DoorOpen } from 'lucide-react'
import { EmptyState } from '@/components/ui'

const appRoute = getRouteApi('/app')

/** Where someone with access to nothing yet lands (signed in, but nothing shared with them). */
export function StartPage() {
  const { me } = appRoute.useRouteContext()
  return (
    <div className="pt-10">
      <EmptyState icon={<DoorOpen className="size-6" />} title={`Welcome, ${me.name.split(' ')[0]}`}>
        Nothing has been shared with you yet. Ask an admin for access to the workflows or apps you need; they
        show up here once you have it.
      </EmptyState>
    </div>
  )
}
