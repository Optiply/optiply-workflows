import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Lock,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { CommitLink, type GitKind, PullRequestLink, useGitInfo } from '@/components/git'
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
  const branches = useQuery({ ...trpc.git.branches.queryOptions(), staleTime: 30_000 })
  const drafts = useQuery(trpc.branchDrafts.list.queryOptions({ kind, id: object.id }))
  const [naming, setNaming] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [committing, setCommitting] = useState(false)
  const deploy = git?.branch ?? 'main'

  const names = [
    ...new Set([
      ...(drafts.data ?? []).map((d) => d.branch),
      ...(branches.data ?? []).filter((b) => !b.deploy).map((b) => b.name),
      ...(branch ? [branch] : []),
    ]),
  ].sort()

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
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
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
  const update = useMutation(
    trpc.branchDrafts.updateFromBranch.mutationOptions({
      onSuccess: async (result) => {
        if (result.status === 'conflicts') {
          // The merge dialog comes in M20 step 4; until then, the branch's version can replace the draft's changes.
          const n = result.conflicts.length
          if (
            confirm(
              `Your changes that aren't committed and the branch's conflict in ${n} place${n === 1 ? '' : 's'}. Replace your changes with the branch's?`,
            )
          ) {
            update.mutate({ id: draft.id, discardChanges: true })
          }
          return
        }
        props.onReplaced(result.draft)
        await queryClient.invalidateQueries({
          queryKey: trpc.branchDrafts.changes.queryKey({ id: draft.id }),
        })
      },
    }),
  )
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
          <AlertTriangle className="size-3.5" /> Someone changed this {props.kind} on {branch}: update before
          committing
        </span>
      ) : (
        c?.behind && <span className="text-warning-strong">{branch} has new commits</span>
      )}
      <span className="flex-1" />
      {c?.behind && (
        <Button
          size="sm"
          loading={update.isPending}
          title="Load the branch's files into this draft"
          onClick={() => {
            // Merged with the draft's changes that aren't committed (M20).
            update.mutate({ id: draft.id })
          }}
        >
          <RefreshCw className="size-3.5" /> Update from branch
        </Button>
      )}
      {pr.data?.pullRequest && <PullRequestLink pullRequest={pr.data.pullRequest} />}
      <Button size="sm" variant="primary" onClick={props.onCommit} data-testid="commit-open">
        <GitCommitHorizontal className="size-3.5" />
        Commit{c && c.files.length > 0 ? ` (${c.files.length})` : ''}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        title="Close this draft (what's committed stays on the branch)"
        loading={discard.isPending}
        onClick={() => {
          if (confirm(`Close the draft on ${branch}? Changes that aren't committed are lost.`)) {
            discard.mutate({ id: draft.id })
          }
        }}
      >
        <Trash2 className="size-4" />
      </Button>
      <ErrorNote error={update.error ?? discard.error ?? changes.error} />
    </>
  )
}

/** The files a commit changes (with their diffs), a message, Commit, and then the pull request. */
function CommitDialog(
  props: GitBarProps & { draft: Draft; webUrl: string | null | undefined; onClose(): void },
) {
  const { draft, branch, object, kind } = props
  const trpc = useTRPC()
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
      queryClient.invalidateQueries({ queryKey: trpc.git.branches.queryKey() }),
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
              It’s in the pull request: <PullRequestLink pullRequest={pullRequest} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-muted">Open a pull request to have it reviewed; merging it deploys it.</p>
              <Button
                className="self-start"
                variant="primary"
                loading={openPr.isPending}
                onClick={() =>
                  openPr.mutate({ branch: branch!, title: message.split('\n')[0]!, body: message })
                }
                data-testid="open-pull-request"
              >
                <GitPullRequest className="size-4" /> Open pull request
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
            Someone changed this {kind} on {branch} since you started: close this, update from the branch,
            then commit.
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

/** A file's changes, line by line (unchanged stretches folded). */
function FileDiff({ before, after }: { before: string | null; after: string | null }) {
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
