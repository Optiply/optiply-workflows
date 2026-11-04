import { type AppDefinition, addLibraryQuery, type LibraryAppQuery, usedLibraries } from '@ow/app-definition'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Library } from 'lucide-react'
import { useState } from 'react'
import { Dialog, EmptyState, ErrorNote, Input, Select, Spinner } from '@/components/ui'
import { useLibraryRefs } from '@/lib/library-refs'
import { useTRPC } from '@/lib/trpc'
import { AppCodeField, EditorField, problemsAt } from './fields'
import { useAppEditor } from './store'

/**
 * Keeps the store's knowledge of the library queries the app uses current (M14), so the validator checks their
 * versions and parameters while the app is edited.
 */
export function useLibrarySync() {
  const key = useAppEditor((s) => usedLibraries(s.definition).join(','))
  useLibraryRefs(
    key,
    useAppEditor((s) => s.setLibraries),
  )
}

/** Picks a published library query to add to the app. */
export function AddLibraryQueryDialog({
  page,
  onAdd,
  onClose,
}: {
  page: string | null
  onAdd: (make: (def: AppDefinition) => { definition: AppDefinition; name: string }) => void
  onClose: () => void
}) {
  const trpc = useTRPC()
  const list = useQuery(trpc.libraryQueries.list.queryOptions())
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const published = (list.data ?? []).filter(
    (q) => q.liveVersion && (!needle || q.name.toLowerCase().includes(needle) || q.slug.includes(needle)),
  )
  return (
    <Dialog title="Add a query from the library" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          aria-label="Search the library"
          placeholder="Search by name or slug"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {list.isLoading && <Spinner />}
        <ErrorNote error={list.error} />
        {list.data && published.length === 0 && (
          <EmptyState icon={<Library className="size-6" />} title="Nothing to add">
            Only published library queries you can use are listed.{' '}
            <Link to="/library" className="text-accent hover:underline">
              Open the Query Library
            </Link>
          </EmptyState>
        )}
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="library-picker">
          {published.map((q) => (
            <li key={q.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-subtle"
                onClick={() => {
                  onAdd((def) => addLibraryQuery(def, q.slug, { page }))
                  onClose()
                }}
              >
                <Library className="size-4 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{q.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">{q.slug}</span>
                </span>
                <span className="text-xs text-muted">v{q.liveVersion}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}

/** A parameter's stored value as the text its field shows: strings as written, other JSON as `{{ value }}`. */
const paramText = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : `{{ ${JSON.stringify(value)} }}`

/** The header of a library query: which one, its version, and when it runs. */
export function LibraryQueryHeader({
  query,
  edit,
}: {
  query: LibraryAppQuery
  edit: (change: (q: LibraryAppQuery) => LibraryAppQuery) => void
}) {
  const trpc = useTRPC()
  const library = useAppEditor((s) => s.libraries[query.library])
  const readOnly = useAppEditor((s) => s.readOnly)

  const releases = useQuery({
    ...trpc.libraryQueries.releases.queryOptions({ libraryQueryId: library?.id ?? '' }),
    enabled: !!library?.id,
  })
  return (
    <>
      <span className="flex h-8 items-center gap-1.5 text-sm">
        <Library className="size-4 text-accent" />
        <span className="font-medium">{library?.name ?? query.library}</span>
        <Link
          to="/library/$slug"
          params={{ slug: query.library }}
          title="Open in the Query Library"
          className="text-muted hover:text-ink"
        >
          <ExternalLink className="size-3.5" />
        </Link>
      </span>
      <Select
        disabled={readOnly}
        aria-label="Version"
        className="w-44"
        value={query.version}
        onChange={(e) => edit((q) => ({ ...q, version: e.target.value }))}
      >
        <option value="latest">Latest{library?.liveVersion ? ` (v${library.liveVersion})` : ''}</option>
        {releases.data?.map((r) => (
          <option key={r.id} value={r.version}>
            v{r.version}
          </option>
        ))}
        {query.version !== 'latest' && !releases.data?.some((r) => r.version === query.version) && (
          <option value={query.version}>v{query.version}</option>
        )}
      </Select>
      <Select
        disabled={readOnly}
        aria-label="Run"
        className="w-56"
        value={query.run}
        onChange={(e) => edit((q) => ({ ...q, run: e.target.value as 'auto' | 'manual' }))}
      >
        <option value="auto">Run automatically when inputs change</option>
        <option value="manual">Run only when triggered</option>
      </Select>
    </>
  )
}

/** The parameters the app passes (the chosen release's, and any it no longer declares) and the query, read-only. */
export function LibraryQueryBody({
  query,
  base,
  edit,
}: {
  query: LibraryAppQuery
  base: (string | number)[]
  edit: (change: (q: LibraryAppQuery) => LibraryAppQuery) => void
}) {
  const trpc = useTRPC()
  const diagnostics = useAppEditor((s) => s.diagnostics)
  const library = useAppEditor((s) => s.libraries[query.library])
  const releases = useQuery({
    ...trpc.libraryQueries.releases.queryOptions({ libraryQueryId: library?.id ?? '' }),
    enabled: !!library?.id,
  })
  const release = releases.data?.find((r) =>
    query.version === 'latest' ? r.live : r.version === query.version,
  )
  const declared = release?.params ?? []
  const extra = Object.keys(query.params ?? {}).filter((name) => !declared.some((p) => p.name === name))
  const setParam = (name: string, text: string) =>
    edit((q) => {
      const { [name]: _, ...rest } = q.params ?? {}
      const params = text === '' ? rest : { ...rest, [name]: text }
      const { params: _old, ...without } = q
      return Object.keys(params).length ? { ...without, params } : without
    })

  if (library === null) {
    return (
      <p className="text-sm text-danger">No library query has the slug "{query.library}". Pick another.</p>
    )
  }
  if (library?.noUse) {
    return (
      <p className="text-sm text-danger">
        You need use access to library query "{query.library}". Ask its owner for access, or pick another.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3" data-testid={`library-query-${query.name}`}>
      <ErrorNote error={releases.error} />
      {problemsAt(diagnostics, [...base, 'version']).map((p) => (
        <p key={p.message} className="text-sm text-danger">
          {p.message}
        </p>
      ))}
      {declared.length === 0 && extra.length === 0 && release && (
        <p className="text-sm text-muted">This release has no parameters.</p>
      )}
      {[...declared, ...extra.map((name) => ({ name, description: undefined }))].map((p) => (
        <EditorField
          key={p.name}
          label={<span className="font-mono">{p.name}</span>}
          hint={p.description ?? (extra.includes(p.name) ? 'Not a parameter of this release' : undefined)}
        >
          <AppCodeField
            path={[...base, 'params', p.name]}
            // Parsed into the parameter's value: not bound to a shared text.
            bind={false}
            language="plaintext"
            singleLine
            height={30}
            value={paramText(query.params?.[p.name])}
            problems={problemsAt(diagnostics, [...base, 'params', p.name])}
            onChange={(text) => setParam(p.name, text)}
          />
        </EditorField>
      ))}
      {release && (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            The query (v{release.version}, on {release.resource})
          </summary>
          <pre className="overflow-x-auto px-3 pb-3 font-mono text-xs whitespace-pre-wrap">
            {typeof release.query.sql === 'string'
              ? release.query.sql
              : JSON.stringify(release.query, null, 2)}
          </pre>
        </details>
      )}
      {(!library || (!release && releases.isLoading)) && <Spinner />}
    </div>
  )
}
