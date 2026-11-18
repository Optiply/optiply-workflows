import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Package, Plus } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '@/components/confirm'
import {
  Badge,
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

type PythonIndex = RouterOutputs['pythonIndexes']['list'][number]
type TestAnswer = RouterOutputs['pythonIndexes']['test']

/**
 * Package indexes for workflows' Python packages (M32, docs/architecture.md §2.35): admins define them, a workflow
 * picks one under Settings → Python packages. The password is a secret config var, read in the default environment.
 */
export function PythonSettingsPage() {
  return (
    <AdminOnly>
      <PythonIndexes />
    </AdminOnly>
  )
}

function PythonIndexes() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: indexes, isLoading, error } = useQuery(trpc.pythonIndexes.list.queryOptions())
  const [editing, setEditing] = useState<PythonIndex | 'new' | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.pythonIndexes.list.queryKey() })
  const remove = useMutation(trpc.pythonIndexes.delete.mutationOptions({ onSuccess: refresh }))

  if (isLoading) return <Spinner />
  if (!indexes) return <ErrorNote error={error} />

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          Package indexes workflows can install Python packages from, besides the builder's default (PyPI or
          its proxy). A workflow picks one in its Settings, under Python packages. Packages without a wheel
          are built from their source distribution, offline, in a sandbox.
        </p>
        <Button variant="primary" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
          <Plus className="size-4" /> New index
        </Button>
      </div>

      {editing && (
        <IndexForm
          key={editing === 'new' ? 'new' : editing.id}
          index={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null)
            refresh()
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <ErrorNote error={remove.error} />

      {indexes.length === 0 ? (
        <EmptyState icon={<Package className="size-6" />} title="No package indexes yet">
          Add one for a private index (Artifactory, CodeArtifact, devpi, GitLab's package registry) or a PyPI
          mirror.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Index</Th>
              <Th>URL</Th>
              <Th>Mode</Th>
              <Th>Sign-in</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {indexes.map((index) => (
              <tr key={index.id} data-testid={`python-index-${index.slug}`}>
                <Td>
                  <div className="font-medium">{index.name}</div>
                  <div className="font-mono text-xs text-muted">{index.slug}</div>
                </Td>
                <Td className="max-w-80 truncate font-mono text-xs">{index.url}</Td>
                <Td>
                  {index.mode === 'primary' ? (
                    <Badge tone="accent">Instead of the default</Badge>
                  ) : (
                    <Badge>With the default</Badge>
                  )}
                </Td>
                <Td className="text-xs">
                  {index.username ? (
                    <>
                      <div>{index.username}</div>
                      {index.passwordConfigVar && (
                        <div className="font-mono text-muted">{index.passwordConfigVar}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-muted">None</span>
                  )}
                </Td>
                <Td className="w-40 text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => setEditing(index)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (
                          await confirmDialog(`Delete the package index "${index.name}"?`, {
                            danger: true,
                            confirm: 'Delete',
                          })
                        ) {
                          remove.mutate({ id: index.id })
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

/** A slug from a name: lowercase letters, digits and dashes. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

function IndexForm({
  index,
  onDone,
  onCancel,
}: {
  index: PythonIndex | null
  onDone: () => void
  onCancel: () => void
}) {
  const trpc = useTRPC()
  const { data: configVars } = useQuery(trpc.configVars.list.queryOptions())
  const secrets = (configVars ?? []).filter((v) => v.isSecret)
  const [name, setName] = useState(index?.name ?? '')
  const [slug, setSlug] = useState(index?.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(false)
  const [url, setUrl] = useState(index?.url ?? '')
  const [mode, setMode] = useState<'primary' | 'extra'>(index?.mode ?? 'extra')
  const [username, setUsername] = useState(index?.username ?? '')
  const [passwordConfigVar, setPasswordConfigVar] = useState(index?.passwordConfigVar ?? '')
  const [testPackage, setTestPackage] = useState('')
  const [tested, setTested] = useState<(TestAnswer & { testPackage?: string }) | null>(null)
  const create = useMutation(trpc.pythonIndexes.create.mutationOptions({ onSuccess: onDone }))
  const update = useMutation(trpc.pythonIndexes.update.mutationOptions({ onSuccess: onDone }))
  const test = useMutation(
    trpc.pythonIndexes.test.mutationOptions({
      onSuccess: (answer, input) => setTested({ ...answer, testPackage: input.testPackage ?? undefined }),
    }),
  )
  const fields = {
    name: name.trim(),
    url: url.trim(),
    mode,
    username: username.trim() || null,
    passwordConfigVar: passwordConfigVar || null,
  }
  const effectiveSlug = index ? index.slug : slugTouched ? slug : slugify(name)

  return (
    <Card className="p-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (index) update.mutate({ id: index.id, ...fields })
          else create.mutate({ slug: effectiveSlug, ...fields })
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Private PyPI"
            />
          </Field>
          <Field
            label="Slug"
            hint={index ? 'Workflows name the index by it: it stays.' : 'Workflows name the index by it.'}
          >
            <Input
              className="font-mono"
              value={effectiveSlug}
              disabled={!!index}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value)
              }}
            />
          </Field>
        </div>
        <Field label="URL" hint="The simple index (PEP 503), without credentials.">
          <Input
            className="font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://pypi.example.com/simple"
          />
        </Field>
        <Field
          label="Mode"
          hint={
            mode === 'extra'
              ? 'Searched with the default index. If a public package has the same name as a private one and a higher version, pip takes it: pin private packages exactly (name==1.2.3).'
              : 'Replaces the default index for workflows that pick it: it must have every package they need (a proxy that mirrors PyPI does).'
          }
        >
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'primary' | 'extra')}
            aria-label="Mode"
          >
            <option value="extra">With the default index</option>
            <option value="primary">Instead of the default index</option>
          </Select>
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Username" hint="Optional (some indexes use __token__ with a token as the password).">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
          <Field
            label="Password"
            hint="A secret config var; its value in the default environment is used. It reaches only the package builder."
          >
            <Select
              value={passwordConfigVar}
              onChange={(e) => setPasswordConfigVar(e.target.value)}
              aria-label="Password config var"
            >
              <option value="">None</option>
              {secrets.map((v) => (
                <option key={v.id} value={v.name}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Package to test with"
          hint="Optional, not saved. Test looks for this package's page instead of the index's root: some indexes, Google's Artifact Registry among them, list nothing at their root."
        >
          <Input
            className="font-mono"
            value={testPackage}
            onChange={(e) => {
              setTestPackage(e.target.value)
              setTested(null)
            }}
            placeholder="my-package"
            autoComplete="off"
          />
        </Field>
        {tested && (
          <p
            className={tested.ok ? 'text-sm text-success-strong' : 'text-sm text-danger'}
            data-testid="python-index-test"
          >
            {tested.ok
              ? tested.testPackage
                ? `The index answered, took the sign-in and has ${tested.testPackage}.`
                : 'The index answered and took the sign-in.'
              : (tested.message ?? 'The index refused.')}
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
              test.mutate({
                ...fields,
                name: fields.name || 'test',
                testPackage: testPackage.trim() || null,
              })
            }}
          >
            Test
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending || update.isPending}
            disabled={!fields.name || !fields.url || !effectiveSlug}
          >
            {index ? 'Save' : 'Add index'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
