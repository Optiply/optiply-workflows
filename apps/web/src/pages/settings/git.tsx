import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, GitBranch, Plug, RefreshCw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { CommitLink, GIT_ALL_ROOTS } from '@/components/git'
import {
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorNote,
  Field,
  Input,
  SecretInput,
  Spinner,
  Table,
  Td,
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
        Protected workflows and apps live in a GitHub repo: they’re changed on branches, reviewed in pull
        requests, and deployed here when a pull request merges into the deploy branch.
      </p>
      <RepoForm settings={settings} />
      {settings.configured && (
        <>
          <WebhookHelp hasSecret={settings.webhookSecret.set} />
          <DeployPanel />
        </>
      )}
    </div>
  )
}

function RepoForm({ settings }: { settings: Settings }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [repoUrl, setRepoUrl] = useState(settings.repoUrl ?? '')
  const [branch, setBranch] = useState(settings.branch)
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
  const changed =
    repoUrl.trim() !== (settings.repoUrl ?? '') ||
    branch.trim() !== settings.branch ||
    token !== '' ||
    secret !== null

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
              ...(token ? { token } : {}),
              ...(secret ? { webhookSecret: secret } : {}),
            },
            {
              onSuccess: () => {
                setToken('')
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
          hint="The https URL of the GitHub repo, e.g. https://github.com/optiply/workflows.git"
        >
          <Input
            className="font-mono"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/optiply/workflows.git"
          />
        </Field>
        <Field label="Deploy branch" hint="Merging into it deploys.">
          <Input className="font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </Field>
        <Field
          label="GitHub token"
          hint="A fine-grained token for this one repo, with Contents and Pull requests (read and write)."
        >
          <div className="flex items-center gap-2">
            <SecretInput
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={settings.token.set ? 'Set: leave empty to keep it' : 'github_pat_…'}
            />
            {settings.token.set && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  save.mutate({ repoUrl: settings.repoUrl!, branch: settings.branch, token: null })
                }
              >
                Remove
              </Button>
            )}
          </div>
        </Field>
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
                  onClick={() =>
                    save.mutate({ repoUrl: settings.repoUrl!, branch: settings.branch, webhookSecret: null })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          )}
          {secret && (
            <span className="text-xs text-warning-strong">
              Copy it into GitHub’s webhook settings now, then save: it isn’t shown again.
            </span>
          )}
          <span className="text-xs text-muted">Signs GitHub’s push webhook, so merges deploy at once.</span>
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
                title={changed ? 'Save first' : 'Sign in to the repo and read the deploy branch'}
                onClick={() => testConnection.mutate()}
              >
                <Plug className="size-4" /> Test connection
              </Button>
              <span className="flex-1" />
              <Button
                variant="danger"
                loading={clear.isPending}
                onClick={() => {
                  if (
                    confirm(
                      'Disconnect the repo? Deploys stop. Protected workflows and apps stay protected until unprotected.',
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
          {test && <TestOutcome result={test} branch={settings.branch} />}
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

function WebhookHelp({ hasSecret }: { hasSecret: boolean }) {
  const url = `${window.location.origin}/api/git/webhook`
  return (
    <Card className="p-5 text-sm">
      <h3 className="mb-2 font-semibold">GitHub webhook</h3>
      <p className="mb-3 text-muted">
        Without it, the instance checks the deploy branch every minute. With it, a merge deploys within
        seconds. In the repo’s settings, add a webhook with:
      </p>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted">Payload URL</dt>
        <dd className="flex items-center gap-1 font-mono">
          {url} <CopyButton text={url} label="Copy URL" />
        </dd>
        <dt className="text-muted">Content type</dt>
        <dd className="font-mono">application/json</dd>
        <dt className="text-muted">Secret</dt>
        <dd>{hasSecret ? 'The webhook secret above' : 'Generate a webhook secret above first'}</dd>
        <dt className="text-muted">Events</dt>
        <dd>Just the push event</dd>
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
  objects?: Array<{ kind: string; slug: string; outcome: string; version?: string }>
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
                    .map((o) => `${o.slug}: ${o.outcome}${o.version ? ` v${o.version}` : ''}`)
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
