import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitPullRequest } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CommitLink, GIT_ALL_LABELS, PullRequestLink, type SettingsKind, useGitInfo } from '@/components/git'
import { FileDiff } from '@/components/git-bar'
import { Badge, Button, Dialog, ErrorNote, Field, Input, Textarea } from '@/components/ui'
import { type RouterInputs, useTRPC } from '@/lib/trpc'

/** What Save to branch commits: a resource's name, description, folder and configs, or a config var's values. */
export type SettingsEdit = RouterInputs['git']['commitSettings']['edit']

/**
 * Save to branch (M22): a protected resource's or config var's edited settings committed onto a branch (made from the
 * deploy branch when new), after showing what changes; then its pull request. Secrets never go: they're saved here.
 */
export function SaveToBranchDialog({
  kind,
  object,
  edit,
  onClose,
}: {
  kind: SettingsKind
  object: { id: string; slug: string }
  edit: SettingsEdit
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: git } = useGitInfo()
  const label = GIT_ALL_LABELS[kind]
  const [branch, setBranch] = useState(`settings/${kind.replace('_', '-')}-${object.slug}`.toLowerCase())
  // Compared once typing stops.
  const [compared, setCompared] = useState(branch)
  useEffect(() => {
    const timer = setTimeout(() => setCompared(branch.trim()), 400)
    return () => clearTimeout(timer)
  }, [branch])
  const [message, setMessage] = useState(`Update ${label} ${object.slug}`)
  const [open, setOpen] = useState<string | null>(null)
  const [committed, setCommitted] = useState<{ commit: string; branch: string } | null>(null)
  const branches = useQuery(trpc.git.branches.queryOptions())
  const onDeployBranch = compared === git?.branch
  const changes = useQuery({
    ...trpc.git.settingsChanges.queryOptions({ kind, id: object.id, branch: compared, edit }),
    enabled: compared !== '' && !onDeployBranch && !committed,
    staleTime: 0,
    retry: false,
  })
  const commit = useMutation(
    trpc.git.commitSettings.mutationOptions({
      onSuccess: async (result) => {
        setCommitted({ commit: result.commit, branch: result.branch })
        await queryClient.invalidateQueries({ queryKey: trpc.git.branches.queryKey() })
      },
    }),
  )
  const pr = useQuery({
    ...trpc.git.pullRequest.queryOptions({ branch: committed?.branch ?? compared }),
    enabled: committed !== null,
  })
  const openPr = useMutation(
    trpc.git.openPullRequest.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.git.pullRequest.pathKey() }),
    }),
  )
  const c = changes.data

  if (committed) {
    const pullRequest = openPr.data?.pullRequest ?? pr.data?.pullRequest
    return (
      <Dialog
        title="Saved to the branch"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm" data-testid="save-to-branch-result">
          <p>
            <CommitLink sha={committed.commit} webUrl={git?.webUrl} /> is on{' '}
            <span className="font-mono">{committed.branch}</span>. Nothing changes here until it’s merged into{' '}
            <span className="font-mono">{git?.branch}</span>.
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
                  openPr.mutate({ branch: committed.branch, title: message.split('\n')[0]!, body: message })
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
      title="Save to branch"
      onClose={onClose}
      className="max-w-4xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={commit.isPending}
            disabled={!c || c.files.length === 0 || compared !== branch.trim() || !message.trim()}
            onClick={() =>
              commit.mutate({
                kind,
                id: object.id,
                branch: compared,
                base: c!.base,
                edit,
                message: message.trim(),
              })
            }
            data-testid="save-to-branch-confirm"
          >
            Commit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted">
          This {label}’s settings come from Git. Your changes go onto a branch for review; merging it into{' '}
          <span className="font-mono">{git?.branch ?? 'main'}</span> deploys them.
        </p>
        <Field label="Branch" hint="A new branch starts from the deploy branch.">
          <Input
            className="font-mono"
            list="save-to-branch-branches"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            data-testid="save-to-branch-branch"
          />
          <datalist id="save-to-branch-branches">
            {branches.data
              ?.filter((b) => !b.deploy)
              .map((b) => (
                <option key={b.name} value={b.name} />
              ))}
          </datalist>
        </Field>
        {onDeployBranch ? (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-strong">
            That’s the deploy branch: pick another one, and merge it after review.
          </p>
        ) : !c ? (
          <p className="text-muted">{changes.isFetching ? 'Comparing with the branch…' : ''}</p>
        ) : c.files.length === 0 ? (
          <p className="text-muted" data-testid="no-changes">
            Nothing to commit: {compared} already has these settings.
          </p>
        ) : (
          <ul
            className="divide-y divide-border rounded-md border border-border"
            data-testid="save-to-branch-files"
          >
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
                  {!c.branchExists && <span className="ml-auto text-xs text-muted">new branch</span>}
                </button>
                {open === f.path && <FileDiff before={f.before} after={f.after} />}
              </li>
            ))}
          </ul>
        )}
        <Field label="Message">
          <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <ErrorNote error={commit.error ?? changes.error} />
      </div>
    </Dialog>
  )
}
