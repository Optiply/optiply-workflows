import {
  addView,
  containerViews,
  type JsonValue,
  moveView,
  removeView,
  renameView,
  setProp,
  slotOf,
  viewNameReason,
} from '@ow/app-definition'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Input, Select } from '@/components/ui'
import { useAppEditor } from './store'

/**
 * A container's views as a list (M24): add, label, reorder, rename (its components, the default view and
 * `setView('…')` in code follow) and remove (asking where its components go).
 */
export function ViewsEditor({ name }: { name: string }) {
  const update = useAppEditor((s) => s.update)
  const readOnly = useAppEditor((s) => s.readOnly)
  const definition = useAppEditor((s) => s.definition)
  const container = definition.components.find((c) => c.name === name)
  const views = containerViews(container)
  const stored = (Array.isArray(container?.props?.views) ? container.props.views : []) as JsonValue[]
  const [removing, setRemoving] = useState<string | null>(null)
  const setLabel = (view: string, label: string) =>
    update((def) =>
      setProp(
        def,
        name,
        'views',
        stored.map((v) =>
          v && typeof v === 'object' && !Array.isArray(v) && v.name === view
            ? (({ label: _old, ...rest }) => (label ? { ...rest, label } : rest))(v)
            : v,
        ),
      ),
    )
  const move = (view: string, by: -1 | 1) => update((def) => moveView(def, name, view, by))
  return (
    <div className="flex flex-col gap-1" data-testid={`views-${name}`}>
      {views.length === 0 && (
        <p className="text-xs text-muted">One grid. Add views to switch between several.</p>
      )}
      <ul className="flex flex-col gap-1">
        {views.map((view, i) => {
          const count = definition.components.filter(
            (c) => c.parent === name && slotOf(definition, c) === view.name,
          ).length
          return (
            <li
              key={view.name}
              className="rounded-md border border-border bg-surface p-1.5"
              data-testid={`view-${view.name}`}
            >
              <div className="flex items-center gap-1">
                <ViewName container={name} view={view.name} disabled={readOnly} />
                <Input
                  aria-label={`Label of ${view.name}`}
                  value={view.label ?? ''}
                  placeholder={view.name}
                  disabled={readOnly}
                  onChange={(e) => setLabel(view.name, e.target.value)}
                  className="h-7 min-w-0 flex-1 text-xs"
                />
                {!readOnly && (
                  <>
                    <Button size="icon" variant="ghost" title="Move up" onClick={() => move(view.name, -1)}>
                      <ChevronUp className="size-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" title="Move down" onClick={() => move(view.name, 1)}>
                      <ChevronDown className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Remove view"
                      onClick={() =>
                        count === 0
                          ? update((def) => removeView(def, name, view.name, null))
                          : setRemoving(view.name)
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
              {removing === view.name && (
                <RemoveView
                  container={name}
                  view={view.name}
                  count={count}
                  others={views.filter((v) => v.name !== view.name).map((v) => v.name)}
                  onDone={() => setRemoving(null)}
                />
              )}
            </li>
          )
        })}
      </ul>
      {!readOnly && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => update((def) => addView(def, name).definition)}
        >
          <Plus className="size-3.5" /> Add view
        </Button>
      )}
    </div>
  )
}

/** A view's name, renamed on Enter or leaving the field; why a name can't be used, under it. */
function ViewName({ container, view, disabled }: { container: string; view: string; disabled: boolean }) {
  const update = useAppEditor((s) => s.update)
  const [text, setText] = useState(view)
  const reason =
    text === view ? null : viewNameReason(useAppEditor.getState().definition, container, text, view)
  const commit = () => {
    if (text === view) return
    if (reason) return setText(view)
    update((def) => renameView(def, container, view, text))
  }
  return (
    <div className="flex w-28 shrink-0 flex-col">
      <Input
        aria-label={`Name of view ${view}`}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(view)
        }}
        className="h-7 font-mono text-xs"
      />
      {reason && <span className="text-[11px] text-danger">{reason}</span>}
    </div>
  )
}

/** Where a removed view's components go: another view, or away with it. */
function RemoveView({
  container,
  view,
  count,
  others,
  onDone,
}: {
  container: string
  view: string
  count: number
  others: string[]
  onDone: () => void
}) {
  const update = useAppEditor((s) => s.update)
  const [to, setTo] = useState(others[0] ?? '')
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-border pt-1.5 text-xs">
      <span>
        {count} {count === 1 ? 'component' : 'components'} in it:
      </span>
      <Select
        aria-label="Where its components go"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="h-7 text-xs"
      >
        {others.map((o) => (
          <option key={o} value={o}>
            move to {o}
          </option>
        ))}
        <option value="">remove them</option>
      </Select>
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          update((def) => removeView(def, container, view, to || null))
          onDone()
        }}
      >
        Remove view
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </div>
  )
}
