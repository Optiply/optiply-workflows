import { bumpVersion, compareVersions, parseSemver, type VersionBump } from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { GitBranch, GitCompare, History, Rocket, Settings, Trash2, Undo2, Users } from 'lucide-react'
import { useState } from 'react'
import { CompareReleasesDialog } from '@/components/compare-releases'
import { confirmDialog } from '@/components/confirm'
import { DroppedWarning } from '@/components/dropped-warning'
import { ProtectDialog, ReleaseAuthor, UNPROTECT_CONFIRM, useGitInfo, useUnprotect } from '@/components/git'
import { Badge, Button, Dialog, ErrorNote, Field, Input, Textarea } from '@/components/ui'
import { errorMessage, type RouterOutputs, trpcClient, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AccessEditor } from '../../resources/shared'
import { ensureSaved } from './collab'
import { useAppEditor } from './store'

type Release = RouterOutputs['apps']['releases'][number]
export interface EditorApp {
  /** An app, or a module (M14): the same editor, its releases and settings through `modules.*`. */
  kind: 'app' | 'module'
  id: string
  slug: string
  name: string
  description: string | null
  level: 'use' | 'edit' | 'own'
  /** Edited on Git branches (M11): main is read-only, rollback is for admins. */
  gitProtected: boolean
}

const appRoute = getRouteApi('/app')

const BUMPS: { bump: VersionBump; label: string; hint: string }[] = [
  { bump: 'patch', label: 'Patch', hint: 'Fixes' },
  { bump: 'minor', label: 'Minor', hint: 'New things people can use' },
  { bump: 'major', label: 'Major', hint: 'Changes people will notice' },
]

/** The app's releases, newest first; the live one is what people using the app see. */
function useReleases(app: EditorApp) {
  const trpc = useTRPC()
  return useQuery<Release[]>(
    app.kind === 'module'
      ? {
          queryKey: trpc.modules.releases.queryKey({ moduleId: app.id }),
          queryFn: () => trpcClient.modules.releases.query({ moduleId: app.id }),
        }
      : {
          queryKey: trpc.apps.releases.queryKey({ appId: app.id }),
          queryFn: () => trpcClient.apps.releases.query({ appId: app.id }),
        },
  )
}

/** What differs between an app's releases and a module's: the API, and what a release means to people. */
function useReleaseApi(app: EditorApp) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const id = app.id
  const invalidate = (...keys: readonly unknown[][]) =>
    Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
  if (app.kind === 'module') {
    return {
      noun: 'module',
      publish: (input: PublishInput) => trpcClient.modules.publish.mutate({ moduleId: id, ...input }),
      setLive: (releaseId: string) => trpcClient.modules.setLive.mutate({ moduleId: id, releaseId }),
      update: (input: { name: string; description: string | null }) =>
        trpcClient.modules.update.mutate({ id, ...input }),
      remove: () => trpcClient.modules.delete.mutate({ id }),
      // Apps' editors resolve modules by slug: what they show follows the release.
      released: () =>
        invalidate(
          trpc.modules.releases.queryKey({ moduleId: id }),
          trpc.modules.list.queryKey(),
          trpc.modules.resolve.pathKey(),
          trpc.modules.instanceReleases.pathKey(),
        ),
      changed: () => invalidate(trpc.modules.list.queryKey(), trpc.modules.get.queryKey({ slug: app.slug })),
      list: '/modules' as const,
      publishHelp: (live: string | null) =>
        `The draft becomes the module apps get when they follow its latest version${live ? `, instead of v${live}` : ''}. Its queries run with the access you have to their resources now, in every app placing it.`,
      liveHelp: (version: string, live: string | null) =>
        `Make v${version} live? Apps following the module's latest version get it${live ? ` instead of v${live}` : ''}.${app.gitProtected ? ' This module is protected: this stays until its next change in Git (or Deploy now).' : ''}`,
      deleteHelp: `Delete ${app.name} with all its releases? It can't be deleted while apps use it.`,
      accessHelp:
        'Use places the module in apps and runs it in their drafts · Edit also changes its draft and publishes · Own also deletes and manages access.',
    }
  }
  return {
    noun: 'app',
    publish: (input: PublishInput) => trpcClient.apps.publish.mutate({ appId: id, ...input }),
    setLive: (releaseId: string) => trpcClient.apps.setLive.mutate({ appId: id, releaseId }),
    update: (input: { name: string; description: string | null }) =>
      trpcClient.apps.update.mutate({ id, ...input }),
    remove: () => trpcClient.apps.delete.mutate({ id }),
    released: () =>
      invalidate(
        trpc.apps.releases.queryKey({ appId: id }),
        trpc.apps.list.queryKey(),
        trpc.apps.open.queryKey({ slug: app.slug }),
      ),
    changed: () => invalidate(trpc.apps.list.queryKey(), trpc.apps.get.queryKey({ slug: app.slug })),
    list: '/apps' as const,
    publishHelp: (live: string | null) =>
      `The draft becomes what people using the app see${live ? `, instead of v${live}` : ''}. Its queries run with the access you have to their resources now, for everyone who can use the app.`,
    liveHelp: (version: string, live: string | null) =>
      `Make v${version} live? People using the app will see it${live ? ` instead of v${live}` : ''}.${app.gitProtected ? ' This app is protected: this stays until its next change in Git (or Deploy now).' : ''}`,
    deleteHelp: `Delete ${app.name} with all its releases? People using it lose it straight away.`,
    accessHelp:
      'Use opens the live release and runs its queries (no access to the resources needed) · Edit also changes the draft and publishes · Own also deletes and manages access.',
  }
}

