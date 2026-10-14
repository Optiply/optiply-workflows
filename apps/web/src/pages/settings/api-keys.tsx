import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { AdminOnly } from './layout'

type ApiKey = RouterOutputs['apiKeys']['list'][number]

/** Keys other systems use to call webhooks. Admins only; a key is shown once, when it's created. */
export function ApiKeysPage() {
  return (
    <AdminOnly>
      <ApiKeys />
    </AdminOnly>
  )
}

function ApiKeys() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: keys, isLoading, error } = useQuery(trpc.apiKeys.list.queryOptions())
  const { data: workflows } = useQuery(trpc.workflows.list.queryOptions())
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() })
  const revoke = useMutation(trpc.apiKeys.revoke.mutationOptions({ onSuccess: refresh }))

  if (isLoading) return <Spinner />
  if (!keys) return <ErrorNote error={error} />

  const workflowName = (id: string) => workflows?.find((w) => w.id === id)?.name ?? 'deleted workflow'
  const environmentName = (id: string) =>
    environments?.find((e) => e.id === id)?.name ?? 'deleted environment'

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          Other systems send a key in the <code className="font-mono">X-Api-Key</code> header to call workflow
          webhooks, and can then read the runs they started. Limit a key to the workflows and environments it
          needs.
        </p>
        <Button variant="primary" onClick={() => setCreating(!creating)}>
          <Plus className="size-4" /> New API key
        </Button>
      </div>

      {created && <NewKey created={created} onDismiss={() => setCreated(null)} />}
      {creating && (
        <CreateKey
          workflows={workflows ?? []}
          environments={environments ?? []}
          onCreated={(key) => {
            setCreating(false)
            setCreated(key)
            refresh()
          }}
        />
      )}
      <ErrorNote error={revoke.error} />

      {keys.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-6" />} title="No API keys yet">
          Create one to let another system call a webhook.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Can call</Th>
              <Th>Last used</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} data-testid={`api-key-${k.name}`}>
                <Td>
                  <div className="font-medium">{k.name}</div>
                  <div className="font-mono text-xs text-muted">{k.prefix}…</div>
                </Td>
                <Td className="text-xs">
                  <div>{k.workflowIds ? k.workflowIds.map(workflowName).join(', ') : 'All workflows'}</div>
                  <div className="text-muted">
                    {k.environmentIds ? k.environmentIds.map(environmentName).join(', ') : 'All environments'}
                  </div>
                </Td>
                <Td className="text-xs text-muted">
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}
                </Td>
                <Td>
                  <KeyStatus apiKey={k} />
                </Td>
                <Td className="w-24 text-right">
                  {!k.revokedAt && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        if (confirm(`Revoke "${k.name}"? Calls with it stop working at once.`)) {
                          revoke.mutate({ id: k.id })
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}

function KeyStatus({ apiKey }: { apiKey: ApiKey }) {
  if (apiKey.revokedAt) return <Badge tone="danger">Revoked</Badge>
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) <= new Date()) return <Badge>Expired</Badge>
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone="success">Active</Badge>
      {apiKey.expiresAt && (
        <span className="text-xs text-muted">until {new Date(apiKey.expiresAt).toLocaleDateString()}</span>
      )}
    </span>
  )
}

/** The key, once: it's stored only as a hash. */
function NewKey({ created, onDismiss }: { created: { name: string; key: string }; onDismiss: () => void }) {
  return (
    <Card className="border-accent/40 bg-accent-soft/30 p-4" data-testid="new-api-key">
      <div className="mb-2 font-medium">
        “{created.name}” is ready. Copy the key now: it won’t be shown again.
      </div>
      <div className="flex items-center gap-1 rounded-md border border-border bg-surface pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-sm" data-testid="new-api-key-value">
          {created.key}
        </code>
        <CopyButton text={created.key} label="Copy key" />
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={onDismiss}>
          I’ve copied it
        </Button>
      </div>
    </Card>
  )
}

function CreateKey({
  workflows,
  environments,
  onCreated,
}: {
  workflows: { id: string; name: string; slug: string }[]
  environments: { id: string; name: string }[]
  onCreated: (created: { name: string; key: string }) => void
}) {
  const trpc = useTRPC()
  const [name, setName] = useState('')
  const [allWorkflows, setAllWorkflows] = useState(true)
  const [workflowIds, setWorkflowIds] = useState<string[]>([])
  const [allEnvironments, setAllEnvironments] = useState(true)
  const [environmentIds, setEnvironmentIds] = useState<string[]>([])
  const [expires, setExpires] = useState('')
  const create = useMutation(trpc.apiKeys.create.mutationOptions())
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id)
  const incomplete =
    !name.trim() || (!allWorkflows && !workflowIds.length) || (!allEnvironments && !environmentIds.length)

  return (
    <Card className="p-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate(
            {
              name,
              workflowIds: allWorkflows ? null : workflowIds,
              environmentIds: allEnvironments ? null : environmentIds,
              expiresAt: expires ? new Date(`${expires}T23:59:59`) : null,
            },
            { onSuccess: (key) => onCreated({ name: key.name, key: key.key }) },
          )
        }}
      >
        <Field label="Name" hint="Who or what uses it, e.g. Shopify order sync.">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Workflows</span>
            <Checkbox
              label="All workflows"
              checked={allWorkflows}
              onChange={(e) => setAllWorkflows(e.target.checked)}
            />
            {!allWorkflows && (
              <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto rounded-md border border-border p-2">
                {workflows.map((w) => (
                  <Checkbox
                    key={w.id}
                    label={
                      <>
                        {w.name} <span className="font-mono text-xs text-muted">{w.slug}</span>
                      </>
                    }
                    checked={workflowIds.includes(w.id)}
                    onChange={(e) => setWorkflowIds(toggle(workflowIds, w.id, e.target.checked))}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Environments</span>
            <Checkbox
              label="All environments"
              checked={allEnvironments}
              onChange={(e) => setAllEnvironments(e.target.checked)}
            />
            {!allEnvironments &&
              environments.map((env) => (
                <Checkbox
                  key={env.id}
                  label={env.name}
                  checked={environmentIds.includes(env.id)}
                  onChange={(e) => setEnvironmentIds(toggle(environmentIds, env.id, e.target.checked))}
                />
              ))}
          </div>
        </div>
        <Field label="Expires" hint="Optional; the key stops working after this day.">
          <Input type="date" className="w-44" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <ErrorNote error={create.error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={incomplete}>
            Create key
          </Button>
        </div>
      </form>
    </Card>
  )
}
