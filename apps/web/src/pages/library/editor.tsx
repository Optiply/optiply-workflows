import type { LibraryDiagnostic, LibraryParam, LibraryQueryDefinition } from '@ow/app-definition'
import { bumpVersion, compareVersions, type VersionBump } from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { GitBranch, GitCompare, History, Play, Plus, Rocket, Trash2, Undo2, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import CodeField, { type FieldProblem } from '@/components/code/code-field'
import type { TextBinding } from '@/components/code/text-binding'
import { CompareReleasesDialog } from '@/components/compare-releases'
import { confirmDialog } from '@/components/confirm'
import { DroppedWarning } from '@/components/dropped-warning'
import { ProtectDialog, UNPROTECT_CONFIRM, useGitInfo, useUnprotect } from '@/components/git'
import { GitBar } from '@/components/git-bar'
import { PresenceAvatars } from '@/components/presence-avatars'
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  SectionLabel,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui'
import { UndoButtons } from '@/components/undo-buttons'
import type { SaveStatus as SaveStatusName } from '@/lib/collab-session'
import { useEditorKeys } from '@/lib/editor-keys'
import { defaultQuery, isSqlType } from '@/lib/resource-types'
import { parseTestValue, showTestValue } from '@/lib/test-value'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AccessEditor, ConnectorErrorNote, ResultView } from '../resources/shared'
import {
  closeLibrarySession,
  ensureLibrarySaved,
  libraryAwareness,
  openLibrarySession,
  useLibraryPresence,
} from './collab'
import { useLibraryEditor } from './store'

const route = getRouteApi('/app/library/$slug')
const appRoute = getRouteApi('/app')

type Detail = RouterOutputs['libraryQueries']['get']

/** Problems at `path` (and below it), as Monaco squiggles. */
function problemsAt(diagnostics: LibraryDiagnostic[], path: (string | number)[]): FieldProblem[] {
  return diagnostics
    .filter((d) => path.every((p, i) => d.path[i] === p))
    .map((d) => ({ message: d.message, severity: d.severity, start: d.start, end: d.end }))
}

/**
 * A library query's editor: its resource and query, parameters with test values, Run, releases and access. A
 * protected one (M14) is edited in a draft on the Git branch in `?branch=`; its main draft is read-only.
 */
export function LibraryEditorPage() {
  const trpc = useTRPC()
  const { slug } = route.useParams()
  const search = route.useSearch()
  const navigate = useNavigate()
  const detail = useQuery({
    ...trpc.libraryQueries.get.queryOptions({ slug }),
    staleTime: Number.POSITIVE_INFINITY,
    // Opened again, it loads afresh: the slug may now be another library query's (one deleted, then created again).
    gcTime: 0,
  })
  const branch = detail.data?.gitProtected ? (search.branch ?? null) : null
  const opened = useQuery({
    queryKey: ['branchDraft', 'library_query', detail.data?.id, branch],
    queryFn: () =>
      trpcClient.branchDrafts.open.mutate({
        kind: 'library_query',
        id: detail.data!.id,
        branch: branch!,
        create: true,
      }),
    enabled: Boolean(detail.data && branch),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  })
  const [draftInfo, setDraftInfo] = useState<BranchDraft | null>(null)
  /** Raised when the branch draft is replaced (updated from the branch): the editor starts again from it. */
  const [epoch, setEpoch] = useState(0)
  const branchDraft = branch ? (draftInfo?.branch === branch ? draftInfo : opened.data) : null
  if (detail.isLoading || (branch && !branchDraft && !opened.error)) return <Spinner />
  if (!detail.data) return <ErrorNote error={detail.error} />
  if (opened.error) return <ErrorNote error={opened.error} />
  const git = detail.data.gitProtected
    ? {
        branch,
        onSwitch: (next: string | null) => {
          setDraftInfo(null)
          // Main may have moved while on a branch (a merge deployed it): load what's there now.
          if (next === null) void detail.refetch()
          void navigate({
            to: '.',
            search: (s: Record<string, unknown>) => ({ ...s, branch: next ?? undefined }),
          })
        },
        onReplaced: (draft: BranchDraft) => {
          setDraftInfo(draft)
          setEpoch((e) => e + 1)
        },
        onUpdated: setDraftInfo,
      }
    : null
  // Another draft (or the branch draft replaced) starts again from it; edits by others arrive through the document.
  return (
    <Editor
      key={`${detail.data.id}:${branchDraft?.id ?? 'main'}:${epoch}`}
      initial={detail.data}
      draft={branchDraft ?? null}
      git={git}
    />
  )
}

