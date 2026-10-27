import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, GitBranch, GitPullRequest } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Dialog, ErrorNote, Field, Input } from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

export type GitInfo = RouterOutputs['git']['info']
type ProtectResult = RouterOutputs['git']['protect']

/** Whether Git sync is set up, its deploy branch, and the repo's web address (for links). */
export function useGitInfo() {
  const trpc = useTRPC()
  return useQuery({ ...trpc.git.info.queryOptions(), staleTime: 60_000 })
}

/** A short commit sha, linking to the commit when the repo is on the web. */
export function CommitLink({ sha, webUrl }: { sha: string; webUrl: string | null | undefined }) {
  const short = <span className="font-mono">{sha.slice(0, 7)}</span>
  if (!webUrl) return <span title={sha}>{short}</span>
  return (
    <a
      href={`${webUrl}/commit/${sha}`}
      target="_blank"
      rel="noreferrer"
      title={sha}
      className="hover:underline"
    >
      {short}
    </a>
  )
}

/** Who made a release: a person, or Git sync with the commit it deployed. */
export function ReleaseAuthor({
  release,
  webUrl,
}: {
  release: { createdBy: { name: string } | null; gitCommit: string | null }
  webUrl: string | null | undefined
}) {
  if (release.gitCommit) {
    return (
      <span data-testid="git-sync-author">
        Git sync from <CommitLink sha={release.gitCommit} webUrl={webUrl} />
      </span>
    )
  }
  return <>{release.createdBy?.name ?? 'Someone'}</>
}

/** Marks an object edited on Git branches and deployed from the repo. */
export function ProtectedBadge() {
  return (
    <Badge tone="accent" title="Protected: edited on Git branches and deployed when they merge">
      <GitBranch className="mr-1 size-3" /> In Git
    </Badge>
  )
}

/** A pull request's link with its state. */
export function PullRequestLink({
  pullRequest,
}: {
  pullRequest: { number: number; url: string; state: string; merged: boolean; draft?: boolean }
}) {
  const state = pullRequest.merged ? 'Merged' : pullRequest.state === 'open' ? 'Open' : 'Closed'
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
      data-testid="pull-request-link"
    >
      <GitPullRequest className="size-3.5" /> #{pullRequest.number}
      <Badge tone={pullRequest.merged ? 'success' : pullRequest.state === 'open' ? 'accent' : 'neutral'}>
        {state}
      </Badge>
      <ExternalLink className="size-3" />
    </a>
  )
}

/**
 * Protecting a workflow, app, library query, module, or since M22 a resource or config var: what it means, an
 * optional branch name, and then the branch and pull request it made (or how to open one by hand).
 */
