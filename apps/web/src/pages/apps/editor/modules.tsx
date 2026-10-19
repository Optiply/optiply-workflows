import { type AppComponent, addModuleInstance, setProp } from '@ow/app-definition'
import { compareVersions } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Puzzle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Dialog, EmptyState, ErrorNote, Input, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { placement } from './canvas'
import { EditorField, ProblemList } from './fields'
import { useAppEditor, usedModuleKeys, usedModuleSlugs } from './store'

/**
 * Keeps the store's knowledge of the modules the app places current (M14): what the validator needs (each one's
 * releases and their interfaces), and the releases the running draft's instances run (only modules the person
 * may use; the others don't run).
 */
export function useModuleSync() {
  const trpc = useTRPC()
  const slugKey = useAppEditor((s) => usedModuleSlugs(s.definition).join(','))
  const releaseKey = useAppEditor((s) => usedModuleKeys(s.definition).join(','))
  const setModules = useAppEditor((s) => s.setModules)
  const setModuleReleases = useAppEditor((s) => s.setModuleReleases)
  const slugs = slugKey ? slugKey.split(',') : []
  const keys = releaseKey ? releaseKey.split(',') : []
  const resolved = useQuery({
    ...trpc.modules.resolve.queryOptions({ slugs }),
    enabled: slugs.length > 0,
  })
  const releases = useQuery({
    ...trpc.modules.instanceReleases.queryOptions({ keys }),
    enabled: keys.length > 0,
  })
  useEffect(() => {
    if (!resolved.data || !slugKey) return
    setModules(Object.fromEntries(slugKey.split(',').map((slug) => [slug, resolved.data[slug] ?? null])))
  }, [resolved.data, slugKey, setModules])
  useEffect(() => {
    if (!releaseKey) setModuleReleases({})
    else if (releases.data) setModuleReleases(releases.data)
  }, [releases.data, releaseKey, setModuleReleases])
}

/** Places a published module in the app (M14): where the palette would put a component. */
export function AddModule() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" className="w-full justify-start" onClick={() => setOpen(true)}>
        <Puzzle className="size-3.5" /> Add a module
      </Button>
      {open && <AddModuleDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function AddModuleDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC()
  const list = useQuery(trpc.modules.list.queryOptions())
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const published = (list.data ?? []).filter(
    (m) => m.liveVersion && (!needle || m.name.toLowerCase().includes(needle) || m.slug.includes(needle)),
  )
  return (
    <Dialog title="Add a module" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          aria-label="Search modules"
          placeholder="Search by name or slug"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {list.isLoading && <Spinner />}
        <ErrorNote error={list.error} />
        {list.data && published.length === 0 && (
          <EmptyState icon={<Puzzle className="size-6" />} title="Nothing to add">
            Only published modules you can use are listed.{' '}
            <Link to="/modules" className="text-accent hover:underline">
              Open Modules
            </Link>
          </EmptyState>
        )}
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="module-picker">
          {published.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-subtle"
                onClick={() => {
                  const added = addModuleInstance(useAppEditor.getState().definition, m.slug, placement())
                  update(() => added.definition)
                  select(added.name)
                  onClose()
                }}
              >
                <Puzzle className="size-4 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{m.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">{m.slug}</span>
                </span>
                <span className="text-xs text-muted">v{m.liveVersion}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}

/**
 * Which module an instance places and which of its releases: `latest` (the live one, whatever it becomes) or a
 * version. Another module starts from its latest release.
 */
export function ModuleInstanceFields({ component, index }: { component: AppComponent; index: number }) {
  const trpc = useTRPC()
  const update = useAppEditor((s) => s.update)
  const slug = typeof component.props?.module === 'string' ? component.props.module : ''
  const version = typeof component.props?.version === 'string' ? component.props.version : 'latest'
  const ref = useAppEditor((s) => (slug ? s.modules[slug] : undefined))
  const list = useQuery(trpc.modules.list.queryOptions())
  const choices = (list.data ?? []).filter((m) => m.liveVersion || m.slug === slug)
  const versions = Object.keys(ref?.versions ?? {}).sort((a, b) => compareVersions(b, a))
  const path = ['components', index, 'props']
  return (
    <>
      <EditorField
        label="Module"
        aside={
          slug ? (
            <Link
              to="/modules/$slug"
              params={{ slug }}
              title="Open the module"
              className="text-muted hover:text-ink"
            >
              <ExternalLink className="size-3.5" />
            </Link>
          ) : undefined
        }
      >
        <Select
          aria-label="Module"
          value={slug}
          onChange={(e) =>
            update((def) =>
              setProp(
                setProp(def, component.name, 'version', undefined),
                component.name,
                'module',
                e.target.value,
              ),
            )
          }
        >
          {!choices.some((m) => m.slug === slug) && <option value={slug}>{slug || 'Pick a module'}</option>}
          {choices.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.name}
            </option>
          ))}
        </Select>
        <ProblemList path={[...path, 'module']} />
      </EditorField>
      <EditorField
        label="Version"
        hint={version === 'latest' && ref?.liveVersion ? `Now v${ref.liveVersion}` : undefined}
      >
        <Select
          aria-label="Version"
          value={version}
          onChange={(e) =>
            update((def) =>
              setProp(
                def,
                component.name,
                'version',
                e.target.value === 'latest' ? undefined : e.target.value,
              ),
            )
          }
        >
          <option value="latest">Latest</option>
          {!versions.includes(version) && version !== 'latest' && <option value={version}>v{version}</option>}
          {versions.map((v) => (
            <option key={v} value={v}>
              v{v}
            </option>
          ))}
        </Select>
        <ProblemList path={[...path, 'version']} />
      </EditorField>
    </>
  )
}
