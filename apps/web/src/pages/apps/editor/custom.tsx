import {
  type AppComponent,
  addCustomInstance,
  customInstanceKeys,
  setProp,
  usedComponentLibraries,
} from '@ow/app-definition'
import { compareVersions } from '@ow/definition'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Blocks, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Dialog, EmptyState, ErrorNote, Input, Select, Spinner } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { placement } from './canvas'
import { EditorField, ProblemList } from './fields'
import { useAppEditor } from './store'

/**
 * Keeps the store's knowledge of the component libraries the app's custom components use current (M25): what the
 * validator and the inspector need (each library's releases and their components), and the releases the running
 * draft's components run (only libraries the person may use; the others don't show).
 */
export function useComponentLibrarySync() {
  const trpc = useTRPC()
  const slugKey = useAppEditor((s) => usedComponentLibraries(s.definition).join(','))
  // The running draft's modules' custom components too.
  const keyKey = useAppEditor((s) =>
    [
      ...new Set([
        ...customInstanceKeys(s.definition),
        ...Object.values(s.moduleReleases).flatMap((m) => customInstanceKeys(m.definition)),
      ]),
    ]
      .sort()
      .join(','),
  )
  const setLibraries = useAppEditor((s) => s.setComponentLibraries)
  const setReleases = useAppEditor((s) => s.setLibraryReleases)
  const slugs = slugKey ? slugKey.split(',') : []
  const keys = keyKey ? keyKey.split(',') : []
  const resolved = useQuery({
    ...trpc.componentLibraries.resolve.queryOptions({ slugs }),
    enabled: slugs.length > 0,
  })
  const releases = useQuery({
    ...trpc.componentLibraries.instanceReleases.queryOptions({ keys }),
    enabled: keys.length > 0,
  })
  useEffect(() => {
    if (!resolved.data || !slugKey) return
    setLibraries(Object.fromEntries(slugKey.split(',').map((slug) => [slug, resolved.data[slug] ?? null])))
  }, [resolved.data, slugKey, setLibraries])
  useEffect(() => {
    if (!keyKey) setReleases({})
    else if (releases.data) setReleases(releases.data)
  }, [releases.data, keyKey, setReleases])
}

/** Places a published library's component in the app or module, where the palette would put one. */
export function AddCustomComponent() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" className="w-full justify-start" onClick={() => setOpen(true)}>
        <Blocks className="size-3.5" /> Add a custom component
      </Button>
      {open && <AddCustomDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function AddCustomDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC()
  const list = useQuery(trpc.componentLibraries.list.queryOptions())
  const update = useAppEditor((s) => s.update)
  const select = useAppEditor((s) => s.select)
  const [search, setSearch] = useState('')
  const live = (list.data ?? []).filter((l) => l.liveVersion)
  const resolved = useQuery({
    ...trpc.componentLibraries.resolve.queryOptions({ slugs: live.map((l) => l.slug) }),
    enabled: live.length > 0,
  })
  const needle = search.trim().toLowerCase()
  const offered = live.flatMap((l) => {
    const info = resolved.data?.[l.slug]
    const components = info?.liveVersion ? (info.versions[info.liveVersion] ?? {}) : {}
    return Object.entries(components)
      .filter(
        ([name, c]) =>
          !needle ||
          name.toLowerCase().includes(needle) ||
          c.label.toLowerCase().includes(needle) ||
          l.name.toLowerCase().includes(needle),
      )
      .map(([name, c]) => ({ library: l, name, component: c }))
  })
  return (
    <Dialog title="Add a custom component" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          aria-label="Search custom components"
          placeholder="Search by component or library"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {(list.isLoading || resolved.isLoading) && <Spinner />}
        <ErrorNote error={list.error ?? resolved.error} />
        {list.data && !resolved.isLoading && offered.length === 0 && (
          <EmptyState icon={<Blocks className="size-6" />} title="Nothing to add">
            Only components of published libraries you can use are listed.{' '}
            <Link to="/component-libraries" className="text-accent hover:underline">
              Open Components
            </Link>
          </EmptyState>
        )}
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="custom-picker">
          {offered.map(({ library, name, component }) => (
            <li key={`${library.slug}:${name}`}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-subtle"
                onClick={() => {
                  const added = addCustomInstance(
                    useAppEditor.getState().definition,
                    {
                      library: library.slug,
                      version: 'latest',
                      component: name,
                      defaultSize: component.defaultSize,
                    },
                    placement(),
                  )
                  update(() => added.definition)
                  select(added.name)
                  onClose()
                }}
              >
                <Blocks className="size-4 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{component.label || name}</span>
                  <span className="block truncate font-mono text-xs text-muted">
                    {library.slug} · {name}
                  </span>
                </span>
                <span className="text-xs text-muted">v{library.liveVersion}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}

/**
 * Which library, component and release a custom component runs: `latest` (the live one, whatever it becomes) or a
 * version. Another library starts from its latest release and its first component.
 */
export function CustomInstanceFields({ component, index }: { component: AppComponent; index: number }) {
  const trpc = useTRPC()
  const update = useAppEditor((s) => s.update)
  const slug = typeof component.props?.library === 'string' ? component.props.library : ''
  const version = typeof component.props?.version === 'string' ? component.props.version : 'latest'
  const name = typeof component.props?.component === 'string' ? component.props.component : ''
  const ref = useAppEditor((s) => (slug ? s.componentLibraries[slug] : undefined))
  const list = useQuery(trpc.componentLibraries.list.queryOptions())
  const choices = (list.data ?? []).filter((l) => l.liveVersion || l.slug === slug)
  const versions = Object.keys(ref?.versions ?? {}).sort((a, b) => compareVersions(b, a))
  const at = version === 'latest' ? ref?.liveVersion : version
  const components = Object.keys((at && ref?.versions[at]) || {})
  const path = ['components', index, 'props']
  const set = (prop: string, value: string | undefined) =>
    update((def) => setProp(def, component.name, prop, value))
  return (
    <>
      <EditorField
        label="Library"
        aside={
          slug ? (
            <Link
              to="/component-libraries/$slug"
              params={{ slug }}
              title="Open the library"
              className="text-muted hover:text-ink"
            >
              <ExternalLink className="size-3.5" />
            </Link>
          ) : undefined
        }
      >
        <Select
          aria-label="Library"
          value={slug}
          onChange={(e) =>
            update((def) =>
              setProp(
                setProp(
                  setProp(def, component.name, 'version', undefined),
                  component.name,
                  'component',
                  undefined,
                ),
                component.name,
                'library',
                e.target.value,
              ),
            )
          }
        >
          {!choices.some((l) => l.slug === slug) && <option value={slug}>{slug || 'Pick a library'}</option>}
          {choices.map((l) => (
            <option key={l.slug} value={l.slug}>
              {l.name}
            </option>
          ))}
        </Select>
        <ProblemList path={[...path, 'library']} />
      </EditorField>
      <EditorField label="Component">
        <Select aria-label="Component" value={name} onChange={(e) => set('component', e.target.value)}>
          {!components.includes(name) && <option value={name}>{name || 'Pick a component'}</option>}
          {components.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <ProblemList path={[...path, 'component']} />
      </EditorField>
      <EditorField
        label="Version"
        hint={version === 'latest' && ref?.liveVersion ? `Now v${ref.liveVersion}` : undefined}
      >
        <Select
          aria-label="Version"
          value={version}
          onChange={(e) => set('version', e.target.value === 'latest' ? undefined : e.target.value)}
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
