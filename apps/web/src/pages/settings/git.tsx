import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, GitBranch, GitPullRequest, Plug, RefreshCw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import { CommitLink, GIT_ALL_ROOTS, PullRequestLink, useChangeRequest } from '@/components/git'
import {
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorNote,
  Field,
  Input,
  SecretInput,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { AdminOnly } from './layout'

type Settings = RouterOutputs['git']['settings']
type Status = RouterOutputs['git']['status']
type TestResult = RouterOutputs['git']['testConnection']
type DeployResult = RouterOutputs['git']['deployNow']

/** The instance's Git repo: where protected workflows and apps live, and what deploying from it did. */
export function GitSettingsPage() {
  return (
    <AdminOnly>
      <GitSettings />
    </AdminOnly>
  )
}

function GitSettings() {
  const trpc = useTRPC()
  const { data: settings, error } = useQuery(trpc.git.settings.queryOptions())
  if (!settings) return error ? <ErrorNote error={error} /> : <Spinner />
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm text-muted">
        Protected workflows, apps, library queries, modules, resources and config vars live in a Git repo on
        GitHub or GitLab: they’re changed on branches, reviewed in pull (or merge) requests, and deployed here
        when one merges into the deploy branch.
      </p>
      <RepoForm settings={settings} />
      {settings.configured && (
        <>
          <WebhookHelp hasSecret={settings.webhookSecret.set} host={settings.host} branch={settings.branch} />
          <DeployPanel />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <NotifyCard settings={settings} />
            <PromoteCard branch={settings.branch} />
          </div>
        </>
      )}
    </div>
  )
}

type Host = Settings['host']

/** The host a repo URL names (github.com, gitlab.com, gitlab.…); null for another host, where the admin picks (M31). */
function detectHost(repoUrl: string): Host | null {
  try {
    const host = new URL(repoUrl.trim()).hostname.toLowerCase()
    if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
    if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab'
  } catch {}
  return null
}

const HOST_LABELS: Record<Host, string> = { github: 'GitHub', gitlab: 'GitLab' }

/** Whether two repo URLs are on the same server (a stored token stays with its server). */
function sameOrigin(a: string, b: string | null): boolean {
  try {
    return !!b && new URL(a.trim()).origin === new URL(b).origin
  } catch {
    return false
  }
}