type BranchDraft = RouterOutputs['branchDrafts']['get']

/** A protected library query's Git bar: the branch edited, and what to do when it switches or is replaced. */
interface EditorGit {
  branch: string | null
  onSwitch(branch: string | null): void
  onReplaced(draft: BranchDraft): void
  onUpdated(draft: BranchDraft): void
}

function Editor({
  initial,
  draft,
  git,
}: {
  initial: Detail
  draft: BranchDraft | null
  git: EditorGit | null
}) {
  const { me } = appRoute.useRouteContext()
  // A protected library query's main draft is what main deployed: it changes on branches.
  const canEdit = (initial.level === 'edit' || initial.level === 'own') && !(initial.gitProtected && !draft)
  // The draft as loaded, until its shared document syncs (M21); then the document, edited together.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor remounts for another draft
  useEffect(() => {
    const start = draft
      ? {
          definition: draft.definition as LibraryQueryDefinition,
          diagnostics: draft.diagnostics as LibraryDiagnostic[],
          draftHash: draft.draftHash,
          revision: draft.revision,
        }
      : {
          definition: initial.draftDefinition,
          diagnostics: initial.diagnostics,
          draftHash: initial.draftHash,
          revision: initial.draftRevision,
        }
    useLibraryEditor
      .getState()
      .load(start.definition, start.revision, start.draftHash, start.diagnostics, !canEdit)
    openLibrarySession(initial.id, draft?.id ?? null)
    return () => closeLibrarySession()
  }, [])
  const definition = useLibraryEditor((s) => s.definition)
  const diagnostics = useLibraryEditor((s) => s.diagnostics)
  const draftHash = useLibraryEditor((s) => s.draftHash)
  const status = useLibraryEditor((s) => s.status)
  const readOnly = useLibraryEditor((s) => s.readOnly)
  const { canUndo, canRedo, update, undo, redo } = useLibraryEditor()
  const peers = useLibraryPresence((s) => s.peers)
  useEditorKeys({ editable: !readOnly, undo, redo })
  // Leaving with edits the server hasn't saved yet asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useLibraryEditor.getState()
      if (!s.readOnly && (s.status === 'saving' || s.status === 'offline' || s.status === 'error')) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const errors = diagnostics.filter((d) => d.severity === 'error').length

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={initial.name}
        description={
          <span className="font-mono text-xs">
            <Link to="/library" className="text-accent hover:underline">
              Library
            </Link>{' '}
            / {initial.slug}
          </span>
        }
        actions={
          <>
            <PresenceAvatars peers={peers} me={me.id} />
            {!readOnly && <UndoButtons canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />}
            <SaveStatus status={status} />
            <ReleaseControls
              detail={initial}
              draftHash={draftHash ?? ''}
              status={status}
              errors={errors}
              ensureSaved={ensureLibrarySaved}
            />
          </>
        }
      />
      {git && (
        <GitBar
          kind="library_query"
          object={initial}
          branch={git.branch}
          draft={draft}
          onSwitch={async (next) => {
            try {
              await ensureLibrarySaved()
            } catch (err) {
              if (!(await confirmDialog(`${errorMessage(err)} Switch anyway, losing the unsaved changes?`)))
                return
            }
            git.onSwitch(next)
          }}
          ensureSaved={async () => {
            await ensureLibrarySaved()
          }}
          revision={() => useLibraryEditor.getState().revision}
          onReplaced={git.onReplaced}
          onUpdated={git.onUpdated}
        />
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <QueryCard definition={definition} diagnostics={diagnostics} readOnly={readOnly} edit={update} />
          <RunCard detail={initial} branchDraftId={draft?.id ?? null} ensureSaved={ensureLibrarySaved} />
        </div>
        <div className="flex flex-col gap-4">
          <ParamsCard definition={definition} diagnostics={diagnostics} readOnly={readOnly} edit={update} />
          <UsedByCard id={initial.id} />
        </div>
      </div>
    </div>
  )
}

const SAVE_LABELS: Record<SaveStatusName, { text: string; className: string }> = {
  connecting: { text: 'Connecting…', className: 'text-muted' },
  saved: { text: 'Saved', className: 'text-muted' },
  saving: { text: 'Saving…', className: 'text-muted' },
  offline: { text: 'Offline: changes will sync', className: 'text-warning-strong' },
  error: { text: 'Not saved', className: 'text-danger' },
  closed: { text: 'Disconnected: reload', className: 'text-danger' },
}

function SaveStatus({ status }: { status: SaveStatusName }) {
  const saveError = useLibraryEditor((s) => s.saveError)
  const label = SAVE_LABELS[status]
  return (
    <span className={cn('text-xs', label.className)} data-testid="save-status" title={saveError ?? undefined}>
      {label.text}
    </span>
  )
}

function QueryCard({
  definition,
  diagnostics,
  readOnly,
  edit,
}: {
  definition: LibraryQueryDefinition
  diagnostics: LibraryDiagnostic[]
  readOnly: boolean
  edit: (next: (d: LibraryQueryDefinition) => LibraryQueryDefinition) => void
}) {
  const trpc = useTRPC()
  const resources = useQuery(trpc.resources.list.queryOptions())
  const resource = resources.data?.resources.find((r) => r.slug === definition.resource)
  const sql = resource ? isSqlType(resource.type) : 'sql' in definition.query
  const [json, setJson] = useState(() => JSON.stringify(definition.query, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  // The text follows the query when it changes some other way (the draft loading, someone else, undo); while it
  // still means the query (typing), it stays as typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `json` is read, not followed
  useEffect(() => {
    let same = false
    try {
      same = JSON.stringify(JSON.parse(json)) === JSON.stringify(definition.query)
    } catch {}
    if (!same) {
      setJson(JSON.stringify(definition.query, null, 2))
      setJsonError(null)
    }
  }, [definition.query])
  // The SQL's text in the shared document (M21): typing merges with others', with their cursors shown.
  const shared = useLibraryEditor((s) => s.shared)
  const hasSql = typeof definition.query.sql === 'string'
  const sqlBinding = useMemo((): TextBinding | null => {
    const text = shared && !readOnly && hasSql ? shared.textAt(['query', 'sql']) : null
    if (!text) return null
    return {
      text,
      write: (change) => useLibraryEditor.getState().editText(['query', 'sql'], change),
      undo: () => useLibraryEditor.getState().undo(),
      redo: () => useLibraryEditor.getState().redo(),
      awareness: libraryAwareness(),
    }
  }, [shared, readOnly, hasSql])
  const resourceProblems = diagnostics.filter((d) => d.path[0] === 'resource')
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Resource" className="w-64">
          <Select
            aria-label="Resource"
            value={definition.resource}
            disabled={readOnly}
            onChange={(e) => {
              const slug = e.target.value
              const next = resources.data?.resources.find((r) => r.slug === slug)
              // Same kind of resource: the query carries over; another kind starts that kind's query (a
              // service's first action, a broker's messages…), as the workflow and app editors do.
              const sameKind =
                next && resource ? next.type === resource.type : sql === isSqlType(next?.type ?? '')
              const query = sameKind
                ? definition.query
                : (defaultQuery(next?.type) as LibraryQueryDefinition['query'])
              setJson(JSON.stringify(query, null, 2))
              edit((d) => ({ ...d, resource: slug, query: sameKind ? d.query : query }))
            }}
          >
            {!resource && <option value={definition.resource}>{definition.resource}</option>}
            {resources.data?.resources.map((r) => (
              <option key={r.id} value={r.slug}>
                {r.name} ({r.slug})
              </option>
            ))}
          </Select>
        </Field>
        <p className="pb-2 text-xs text-muted">
          Its <code>{'{{ }}'}</code>s read the parameters by name, <code>current_user</code> and the stdlib.
        </p>
      </div>
      {resourceProblems.map((p) => (
        <p key={p.message} className="text-xs text-danger">
          {p.message}
        </p>
      ))}
      {sql ? (
        <CodeField
          path={`library:${definition.resource}:sql`}
          language="sql"
          height={220}
          readOnly={readOnly}
          value={String(definition.query.sql ?? '')}
          problems={problemsAt(diagnostics, ['query', 'sql'])}
          binding={sqlBinding}
          onChange={(text) => edit((d) => ({ ...d, query: { ...d.query, sql: text } }))}
        />
      ) : (
        <Field
          label="Request"
          hint="The resource’s query as JSON, as its Query tab shows it; it starts as that kind of resource’s empty query"
        >
          <CodeField
            path={`library:${definition.resource}:json`}
            language="json"
            height={220}
            readOnly={readOnly}
            value={json}
            problems={problemsAt(diagnostics, ['query'])}
            onChange={(text) => {
              setJson(text)
              try {
                const parsed = JSON.parse(text)
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  return setJsonError('Must be a JSON object')
                }
                setJsonError(null)
                edit((d) => ({ ...d, query: parsed }))
              } catch (err) {
                setJsonError((err as Error).message)
              }
            }}
          />
          {jsonError && <span className="text-xs text-danger">{jsonError}</span>}
        </Field>
      )}
    </Card>
  )
}

function ParamsCard({
  definition,
  diagnostics,
  readOnly,
  edit,
}: {
  definition: LibraryQueryDefinition
  diagnostics: LibraryDiagnostic[]
  readOnly: boolean
  edit: (next: (d: LibraryQueryDefinition) => LibraryQueryDefinition) => void
}) {
  const setParam = (i: number, patch: Partial<LibraryParam>) =>
    edit((d) => ({
      ...d,
      params: d.params.map((p, j) => {
        if (j !== i) return p
        const next = { ...p, ...patch }
        for (const key of ['description', 'testValue'] as const) if (next[key] === undefined) delete next[key]
        return next
      }),
    }))
  const nextName = () => {
    const names = new Set(definition.params.map((p) => p.name))
    let n = definition.params.length + 1
    while (names.has(`param${n}`)) n++
    return `param${n}`
  }
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="library-params">
      <div className="flex items-center gap-2">
        <SectionLabel className="flex-1">Parameters</SectionLabel>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => edit((d) => ({ ...d, params: [...d.params, { name: nextName() }] }))}
          >
            <Plus className="size-3.5" /> Add
          </Button>
        )}
      </div>
      {definition.params.length === 0 && (
        <p className="text-sm text-muted">
          None yet. Apps pass a value for each parameter; the query reads it as <code>{'{{ name }}'}</code>.
        </p>
      )}
      {definition.params.map((p, i) => {
        const problems = diagnostics.filter((d) => d.path[0] === 'params' && d.path[1] === i)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: parameters are edited in place, names change as people type
          <div key={i} className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Parameter ${i + 1} name`}
                className="font-mono"
                value={p.name}
                disabled={readOnly}
                onChange={(e) => setParam(i, { name: e.target.value })}
              />
              {!readOnly && (
                <Button
                  size="icon"
                  variant="ghost"
                  title={`Remove ${p.name}`}
                  onClick={() => edit((d) => ({ ...d, params: d.params.filter((_, j) => j !== i) }))}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
            <span className="text-xs text-muted">Description</span>
            <Input
              aria-label={`${p.name} description`}
              placeholder="Shown in apps"
              value={p.description ?? ''}
              disabled={readOnly}
              onChange={(e) => setParam(i, { description: e.target.value || undefined })}
            />
            <span className="text-xs text-muted">Test value (for Run)</span>
            <Input
              aria-label={`${p.name} test value`}
              placeholder="JSON, or plain text"
              className="font-mono"
              value={showTestValue(p.testValue)}
              disabled={readOnly}
              onChange={(e) => setParam(i, { testValue: parseTestValue(e.target.value) })}
            />
            {problems.map((d) => (
              <span
                key={d.message}
                className={cn('text-xs', d.severity === 'error' ? 'text-danger' : 'text-warning-strong')}
              >
                {d.message}
              </span>
            ))}
          </div>
        )
      })}
    </Card>
  )
}

/** Runs the saved draft with the parameters' test values, in an environment the person picks. */
function RunCard({
  detail,
  branchDraftId,
  ensureSaved,
}: {
  detail: Detail
  /** Runs this Git branch draft (M14) instead of the main draft. */
  branchDraftId: string | null
  ensureSaved: () => Promise<number>
}) {
  const trpc = useTRPC()
  const search = route.useSearch()
  const navigate = useNavigate()
  const environments = useQuery(trpc.environments.list.queryOptions())
  const environment =
    environments.data?.find((e) => e.slug === search.env) ??
    environments.data?.find((e) => e.isDefault) ??
    environments.data?.[0]
  const run = useMutation(trpc.libraryQueries.run.mutationOptions())
  const [saveError, setSaveError] = useState<string | null>(null)
  const canRun = detail.level === 'edit' || detail.level === 'own'
  const execute = async () => {
    if (!environment) return
    setSaveError(null)
    try {
      await ensureSaved()
    } catch (err) {
      return setSaveError(errorMessage(err))
    }
    run.mutate({
      libraryQueryId: detail.id,
      ...(branchDraftId && { branchDraftId }),
      environmentId: environment.id,
    })
  }
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="library-run">
      <div className="flex items-center gap-2">
        <SectionLabel className="flex-1">Result</SectionLabel>
        <Select
          aria-label="Environment"
          className="w-40"
          value={environment?.slug ?? ''}
          onChange={(e) =>
            navigate({ to: '.', search: (s: Record<string, unknown>) => ({ ...s, env: e.target.value }) })
          }
        >
          {environments.data?.map((e) => (
            <option key={e.id} value={e.slug}>
              {e.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="primary"
          disabled={!canRun || !environment}
          loading={run.isPending}
          onClick={execute}
          title="Run the draft with the parameters' test values"
        >
          <Play className="size-3.5" /> Run
        </Button>
      </div>
      <ErrorNote error={saveError ?? run.error} />
      {run.data?.ok === true && (
        <>
          <span className="text-xs text-muted">{run.data.durationMs} ms</span>
          <ResultView data={run.data.data} />
        </>
      )}
      {run.data?.ok === false && <ConnectorErrorNote error={run.data.error} onConnected={execute} />}
      {!run.data && !run.isPending && (
        <p className="text-sm text-muted">Run the draft to see what it returns with the test values.</p>
      )}
    </Card>
  )
}

/** The apps, modules and workflows (M21) using this library query (the ones the person can see). */
function UsedByCard({ id }: { id: string }) {
  const trpc = useTRPC()
  const usedBy = useQuery(trpc.libraryQueries.usedBy.queryOptions({ libraryQueryId: id }))
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="library-used-by">
      <SectionLabel>Used by</SectionLabel>
      <ErrorNote error={usedBy.error} />
      {usedBy.data &&
        usedBy.data.apps.length === 0 &&
        usedBy.data.modules.length === 0 &&
        usedBy.data.workflows.length === 0 &&
        usedBy.data.hidden === 0 && <p className="text-sm text-muted">Nothing uses it yet.</p>}
      <ul className="flex flex-col gap-1">
        {usedBy.data?.apps.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-sm">
            <Link
              to="/apps/$slug/edit"
              params={{ slug: a.slug }}
              className="flex-1 truncate text-accent hover:underline"
            >
              {a.name}
            </Link>
            <span className="text-xs text-muted">{a.where.join(', ')}</span>
          </li>
        ))}
        {usedBy.data?.modules.map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-sm">
            <Link
              to="/modules/$slug"
              params={{ slug: m.slug }}
              className="flex-1 truncate text-accent hover:underline"
            >
              {m.name}
            </Link>
            <span className="text-xs text-muted">module · {m.where.join(', ')}</span>
          </li>
        ))}
        {usedBy.data?.workflows.map((w) => (
          <li key={w.id} className="flex items-center gap-2 text-sm">
            <Link
              to="/workflows/$workflowId"
              params={{ workflowId: w.id }}
              className="flex-1 truncate text-accent hover:underline"
            >
              {w.name}
            </Link>
            <span className="text-xs text-muted">workflow · {w.where.join(', ')}</span>
          </li>
        ))}
      </ul>
      {!!usedBy.data?.hidden && (
        <p className="text-xs text-muted">and {usedBy.data.hidden} more you can't see</p>
      )}
    </Card>
  )
}

function useReleases(id: string) {
  const trpc = useTRPC()
  return useQuery(trpc.libraryQueries.releases.queryOptions({ libraryQueryId: id }))
}

function ReleaseControls({
  detail,
  draftHash,
  status,
  errors,
  ensureSaved,
}: {
  detail: Detail
  draftHash: string
  status: SaveStatusName
  errors: number
  ensureSaved: () => Promise<number>
}) {
  const releases = useReleases(detail.id)
  const live = releases.data?.find((r) => r.live) ?? null
  const unpublished = !live || status !== 'saved' || draftHash !== live.definitionHash
  const canEdit = detail.level === 'edit' || detail.level === 'own'
  const [open, setOpen] = useState<'publish' | 'releases' | 'access' | 'delete' | null>(null)
  const close = () => setOpen(null)
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        data-testid="release-status"
        title="Releases"
        onClick={() => setOpen('releases')}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-subtle"
      >
        {live ? <Badge tone="success">Live v{live.version}</Badge> : <Badge>Not published</Badge>}
        {live && unpublished && (
          <span className="text-xs whitespace-nowrap text-warning-strong">Unpublished changes</span>
        )}
      </button>
      {/* A protected library query is published by merging on Git. */}
      {canEdit && !detail.gitProtected && (
        <Button
          size="sm"
          variant="primary"
          disabled={errors > 0 || !unpublished || !releases.data}
          title={
            errors
              ? 'Fix the problems first'
              : unpublished
                ? 'Release this draft to the apps using it'
                : 'Nothing changed since the live release'
          }
          onClick={() => setOpen('publish')}
        >
          <Rocket className="size-3.5" /> Publish
        </Button>
      )}
      <Button size="icon" variant="ghost" title="Releases" onClick={() => setOpen('releases')}>
        <History className="size-4" />
      </Button>
      {detail.level === 'own' && (
        <>
          <GitProtectionButton detail={detail} />
          <Button size="icon" variant="ghost" title="Access" onClick={() => setOpen('access')}>
            <Users className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" title="Delete" onClick={() => setOpen('delete')}>
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
      {open === 'publish' && releases.data && (
        <PublishDialog detail={detail} releases={releases.data} ensureSaved={ensureSaved} onClose={close} />
      )}
      {open === 'releases' && <ReleasesDialog detail={detail} canEdit={canEdit} onClose={close} />}
      {open === 'access' && (
        <Dialog title={`Who can use ${detail.name}`} onClose={close} className="max-w-2xl">
          <AccessEditor
            target={{ objectType: 'library_query', objectId: detail.id }}
            help="Use puts it in apps (their publishers need it; viewers don't) · Edit also changes the draft, runs it and publishes · Own also deletes and manages access."
          />
        </Dialog>
      )}
      {open === 'delete' && <DeleteDialog detail={detail} onClose={close} />}
    </div>
  )
}

type Release = RouterOutputs['libraryQueries']['releases'][number]

/** Owners protect the library query in Git (M14), or unprotect it; nothing until Git sync is set up. */
function GitProtectionButton({ detail }: { detail: Detail }) {
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const unprotect = useUnprotect('library_query')
  if (!git?.configured && !detail.gitProtected) return null
  return (
    <>
      {detail.gitProtected ? (
        <Button
          size="sm"
          variant="ghost"
          loading={unprotect.isPending}
          title="Edit it here again; its files stay in the repo"
          onClick={async () =>
            (await confirmDialog(UNPROTECT_CONFIRM)) &&
            unprotect.mutate({ kind: 'library_query', id: detail.id })
          }
        >
          Unprotect
        </Button>
      ) : (
        <Button size="icon" variant="ghost" title="Protect in Git" onClick={() => setProtecting(true)}>
          <GitBranch className="size-4" />
        </Button>
      )}
      {/* Stays open once protected, to show the branch and pull request it made. */}
      {protecting && (
        <ProtectDialog kind="library_query" object={detail} onClose={() => setProtecting(false)} />
      )}
    </>
  )
}

const BUMPS: { bump: VersionBump; label: string }[] = [
  { bump: 'patch', label: 'Patch' },
  { bump: 'minor', label: 'Minor' },
  { bump: 'major', label: 'Major' },
]

function PublishDialog({
  detail,
  releases,
  ensureSaved,
  onClose,
}: {
  detail: Detail
  releases: Release[]
  ensureSaved: () => Promise<number>
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const highest =
    releases
      .map((r) => r.version)
      .sort(compareVersions)
      .at(-1) ?? null
  const [bump, setBump] = useState<VersionBump>('patch')
  const [notes, setNotes] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const usedBy = useQuery(trpc.libraryQueries.usedBy.queryOptions({ libraryQueryId: detail.id }))
  // Parameters this release drops that apps, modules or workflows on latest still pass (M21).
  const impact = useQuery(trpc.libraryQueries.publishImpact.queryOptions({ libraryQueryId: detail.id }))
  const publish = useMutation(trpc.libraryQueries.publish.mutationOptions())
  const version = bumpVersion(highest, bump)
  const users =
    (usedBy.data?.apps.length ?? 0) +
    (usedBy.data?.modules.length ?? 0) +
    (usedBy.data?.workflows.length ?? 0) +
    (usedBy.data?.hidden ?? 0)

  const submit = async () => {
    setSaveError(null)
    let draftRevision: number
    try {
      draftRevision = await ensureSaved()
    } catch (err) {
      return setSaveError(errorMessage(err))
    }
    publish.mutate(
      { libraryQueryId: detail.id, draftRevision, bump, notes: notes.trim() || null },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: trpc.libraryQueries.releases.queryKey({ libraryQueryId: detail.id }),
            }),
            queryClient.invalidateQueries({ queryKey: trpc.libraryQueries.list.queryKey() }),
          ])
          onClose()
        },
      },
    )
  }
  return (
    <Dialog
      title="Publish a release"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={publish.isPending}
            onClick={submit}
            data-testid="publish-confirm"
          >
            Publish v{version}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Apps and workflows following the latest release run this one from now on; those pinned to a version
          keep theirs. It runs with the access you have to its resource now, for everyone using them.
          {users > 0 &&
            ` ${users} ${users === 1 ? 'app, module or workflow uses' : 'apps, modules or workflows use'} this query.`}
        </p>
        <DroppedWarning impact={impact.data} what="parameter" />
        {highest ? (
          <Field label="Version">
            <Select
              aria-label="Version"
              value={bump}
              onChange={(e) => setBump(e.target.value as VersionBump)}
            >
              {BUMPS.map((b) => (
                <option key={b.bump} value={b.bump}>
                  {b.label} · v{bumpVersion(highest, b.bump)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-sm">First release: v1.0.0</p>
        )}
        <Field label="Release notes" hint="Optional: what changed, for the people whose apps use it.">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorNote error={saveError ?? publish.error} />
      </div>
    </Dialog>
  )
}

function ReleasesDialog({
  detail,
  canEdit,
  onClose,
}: {
  detail: Detail
  canEdit: boolean
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const releases = useReleases(detail.id)
  const live = releases.data?.find((r) => r.live)
  const setLive = useMutation(
    trpc.libraryQueries.setLive.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.libraryQueries.releases.queryKey({ libraryQueryId: detail.id }),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.libraryQueries.list.queryKey() }),
        ]),
    }),
  )
  const draft = useLibraryEditor((s) => s.definition)
  const [comparing, setComparing] = useState<string | null>(null)
  if (comparing && releases.data) {
    return (
      <CompareReleasesDialog
        kind="library"
        objectId={detail.id}
        releases={releases.data}
        releaseId={comparing}
        draft={draft}
        loadRelease={(id) => trpcClient.libraryQueries.release.query({ libraryQueryId: detail.id, id })}
        onClose={() => setComparing(null)}
      />
    )
  }
  return (
    <Dialog title="Releases" onClose={onClose}>
      <ErrorNote error={releases.error ?? setLive.error} />
      {releases.data?.length === 0 && <p className="text-sm text-muted">Nothing published yet.</p>}
      <ul className="space-y-2" data-testid="releases">
        {releases.data?.map((r) => (
          <li
            key={r.id}
            className={cn(
              'rounded-md border px-3 py-2',
              r.live ? 'border-success/40 bg-success/5' : 'border-border',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold">v{r.version}</span>
              {r.live && <Badge tone="success">Live</Badge>}
              <span className="flex-1 truncate font-mono text-xs text-muted">
                {r.params.map((p) => p.name).join(', ')}
              </span>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="What changed: against the release before it, another one or the draft"
                  onClick={() => setComparing(r.id)}
                >
                  <GitCompare className="size-3.5" /> Compare
                </Button>
              )}
              {canEdit && !r.live && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={setLive.isPending && setLive.variables?.releaseId === r.id}
                  onClick={async () => {
                    if (
                      await confirmDialog(
                        `Make v${r.version} live? Apps following the latest release run it${live ? ` instead of v${live.version}` : ''}.`,
                      )
                    ) {
                      setLive.mutate({ libraryQueryId: detail.id, releaseId: r.id })
                    }
                  }}
                >
                  <Undo2 className="size-3.5" /> Make live
                </Button>
              )}
            </div>
            {r.notes && <p className="mt-1 text-sm whitespace-pre-wrap">{r.notes}</p>}
            <p className="mt-1 text-xs text-muted">
              {r.createdBy?.name ?? 'Git sync'} · {new Date(r.createdAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

function DeleteDialog({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation(
    trpc.libraryQueries.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.libraryQueries.list.queryKey() })
        await navigate({ to: '/library' })
      },
    }),
  )
  return (
    <Dialog
      title={`Delete ${detail.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate({ id: detail.id })}
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        Its releases and access go with it. Apps still using it must stop first: deleting is refused until
        then.
      </p>
      <ErrorNote error={remove.error} />
    </Dialog>
  )
}
