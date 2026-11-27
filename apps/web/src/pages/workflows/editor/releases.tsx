import { bumpVersion, compareVersions, parseSemver, type VersionBump } from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { ChevronDown, Clock, GitCompare, History, KeyRound, Rocket, Undo2, Webhook } from 'lucide-react'
import { useState } from 'react'
import { CompareReleasesDialog } from '@/components/compare-releases'
import { confirmDialog } from '@/components/confirm'
import { ReleaseAuthor, useGitInfo } from '@/components/git'
import { Badge, Button, Dialog, ErrorNote, Field, Input, Menu, MenuItem, Textarea } from '@/components/ui'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { ensureSaved } from './collab'
import { useEditor } from './store'

type Workflow = RouterOutputs['workflows']['get']
type Release = RouterOutputs['releases']['list'][number]

const appRoute = getRouteApi('/app')

/** For a rollback's confirmation: a release that runs as someone will run as whoever makes it live. */
const runsAsYou = (release: Release) =>
  release.runsAs
    ? ' Resources that sign in with each person’s own account will use yours in its live runs (connect them first).'
    : ''

/** Refetches what a new live release changes. */
function useRefreshReleases(workflowId: string) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.workflows.get.queryKey({ id: workflowId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.releases.list.queryKey({ workflowId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.workflows.triggers.queryKey({ id: workflowId }) }),
    ])
}

/** True when the draft differs from the live release (or nothing is live yet). */
export function useUnpublished(workflow: Workflow): boolean {
  const status = useEditor((s) => s.status)
  const draftHash = useEditor((s) => s.draftHash)
  return !workflow.liveRelease || status !== 'saved' || draftHash !== workflow.liveRelease.definitionHash
}

/** The header's live release badge and Publish button. */
export function ReleaseControls({ workflow, canEdit }: { workflow: Workflow; canEdit: boolean }) {
  const [publishing, setPublishing] = useState(false)
  const unpublished = useUnpublished(workflow)
  const errors = useEditor((s) => s.diagnostics.filter((d) => d.severity === 'error').length)
  const live = workflow.liveRelease

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="release-status"
        title="Releases"
        onClick={() => useEditor.getState().showTab('releases')}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-subtle"
      >
        {live ? <Badge tone="success">Live v{live.version}</Badge> : <Badge>Not published</Badge>}
        {live && unpublished && (
          <span className="text-xs whitespace-nowrap text-warning-strong">Unpublished changes</span>
        )}
      </button>
      {canEdit && (
        <div className="flex items-center">
          <Button
            size="sm"
            className="rounded-r-none"
            disabled={errors > 0 || !unpublished}
            title={
              errors
                ? 'Fix the problems first'
                : unpublished
                  ? 'Release this draft and make it live'
                  : 'Nothing changed since the live release'
            }
            onClick={() => setPublishing(true)}
          >
            <Rocket className="size-3.5" /> Publish
          </Button>
          <ReleaseMenu workflow={workflow} />
        </div>
      )}
      {publishing && <PublishDialog workflow={workflow} onClose={() => setPublishing(false)} />}
    </div>
  )
}