function RepoForm({ settings }: { settings: Settings }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [repoUrl, setRepoUrl] = useState(settings.repoUrl ?? '')
  const [branch, setBranch] = useState(settings.branch)
  const [host, setHost] = useState<Host>(settings.host)
  const [apiUrl, setApiUrl] = useState(settings.apiUrl ?? '')
  const [signIn, setSignIn] = useState(settings.githubAuth)
  const [appId, setAppId] = useState(settings.githubAppId ?? '')
  const [appKey, setAppKey] = useState('')
  const [token, setToken] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.git.settings.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.git.info.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.git.status.queryKey() }),
    ])
  const save = useMutation(trpc.git.saveSettings.mutationOptions({ onSuccess: refresh }))
  const clear = useMutation(trpc.git.clearSettings.mutationOptions({ onSuccess: refresh }))
  const testConnection = useMutation(trpc.git.testConnection.mutationOptions({ onSuccess: setTest }))
  const detected = detectHost(repoUrl)
  const app = host === 'github' && signIn === 'app'
  const changed =
    repoUrl.trim() !== (settings.repoUrl ?? '') ||
    branch.trim() !== settings.branch ||
    host !== settings.host ||
    (host === 'gitlab' && apiUrl.trim() !== (settings.apiUrl ?? '')) ||
    (host === 'github' && signIn !== settings.githubAuth) ||
    (app && (appId.trim() !== (settings.githubAppId ?? '') || appKey !== '')) ||
    token !== '' ||
    secret !== null
  const keep = { repoUrl: settings.repoUrl!, branch: settings.branch }
  // Another host (or server) needs the token again: a stored one is never sent somewhere new.
  const tokenKept = settings.token.set && host === settings.host && sameOrigin(repoUrl, settings.repoUrl)

  return (
    <Card className="p-5">
      <form
        className="grid gap-4 md:grid-cols-2"
        data-testid="git-settings-form"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(
            {
              repoUrl: repoUrl.trim(),
              branch: branch.trim(),
              host,
              ...(host === 'gitlab' ? { apiUrl: apiUrl.trim() || null } : { githubAuth: signIn }),
              ...(app ? { githubAppId: appId.trim(), ...(appKey ? { appPrivateKey: appKey } : {}) } : {}),
              ...(token ? { token } : {}),
              ...(secret ? { webhookSecret: secret } : {}),
            },
            {
              onSuccess: () => {
                setToken('')
                setAppKey('')
                // It was copied before saving (the hint says so); from now on it's only "Set".
                setSecret(null)
                setTest(null)
              },
            },
          )
        }}
      >
        <Field
          label="Repository"
          hint="The https URL of the repo on GitHub or GitLab, e.g. https://github.com/optiply/workflows.git"
        >
          <Input
            className="font-mono"
            data-testid="git-repo-url"
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value)
              const found = detectHost(e.target.value)
              if (found) setHost(found)
            }}
            placeholder="https://github.com/optiply/workflows.git"
          />
        </Field>
        <Field label="Deploy branch" hint="Merging into it deploys.">
          <Input className="font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </Field>
        <Field
          label="Host"
          hint={
            detected
              ? 'From the repo’s address.'
              : 'Another server: GitHub Enterprise Server or a self-managed GitLab.'
          }
        >
          <Select
            data-testid="git-host"
            value={host}
            disabled={!!detected}
            onChange={(e) => setHost(e.target.value as Host)}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </Select>
        </Field>
        {host === 'github' ? (
          <Field
            label="Sign in with"
            hint={
              signIn === 'app'
                ? 'A GitHub App installed on the repo: short-lived tokens, not tied to a person.'
                : 'A token of a person or machine user.'
            }
          >
            <Select
              data-testid="git-signin"
              value={signIn}
              onChange={(e) => setSignIn(e.target.value as 'token' | 'app')}
            >
              <option value="token">A token</option>
              <option value="app">A GitHub App</option>
            </Select>
          </Field>
        ) : (
          <Field
            label="API URL"
            hint="Only for GitLab served under a path, e.g. https://code.example.com/gitlab/api/v4. Empty: <server>/api/v4."
          >
            <Input
              className="font-mono"
              data-testid="git-api-url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://gitlab.com/api/v4"
            />
          </Field>
        )}
        {app ? (
          <>
            <Field label="App id" hint="On the App’s settings page (About: App ID).">
              <Input
                className="font-mono"
                data-testid="git-app-id"
                inputMode="numeric"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="123456"
              />
            </Field>
            <Field
              label="Private key"
              hint="A private key made on the App’s settings page (a .pem file): paste its contents. Kept encrypted, never shown again."
            >
              <Textarea
                className="font-mono text-xs"
                data-testid="git-app-key"
                rows={3}
                spellCheck={false}
                value={appKey}
                onChange={(e) => setAppKey(e.target.value)}
                placeholder={
                  settings.appPrivateKey.set &&
                  settings.githubAuth === 'app' &&
                  sameOrigin(repoUrl, settings.repoUrl)
                    ? 'Set: leave empty to keep it'
                    : '-----BEGIN RSA PRIVATE KEY-----'
                }
              />
            </Field>
            <p className="text-xs text-muted md:col-span-2">
              The App needs <b>Contents</b> and <b>Pull requests</b> (read and write) and <b>Metadata</b>{' '}
              (read), installed on this repo; subscribe it to the <b>push</b> event for the webhook below.
            </p>
          </>
        ) : (
          <Field
            label={host === 'gitlab' ? 'GitLab access token' : 'GitHub token'}
            hint={
              host === 'gitlab'
                ? 'A project (or group) access token with the api and write_repository scopes and the Developer role (Maintainer to push to protected branches).'
                : 'A fine-grained token for this one repo, with Contents and Pull requests (read and write).'
            }
          >
            <div className="flex items-center gap-2">
              <SecretInput
                value={token}
                data-testid="git-token"
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  tokenKept ? 'Set: leave empty to keep it' : host === 'gitlab' ? 'glpat-…' : 'github_pat_…'
                }
              />
              {tokenKept && !changed && (
                <Button size="sm" variant="ghost" onClick={() => save.mutate({ ...keep, token: null })}>
                  Remove
                </Button>
              )}
            </div>
          </Field>
        )}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink">Webhook secret</legend>
          {secret ? (
            <div className="flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/30 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm" data-testid="new-webhook-secret">
                {secret}
              </code>
              <CopyButton text={secret} label="Copy secret" />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">{settings.webhookSecret.set ? 'Set' : 'Not set'}</span>
              <Button size="sm" onClick={() => setSecret(randomSecret())}>
                {settings.webhookSecret.set ? 'Replace' : 'Generate'}
              </Button>
              {settings.webhookSecret.set && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => save.mutate({ ...keep, webhookSecret: null })}
                >
                  Remove
                </Button>
              )}
            </div>
          )}
          {secret && (
            <span className="text-xs text-warning-strong">
              Copy it into {HOST_LABELS[host]}’s webhook settings now, then save: it isn’t shown again.
            </span>
          )}
          <span className="text-xs text-muted">
            {host === 'gitlab'
              ? 'GitLab sends it with each push (the secret token), so merges deploy at once.'
              : 'Signs GitHub’s push webhook, so merges deploy at once.'}
          </span>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2 md:col-span-2">
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={!repoUrl.trim() || !changed}
          >
            Save
          </Button>
          {settings.configured && (
            <>
              <Button
                loading={testConnection.isPending}
                disabled={changed}
                title={
                  changed
                    ? 'Save first'
                    : `Sign in to the repo and ${HOST_LABELS[settings.host]}, and read the deploy branch`
                }
                onClick={() => testConnection.mutate()}
              >
                <Plug className="size-4" /> Test connection
              </Button>
              <span className="flex-1" />
              <Button
                variant="danger"
                loading={clear.isPending}
                onClick={async () => {
                  if (
                    await confirmDialog(
                      'Disconnect the repo? Deploys stop. Protected workflows and apps stay protected until unprotected.',
                      { danger: true, confirm: 'Disconnect' },
                    )
                  ) {
                    clear.mutate()
                  }
                }}
              >
                Disconnect
              </Button>
            </>
          )}
        </div>
        <div className="md:col-span-2">
          <ErrorNote error={save.error ?? clear.error ?? testConnection.error} />
          {test && !changed && <TestOutcome result={test} branch={settings.branch} />}
        </div>
      </form>
    </Card>
  )
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function TestOutcome({ result, branch }: { result: TestResult; branch: string }) {
  return (
    <div className="flex flex-col gap-2">
      <RepoOutcome result={result} branch={branch} />
      {result.host && <HostOutcome report={result.host} />}
    </div>
  )
}

