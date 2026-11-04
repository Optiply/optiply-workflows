import {
  addModuleItem,
  appNameReason,
  appNameSchema,
  type ModulePart,
  type ModuleSpec,
  removeModuleItem,
  updateModuleItem,
} from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Input, sectionLabelClass } from '@/components/ui'
import { parseTestValue, showTestValue } from '@/lib/test-value'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AppCodeField, EditorField, ProblemList, problemsAt } from './fields'
import { useAppEditor } from './store'

const PARTS: { part: ModulePart; title: string; empty: string }[] = [
  { part: 'inputs', title: 'Inputs', empty: 'What apps pass in; read as inputs.<name>.' },
  { part: 'outputs', title: 'Outputs', empty: 'What apps read off the instance; each a {{ }} template.' },
  { part: 'events', title: 'Events', empty: 'What apps can handle; fired by a Fire module event action.' },
]

/**
 * A module's interface (M14), in place of the pages: its inputs (with a default and the value its editor runs
 * with), outputs and events; and the apps using it.
 */
export function ModulePanel() {
  const spec = useAppEditor((s) => s.definition.module)
  const readOnly = useAppEditor((s) => s.readOnly)
  const update = useAppEditor((s) => s.update)
  const [open, setOpen] = useState<string | null>(null)
  if (!spec) return null
  return (
    <section aria-label="Module" className="flex flex-col gap-4">
      {PARTS.map(({ part, title, empty }) => (
        <div key={part}>
          <div className="mb-1 flex items-center gap-1">
            <h2 className={cn('flex-1', sectionLabelClass)}>{title}</h2>
            {!readOnly && (
              <Button
                size="icon"
                variant="ghost"
                title={`Add ${title.toLowerCase().replace(/s$/, '')}`}
                onClick={() => {
                  const added = addModuleItem(useAppEditor.getState().definition, part)
                  update(() => added.definition)
                  setOpen(`${part}:${added.name}`)
                }}
              >
                <Plus className="size-3.5" />
              </Button>
            )}
          </div>
          {spec[part].length === 0 && <p className="px-1 text-xs text-muted">{empty}</p>}
          <ul className="flex flex-col gap-1">
            {spec[part].map((item, index) => {
              const key = `${part}:${item.name}`
              return (
                <li key={key}>
                  <button
                    type="button"
                    aria-expanded={open === key}
                    onClick={() => setOpen(open === key ? null : key)}
                    className={cn(
                      'flex w-full items-center rounded px-2 py-1 text-left font-mono text-xs',
                      open === key ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-canvas hover:text-ink',
                    )}
                  >
                    {item.name}
                  </button>
                  {open === key && (
                    <ItemSettings
                      part={part}
                      item={item}
                      index={index}
                      onRenamed={(name) => setOpen(`${part}:${name}`)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      <UsedBy />
    </section>
  )
}

type Item = ModuleSpec[ModulePart][number]

/** One input, output or event: its name (applied on Enter or leaving the field), description and values. */
function ItemSettings({
  part,
  item,
  index,
  onRenamed,
}: {
  part: ModulePart
  item: Item
  index: number
  onRenamed: (name: string) => void
}) {
  const update = useAppEditor((s) => s.update)
  const readOnly = useAppEditor((s) => s.readOnly)
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const [name, setName] = useState(item.name)
  const [nameError, setNameError] = useState<string | null>(null)
  useEffect(() => setName(item.name), [item.name])
  const siblings = useAppEditor((s) => s.definition.module?.[part] ?? [])
  const at = ['module', part, index]
  const change = (next: Item) => update((def) => updateModuleItem(def, part, item.name, next))
  const label = part === 'inputs' ? 'Input' : part === 'outputs' ? 'Output' : 'Event'
  // A name that isn't one, or is taken, isn't applied (M21): renaming an input rewrites the code reading it, which
  // only works from one valid, unique name to another.
  const rename = () => {
    const to = name.trim()
    setNameError(null)
    if (!to || to === item.name) return setName(item.name)
    const parsed = appNameSchema.safeParse(to)
    const reason = !parsed.success
      ? (parsed.error.issues[0]?.message ?? 'Not a valid name')
      : (appNameReason(to) ??
        (siblings.some((i) => i.name === to)
          ? `Another ${label.toLowerCase()} is already named "${to}"`
          : null))
    if (reason) {
      setNameError(reason)
      return setName(item.name)
    }
    change({ ...item, name: to })
    onRenamed(to)
  }
  /** Sets a key, or removes it when undefined or blank (the schema keeps optional keys absent). */
  const set = (key: string, value: unknown) => {
    const next: Record<string, unknown> = { ...item, [key]: value }
    if (value === undefined || value === '') delete next[key]
    change(next as Item)
  }
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border border-border p-2">
      <EditorField label="Name">
        <Input
          aria-label={`${label} name`}
          className="font-mono"
          value={name}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename()
            if (e.key === 'Escape') setName(item.name)
          }}
        />
        {nameError && <p className="text-xs text-danger">{nameError}</p>}
        <ProblemList path={[...at, 'name']} />
      </EditorField>
      {'value' in item && (
        <EditorField label="Value" hint="A {{ }} template over the module's values">
          <AppCodeField
            path={[...at, 'value']}
            language="plaintext"
            singleLine
            height={30}
            value={item.value}
            problems={problemsAt(diagnostics, [...at, 'value'])}
            onChange={(value) => set('value', value)}
          />
        </EditorField>
      )}
      {part === 'inputs' && (
        <>
          <EditorField label="Default" hint="When the app passes nothing">
            <Input
              aria-label={`${item.name} default`}
              value={showTestValue((item as ModuleSpec['inputs'][number]).default)}
              disabled={readOnly}
              onChange={(e) => set('default', parseTestValue(e.target.value))}
            />
          </EditorField>
          <EditorField label="Test value" hint="What this editor runs the module with">
            <Input
              aria-label={`${item.name} test value`}
              value={showTestValue((item as ModuleSpec['inputs'][number]).testValue)}
              disabled={readOnly}
              onChange={(e) => set('testValue', parseTestValue(e.target.value))}
            />
          </EditorField>
        </>
      )}
      <EditorField label="Description">
        <Input
          aria-label={`${item.name} description`}
          value={item.description ?? ''}
          disabled={readOnly}
          onChange={(e) => set('description', e.target.value)}
        />
      </EditorField>
      {!readOnly && (
        <Button
          size="sm"
          variant="ghost"
          className="self-end"
          onClick={() => update((def) => removeModuleItem(def, part, item.name))}
        >
          <Trash2 className="size-3.5" /> Remove
        </Button>
      )}
    </div>
  )
}

/** The apps and (M21) modules placing the module, in their draft, live release or a Git branch draft. */
function UsedBy() {
  const trpc = useTRPC()
  const moduleId = useAppEditor((s) => s.appId)
  const usedBy = useQuery({
    ...trpc.modules.usedBy.queryOptions({ moduleId: moduleId! }),
    enabled: !!moduleId,
  })
  if (!usedBy.data) return null
  const { apps, modules, hidden } = usedBy.data
  return (
    <div data-testid="module-used-by">
      <h2 className={cn('mb-1', sectionLabelClass)}>Used by</h2>
      {apps.length === 0 && modules.length === 0 && !hidden && (
        <p className="px-1 text-xs text-muted">Nothing uses it yet.</p>
      )}
      <ul className="flex flex-col">
        {apps.map((a) => (
          <li key={a.id}>
            <Link
              to="/apps/$slug/edit"
              params={{ slug: a.slug }}
              className="block truncate rounded px-2 py-1 text-xs text-accent hover:bg-canvas"
              title={`In its ${a.where.join(', ')}`}
            >
              {a.name}
            </Link>
          </li>
        ))}
        {modules.map((m) => (
          <li key={m.id}>
            <Link
              to="/modules/$slug"
              params={{ slug: m.slug }}
              className="block truncate rounded px-2 py-1 text-xs text-accent hover:bg-canvas"
              title={`A module · in its ${m.where.join(', ')}`}
            >
              {m.name} <span className="text-muted">(module)</span>
            </Link>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="px-1 text-xs text-muted">and {hidden} more you can't see</p>}
    </div>
  )
}