export function ProtectDialog({
  kind,
  object,
  onClose,
}: {
  kind: GitKind | SettingsKind
  object: { id: string; slug: string; name: string }
  onClose: () => void
}) {
  const trpc = useTRPC()
  const refresh = useRefreshKind(kind)
  const { data: git } = useGitInfo()
  const settings = isSettingsKind(kind)
  const defaultBranch = `protect/${kind.replace('_', '-')}-${object.slug}`
  const [branch, setBranch] = useState(defaultBranch)
  const [result, setResult] = useState<ProtectResult | null>(null)
  const onSuccess = async (done: ProtectResult) => {
    setResult(done)
    await refresh()
  }
  const protectObject = useMutation(trpc.git.protect.mutationOptions({ onSuccess }))
  const protectSettings = useMutation(trpc.git.protectSettings.mutationOptions({ onSuccess }))
  const protect = settings ? protectSettings : protectObject
  const label = GIT_ALL_LABELS[kind]
  return (
    <Dialog
      title={`Protect “${object.name}”`}
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={protect.isPending}
              disabled={!branch.trim()}
              onClick={() => {
                const input = {
                  id: object.id,
                  // The default: the server picks the next free name if an earlier protect left that branch.
                  ...(branch.trim() !== defaultBranch && { branch: branch.trim() }),
                }
                if (isSettingsKind(kind)) protectSettings.mutate({ ...input, kind })
                else protectObject.mutate({ ...input, kind })
              }}
              data-testid="protect-confirm"
            >
              Protect
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3 text-sm" data-testid="protect-result">
          <p>
            The {label} is protected: from now on {settings ? 'its settings change' : 'it’s edited'} on Git
            branches, and merging into <span className="font-mono">{git?.branch}</span> deploys it.
          </p>
          <p>
            Its files are on <span className="font-mono">{result.branch}</span> (
            <CommitLink sha={result.commit} webUrl={git?.webUrl} />
            ).
          </p>
          {result.pullRequest ? (
            <div>
              Review and merge the pull request: <PullRequestLink pullRequest={result.pullRequest} />
            </div>
          ) : (
            <div className="rounded-md bg-warning-soft px-3 py-2 text-warning-strong">
              No pull request was opened: {result.pullRequestError}
              {git?.webUrl && (
                <>
                  {' '}
                  <a
                    className="underline"
                    href={`${git.webUrl}/compare/${git.branch}...${result.branch}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open one on the repo
                  </a>
                  .
                </>
              )}
            </div>
          )}
          {result.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-warning-strong">
              {result.warnings.map((w) => (
                <li key={w.path}>{w.message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <p>
            A protected {label} is reviewed before it changes.{' '}
            {settings ? 'Its settings (never its secrets)' : 'Its live version'} {settings ? 'are' : 'is'}{' '}
            committed to a branch and a pull request into{' '}
            <span className="font-mono">{git?.branch ?? 'main'}</span> is opened. From then on:
          </p>
          {settings ? (
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>
                Its settings are read-only here: change them with Save to branch, and review the pull request.
              </li>
              <li>Merging deploys them to every instance deploying that branch.</li>
              <li>
                Secrets stay on each instance
                {kind === 'resource' ? ', as do overrides of single settings' : ''}
                {kind === 'config_var' ? ', as do local values' : ''}.
              </li>
            </ul>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>Changes are made in a draft on a branch, committed, and reviewed in a pull request.</li>
              <li>Merging deploys it as a new release; nobody publishes it here any more.</li>
              <li>Only admins can roll it back here, in an emergency, until its next change in Git.</li>
            </ul>
          )}
          <Field
            label="Branch"
            hint="Where its files go first. Left as it is, a name already taken gets a number (-2, -3…)."
          >
            <Input className="font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </Field>
          <ErrorNote error={protect.error} />
        </div>
      )}
    </Dialog>
  )
}

/** Unprotecting a resource or config var (M22): it can then be changed here again. */
export function useUnprotectSettings(kind: SettingsKind) {
  const trpc = useTRPC()
  const refresh = useRefreshKind(kind)
  return useMutation(trpc.git.unprotectSettings.mutationOptions({ onSuccess: () => refresh() }))
}

/** Unprotecting: confirms, then lets the object be edited here again. */
export function useUnprotect(kind: GitKind) {
  const trpc = useTRPC()
  const refresh = useRefreshKind(kind)
  return useMutation(trpc.git.unprotect.mutationOptions({ onSuccess: () => refresh() }))
}

/** What Git sync keeps: workflows, apps, and since M14 library queries and modules. */
export type GitKind = 'workflow' | 'app' | 'library_query' | 'module'

/** Resources and config vars (M22): kept in Git without drafts or releases. */
export type SettingsKind = 'resource' | 'config_var'

export function isSettingsKind(kind: string): kind is SettingsKind {
  return kind === 'resource' || kind === 'config_var'
}

/** Each kind as people read it. */
export const GIT_KIND_LABELS: Record<GitKind, string> = {
  workflow: 'workflow',
  app: 'app',
  library_query: 'library query',
  module: 'module',
}

/** Where each kind's directories are in the repo. */
export const GIT_KIND_ROOTS: Record<GitKind, string> = {
  workflow: 'workflows',
  app: 'apps',
  library_query: 'library',
  module: 'modules',
}

/** Every kind as people read it, resources and config vars (M22) included. */
export const GIT_ALL_LABELS: Record<GitKind | SettingsKind, string> = {
  ...GIT_KIND_LABELS,
  resource: 'resource',
  config_var: 'config var',
}

/** Every kind's directory in the repo, resources and config vars (M22) included. */
export const GIT_ALL_ROOTS: Record<GitKind | 'resource' | 'config_var', string> = {
  ...GIT_KIND_ROOTS,
  resource: 'resources',
  config_var: 'config-vars',
}

/** Refetches a kind's list and objects (after protecting or unprotecting one). */
function useRefreshKind(kind: GitKind | SettingsKind) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const keys = {
    workflow: [trpc.workflows.list.queryKey(), trpc.workflows.get.queryKey()],
    app: [trpc.apps.list.queryKey(), trpc.apps.get.queryKey()],
    library_query: [trpc.libraryQueries.list.queryKey(), trpc.libraryQueries.get.queryKey()],
    module: [trpc.modules.list.queryKey(), trpc.modules.get.queryKey()],
    resource: [trpc.resources.list.queryKey(), trpc.resources.get.queryKey()],
    config_var: [trpc.configVars.list.queryKey()],
  }[kind]
  return () => Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

export const UNPROTECT_CONFIRM =
  'Unprotect it? It can then be edited and published here again. Its files stay in the repo, and merges there stop deploying it.'

export const UNPROTECT_SETTINGS_CONFIRM =
  'Unprotect it? Its settings can then be changed here again. Its files stay in the repo, and merges there stop deploying it.'
