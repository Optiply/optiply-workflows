import type { ComponentLibraryDefinition, ComponentLibraryDiagnostic } from '@ow/app-definition'
import { bumpVersion, compareVersions, type VersionBump } from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { GitBranch, GitCompare, History, Rocket, Trash2, Undo2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
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
  PageHeader,
  SectionLabel,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui'
import { UndoButtons } from '@/components/undo-buttons'
import type { SaveStatus as SaveStatusName } from '@/lib/collab-session'
import { useEditorKeys } from '@/lib/editor-keys'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AccessEditor } from '../resources/shared'
import { BuildCard } from './build'
import {
  closeComponentLibrarySession,
  ensureComponentLibrarySaved,
  openComponentLibrarySession,
  useComponentLibraryPresence,
} from './collab'
import { ComponentsCard } from './components-panel'
import { FilesCard } from './files'
import { DependenciesCard, OriginsCard } from './settings'
import { useComponentLibraryEditor } from './store'

const route = getRouteApi('/app/component-libraries/$slug')
const appRoute = getRouteApi('/app')

type Detail = RouterOutputs['componentLibraries']['get']

/**
 * A component library's editor (M25): its files, components, dependencies and allowed origins, Build and Preview,
 * releases and access. A protected one is edited in a draft on the Git branch in `?branch=`; its main draft is
 * read-only.
 */