/** Inputs this module release drops that apps or modules placing it on latest still pass (M21). */
function ModuleDropped({ moduleId }: { moduleId: string }) {
  const trpc = useTRPC()
  const impact = useQuery(trpc.modules.publishImpact.queryOptions({ moduleId }))
  return <DroppedWarning impact={impact.data} what="input" />
}

interface PublishInput {
  draftRevision: number
  version?: string
  bump?: VersionBump
  notes: string | null
}

/**
 * The header's release status (live version, unpublished changes), Publish, and the Releases, Access and Settings
 * dialogs.
 */
export function ReleaseControls({ app }: { app: EditorApp }) {
  const releases = useReleases(app)
  const api = useReleaseApi(app)
  const live = releases.data?.find((r) => r.live) ?? null
  const status = useAppEditor((s) => s.status)
  const draftHash = useAppEditor((s) => s.draftHash)
  const errors = useAppEditor((s) => s.diagnostics.filter((d) => d.severity === 'error').length)
  const unpublished = !live || status !== 'saved' || draftHash !== live.definitionHash
  const [open, setOpen] = useState<'publish' | 'releases' | 'access' | 'settings' | null>(null)
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
      {/* A protected app or module is published by merging on Git. */}
      {!app.gitProtected && (
        <Button
          size="sm"
          variant="primary"
          disabled={errors > 0 || !unpublished || !releases.data}
          title={
            errors
              ? 'Fix the problems first'
              : unpublished
                ? app.kind === 'module'
                  ? 'Release this draft to the apps placing the module'
                  : 'Release this draft to the people using the app'
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
      {live && app.kind === 'app' && (
        <Link
          to="/apps/$slug/{-$page}"
          params={{ slug: app.slug }}
          className="px-1.5 text-xs whitespace-nowrap text-accent hover:underline"
          title="Open the live release, as people using the app see it"
        >
          Open app
        </Link>
      )}
      {app.level === 'own' && (
        <Button size="icon" variant="ghost" title="Access" onClick={() => setOpen('access')}>
          <Users className="size-4" />
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        title={app.kind === 'module' ? 'Module settings' : 'App settings'}
        onClick={() => setOpen('settings')}
      >
        <Settings className="size-4" />
      </Button>
      {open === 'publish' && releases.data && (
        <PublishDialog app={app} releases={releases.data} live={live} onClose={close} />
      )}
      {open === 'releases' && <ReleasesDialog app={app} onClose={close} />}
      {open === 'access' && (
        <Dialog title={`Who can use ${app.name}`} onClose={close} className="max-w-2xl">
          <AccessEditor target={{ objectType: app.kind, objectId: app.id }} help={api.accessHelp} />
        </Dialog>
      )}
      {open === 'settings' && <SettingsDialog app={app} onClose={close} />}
    </div>
  )
}

function PublishDialog({
  app,
  releases,
  live,
  onClose,
}: {
  app: EditorApp
  releases: Release[]
  live: Release | null
  onClose: () => void
}) {
  const api = useReleaseApi(app)
  const highest =
    releases
      .map((r) => r.version)
      .sort(compareVersions)
      .at(-1) ?? null
  const [bump, setBump] = useState<VersionBump | 'custom'>('patch')
  const [custom, setCustom] = useState('')
  const [notes, setNotes] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const publish = useMutation({ mutationFn: api.publish })
  const version = bump === 'custom' ? custom.trim() : bumpVersion(highest, bump)
  const customProblem =
    bump !== 'custom'
      ? null
      : !parseSemver(version)
        ? 'Use a version like 1.2.3'
        : highest && compareVersions(version, highest) <= 0
          ? `Must be higher than v${highest}`
          : null

  const submit = async () => {
    setSaveError(null)
    try {
      await ensureSaved()
    } catch (err) {
      return setSaveError(errorMessage(err))
    }
    publish.mutate(
      {
        draftRevision: useAppEditor.getState().revision,
        ...(bump === 'custom' ? { version } : { bump }),
        notes: notes.trim() || null,
      },
      {
        onSuccess: async () => {
          await api.released()
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
            disabled={!!customProblem}
            onClick={submit}
            data-testid="publish-confirm"
          >
            Publish v{version || '…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{api.publishHelp(live?.version ?? null)}</p>
        {app.kind === 'module' && <ModuleDropped moduleId={app.id} />}
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

/** Every release, newest first, with rollback. */
function ReleasesDialog({ app, onClose }: { app: EditorApp; onClose: () => void }) {
  const api = useReleaseApi(app)
  const { me } = appRoute.useRouteContext()
  const { data: git } = useGitInfo()
  const releases = useReleases(app)
  // A protected app's live release changes by merging; admins can still roll back in an emergency.
  const canSetLive = !app.gitProtected || me.isAdmin
  const live = releases.data?.find((r) => r.live)
  const setLive = useMutation({ mutationFn: api.setLive, onSuccess: () => api.released() })
  const draft = useAppEditor((s) => s.definition)
  const [comparing, setComparing] = useState<string | null>(null)
  if (comparing && releases.data) {
    return (
      <CompareReleasesDialog
        kind={app.kind}
        objectId={app.id}
        releases={releases.data}
        releaseId={comparing}
        draft={draft}
        loadRelease={(id) =>
          app.kind === 'module'
            ? trpcClient.modules.release.query({ moduleId: app.id, id })
            : trpcClient.apps.release.query({ appId: app.id, id })
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
              <span className="flex-1" />
              {app.level !== 'use' && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="What changed: against the release before it, another one or the draft"
                  onClick={() => setComparing(r.id)}
                >
                  <GitCompare className="size-3.5" /> Compare
                </Button>
              )}
              {canSetLive && !r.live && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={setLive.isPending && setLive.variables === r.id}
                  title={
                    app.gitProtected
                      ? `Emergency rollback: it stays until the ${app.kind}’s next change in Git (or Deploy now)`
                      : 'Make this release live again'
                  }
                  onClick={async () => {
                    if (await confirmDialog(api.liveHelp(r.version, live?.version ?? null)))
                      setLive.mutate(r.id)
                  }}
                >
                  <Undo2 className="size-3.5" /> Make live
                </Button>
              )}
            </div>
            {r.notes && <p className="mt-1 text-sm whitespace-pre-wrap">{r.notes}</p>}
            <p className="mt-1 text-xs text-muted">
              <ReleaseAuthor release={r} webUrl={git?.webUrl} /> · {new Date(r.createdAt).toLocaleString()} ·{' '}
              <span className="font-mono" title={r.definitionHash}>
                {r.definitionHash.slice(0, 8)}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

/** Name and description; owners can delete the app. */
function SettingsDialog({ app, onClose }: { app: EditorApp; onClose: () => void }) {
  const api = useReleaseApi(app)
  const navigate = useNavigate()
  const [name, setName] = useState(app.name)
  const [description, setDescription] = useState(app.description ?? '')
  const update = useMutation({
    mutationFn: api.update,
    onSuccess: async () => {
      await api.changed()
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: api.remove,
    onSuccess: async () => {
      await api.changed()
      await navigate({ to: api.list })
    },
  })
  return (
    <Dialog
      title={app.kind === 'module' ? 'Module settings' : 'App settings'}
      onClose={onClose}
      footer={
        <>
          {app.level === 'own' && (
            <Button
              variant="danger"
              className="mr-auto"
              loading={remove.isPending}
              onClick={async () => {
                if (await confirmDialog(api.deleteHelp)) remove.mutate()
              }}
            >
              <Trash2 className="size-3.5" /> Delete {api.noun}
            </Button>
          )}
          <Button onClick={onClose}>{app.gitProtected ? 'Close' : 'Cancel'}</Button>
          {!app.gitProtected && (
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!name.trim()}
              onClick={() => update.mutate({ name, description: description.trim() || null })}
            >
              Save
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          hint={app.gitProtected ? `A protected ${app.kind}’s name comes from the repo.` : undefined}
        >
          <Input value={name} disabled={app.gitProtected} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea
            rows={3}
            value={description}
            disabled={app.gitProtected}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {app.level === 'own' && <GitProtection app={app} />}
        <p className="text-xs text-muted">
          Slug <span className="font-mono">{app.slug}</span>{' '}
          {app.kind === 'module' ? '(how apps refer to it)' : "(the app's address)"} can't change.
        </p>
        <ErrorNote error={update.error ?? remove.error} />
      </div>
    </Dialog>
  )
}

/** Owners protect the app or module in Git (M11, M14), or unprotect it. */
function GitProtection({ app }: { app: EditorApp }) {
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const unprotect = useUnprotect(app.kind)
  if (!git?.configured && !app.gitProtected) return null
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-sm font-medium text-ink">Git</h4>
      <div>
        {app.gitProtected ? (
          <Button
            size="sm"
            variant="danger"
            loading={unprotect.isPending}
            onClick={async () =>
              (await confirmDialog(UNPROTECT_CONFIRM)) && unprotect.mutate({ kind: app.kind, id: app.id })
            }
          >
            Unprotect
          </Button>
        ) : (
          <Button size="sm" onClick={() => setProtecting(true)}>
            <GitBranch className="size-3.5" /> Protect in Git
          </Button>
        )}
      </div>
      <span className="text-xs text-muted">
        {app.gitProtected
          ? `Protected: edited on branches, deployed by merging into ${git?.branch ?? 'the deploy branch'}.`
          : 'Protect it to have changes reviewed in pull requests before they go live.'}
      </span>
      <ErrorNote error={unprotect.error} />
      {protecting && <ProtectDialog kind={app.kind} object={app} onClose={() => setProtecting(false)} />}
    </section>
  )
}
