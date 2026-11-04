import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Lock,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { folderPath, useFolders } from '@/components/folders'
import {
  CommitLink,
  GIT_KIND_LABELS,
  type GitKind,
  PullRequestLink,
  useChangeRequest,
  useGitInfo,
} from '@/components/git'
import { type ConflictGroup, MergeDialog } from '@/components/merge-dialog'
import { Badge, Button, Dialog, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui'
import { lineDiff, withContext } from '@/lib/diff'
import { errorMessage, type RouterOutputs, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

type Draft = RouterOutputs['branchDrafts']['get']
type Changes = RouterOutputs['branchDrafts']['changes']

/** What the bar needs from the editor it sits in. */
export interface GitBarProps {
  kind: GitKind
  object: { id: string; slug: string; name: string }
  /** The branch being edited, or null for main (read-only). */
  branch: string | null
  /** The open branch draft, once loaded. */
  draft: Draft | null
  /** Moves the editor to a branch (or main), e.g. by changing the URL. */
  onSwitch(branch: string | null): void
  /** Waits for the editor's draft to be saved; commits take what's saved. */
  ensureSaved(): Promise<void>
  /** The revision the editor has saved (what a commit includes). */
  revision(): number
  /** The draft was replaced (updated from the branch): load it into the editor again. */
  onReplaced(draft: Draft): void
  /** The draft's Git details changed (a commit moved its base); its definition didn't. */
  onUpdated(draft: Draft): void
}

const NEW_BRANCH = '\u0000new'

/**
 * A protected object's Git bar: which branch is being edited (main is read-only), and on a branch its state
 * against the repo: Commit, Update from branch, the pull request.
 */
export function GitBar(props: GitBarProps) {
  const { kind, object, branch, draft } = props
  const trpc = useTRPC()
  const { data: git } = useGitInfo()
  // This object's branches (M22): the ones changing it, or holding its draft, come first.
  const branches = useQuery({ ...trpc.git.branches.queryOptions({ kind, id: object.id }), staleTime: 30_000 })
  const drafts = useQuery(trpc.branchDrafts.list.queryOptions({ kind, id: object.id }))
  const [naming, setNaming] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [committing, setCommitting] = useState(false)
  const deploy = git?.branch ?? 'main'

  const others = (branches.data ?? []).filter((b) => !b.deploy)
  const mine = [
    ...new Set([
      ...(drafts.data ?? []).map((d) => d.branch),
      ...others.filter((b) => b.changes || b.draft).map((b) => b.name),
      ...(branch ? [branch] : []),
    ]),
  ].sort()
  const rest = others.map((b) => b.name).filter((name) => !mine.includes(name))

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg bg-accent-soft px-4 py-2 text-sm"
      data-testid="git-bar"
    >
      <GitBranch className="size-4 text-accent" />
      {naming ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newBranch.trim()) return
            setNaming(false)
            props.onSwitch(newBranch.trim())
          }}
        >
          <Input
            autoFocus
            aria-label="New branch name"
            className="h-8 w-64 font-mono"
            placeholder={`${kind}/${object.slug}-change`}
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
          <Button size="sm" type="submit" variant="primary" disabled={!newBranch.trim()}>
            Start branch
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Select
          aria-label="Branch"
          className="h-8 w-72 font-mono"
          value={branch ?? ''}
          onChange={(e) => {
            if (e.target.value === NEW_BRANCH) return setNaming(true)
            props.onSwitch(e.target.value || null)
          }}
        >
          <option value="">{deploy} (deployed, read-only)</option>
          {mine.length > 0 && (
            <optgroup label={`Changing this ${GIT_KIND_LABELS[kind]}`}>
              {mine.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          )}
          {rest.length > 0 && (
            <optgroup label="Other branches">
              {rest.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          )}
          <option value={NEW_BRANCH}>New branch…</option>
        </Select>
      )}
      {branch === null ? (
        <span className="flex items-center gap-1.5 text-muted" data-testid="read-only-banner">
          <Lock className="size-3.5" /> This {kind} is protected: what’s here is what {deploy} deployed. Pick
          a branch (or start one) to change it.
        </span>
      ) : draft ? (
        <BranchStatus {...props} draft={draft} onCommit={() => setCommitting(true)} />
      ) : (
        <span className="text-muted">Opening the draft on {branch}…</span>
      )}
      {committing && draft && (
        <CommitDialog {...props} draft={draft} webUrl={git?.webUrl} onClose={() => setCommitting(false)} />
      )}
    </div>
  )
}