/** What the host's API said (M31): who signed in where, and what's missing for pull or merge requests. */
function HostOutcome({ report }: { report: NonNullable<TestResult['host']> }) {
  if (!report.ok)
    return (
      <div
        className="flex items-start gap-2 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger"
        data-testid="git-test-host"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{report.message}</span>
      </div>
    )
  const lacking = report.problems.length > 0
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${lacking ? 'bg-warning-soft text-warning-strong' : 'bg-success/5'}`}
      data-testid="git-test-host"
    >
      {lacking ? (
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
      )}
      <span>
        {report.message}.
        {report.problems.map((p) => (
          <span key={p} className="block">
            {p}.
          </span>
        ))}
      </span>
    </div>
  )
}

function RepoOutcome({ result, branch }: { result: TestResult; branch: string }) {
  if (!result.ok) {
    return (
      <div
        className="flex items-start gap-2 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger"
        data-testid="git-test"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{result.message}</span>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 rounded-md bg-success/5 px-3 py-2 text-sm" data-testid="git-test">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
      <span>
        Connected: {result.branches} branch{result.branches === 1 ? '' : 'es'}.{' '}
        {result.commit ? (
          <>
            {branch} holds {result.workflows} workflow{result.workflows === 1 ? '' : 's'} and {result.apps}{' '}
            app
            {result.apps === 1 ? '' : 's'}.
          </>
        ) : (
          <>The repo has no {branch} branch yet: protecting something creates it.</>
        )}{' '}
        {result.manifest === 'missing' &&
          result.commit &&
          'It has no ow.json yet: the first commit from here adds it.'}
        {result.manifest === 'unsupported' && result.manifestMessage}
      </span>
    </div>
  )
}

function WebhookHelp({ hasSecret, host, branch }: { hasSecret: boolean; host: Host; branch: string }) {
  const url = `${window.location.origin}/api/git/webhook`
  const secret = hasSecret ? 'The webhook secret above' : 'Generate a webhook secret above first'
  return (
    <Card className="p-5 text-sm" data-testid="git-webhook-help">
      <h3 className="mb-2 font-semibold">{HOST_LABELS[host]} webhook</h3>
      <p className="mb-3 text-muted">
        Without it, the instance checks the deploy branch every minute. With it, a merge deploys within
        seconds.{' '}
        {host === 'gitlab'
          ? 'In the project’s Settings → Webhooks, add one with:'
          : 'In the repo’s settings (or the GitHub App’s), add a webhook with:'}
      </p>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted">{host === 'gitlab' ? 'URL' : 'Payload URL'}</dt>
        <dd className="flex items-center gap-1 font-mono">
          {url} <CopyButton text={url} label="Copy URL" />
        </dd>
        {host === 'gitlab' ? (
          <>
            <dt className="text-muted">Secret token</dt>
            <dd>{secret}</dd>
            <dt className="text-muted">Trigger</dt>
            <dd>
              Push events, for the branch <span className="font-mono">{branch}</span>
            </dd>
            <dt className="text-muted">SSL verification</dt>
            <dd>On</dd>
          </>
        ) : (
          <>
            <dt className="text-muted">Content type</dt>
            <dd className="font-mono">application/json</dd>
            <dt className="text-muted">Secret</dt>
            <dd>{secret}</dd>
            <dt className="text-muted">Events</dt>
            <dd>Just the push event</dd>
          </>
        )}
      </dl>
    </Card>
  )
}

const STATUS_TONES = { deployed: 'success', problem: 'danger', missing: 'neutral' } as const
const STATUS_LABELS = { deployed: 'Deployed', problem: 'Problems', missing: 'Gone from the branch' } as const

function DeployPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: git } = useQuery(trpc.git.info.queryOptions())
  const { data: status, error } = useQuery({ ...trpc.git.status.queryOptions(), refetchInterval: 15_000 })
  const [result, setResult] = useState<DeployResult | null>(null)
  const deployNow = useMutation(
    trpc.git.deployNow.mutationOptions({
      onSuccess: async (done) => {
        setResult(done)
        await queryClient.invalidateQueries({ queryKey: trpc.git.status.queryKey() })
      },
    }),
  )
  if (!status) return error ? <ErrorNote error={error} /> : <Spinner />
  const s = status.settings
  return (
    <Card className="p-5" data-testid="git-deploys">
      <div className="mb-4 flex items-start gap-4">
        <div className="flex-1 text-sm">
          <h3 className="mb-1 font-semibold">Deploys</h3>
          <p className="text-muted">
            {s?.deployedCommit ? (
              <>
                Deployed from <CommitLink sha={s.deployedCommit} webUrl={git?.webUrl} /> on{' '}
                <span className="font-mono">{s.branch}</span>
              </>
            ) : (
              'Nothing deployed yet'
            )}
            {s?.checkedAt && <> · checked {new Date(s.checkedAt).toLocaleString()}</>}
            {s?.deploying && <Badge className="ml-2">Deploying…</Badge>}
          </p>
          {s?.lastError && (
            <p className="mt-2 flex items-start gap-2 text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {s.lastError}
            </p>
          )}
        </div>
        <Button
          loading={deployNow.isPending}
          onClick={() => deployNow.mutate()}
          title="Deploy the branch now, checking every workflow and app again"
        >
          <RefreshCw className="size-4" /> Deploy now
        </Button>
      </div>
      <ErrorNote error={deployNow.error} />
      {result && <DeployOutcome result={result} />}

      {status.objects.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>In the repo</Th>
              <Th>Status</Th>
              <Th>Live</Th>
              <Th>Problems</Th>
            </tr>
          </thead>
          <tbody>
            {status.objects.map((o) => (
              <tr key={o.id} data-testid={`git-object-${o.kind}-${o.slug}`}>
                <Td>
                  <ObjectLink object={o} />
                </Td>
                <Td>
                  <Badge tone={STATUS_TONES[o.status]}>{STATUS_LABELS[o.status]}</Badge>
                </Td>
                <Td className="font-mono text-xs">{o.version ? `v${o.version}` : '—'}</Td>
                <Td className="text-xs">
                  {o.problems.length === 0 ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {o.problems.map((p) => (
                        <li key={`${p.path}:${p.message}`}>
                          <span className="font-mono text-muted">{p.path}</span>: {p.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {status.deploys.length > 0 && <RecentDeploys deploys={status.deploys} webUrl={git?.webUrl} />}
    </Card>
  )
}

function ObjectLink({ object }: { object: Status['objects'][number] }) {
  const label = (
    <span className="font-mono text-sm">
      {GIT_ALL_ROOTS[object.kind]}/{object.slug}
    </span>
  )
  if (object.objectId && object.status !== 'missing') {
    const className = 'hover:underline'
    switch (object.kind) {
      case 'workflow':
        return (
          <Link to="/workflows/$workflowId" params={{ workflowId: object.objectId }} className={className}>
            {label}
          </Link>
        )
      case 'app':
        return (
          <Link to="/apps/$slug/edit" params={{ slug: object.slug }} className={className}>
            {label}
          </Link>
        )
      case 'library_query':
        return (
          <Link to="/library/$slug" params={{ slug: object.slug }} className={className}>
            {label}
          </Link>
        )
      case 'module':
        return (
          <Link to="/modules/$slug" params={{ slug: object.slug }} className={className}>
            {label}
          </Link>
        )
      case 'component_library':
        return (
          <Link to="/component-libraries/$slug" params={{ slug: object.slug }} className={className}>
            {label}
          </Link>
        )
      case 'resource':
        return (
          <Link to="/resources/$resourceId" params={{ resourceId: object.objectId }} className={className}>
            {label}
          </Link>
        )
      case 'config_var':
        return (
          <Link to="/settings/config-vars" className={className}>
            {label}
          </Link>
        )
    }
  }
  return label
}

function DeployOutcome({ result }: { result: DeployResult }) {
  const text =
    result.status === 'deployed'
      ? result.ok
        ? 'Deployed.'
        : 'Deployed, with problems: see below.'
      : result.status === 'up_to_date'
        ? 'Already up to date.'
        : result.status === 'busy'
          ? 'Another deploy is running; it goes again right after.'
          : result.status === 'empty'
            ? 'The repo has no deploy branch yet.'
            : result.status === 'failed'
              ? result.error
              : 'Git sync isn’t set up.'
  return (
    <p className="mb-3 text-sm" data-testid="deploy-outcome">
      {text}
    </p>
  )
}

type Deploy = Status['deploys'][number]
interface DeploySummary {
  subject?: string
  author?: { name: string }
  objects?: Array<{
    kind: keyof typeof GIT_ALL_ROOTS
    slug: string
    outcome: string
    version?: string
    /** Moved into the folder Git names (M22); null is the top level. */
    folder?: { from: string | null; to: string | null }
  }>
  problems?: Array<{ path: string; message: string }>
}

const TRIGGERS = { poll: 'Check', webhook: 'Push', manual: 'Deploy now', retry: 'Retry' } as const

function RecentDeploys({ deploys, webUrl }: { deploys: Deploy[]; webUrl: string | null | undefined }) {
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-sm font-semibold">Recent deploys</h3>
      <ul className="divide-y divide-border rounded-md border border-border text-sm">
        {deploys.map((d) => {
          const summary = d.summary as DeploySummary
          return (
            <li key={d.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <GitBranch className="size-3.5 text-muted" />
                <CommitLink sha={d.commit} webUrl={webUrl} />
                <span className="min-w-0 flex-1 truncate">{summary.subject}</span>
                {d.status === 'ok' ? <Badge tone="success">OK</Badge> : <Badge tone="danger">Problems</Badge>}
                <span className="text-xs text-muted">
                  {TRIGGERS[d.trigger]} · {new Date(d.startedAt).toLocaleString()}
                </span>
              </div>
              {!!summary.objects?.length && (
                <div className="mt-1 pl-6 text-xs text-muted">
                  {summary.objects
                    .map(
                      (o) =>
                        `${GIT_ALL_ROOTS[o.kind] ?? o.kind}/${o.slug}: ${o.outcome}${o.version ? ` v${o.version}` : ''}${
                          o.folder ? ` (moved to ${o.folder.to ?? 'the top level'})` : ''
                        }`,
                    )
                    .join(' · ')}
                </div>
              )}
              {!!summary.problems?.length && (
                <div className="mt-1 pl-6 text-xs text-danger">
                  {summary.problems.map((p) => p.message).join(' · ')}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The workflow run when a deploy's problems change (M22): its live release gets the deploy and the problems. */
function NotifyCard({ settings }: { settings: Settings }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: workflows } = useQuery(trpc.workflows.list.queryOptions())
  const set = useMutation(
    trpc.git.setNotifyWorkflow.mutationOptions({
      onSuccess: (view) => queryClient.setQueryData(trpc.git.settings.queryKey(), view),
    }),
  )
  const chosen = settings.notifyWorkflow
  const live = workflows?.find((w) => w.id === chosen?.id)?.liveReleaseId
  return (
    <Card className="space-y-3 p-5" data-testid="git-notify">
      <h3 className="font-semibold">When deploys have problems</h3>
      <p className="text-sm text-muted">
        Admins see a banner while objects can’t deploy. A workflow can be told too: its live release runs once
        each time the problems change, and once more when they’re gone, with{' '}
        <code className="font-mono text-xs">{'{ deploy, problems }'}</code>.
      </p>
      <Field label="Notify workflow">
        <Select
          value={chosen?.id ?? ''}
          disabled={set.isPending}
          onChange={(e) => set.mutate({ workflowId: e.target.value || null })}
        >
          <option value="">None</option>
          {workflows?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>
      {chosen && workflows && !live && (
        <p className="text-sm text-warning-strong">
          {chosen.name} has no live release yet: publish it, or notifications are only logged.
        </p>
      )}
      <ErrorNote error={set.error} />
    </Card>
  )
}

/** Promote (M22): a pull request from this instance's deploy branch into another branch, such as production's. */
function PromoteCard({ branch }: { branch: string }) {
  const trpc = useTRPC()
  const cr = useChangeRequest()
  const { data: branches } = useQuery(trpc.git.branches.queryOptions())
  const [target, setTarget] = useState('')
  const promote = useMutation(trpc.git.openPromotion.mutationOptions())
  const result = promote.data
  return (
    <Card className="space-y-3 p-5" data-testid="git-promote">
      <h3 className="font-semibold">Promote</h3>
      <p className="text-sm text-muted">
        Opens a {cr.noun} from <span className="font-mono">{branch}</span> into another instance’s deploy
        branch. Merging it deploys there; that instance keeps its own secrets, overrides and local values.
      </p>
      <div className="flex items-end gap-2">
        <Field label="Into branch" className="flex-1">
          <Input
            className="font-mono"
            list="promote-branches"
            placeholder="production"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value)
              promote.reset()
            }}
          />
          <datalist id="promote-branches">
            {branches
              ?.filter((b) => !b.deploy)
              .map((b) => (
                <option key={b.name} value={b.name} />
              ))}
          </datalist>
        </Field>
        <Button
          loading={promote.isPending}
          disabled={!target.trim() || target.trim() === branch}
          onClick={() => promote.mutate({ target: target.trim() })}
        >
          <GitPullRequest className="size-4" /> Open {cr.noun}
        </Button>
      </div>
      {result?.status === 'up_to_date' && (
        <p className="text-sm text-muted" data-testid="promote-result">
          <CheckCircle2 className="mr-1 inline size-4 text-success" />
          {target} already has everything on {branch}.
        </p>
      )}
      {result?.status === 'opened' && (
        <div className="space-y-2 text-sm" data-testid="promote-result">
          {result.pullRequest ? (
            <PullRequestLink pullRequest={result.pullRequest} />
          ) : (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-strong">
              No {cr.noun} was opened: {result.pullRequestError}
            </p>
          )}
          {result.directories.length > 0 && (
            <p className="text-muted">
              Brings: <span className="font-mono text-xs">{result.directories.join(', ')}</span>
            </p>
          )}
        </div>
      )}
      <ErrorNote error={promote.error} />
    </Card>
  )
}