/** Publish's ▾: compare the draft with the live release, the release history, a rollback to the release before. */
function ReleaseMenu({ workflow }: { workflow: Workflow }) {
  const trpc = useTRPC()
  const refresh = useRefreshReleases(workflow.id)
  const { me } = appRoute.useRouteContext()
  const { data: releases } = useQuery(trpc.releases.list.queryOptions({ workflowId: workflow.id }))
  const setLive = useMutation(
    trpc.releases.setLive.mutationOptions({
      onSuccess: () => refresh(),
      // The menu has closed: the editor's notice says why the rollback didn't happen.
      onError: (e) => useEditor.getState().notify(`The rollback failed: ${errorMessage(e)}`),
    }),
  )
  const draft = useEditor((s) => s.definition)
  const [comparing, setComparing] = useState(false)
  const live = releases?.find((r) => r.live)
  // Newest first: the release before the live one.
  const previous = live && releases?.[releases.indexOf(live) + 1]
  const canSetLive = !workflow.gitProtected || me.isAdmin
  return (
    <>
      <Menu
        label="Release actions"
        trigger={(props) => (
          <Button
            size="sm"
            className="rounded-l-none border-l border-l-white/25 px-1.5"
            title="Release actions"
            aria-label="Release actions"
            {...props}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        )}
      >
        {live && (
          <MenuItem icon={<GitCompare />} onClick={() => setComparing(true)}>
            Compare draft with live (v{live.version})
          </MenuItem>
        )}
        <MenuItem icon={<History />} onClick={() => useEditor.getState().showTab('releases')}>
          Release history
        </MenuItem>
        {canSetLive && live && (
          <MenuItem
            icon={<KeyRound />}
            onClick={async () => {
              if (
                await confirmDialog(
                  `Make v${live.version} live again, as you? Its checks run again, and resources that sign in with each person’s own account use yours in its live runs (connect them first).`,
                )
              ) {
                setLive.mutate({ workflowId: workflow.id, releaseId: live.id })
              }
            }}
          >
            Make v{live.version} live again
          </MenuItem>
        )}
        {canSetLive && previous && (
          <MenuItem
            icon={<Undo2 />}
            onClick={async () => {
              const emergency = workflow.gitProtected
                ? ' This workflow is protected: this stays until its next change in Git (or Deploy now).'
                : ''
              if (
                await confirmDialog(
                  `Roll back to v${previous.version}? Its webhook and schedules will run instead of v${live.version}.${runsAsYou(previous)}${emergency}`,
                )
              ) {
                setLive.mutate({ workflowId: workflow.id, releaseId: previous.id })
              }
            }}
          >
            Roll back to v{previous.version}
          </MenuItem>
        )}
      </Menu>
      {comparing && releases && live && (
        <CompareReleasesDialog
          kind="workflow"
          objectId={workflow.id}
          releases={releases}
          releaseId={live.id}
          draft={draft}
          withDraft
          loadRelease={(id) => trpcClient.releases.get.query({ workflowId: workflow.id, id })}
          onClose={() => setComparing(false)}
        />
      )}
    </>
  )
}

const BUMPS: { bump: VersionBump; label: string; hint: string }[] = [
  { bump: 'patch', label: 'Patch', hint: 'Fixes' },
  { bump: 'minor', label: 'Minor', hint: 'New behaviour that stays compatible' },
  { bump: 'major', label: 'Major', hint: 'Changes callers must adapt to' },
]

