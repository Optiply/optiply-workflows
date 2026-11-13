import { type AppChangeSummary, describeChange } from '@ow/app-definition'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeftRight, CopyPlus, History as HistoryIcon, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { CompareReleasesDialog } from '@/components/compare-releases'
import { confirmDialog } from '@/components/confirm'
import { Button, Dialog, ErrorNote, Field, Input, Spinner } from '@/components/ui'
import { errorMessage, trpcClient, useTRPC } from '@/lib/trpc'
import { formatDateTime, timeAgo } from '@/lib/utils'
import { ensureSaved } from './collab'
import { useAppEditor } from './store'

/*
 * The History panel (session 41, after Retool's save log): the app's draft as it was, newest first, each entry
 * labelled by what changed. Compare one with the draft, restore it, or start a new app from it. The main draft of an
 * app only: a Git branch's draft has its commits.
 */

interface Version {
  id: string
  revision: number
  summary: AppChangeSummary
  restoredFrom: string | null
  updatedAt: string | Date
  author: { name: string | null; email: string } | null
}

export function HistoryPanel({ appId, slug }: { appId: string; slug: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const readOnly = useAppEditor((s) => s.readOnly)
  const branchDraftId = useAppEditor((s) => s.branchDraftId)
  const draft = useAppEditor((s) => s.definition)
  const revision = useAppEditor((s) => s.revision)
  const [older, setOlder] = useState<Version[]>([])
  const [more, setMore] = useState<boolean | null>(null)
  const [comparing, setComparing] = useState<string | null>(null)
  const [copying, setCopying] = useState<Version | null>(null)
  // The newest page follows the saves (the draft's revision changes with each).
  // The newest page refreshes while the panel is open (saves come every few seconds while editing), until older
  // pages are loaded: refreshing then would push entries into a gap between the pages (review).
  const first = useQuery({
    ...trpc.apps.history.queryOptions({ appId }),
    refetchInterval: older.length ? false : 15_000,
  })
  const versions: Version[] = [...((first.data?.versions as Version[] | undefined) ?? []), ...older]
  const hasMore = more ?? first.data?.more ?? false
  const loadMore = useMutation({
    mutationFn: async () => {
      const last = versions.at(-1)!
      return trpcClient.apps.history.query({
        appId,
        before: { updatedAt: new Date(last.updatedAt), id: last.id },
      })
    },
    onSuccess: (page) => {
      setOlder((o) => [...o, ...(page.versions as Version[])])
      setMore(page.more)
    },
  })
  const restore = useMutation({
    mutationFn: async (v: Version) => {
      await ensureSaved()
      return trpcClient.apps.restoreVersion.mutate({ appId, id: v.id })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: trpc.apps.history.queryKey({ appId }) })
      // The editor opens the restored draft (its document folds it in on loading).
      window.location.reload()
    },
  })

  if (branchDraftId)
    return (
      <p className="text-xs text-muted">
        On a Git branch, the history is the branch's commits (the Git bar).
      </p>
    )
  if (first.error) return <ErrorNote error={first.error} />
  if (!first.data) return <Spinner />
  if (!versions.length)
    return (
      <p className="text-xs text-muted">
        No saves yet. Each save of the draft shows here, by what it changed.
      </p>
    )

  const compared = comparing ? versions.find((v) => v.id === comparing) : null
  return (
    <div className="flex flex-col gap-1" data-testid="history-panel">
      {restore.error && <ErrorNote error={restore.error} />}
      <ol className="flex flex-col">
        {versions.map((v, i) => {
          const current = i === 0 && v.revision === revision
          return (
            <li
              key={v.id}
              className="group rounded-md px-2 py-1.5 hover:bg-canvas"
              data-testid={`version-${v.revision}`}
            >
              <div className="flex items-start gap-1.5">
                <HistoryIcon className="mt-0.5 size-3.5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs leading-4 break-words">
                    {v.restoredFrom ? 'Restored an earlier version' : describeChange(v.summary)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted" title={formatDateTime(v.updatedAt)}>
                    {timeAgo(v.updatedAt)} · {v.author?.name || v.author?.email || 'Someone'}
                    {current && <span className="ml-1 font-medium text-accent">· current</span>}
                  </p>
                </div>
              </div>
              {!current && (
                <div className="mt-1 ml-5 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setComparing(v.id)}>
                    <ArrowLeftRight className="size-3.5" /> Compare
                  </Button>
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={restore.isPending}
                      onClick={async () => {
                        if (
                          await confirmDialog(
                            'Restore this version? The draft becomes what it was then; the current draft stays in the history.',
                            { confirm: 'Restore' },
                          )
                        )
                          restore.mutate(v)
                      }}
                    >
                      <RotateCcw className="size-3.5" /> Restore
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setCopying(v)}>
                    <CopyPlus className="size-3.5" /> New app
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {hasMore && (
        <Button size="sm" variant="ghost" disabled={loadMore.isPending} onClick={() => loadMore.mutate()}>
          Older saves
        </Button>
      )}
      {compared && (
        <CompareReleasesDialog
          kind="app"
          objectId={appId}
          releases={versions.map((x) => ({
            id: x.id,
            version: `${timeAgo(x.updatedAt)} (r${x.revision})`,
            live: false,
          }))}
          releaseId={compared.id}
          draft={draft}
          withDraft
          loadRelease={(id) => trpcClient.apps.historyVersion.query({ appId, id })}
          onClose={() => setComparing(null)}
        />
      )}
      {copying && (
        <NewAppFromVersion appId={appId} slug={slug} version={copying} onClose={() => setCopying(null)} />
      )}
    </div>
  )
}

/** A new app from a version: its slug and name, in the app's folder. */
function NewAppFromVersion({
  appId,
  slug,
  version,
  onClose,
}: {
  appId: string
  slug: string
  version: Version
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [newSlug, setNewSlug] = useState(`${slug}-r${version.revision}`.slice(0, 63))
  const [name, setName] = useState(`${slug} (revision ${version.revision})`)
  const create = useMutation({
    mutationFn: () =>
      trpcClient.apps.duplicate.mutate({ id: appId, slug: newSlug, name, fromVersionId: version.id }),
    onSuccess: (app) => navigate({ to: '/apps/$slug/edit', params: { slug: app.slug } }),
  })
  return (
    <Dialog title="New app from this version" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <Field label="Name">
          <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Slug">
          <Input
            aria-label="Slug"
            className="font-mono"
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
          />
        </Field>
        {create.error && <p className="text-sm text-danger">{errorMessage(create.error)}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending || !name.trim() || !newSlug}>
            Create the app
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
