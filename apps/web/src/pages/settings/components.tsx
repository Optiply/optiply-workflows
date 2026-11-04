import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Package, Plus } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { AdminOnly } from './layout'

type NpmRegistry = RouterOutputs['npmRegistries']['list'][number]
type TestAnswer = RouterOutputs['npmRegistries']['test']

/**
 * npm registries for component libraries' builds (M33, docs/architecture.md §2.36): one per scope (`@acme`), or one
 * for every other package instead of the server's default. The token is a secret config var, read in the default
 * environment; it reaches only npm, in the build's own `.npmrc`.
 */
export function ComponentsSettingsPage() {
  return (
    <AdminOnly>
      <Registries />
    </AdminOnly>
  )
}

function Registries() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: registries, isLoading, error } = useQuery(trpc.npmRegistries.list.queryOptions())
  const [editing, setEditing] = useState<NpmRegistry | 'new' | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.npmRegistries.list.queryKey() })
  const remove = useMutation(trpc.npmRegistries.delete.mutationOptions({ onSuccess: refresh }))

  if (isLoading) return <Spinner />
  if (!registries) return <ErrorNote error={error} />

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          npm registries component libraries install their packages from. A registry for a scope serves that
          scope’s packages (<code className="font-mono">@acme/…</code>); one without a scope serves every
          other package instead of the default. Libraries need nothing: their{' '}
          <code className="font-mono">package.json</code> names the packages.
        </p>
        <Button variant="primary" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
          <Plus className="size-4" /> New registry
        </Button>
      </div>

      {editing && (
        <RegistryForm
          key={editing === 'new' ? 'new' : editing.id}
          registry={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null)
            refresh()
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <ErrorNote error={remove.error} />

      {registries.length === 0 ? (
        <EmptyState icon={<Package className="size-6" />} title="No npm registries yet">
          Every package comes from the default registry. Add one for your private packages (GitHub Packages,
          GitLab, Artifactory, Verdaccio).
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Scope</Th>
              <Th>URL</Th>
              <Th>Token</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {registries.map((r) => (
              <tr key={r.id} data-testid={`npm-registry-${r.scope ?? 'default'}`}>
                <Td className="font-mono text-sm">
                  {r.scope ?? <span className="text-muted">Every other package</span>}
                </Td>
                <Td className="max-w-96 truncate font-mono text-xs">{r.url}</Td>
                <Td className="font-mono text-xs">
                  {r.tokenConfigVar ?? <span className="font-sans text-muted">None</span>}
                </Td>
                <Td className="w-40 text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (
                          await confirmDialog(
                            `Delete the registry for ${r.scope ?? 'every other package'}?`,
                            {
                              danger: true,
                              confirm: 'Delete',
                            },
                          )
                        ) {
                          remove.mutate({ id: r.id })
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}

function RegistryForm({
  registry,
  onDone,
  onCancel,
}: {
  registry: NpmRegistry | null
  onDone: () => void
  onCancel: () => void
}) {
  const trpc = useTRPC()
  const { data: configVars } = useQuery(trpc.configVars.list.queryOptions())
  const secrets = (configVars ?? []).filter((v) => v.isSecret)
  const [scope, setScope] = useState(registry?.scope ?? '')
  const [url, setUrl] = useState(registry?.url ?? '')
  const [tokenConfigVar, setTokenConfigVar] = useState(registry?.tokenConfigVar ?? '')
  const [tested, setTested] = useState<TestAnswer | null>(null)
  const create = useMutation(trpc.npmRegistries.create.mutationOptions({ onSuccess: onDone }))
  const update = useMutation(trpc.npmRegistries.update.mutationOptions({ onSuccess: onDone }))
  const test = useMutation(trpc.npmRegistries.test.mutationOptions({ onSuccess: setTested }))
  const fields = { scope: scope.trim() || null, url: url.trim(), tokenConfigVar: tokenConfigVar || null }

  return (
    <Card className="p-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (registry) update.mutate({ id: registry.id, ...fields })
          else create.mutate(fields)
        }}
      >
        <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
          <Field label="Scope" hint="Empty: every package without a registry of its own.">
            <Input
              className="font-mono"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="@acme"
            />
          </Field>
          <Field label="URL">
            <Input
              className="font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://npm.pkg.github.com/"
            />
          </Field>
        </div>
        <Field
          label="Token"
          hint="A secret config var; its value in the default environment is used, only by npm during builds."
        >
          <Select
            className="max-w-sm"
            aria-label="Token config var"
            value={tokenConfigVar}
            onChange={(e) => setTokenConfigVar(e.target.value)}
          >
            <option value="">None</option>
            {secrets.map((v) => (
              <option key={v.id} value={v.name}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        {tested && (
          <p
            className={tested.ok ? 'text-sm text-success-strong' : 'text-sm text-danger'}
            data-testid="npm-registry-test"
          >
            {tested.ok
              ? `The registry answered${tested.username ? `: signed in as ${tested.username}` : ''}.`
              : tested.message}
          </p>
        )}
        <ErrorNote error={create.error ?? update.error ?? test.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={test.isPending}
            disabled={!fields.url}
            onClick={() => {
              setTested(null)
              test.mutate(fields)
            }}
          >
            Test
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending || update.isPending}
            disabled={!fields.url}
          >
            {registry ? 'Save' : 'Add registry'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