/** On a branch: whether the branch exists yet, moved meanwhile, or conflicts; Commit; the pull request. */
function BranchStatus(props: GitBarProps & { draft: Draft; onCommit(): void }) {
  const { draft, branch } = props
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: git } = useGitInfo()
  const changes = useQuery({
    ...trpc.branchDrafts.changes.queryOptions({ id: draft.id }),
    refetchInterval: 30_000,
  })
  const pr = useQuery({
    ...trpc.git.pullRequest.queryOptions({ branch: branch! }),
    enabled: draft.branchExists,
    refetchInterval: 60_000,
  })
  const deploy = git?.branch ?? 'main'
  /** Open while a merge has conflicts: from the branch (the draft's own) or from main (by object). */
  const [merging, setMerging] = useState<{ from: 'branch' | 'main'; groups: ConflictGroup[] } | null>(null)
  const [detailing, setDetailing] = useState(false)
  /** Commit was clicked while the branch had moved: commit once the update is in. */
  const [commitAfter, setCommitAfter] = useState(false)
  /** What went wrong outside the mutations: saving before a merge, or the draft's update after main's merge. */
  const [note, setNote] = useState<string | null>(null)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.branchDrafts.changes.queryKey({ id: draft.id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.git.pullRequest.queryKey() }),
    ])
  /** The draft's own update came back: replaced, or its conflicts to resolve. */
  const updated = (result: RouterOutputs['branchDrafts']['updateFromBranch']) => {
    if (result.status === 'conflicts') {
      setMerging({
        from: 'branch',
        groups: [{ key: '', label: props.object.name, conflicts: result.conflicts }],
      })
      return
    }
    setMerging(null)
    props.onReplaced(result.draft)
    if (commitAfter) {
      setCommitAfter(false)
      props.onCommit()
    }
  }
  const update = useMutation(
    trpc.branchDrafts.updateFromBranch.mutationOptions({
      onSuccess: async (result) => {
        updated(result)
        await refresh()
      },
      onError: () => setCommitAfter(false),
    }),
  )
  const fromMain = useMutation(
    trpc.branchDrafts.updateFromMain.mutationOptions({
      onError: () => setCommitAfter(false),
      onSuccess: async (result) => {
        if (result.status === 'conflicts') {
          setMerging({
            from: 'main',
            groups: result.objects.map((o) => ({ key: o.dir, label: o.name, conflicts: o.conflicts })),
          })
        } else if (result.status === 'merged') {
          // Main is in; the draft's own changes may still conflict with what came in.
          if (result.draft) updated(result.draft)
          else {
            setMerging(null)
            setCommitAfter(false)
            setNote(
              `${deploy} is merged into ${branch}, but updating this draft failed (${result.draftError}): use Update from branch`,
            )
          }
        } else {
          setMerging(null)
        }
        await refresh()
      },
    }),
  )
  /** Saves what's typed, then updates (the merge starts from the saved draft). */
  const startUpdate = async (from: 'branch' | 'main', thenCommit = false) => {
    setNote(null)
    // A fresh start: no error left over from the other update in the dialog.
    update.reset()
    fromMain.reset()
    setCommitAfter(thenCommit)
    try {
      await props.ensureSaved()
    } catch (err) {
      setCommitAfter(false)
      setNote(`Your changes couldn't be saved, so nothing was merged: ${errorMessage(err)}`)
      return
    }
    if (from === 'branch') update.mutate({ id: draft.id })
    else fromMain.mutate({ id: draft.id })
  }
  const discard = useMutation(
    trpc.branchDrafts.discard.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.branchDrafts.list.queryKey() })
        props.onSwitch(null)
      },
    }),
  )
  const c = changes.data
  return (
    <>
      {!draft.branchExists && <Badge>New: the first commit makes it</Badge>}
      {draft.committedCommit && (
        <span className="text-xs text-muted">
          Last commit <CommitLink sha={draft.committedCommit} webUrl={git?.webUrl} />
        </span>
      )}
      {c?.conflict ? (
        <span className="flex items-center gap-1.5 text-danger" data-testid="branch-conflict">
          <AlertTriangle className="size-3.5" /> Someone changed this {props.kind} on {branch}:{' '}
          {mergeOutlook(c.merge)}
        </span>
      ) : (
        c?.behind && <span className="text-warning-strong">{branch} has new commits</span>
      )}
      {c?.mainAhead && (
        <span className="text-warning-strong" data-testid="main-ahead">
          {deploy} changed this {props.kind}
        </span>
      )}
      <span className="flex-1" />
      {c?.mainAhead && (
        <Button
          size="sm"
          loading={fromMain.isPending}
          title={`Merge ${deploy} into ${branch}, keeping your changes`}
          onClick={() => startUpdate('main')}
          data-testid="update-from-main"
        >
          <GitMerge className="size-3.5" /> Update from {deploy}
        </Button>
      )}
      {c?.behind && (
        <Button
          size="sm"
          loading={update.isPending && !commitAfter}
          title="Merge the branch's new commits into this draft, keeping your changes"
          onClick={() => startUpdate('branch')}
          data-testid="update-from-branch"
        >
          <RefreshCw className="size-3.5" /> Update from branch
        </Button>
      )}
      {pr.data?.pullRequest && <PullRequestLink pullRequest={pr.data.pullRequest} />}
      {c?.conflict ? (
        <Button
          size="sm"
          variant="primary"
          loading={update.isPending && commitAfter}
          title="The branch changed this too: update from it first, then commit"
          onClick={() => startUpdate('branch', true)}
          data-testid="commit-open"
        >
          <GitCommitHorizontal className="size-3.5" />
          Update, then commit
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={props.onCommit} data-testid="commit-open">
          <GitCommitHorizontal className="size-3.5" />
          Commit{c && c.files.length > 0 ? ` (${c.files.length})` : ''}
        </Button>
      )}
      <Button size="sm" onClick={() => setDetailing(true)} data-testid="branch-details-open">
        <Pencil className="size-3.5" /> Details
      </Button>
      {detailing && (
        <DetailsDialog
          kind={props.kind}
          draft={draft}
          onClose={() => setDetailing(false)}
          onSaved={async (next) => {
            props.onUpdated(next)
            await refresh()
          }}
        />
      )}
      <Button
        size="icon"
        variant="ghost"
        title="Close this draft (what's committed stays on the branch)"
        loading={discard.isPending}
        onClick={async () => {
          if (
            await confirmDialog(`Close the draft on ${branch}? Changes that aren't committed are lost.`, {
              danger: true,
              confirm: 'Close',
            })
          ) {
            discard.mutate({ id: draft.id })
          }
        }}
      >
        <Trash2 className="size-4" />
      </Button>
      <ErrorNote
        error={
          // The updates' errors show in the dialog while it's open; the rest always here.
          (merging ? null : (update.error ?? fromMain.error)) ??
          discard.error ??
          changes.error ??
          (note ? new Error(note) : null)
        }
      />
      {merging && (
        <MergeDialog
          title={merging.from === 'main' ? `Update from ${deploy}` : 'Update from branch'}
          intro={
            merging.from === 'main'
              ? `${deploy} and ${branch} both changed these. Mine is ${branch}, theirs is ${deploy}. Nothing is committed until you apply.`
              : `Your changes that aren't committed and the new commits on ${branch} both changed these. Mine is your draft, theirs is the branch. Nothing is saved until you apply.`
          }
          groups={merging.groups}
          applying={update.isPending || fromMain.isPending}
          error={merging.from === 'branch' ? update.error : fromMain.error}
          secondary={
            merging.from === 'branch'
              ? {
                  label: 'Discard mine, take the branch’s',
                  onClick: async () => {
                    if (
                      await confirmDialog("Replace your changes that aren't committed with the branch's?", {
                        danger: true,
                        confirm: 'Replace',
                      })
                    ) {
                      update.mutate({ id: draft.id, discardChanges: true })
                    }
                  },
                }
              : undefined
          }
          onApply={(resolutions) => {
            if (merging.from === 'branch') update.mutate({ id: draft.id, resolutions: resolutions[''] ?? {} })
            else fromMain.mutate({ id: draft.id, resolutions })
          }}
          onClose={() => {
            setMerging(null)
            setCommitAfter(false)
          }}
        />
      )}
    </>
  )
}

