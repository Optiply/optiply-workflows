import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { KeyRound, Lock, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
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

  if (isLoading) return <Spinner />
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
                  </div>
                  {v.description && <div className="text-xs text-muted">{v.description}</div>}
                </Td>
                {environments?.map((e) => (
                  <Td key={e.id}>
                    <ValueCell variable={v} environmentId={e.id} editable={me.isAdmin} onSaved={refresh} />
                  </Td>
                ))}
                {me.isAdmin && (
                  <Td className="w-10">
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Delete variable"
                      onClick={() => {
                        if (confirm(`Delete ${v.name} in every environment?`)) remove.mutate({ id: v.id })
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
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
  const setValue = useMutation(
    trpc.configVars.setValue.mutationOptions({
      onSuccess: async () => {
        setDraft(null)
        await onSaved()
      },
    }),
  )
  const save = (value: string | null) => setValue.mutate({ configVarId: variable.id, environmentId, value })

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
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
        <ErrorNote error={setValue.error} />
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
      {editable && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(current && 'value' in current ? current.value : '')}
          >
            {current ? (variable.isSecret ? 'Replace' : 'Edit') : 'Set'}
          </Button>
          {current && (
            <Button size="sm" variant="ghost" loading={setValue.isPending} onClick={() => save(null)}>
              Clear
            </Button>
          )}
        </>
      )}
    </div>
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
