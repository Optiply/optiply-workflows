import { bumpVersion, compareVersions, parseSemver, type VersionBump } from '@ow/definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { History, Rocket, Settings, Trash2, Undo2, Users } from 'lucide-react'
import { useState } from 'react'
import { ReleaseAuthor, useGitInfo } from '@/components/git'
import { Badge, Button, Dialog, ErrorNote, Field, Input, Textarea } from '@/components/ui'
import { errorMessage, type RouterOutputs, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { AccessEditor } from '../../resources/shared'
import { ensureSaved } from './save'
import { useAppEditor } from './store'

type Release = RouterOutputs['apps']['releases'][number]
export interface EditorApp {
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
function useReleases(appId: string) {
  const trpc = useTRPC()
  return useQuery(trpc.apps.releases.queryOptions({ appId }))
}

/**
 * The header's release status (live version, unpublished changes), Publish, and the Releases, Access and Settings
 * dialogs.
 */
export function ReleaseControls({ app }: { app: EditorApp }) {
  const releases = useReleases(app.id)
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
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-black/5"
      >
        {live ? <Badge tone="success">Live v{live.version}</Badge> : <Badge>Not published</Badge>}
        {live && unpublished && (
          <span className="text-xs whitespace-nowrap text-amber-700">Unpublished changes</span>
        )}
      </button>
      <Button
        size="sm"
        variant="primary"
        disabled={errors > 0 || !unpublished || !releases.data}
        title={
          errors
            ? 'Fix the problems first'
            : unpublished
              ? 'Release this draft to the people using the app'
              : 'Nothing changed since the live release'
        }
        onClick={() => setOpen('publish')}
      >
        <Rocket className="size-3.5" /> Publish
      </Button>
      <Button size="icon" variant="ghost" title="Releases" onClick={() => setOpen('releases')}>
        <History className="size-4" />
      </Button>
      {live && (
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
      <Button size="icon" variant="ghost" title="App settings" onClick={() => setOpen('settings')}>
        <Settings className="size-4" />
      </Button>
      {open === 'publish' && releases.data && (
        <PublishDialog app={app} releases={releases.data} live={live} onClose={close} />
      )}
      {open === 'releases' && <ReleasesDialog app={app} onClose={close} />}
      {open === 'access' && (
        <Dialog title={`Who can use ${app.name}`} onClose={close} className="max-w-2xl">
          <AccessEditor
            target={{ objectType: 'app', objectId: app.id }}
            help="Use opens the live release and runs its queries (no access to the resources needed) · Edit also changes the draft and publishes · Own also deletes and manages access."
          />
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
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const highest =
    releases
      .map((r) => r.version)
      .sort(compareVersions)
      .at(-1) ?? null
  const [bump, setBump] = useState<VersionBump | 'custom'>('patch')
  const [custom, setCustom] = useState('')
  const [notes, setNotes] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const publish = useMutation(trpc.apps.publish.mutationOptions())
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
        appId: app.id,
        draftRevision: useAppEditor.getState().revision,
        ...(bump === 'custom' ? { version } : { bump }),
        notes: notes.trim() || null,
      },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: trpc.apps.releases.queryKey({ appId: app.id }) }),
            queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() }),
            queryClient.invalidateQueries({ queryKey: trpc.apps.open.queryKey({ slug: app.slug }) }),
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
        <p className="text-sm text-muted">
          The draft becomes what people using the app see{live ? `, instead of v${live.version}` : ''}. Its
          queries run with the access you have to their resources now, for everyone who can use the app.
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
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { me } = appRoute.useRouteContext()
  const { data: git } = useGitInfo()
  const releases = useReleases(app.id)
  // A protected app's live release changes by merging; admins can still roll back in an emergency.
  const canSetLive = !app.gitProtected || me.isAdmin
  const live = releases.data?.find((r) => r.live)
  const setLive = useMutation(
    trpc.apps.setLive.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.apps.releases.queryKey({ appId: app.id }) }),
          queryClient.invalidateQueries({ queryKey: trpc.apps.open.queryKey({ slug: app.slug }) }),
        ]),
    }),
  )
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
              {canSetLive && !r.live && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={setLive.isPending && setLive.variables?.releaseId === r.id}
                  title={
                    app.gitProtected
                      ? 'Emergency rollback: the next deploy from Git replaces it'
                      : 'Make this release live again'
                  }
                  onClick={() => {
                    if (
                      confirm(
                        `Make v${r.version} live? People using the app will see it${live ? ` instead of v${live.version}` : ''}.${app.gitProtected ? ' This app is protected: the next deploy from Git replaces it.' : ''}`,
                      )
                    ) {
                      setLive.mutate({ appId: app.id, releaseId: r.id })
                    }
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
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(app.name)
  const [description, setDescription] = useState(app.description ?? '')
  const update = useMutation(
    trpc.apps.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() })
        await queryClient.invalidateQueries({ queryKey: trpc.apps.get.queryKey({ slug: app.slug }) })
        onClose()
      },
    }),
  )
  const remove = useMutation(
    trpc.apps.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() })
        await navigate({ to: '/apps' })
      },
    }),
  )
  return (
    <Dialog
      title="App settings"
      onClose={onClose}
      footer={
        <>
          {app.level === 'own' && (
            <Button
              variant="danger"
              className="mr-auto"
              loading={remove.isPending}
              onClick={() => {
                if (
                  confirm(`Delete ${app.name} with all its releases? People using it lose it straight away.`)
                ) {
                  remove.mutate({ id: app.id })
                }
              }}
            >
              <Trash2 className="size-3.5" /> Delete app
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!name.trim()}
            onClick={() => update.mutate({ id: app.id, name, description: description.trim() || null })}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="text-xs text-muted">
          Slug <span className="font-mono">{app.slug}</span> (the app's address) can't change.
        </p>
        <ErrorNote error={update.error ?? remove.error} />
      </div>
    </Dialog>
  )
}