/** The files a commit changes (with their diffs), a message, Commit, and then the pull request. */
function CommitDialog(
  props: GitBarProps & { draft: Draft; webUrl: string | null | undefined; onClose(): void },
) {
  const { draft, branch, object, kind } = props
  const trpc = useTRPC()
  const cr = useChangeRequest()
  const queryClient = useQueryClient()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [message, setMessage] = useState(`Update ${kind} ${object.slug}`)
  const [open, setOpen] = useState<string | null>(null)
  const [committed, setCommitted] = useState<string | null>(null)
  const changes = useQuery({
    ...trpc.branchDrafts.changes.queryOptions({ id: draft.id }),
    enabled: saved,
    staleTime: 0,
  })
  // Commits take what's saved: save first, then list the changes.
  const { ensureSaved } = props
  useEffect(() => {
    ensureSaved()
      .then(() => setSaved(true))
      .catch((err) => setSaveError(errorMessage(err)))
  }, [ensureSaved])
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.branchDrafts.changes.queryKey({ id: draft.id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.branchDrafts.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.git.branches.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.git.pullRequest.queryKey({ branch: branch! }) }),
    ])
  const commit = useMutation(
    trpc.branchDrafts.commit.mutationOptions({
      onSuccess: async (result) => {
        setCommitted(result.commit)
        props.onUpdated(result.draft)
        await refresh()
      },
    }),
  )
  const pr = useQuery({
    ...trpc.git.pullRequest.queryOptions({ branch: branch! }),
    enabled: committed !== null,
  })
  const openPr = useMutation(
    trpc.git.openPullRequest.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.git.pullRequest.queryKey({ branch: branch! }) }),
    }),
  )
  const c: Changes | undefined = changes.data

  if (committed) {
    const pullRequest = openPr.data?.pullRequest ?? pr.data?.pullRequest
    return (
      <Dialog
        title="Committed"
        onClose={props.onClose}
        footer={
          <Button variant="primary" onClick={props.onClose}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm" data-testid="commit-result">
          <p>
            <CommitLink sha={committed} webUrl={props.webUrl} /> is on{' '}
            <span className="font-mono">{branch}</span>.
          </p>
          {pullRequest?.state === 'open' ? (
            <div>
              It’s in the {cr.noun}: <PullRequestLink pullRequest={pullRequest} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-muted">Open a {cr.noun} to have it reviewed; merging it deploys it.</p>
              <Button
                className="self-start"
                variant="primary"
                loading={openPr.isPending}
                onClick={() =>
                  openPr.mutate({ branch: branch!, title: message.split('\n')[0]!, body: message })
                }
                data-testid="open-pull-request"
              >
                <GitPullRequest className="size-4" /> Open {cr.noun}
              </Button>
              {openPr.data?.pullRequestError && (
                <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-strong">
                  {openPr.data.pullRequestError}
                </p>
              )}
            </div>
          )}
          <ErrorNote error={openPr.error} />
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={`Commit to ${branch}`}
      onClose={props.onClose}
      className="max-w-4xl"
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={commit.isPending}
            disabled={!c || c.files.length === 0 || c.conflict || !message.trim()}
            onClick={() =>
              commit.mutate({ id: draft.id, revision: props.revision(), message: message.trim() })
            }
            data-testid="commit-confirm"
          >
            Commit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        {saveError && <ErrorNote error={new Error(saveError)} />}
        {!c ? (
          <p className="text-muted">{saved ? 'Comparing with the branch…' : 'Saving the draft…'}</p>
        ) : c.files.length === 0 ? (
          <p className="text-muted" data-testid="no-changes">
            Nothing to commit: {branch} already has this.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="commit-files">
            {c.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-canvas"
                  onClick={() => setOpen(open === f.path ? null : f.path)}
                >
                  <Badge
                    tone={f.status === 'added' ? 'success' : f.status === 'deleted' ? 'danger' : 'neutral'}
                  >
                    {f.status}
                  </Badge>
                  <span className="font-mono text-xs">{f.path}</span>
                </button>
                {open === f.path && <FileDiff before={f.before} after={f.after} />}
              </li>
            ))}
          </ul>
        )}
        {c?.conflict && (
          <p className="rounded-md bg-danger/5 px-3 py-2 text-danger">
            Someone changed this {kind} on {branch} since you started: close this, update from the branch (
            {mergeOutlook(c.merge)}), then commit.
          </p>
        )}
        <Field label="Message">
          <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <ErrorNote error={commit.error ?? changes.error} />
      </div>
    </Dialog>
  )
}

