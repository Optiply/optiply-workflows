import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { GitBranch, GitBranchMinus, KeyRound, Lock, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import {
  ProtectDialog,
  ProtectedBadge,
  UNPROTECT_SETTINGS_CONFIRM,
  useGitInfo,
  useUnprotectSettings,
} from '@/components/git'
import { SaveToBranchDialog } from '@/components/settings-git'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  ListSkeleton,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'

const appRoute = getRouteApi('/app')

type ConfigVar = RouterOutputs['configVars']['list'][number]

export function ConfigVarsPage() {
  const { me } = appRoute.useRouteContext()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: vars, isLoading, error } = useQuery(trpc.configVars.list.queryOptions())
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const [creating, setCreating] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.configVars.list.queryKey() })
  const remove = useMutation(trpc.configVars.delete.mutationOptions({ onSuccess: refresh }))

  if (isLoading) return <ListSkeleton header={false} rows={4} />
  if (!vars) return <ErrorNote error={error} />

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          Values that differ per environment, used as{' '}
          <code className="font-mono">{'{{ configVars.NAME }}'}</code>. Secret values are encrypted, never
          shown again, and not available in the query playground.
        </p>
        {me.isAdmin && (
          <Button variant="primary" onClick={() => setCreating(!creating)}>
            <Plus className="size-4" /> New variable
          </Button>
        )}
      </div>
      {creating && <CreateVar onDone={() => setCreating(false)} />}
      <ErrorNote error={remove.error} />
      {vars.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-6" />} title="No config variables yet">
          {me.isAdmin
            ? 'Create one to share a value across resources and workflows.'
            : 'Admins can add them.'}
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              {environments?.map((e) => (
                <Th key={e.id}>{e.name}</Th>
              ))}
              {me.isAdmin && <Th />}
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => (
              <tr key={v.id}>
                <Td>
                  <div className="flex items-center gap-2 font-mono font-medium">
                    {v.name} {v.isSecret && <Lock className="size-3.5 text-muted" />}
                    {v.gitProtected && <ProtectedBadge />}
                  </div>
                  {v.description && <div className="text-xs text-muted">{v.description}</div>}
                </Td>
                {environments?.map((e) => (
                  <Td key={e.id}>
                    <ValueCell variable={v} environmentId={e.id} editable={me.isAdmin} onSaved={refresh} />
                  </Td>
                ))}
                {me.isAdmin && (
                  <Td className="w-24">
                    <div className="flex justify-end">
                      <GitActions variable={v} />
                      {!v.gitProtected && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Delete variable"
                          onClick={async () => {
                            if (
                              await confirmDialog(`Delete ${v.name} in every environment?`, {
                                danger: true,
                                confirm: 'Delete',
                              })
                            )
                              remove.mutate({ id: v.id })
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}

function ValueCell({
  variable,
  environmentId,
  editable,
  onSaved,
}: {
  variable: ConfigVar
  environmentId: string
  editable: boolean
  onSaved: () => Promise<unknown>
}) {
  const trpc = useTRPC()
  const current = variable.values[environmentId]
  const [draft, setDraft] = useState<string | null>(null)
  // Protected and not secret (M22): the values are Git's; one set here only is a local value, kept by deploys.
  const fromGit = variable.gitProtected && !variable.isSecret
  const local = !!current && 'value' in current && !!current.local
  const [toBranch, setToBranch] = useState<{ value: string | null } | null>(null)
  const setValue = useMutation(
    trpc.configVars.setValue.mutationOptions({
      onSuccess: async () => {
        setDraft(null)
        await onSaved()
      },
    }),
  )
  const save = (value: string | null) =>
    setValue.mutate({
      configVarId: variable.id,
      environmentId,
      value,
      ...(fromGit && value !== null && { local: true }),
    })
  const branchDialog = toBranch && (
    <SaveToBranchDialog
      kind="config_var"
      object={{ id: variable.id, slug: variable.name }}
      edit={{ values: { [environmentId]: toBranch.value } }}
      onClose={() => {
        setToBranch(null)
        setDraft(null)
      }}
    />
  )

  if (draft !== null) {
    return (
      <div className="space-y-1">
        <div className="flex gap-1.5">
          <Input
            autoFocus
            type={variable.isSecret ? 'password' : 'text'}
            autoComplete="off"
            className="h-8 font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(draft)
              if (e.key === 'Escape') setDraft(null)
            }}
          />
          <Button size="sm" variant="primary" loading={setValue.isPending} onClick={() => save(draft)}>
            {fromGit ? 'Save here only' : 'Save'}
          </Button>
          {fromGit && (
            <Button size="sm" onClick={() => setToBranch({ value: draft })}>
              <GitBranch className="size-3.5" /> Save to branch…
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
        <ErrorNote error={setValue.error} />
        {branchDialog}
      </div>
    )
  }

  const display = !current ? (
    <span className="text-muted">Not set</span>
  ) : 'set' in current ? (
    <Badge>
      <KeyRound className="mr-1 size-3" /> Set
    </Badge>
  ) : (
    <span className="font-mono">{current.value}</span>
  )
  return (
    <div className="flex items-center gap-1.5">
      {display}
      {local && (
        <Badge tone="warning" title="Set on this instance only: deploys from Git keep it">
          local
        </Badge>
      )}
      {editable && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(current && 'value' in current ? current.value : '')}
          >
            {current ? (variable.isSecret ? 'Replace' : 'Edit') : 'Set'}
          </Button>
          {current &&
            (fromGit && !local ? (
              // Git's value: removed through a branch.
              <Button size="sm" variant="ghost" onClick={() => setToBranch({ value: null })}>
                Clear…
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                loading={setValue.isPending}
                title={local ? 'Back to Git’s value (from the next deploy)' : undefined}
                onClick={() => save(null)}
              >
                Clear
              </Button>
            ))}
        </>
      )}
      <ErrorNote error={setValue.error} />
      {branchDialog}
    </div>
  )
}

/** Protect (admins; M22): the description and non-secret values then come from Git; or Unprotect. */
function GitActions({ variable }: { variable: ConfigVar }) {
  const { data: git } = useGitInfo()
  const [protecting, setProtecting] = useState(false)
  const unprotect = useUnprotectSettings('config_var')
  if (!git?.configured && !variable.gitProtected) return null
  return (
    <>
      {variable.gitProtected ? (
        <Button
          size="icon"
          variant="ghost"
          title={`Unprotect ${variable.name}`}
          loading={unprotect.isPending}
          onClick={async () =>
            (await confirmDialog(UNPROTECT_SETTINGS_CONFIRM)) &&
            unprotect.mutate({ kind: 'config_var', id: variable.id })
          }
        >
          <GitBranchMinus className="size-4" />
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          title={`Protect ${variable.name} in Git`}
          onClick={() => setProtecting(true)}
        >
          <GitBranch className="size-4" />
        </Button>
      )}
      {protecting && (
        <ProtectDialog
          kind="config_var"
          object={{ id: variable.id, slug: variable.name, name: variable.name }}
          onClose={() => setProtecting(false)}
        />
      )}
    </>
  )
}

function CreateVar({ onDone }: { onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', description: '', isSecret: false })
  const create = useMutation(
    trpc.configVars.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.configVars.list.queryKey() })
        onDone()
      },
    }),
  )
  return (
    <Card className="space-y-4 p-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name" hint="Letters, digits and underscores, e.g. API_BASE_URL.">
          <Input
            autoFocus
            className="font-mono"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <Input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-accent"
          checked={form.isSecret}
          onChange={(e) => setForm({ ...form, isSecret: e.target.checked })}
        />
        Secret (encrypted, write-only; this can't be changed later)
      </label>
      <ErrorNote error={create.error} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!form.name}
          loading={create.isPending}
          onClick={() =>
            create.mutate({ name: form.name, description: form.description || null, isSecret: form.isSecret })
          }
        >
          Create
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}