export function ComponentLibraryEditorPage() {
  const trpc = useTRPC()
  const { slug } = route.useParams()
  const search = route.useSearch()
  const navigate = useNavigate()
  const detail = useQuery({
    ...trpc.componentLibraries.get.queryOptions({ slug }),
    staleTime: Number.POSITIVE_INFINITY,
    // Opened again, it loads afresh: the slug may now be another library's (one deleted, then created again).
    gcTime: 0,
  })
  const branch = detail.data?.gitProtected ? (search.branch ?? null) : null
  const opened = useQuery({
    queryKey: ['branchDraft', 'component_library', detail.data?.id, branch],
    queryFn: () =>
      trpcClient.branchDrafts.open.mutate({
        kind: 'component_library',
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

/** A protected library's Git bar: the branch edited, and what to do when it switches or is replaced. */
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
  // A protected library's main draft is what main deployed: it changes on branches.
  const canEdit = (initial.level === 'edit' || initial.level === 'own') && !(initial.gitProtected && !draft)
  // The draft as loaded, until its shared document syncs; then the document, edited together.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor remounts for another draft
  useEffect(() => {
    const start = draft
      ? {
          definition: draft.definition as ComponentLibraryDefinition,
          diagnostics: draft.diagnostics as ComponentLibraryDiagnostic[],
          draftHash: draft.draftHash,
          revision: draft.revision,
        }
      : {
          definition: initial.draftDefinition,
          diagnostics: initial.diagnostics,
          draftHash: initial.draftHash,
          revision: initial.draftRevision,
        }
    useComponentLibraryEditor
      .getState()
      .load(start.definition, start.revision, start.draftHash, start.diagnostics, !canEdit)
    useComponentLibraryEditor.getState().setLock(draft ? null : initial.draftLock)
    openComponentLibrarySession(initial.id, draft?.id ?? null)
    return () => closeComponentLibrarySession()
  }, [])
  const definition = useComponentLibraryEditor((s) => s.definition)
  const diagnostics = useComponentLibraryEditor((s) => s.diagnostics)
  const draftHash = useComponentLibraryEditor((s) => s.draftHash)
  const status = useComponentLibraryEditor((s) => s.status)
  const readOnly = useComponentLibraryEditor((s) => s.readOnly)
  const { canUndo, canRedo, update, undo, redo } = useComponentLibraryEditor()
  const peers = useComponentLibraryPresence((s) => s.peers)
  useEditorKeys({ editable: !readOnly, undo, redo })
  // Leaving with edits the server hasn't saved yet asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useComponentLibraryEditor.getState()
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
            <Link to="/component-libraries" className="text-accent hover:underline">
              Components
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
              ensureSaved={ensureComponentLibrarySaved}
            />
          </>
        }
      />
      {git && (
        <GitBar
          kind="component_library"
          object={initial}
          branch={git.branch}
          draft={draft}
          onSwitch={async (next) => {
            try {
              await ensureComponentLibrarySaved()
            } catch (err) {
              if (!(await confirmDialog(`${errorMessage(err)} Switch anyway, losing the unsaved changes?`)))
                return
            }
            git.onSwitch(next)
          }}
          ensureSaved={async () => {
            await ensureComponentLibrarySaved()
          }}
          revision={() => useComponentLibraryEditor.getState().revision}
          onReplaced={git.onReplaced}
          onUpdated={git.onUpdated}
        />
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <FilesCard
            library={initial.slug}
            definition={definition}
            diagnostics={diagnostics}
            readOnly={readOnly}
            edit={update}
          />
          <BuildCard
            detail={initial}
            branchDraftId={draft?.id ?? null}
            definition={definition}
            ensureSaved={ensureComponentLibrarySaved}
          />
        </div>
        <div className="flex flex-col gap-4">
          <ComponentsCard
            definition={definition}
            diagnostics={diagnostics}
            readOnly={readOnly}
            edit={update}
          />
          <DependenciesCard
            definition={definition}
            diagnostics={diagnostics}
            readOnly={readOnly}
            edit={update}
          />
          <OriginsCard
            definition={definition}
            diagnostics={diagnostics}
            readOnly={readOnly}
            edit={update}
            liveOrigins={initial.liveRelease?.allowedOrigins ?? []}
          />
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
  const saveError = useComponentLibraryEditor((s) => s.saveError)
  const label = SAVE_LABELS[status]
  return (
    <span className={cn('text-xs', label.className)} data-testid="save-status" title={saveError ?? undefined}>
      {label.text}
    </span>
  )
}

function UsedByCard({ id }: { id: string }) {
  const trpc = useTRPC()
  const usedBy = useQuery(trpc.componentLibraries.usedBy.queryOptions({ componentLibraryId: id }))
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="component-library-used-by">
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
  return useQuery(trpc.componentLibraries.releases.queryOptions({ componentLibraryId: id }))
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
      {/* A protected library is published by merging on Git. */}
      {canEdit && !detail.gitProtected && (
        <Button
          size="sm"
          variant="primary"
          disabled={errors > 0 || !unpublished || !releases.data}
          title={
            errors
              ? 'Fix the problems first'
              : unpublished
                ? 'Build this draft and release it to the apps using it'
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
            target={{ objectType: 'component_library', objectId: detail.id }}
            help="Use places its components in apps and modules (their publishers need it; viewers don't) · Edit also changes the draft, builds it and publishes · Own also deletes and manages access."
          />
        </Dialog>
      )}
      {open === 'delete' && <DeleteDialog detail={detail} onClose={close} />}
    </div>
  )
}

type Release = RouterOutputs['componentLibraries']['releases'][number]

/**
 * What another release going live changes besides the list: this library's live release (its origins, which the
 * Allowed origins card compares with), and what app and module editors resolved of it.
 */
const releasedKeys = (trpc: ReturnType<typeof useTRPC>) => [
  trpc.componentLibraries.get.queryKey(),
  trpc.componentLibraries.resolve.pathKey(),
  trpc.componentLibraries.instanceReleases.pathKey(),
]

/** Owners protect the library in Git, or unprotect it; nothing until Git sync is set up. */
function GitProtectionButton({ detail }: { detail: Detail }) {
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const unprotect = useUnprotect('component_library')
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
            unprotect.mutate({ kind: 'component_library', id: detail.id })
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
        <ProtectDialog kind="component_library" object={detail} onClose={() => setProtecting(false)} />
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
  const { me } = appRoute.useRouteContext()
  const highest =
    releases
      .map((r) => r.version)
      .sort(compareVersions)
      .at(-1) ?? null
  const [bump, setBump] = useState<VersionBump>('patch')
  const [notes, setNotes] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const usedBy = useQuery(trpc.componentLibraries.usedBy.queryOptions({ componentLibraryId: detail.id }))
  // Components and props this release drops that apps and modules on latest still use.
  const impact = useQuery(
    trpc.componentLibraries.publishImpact.queryOptions({ componentLibraryId: detail.id }),
  )
  const publish = useMutation(trpc.componentLibraries.publish.mutationOptions())
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
      { componentLibraryId: detail.id, draftRevision, bump, notes: notes.trim() || null },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: trpc.componentLibraries.releases.queryKey({ componentLibraryId: detail.id }),
            }),
            queryClient.invalidateQueries({ queryKey: trpc.componentLibraries.list.queryKey() }),
            ...releasedKeys(trpc).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
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
          The draft is built first. Apps and modules following the latest release get this one when they next
          open; those pinned to a version keep theirs.
          {users > 0 &&
            ` ${users} ${users === 1 ? 'app or module uses' : 'apps or modules use'} this library.`}
        </p>
        {impact.data?.originsChanged && (
          <p className="rounded-md border border-warning-strong/40 p-3 text-sm" data-testid="publish-origins">
            The allowed origins changed: where its components may send data.{' '}
            {me.isAdmin ? 'As an admin, you approve them by publishing.' : 'Only an admin can publish this.'}
          </p>
        )}
        <DroppedWarning impact={impact.data} what="component or prop" />
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
    trpc.componentLibraries.setLive.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.componentLibraries.releases.queryKey({ componentLibraryId: detail.id }),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.componentLibraries.list.queryKey() }),
          ...releasedKeys(trpc).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        ]),
    }),
  )
  const draft = useComponentLibraryEditor((s) => s.definition)
  const [comparing, setComparing] = useState<string | null>(null)
  if (comparing && releases.data) {
    return (
      <CompareReleasesDialog
        kind="components"
        objectId={detail.id}
        releases={releases.data}
        releaseId={comparing}
        draft={draft}
        loadRelease={(id) =>
          trpcClient.componentLibraries.release.query({ componentLibraryId: detail.id, id })
        }
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
                {Object.keys(r.components).join(', ')}
                {r.uploaded && ' · uploaded'}
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
                      setLive.mutate({ componentLibraryId: detail.id, releaseId: r.id })
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
    trpc.componentLibraries.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.componentLibraries.list.queryKey() })
        await navigate({ to: '/component-libraries' })
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
        Its releases and access go with it. Apps and modules still placing its components must stop first:
        deleting is refused until then.
      </p>
      <ErrorNote error={remove.error} />
    </Dialog>
  )
}
