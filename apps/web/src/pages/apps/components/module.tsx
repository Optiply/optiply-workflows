import { instanceRelease } from '@ow/app-definition'
import { Puzzle } from 'lucide-react'
import { AppCanvas } from '../canvas'
import { EditingContext, EditorActionsContext } from '../grid-context'
import type { RendererProps } from '../renderer'
import { AppScope, useAppHostState } from '../runtime/react'

/**
 * A module instance (M14): the components of the release it runs, on the module's own grid, with the instance's
 * values. In the editor too they render as in the app (the instance is edited as a whole, the module in its own
 * editor).
 */
export function ModuleRenderer({ component }: RendererProps) {
  const ref = instanceRelease(component)
  const release = useAppHostState((s) =>
    ref && Object.hasOwn(s.modules, ref.key) ? s.modules[ref.key] : undefined,
  )
  if (!release) {
    return (
      <div className="flex h-full items-center justify-center gap-2 rounded-md border border-dashed border-border p-2 text-xs text-muted">
        <Puzzle className="size-4 shrink-0" />
        <span className="truncate">
          {ref ? `Module ${ref.slug} (${ref.version}) isn't available` : 'Pick a module'}
        </span>
      </div>
    )
  }
  return (
    <div className="h-full overflow-auto" data-module={ref!.slug}>
      <EditingContext.Provider value={false}>
        {/* The instance's definition is the module's release: nothing on it is edited from here. */}
        <EditorActionsContext.Provider value={null}>
          <AppScope instance={component.name}>
            <AppCanvas definition={release.definition} />
          </AppScope>
        </EditorActionsContext.Provider>
      </EditingContext.Provider>
    </div>
  )
}
