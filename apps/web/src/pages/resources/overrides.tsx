import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, ErrorNote, Input, Select } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import type { ResourceDetail } from './shared'

type Config = Record<string, unknown>

/** A setting's path the server takes: names joined by dots (`host`, `ssh.host`), up to 8 deep. */
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/

/** Every setting in Git's config by path: values, and lists as a whole (a path can't reach into a list). */
export function settingPaths(config: Config, prefix = '', depth = 0): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 7) {
      return settingPaths(value as Config, path, depth + 1)
    }
    return [path]
  })
}

export function valueAt(config: Config, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v as Config | undefined)?.[k], config)
}

/** How a value is typed in: as Git's value at the path is, JSON for lists, objects and anything unknown. */
type Kind = 'string' | 'number' | 'boolean' | 'json'
const kindOf = (value: unknown): Kind =>
  typeof value === 'string'
    ? 'string'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'boolean'
        : 'json'

const toText = (value: unknown, kind: Kind) =>
  kind === 'string'
    ? String(value ?? '')
    : kind === 'json'
      ? JSON.stringify(value ?? null)
      : String(value ?? '')

function parse(text: string, kind: Kind): { value: unknown } | { error: string } {
  if (kind === 'string') return { value: text }
  if (kind === 'boolean') return { value: text === 'true' }
  if (kind === 'number') {
    const n = Number(text)
    return text.trim() === '' || Number.isNaN(n) ? { error: 'Expected a number' } : { value: n }
  }
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { error: 'Expected JSON, such as ["a", "b"] or {"key": 1}' }
  }
}

type Row = { path: string; text: string }

/**
 * Overrides on this instance (M22): single non-secret settings of a protected resource set here, over Git's, in one
 * environment. Deploys leave them; the server checks each against the resource's settings.
 */
export function OverridesCard({
  resource,
  environmentId,
  canEdit,
}: {
  resource: ResourceDetail
  environmentId: string
  canEdit: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const stored = resource.environments.find((e) => e.environmentId === environmentId)
  const git = (stored?.config ?? {}) as Config
  const saved = (stored?.overrides ?? {}) as Config
  const rowsOf = (overrides: Config): Row[] =>
    Object.entries(overrides).map(([path, value]) => ({
      path,
      text: toText(value, kindOf(valueAt(git, path) ?? value)),
    }))
  const [rows, setRows] = useState<Row[]>(() => rowsOf(saved))
  const [adding, setAdding] = useState('')
  const save = useMutation(
    trpc.resources.setOverrides.mutationOptions({
      onSuccess: (result) => {
        setRows(rowsOf(result.overrides as Config))
        return queryClient.invalidateQueries({ queryKey: trpc.resources.get.queryKey({ id: resource.id }) })
      },
    }),
  )
  const paths = settingPaths(git).filter((p) => !rows.some((r) => r.path === p))
  const parsed = rows.map((r) => ({ ...r, result: parse(r.text, kindOf(valueAt(git, r.path))) }))
  const invalid = parsed.some((r) => 'error' in r.result)
  const overrides = Object.fromEntries(
    parsed.flatMap((r) => ('value' in r.result ? [[r.path, r.result.value]] : [])),
  )
  const dirty = JSON.stringify(overrides) !== JSON.stringify(saved)
  const add = () => {
    const path = adding.trim()
    if (!PATH.test(path) || rows.some((r) => r.path === path)) return
    setRows([...rows, { path, text: toText(valueAt(git, path), kindOf(valueAt(git, path))) }])
    setAdding('')
  }

  return (
    <Card className="space-y-4 p-5" data-testid="overrides">
      <div>
        <h2 className="font-semibold">
          Overrides on this instance <Badge className="ml-1">this environment</Badge>
        </h2>
        <p className="mt-1 text-sm text-muted">
          Single settings this instance sets over Git’s, such as a host only it reaches. Deploys from Git keep
          them.
        </p>
      </div>
      {parsed.length > 0 && (
        <ul className="space-y-2">
          {parsed.map((row, i) => {
            const kind = kindOf(valueAt(git, row.path))
            const set = (text: string) => setRows(rows.map((r, j) => (j === i ? { ...r, text } : r)))
            return (
              <li key={row.path} className="grid grid-cols-[12rem_1fr_auto] items-start gap-2">
                <div className="pt-1.5 font-mono text-sm">{row.path}</div>
                <div className="space-y-1">
                  {kind === 'boolean' ? (
                    <Select
                      aria-label={`Override of ${row.path}`}
                      value={row.text}
                      disabled={!canEdit}
                      onChange={(e) => set(e.target.value)}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <Input
                      aria-label={`Override of ${row.path}`}
                      className={kind === 'json' ? 'font-mono' : undefined}
                      value={row.text}
                      disabled={!canEdit}
                      onChange={(e) => set(e.target.value)}
                    />
                  )}
                  <p className="text-xs text-muted">
                    Git: <span className="font-mono">{JSON.stringify(valueAt(git, row.path) ?? null)}</span>
                    {'error' in row.result && <span className="ml-2 text-danger">{row.result.error}</span>}
                  </p>
                </div>
                {canEdit && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title={`Remove the override of ${row.path}`}
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {canEdit && (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Setting to override"
            className="w-64 font-mono"
            placeholder="host, ssh.host…"
            list={`override-paths-${environmentId}`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <datalist id={`override-paths-${environmentId}`}>
            {paths.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <Button disabled={!PATH.test(adding.trim())} onClick={add}>
            <Plus className="size-4" /> Override
          </Button>
          <Button
            variant="primary"
            className="ml-auto"
            disabled={!dirty || invalid}
            loading={save.isPending}
            onClick={() => save.mutate({ resourceId: resource.id, environmentId, overrides })}
          >
            Save overrides
          </Button>
        </div>
      )}
      <ErrorNote error={save.error} />
      {save.isSuccess && !dirty && <p className="text-sm text-success">Saved.</p>}
    </Card>
  )
}