function PublishDialog({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefreshReleases(workflow.id)
  const { data: releases } = useQuery(trpc.releases.list.queryOptions({ workflowId: workflow.id }))
  const triggers = useEditor((s) => s.definition.triggers)
  const highest =
    releases
      ?.map((r) => r.version)
      .sort(compareVersions)
      .at(-1) ?? null
  const [bump, setBump] = useState<VersionBump | 'custom'>('patch')
  const [custom, setCustom] = useState('')
  const [notes, setNotes] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const publish = useMutation(trpc.releases.publish.mutationOptions())

  const version = bump === 'custom' ? custom.trim() : bumpVersion(highest, bump)
  const customProblem =
    bump !== 'custom'
      ? null
      : !parseSemver(version)
        ? 'Use a version like 1.2.3'
        : highest && compareVersions(version, highest) <= 0
          ? `Must be higher than v${highest}`
          : null
  const schedules = triggers?.schedules?.filter((s) => s.enabled) ?? []

  const submit = async () => {
    setSaveError(null)
    try {
      await ensureSaved()
    } catch (err) {
      return setSaveError(errorMessage(err))
    }
    publish.mutate(
      {
        workflowId: workflow.id,
        draftRevision: useEditor.getState().revision,
        ...(bump === 'custom' ? { version } : { bump }),
        notes: notes.trim() || null,
      },
      {
        onSuccess: async () => {
          await refresh()
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
            disabled={!!customProblem || !releases}
            onClick={submit}
            data-testid="publish-confirm"
          >
            Publish v{version || '…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          The draft becomes the live release: from now on its webhook and schedules run it
          {workflow.liveRelease ? ` instead of v${workflow.liveRelease.version}` : ''}. Editor runs keep using
          the draft.
        </p>
        <p className="flex gap-2 text-sm text-muted" data-testid="publish-runs-as">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span>
            Resources that sign in with each person’s own account (such as the Optiply SDK) use <b>yours</b>{' '}
            in its live runs, whoever or whatever starts them. Connect your account to them first.
          </span>
        </p>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Version</span>
          <div className="grid grid-cols-2 gap-2">
            {highest ? (
              BUMPS.map((b) => (
                <VersionChoice
                  key={b.bump}
                  checked={bump === b.bump}
                  onChange={() => setBump(b.bump)}
                  title={`${b.label} · v${bumpVersion(highest, b.bump)}`}
                  hint={b.hint}
                />
              ))
            ) : (
              <VersionChoice
                checked={bump !== 'custom'}
                onChange={() => setBump('patch')}
                title="First release · v1.0.0"
                hint="Releases are numbered major.minor.patch"
              />
            )}
            <VersionChoice
              checked={bump === 'custom'}
              onChange={() => setBump('custom')}
              title="Custom"
              hint={
                <Input
                  aria-label="Custom version"
                  className="mt-1 h-7"
                  placeholder={bumpVersion(highest, 'minor')}
                  value={custom}
                  onFocus={() => setBump('custom')}
                  onChange={(e) => setCustom(e.target.value)}
                />
              }
            />
          </div>
          {customProblem && <span className="text-xs text-danger">{customProblem}</span>}
        </div>
        <Field label="Release notes" hint="Optional: what changed, for whoever rolls back later.">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="rounded-md bg-canvas px-3 py-2 text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <Webhook className="size-3.5" />
            Webhook {triggers?.webhook?.enabled ? 'on' : 'off'}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <Clock className="size-3.5" />
            {schedules.length
              ? `${schedules.length} schedule${schedules.length === 1 ? '' : 's'}: ${schedules.map((s) => s.name).join(', ')}`
              : 'No schedules'}
          </div>
        </div>
        <ErrorNote error={saveError ?? publish.error} />
      </div>
    </Dialog>
  )
}

function VersionChoice({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean
  onChange: () => void
  title: string
  hint: React.ReactNode
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-2 rounded-md border px-3 py-2 text-sm',
        checked ? 'border-accent bg-accent-soft/40' : 'border-border',
      )}
    >
      <input
        type="radio"
        name="version"
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-accent"
      />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{title}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  )
}

/** The side panel's Releases tab: the live triggers, then every release, newest first, with rollback. */
export function ReleasesTab({ workflow, canEdit }: { workflow: Workflow; canEdit: boolean }) {
  const trpc = useTRPC()
  const { data: releases, error } = useQuery(trpc.releases.list.queryOptions({ workflowId: workflow.id }))
  const draft = useEditor((s) => s.definition)
  const [comparing, setComparing] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-5">
      <LiveTriggers workflowId={workflow.id} slug={workflow.slug} />
      <section>
        <h3 className="mb-2 text-sm font-semibold">Releases</h3>
        <ErrorNote error={error} />
        {releases?.length === 0 && (
          <p className="text-sm text-muted">
            Nothing published yet. Publish to turn on this workflow's webhook and schedules.
          </p>
        )}
        <ul className="space-y-2" data-testid="releases">
          {releases?.map((r) => (
            <ReleaseRow
              key={r.id}
              release={r}
              workflow={workflow}
              canEdit={canEdit}
              onCompare={() => setComparing(r.id)}
            />
          ))}
        </ul>
      </section>
      {comparing && releases && (
        <CompareReleasesDialog
          kind="workflow"
          objectId={workflow.id}
          releases={releases}
          releaseId={comparing}
          draft={draft}
          loadRelease={(id) => trpcClient.releases.get.query({ workflowId: workflow.id, id })}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  )
}

function ReleaseRow({
  release,
  workflow,
  canEdit,
  onCompare,
}: {
  release: Release
  workflow: Workflow
  canEdit: boolean
  onCompare: () => void
}) {
  const trpc = useTRPC()
  const refresh = useRefreshReleases(workflow.id)
  const { me } = appRoute.useRouteContext()
  const { data: git } = useGitInfo()
  const setLive = useMutation(trpc.releases.setLive.mutationOptions({ onSuccess: () => refresh() }))
  // A protected workflow's live release changes by merging; admins can still roll back in an emergency.
  const canSetLive = canEdit && (!workflow.gitProtected || me.isAdmin)
  return (
    <li
      className={cn(
        'rounded-md border px-3 py-2',
        release.live ? 'border-success/40 bg-success/5' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold">v{release.version}</span>
        {release.live && <Badge tone="success">Live</Badge>}
        <span className="flex-1" />
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            title="What changed: against the release before it, another one or the draft"
            onClick={onCompare}
          >
            <GitCompare className="size-3.5" /> Compare
          </Button>
        )}
        {canSetLive && release.live && release.runsAs && release.runsAs.id !== me.id && (
          <Button
            size="sm"
            variant="ghost"
            loading={setLive.isPending}
            title="Make this release live again as you: its live runs then use your own accounts"
            onClick={async () => {
              if (
                await confirmDialog(
                  `Run v${release.version} as you instead of ${release.runsAs!.name}? Resources that sign in with each person’s own account will use yours in its live runs (connect them first).`,
                )
              ) {
                setLive.mutate({ workflowId: workflow.id, releaseId: release.id })
              }
            }}
          >
            <KeyRound className="size-3.5" /> Run as me
          </Button>
        )}
        {canSetLive && !release.live && (
          <Button
            size="sm"
            variant="ghost"
            loading={setLive.isPending}
            title={
              workflow.gitProtected
                ? 'Emergency rollback: it stays until the workflow’s next change in Git (or Deploy now)'
                : 'Make this release live again'
            }
            onClick={async () => {
              const current = workflow.liveRelease ? ` instead of v${workflow.liveRelease.version}` : ''
              const emergency = workflow.gitProtected
                ? ' This workflow is protected: this stays until its next change in Git (or Deploy now).'
                : ''
              if (
                await confirmDialog(
                  `Make v${release.version} live? Its webhook and schedules will run${current}.${runsAsYou(release)}${emergency}`,
                )
              ) {
                setLive.mutate({ workflowId: workflow.id, releaseId: release.id })
              }
            }}
          >
            <Undo2 className="size-3.5" /> Make live
          </Button>
        )}
      </div>
      {release.notes && <p className="mt-1 text-sm whitespace-pre-wrap">{release.notes}</p>}
      {release.runsAs && (
        <p
          className="mt-1 flex items-center gap-1.5 text-xs"
          data-testid="release-runs-as"
          title="Resources that sign in with each person’s own account use this person’s in its live runs: whoever makes a release live"
        >
          <KeyRound className="size-3.5 text-muted" /> Runs as {release.runsAs.name}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        <ReleaseAuthor release={release} webUrl={git?.webUrl} /> ·{' '}
        {new Date(release.createdAt).toLocaleString()} ·{' '}
        <span className="font-mono" title={release.definitionHash}>
          {release.definitionHash.slice(0, 8)}
        </span>
      </p>
      <ErrorNote error={setLive.error} />
    </li>
  )
}

/** What the live release answers to right now, with the schedules' next and last fire times. */
function LiveTriggers({ workflowId, slug }: { workflowId: string; slug: string }) {
  const trpc = useTRPC()
  const { data: triggers } = useQuery(trpc.workflows.triggers.queryOptions({ id: workflowId }))
  if (!triggers?.length) return null
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Live triggers</h3>
      <ul className="space-y-1.5 text-sm" data-testid="live-triggers">
        {triggers.map((t) => (
          <li key={t.id} className="flex items-start gap-2">
            {t.kind === 'webhook' ? (
              <Webhook className="mt-0.5 size-4 text-muted" />
            ) : (
              <Clock className="mt-0.5 size-4 text-muted" />
            )}
            <div className="min-w-0">
              <div>
                {t.kind === 'webhook' ? 'Webhook' : t.name} {!t.enabled && <Badge>off</Badge>}
                {t.kind === 'schedule' && t.environment && (
                  <span className="text-xs text-muted"> · {t.environment}</span>
                )}
              </div>
              <div className="text-xs text-muted">
                {t.kind === 'webhook'
                  ? `/api/v1/workflows/${slug}/webhook${t.config.alias ? ` · /api/v1/hooks/${t.config.alias}` : ''}`
                  : [
                      t.nextFireAt && `next ${new Date(t.nextFireAt).toLocaleString()}`,
                      t.lastFiredAt && `last ${new Date(t.lastFiredAt).toLocaleString()}`,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'not scheduled'}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