/**
 * The name, description and folder Git keeps for the object, on this branch (M22): saved on the draft without a new
 * revision, committed with the next commit.
 */
function DetailsDialog({
  kind,
  draft,
  onClose,
  onSaved,
}: {
  kind: GitKind
  draft: Draft
  onClose(): void
  onSaved(draft: Draft): Promise<unknown>
}) {
  const trpc = useTRPC()
  const { data: folders } = useFolders(kind)
  const [form, setForm] = useState({
    name: draft.name,
    description: draft.description ?? '',
    folder: draft.folder ?? '',
  })
  const paths = [
    ...new Set([
      ...(folders?.folders ?? []).map((f) => folderPath(folders!.folders, f.id)!),
      ...(draft.folder ? [draft.folder] : []),
    ]),
  ].sort()
  const save = useMutation(
    trpc.branchDrafts.setDetails.mutationOptions({
      onSuccess: async (next) => {
        await onSaved(next)
        onClose()
      },
    }),
  )
  return (
    <Dialog
      title={`Details on ${draft.branch}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!form.name.trim()}
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                id: draft.id,
                name: form.name.trim(),
                description: form.description.trim() || null,
                folder: form.folder || null,
              })
            }
            data-testid="branch-details-save"
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted">
          Git keeps these with the {GIT_KIND_LABELS[kind]}: they change here when the branch merges and
          deploys.
        </p>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <Field label="Folder" hint="The deploy makes a folder this instance doesn't have yet.">
          <Select value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })}>
            <option value="">Not in a folder</option>
            {paths.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  )
}

/** A file's changes, line by line (unchanged stretches folded). */
export function FileDiff({ before, after }: { before: string | null; after: string | null }) {
  const diff = lineDiff(before ?? '', after ?? '')
  if (!diff) return <p className="px-3 pb-3 text-xs text-muted">Too long to compare here.</p>
  return (
    <pre
      className="max-h-96 overflow-auto border-t border-border bg-canvas py-1 font-mono text-xs"
      data-testid="file-diff"
    >
      {withContext(diff).map((line, i) =>
        line === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: folds have no identity but their place
          <div key={`fold-${i}`} className="px-3 text-muted">
            ⋯
          </div>
        ) : (
          <div
            key={`${line.before}:${line.after}`}
            className={cn(
              'flex gap-3 px-3',
              line.kind === 'added' && 'bg-success/10',
              line.kind === 'removed' && 'bg-danger/10',
            )}
          >
            <span className="w-4 shrink-0 text-muted select-none">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </span>
            <span className="whitespace-pre-wrap">{line.text}</span>
          </div>
        ),
      )}
    </pre>
  )
}

/** What updating from the branch would do, as the changes query says. */
function mergeOutlook(merge: { conflicts: number } | null): string {
  if (!merge) return 'update before committing'
  if (merge.conflicts === 0) return 'updating merges it with your changes'
  return `updating leaves ${merge.conflicts} conflict${merge.conflicts === 1 ? '' : 's'} to resolve`
}
