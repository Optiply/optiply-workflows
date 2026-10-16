import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, KeyRound, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { AuthRequiredNote } from '@/components/auth-required'
import { Badge, Button, Card, ErrorNote, Input, Select, Spinner } from '@/components/ui'
import { authRequired } from '@/lib/oauth'
import { TYPE_BADGES } from '@/lib/resource-types'
import { type RouterOutputs, useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

export type Level = 'use' | 'edit' | 'own'
export type KeyValue = { key: string; value: string }
/** A write-only secret edit: `undefined` keeps the stored value, `null` clears it, a string replaces it. */
export type SecretEdit = string | null | undefined

export const LEVEL_LABELS: Record<Level, string> = { use: 'Use', edit: 'Edit', own: 'Own' }
const RANK: Record<Level, number> = { use: 1, edit: 2, own: 3 }
export const atLeast = (level: Level | null | undefined, required: Level) =>
  !!level && RANK[level] >= RANK[required]

export function LevelBadge({ level }: { level: Level | null | undefined }) {
  if (!level) return <Badge>No access</Badge>
  return <Badge tone={level === 'own' ? 'accent' : 'neutral'}>{LEVEL_LABELS[level]}</Badge>
}

/**
 * A secret input that never shows the stored value: when one is set it offers Replace / Clear, and the edit is
 * sent as a patch on save.
 */
export function SecretField({
  isSet,
  edit,
  onChange,
  disabled,
  placeholder,
}: {
  isSet: boolean
  edit: SecretEdit
  onChange: (edit: SecretEdit) => void
  disabled?: boolean
  placeholder?: string
}) {
  if (edit === undefined && isSet) {
    return (
      <div className="flex h-9 items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <KeyRound className="size-4" /> Stored securely
        </span>
        {!disabled && (
          <>
            <Button size="sm" variant="ghost" onClick={() => onChange('')}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              Clear
            </Button>
          </>
        )}
      </div>
    )
  }
  if (edit === null) {
    return (
      <div className="flex h-9 items-center gap-2 text-sm text-danger">
        Will be removed when you save
        <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
          Undo
        </Button>
      </div>
    )
  }
  return (
    <div className="flex gap-2">
      <Input
        type="password"
        autoComplete="new-password"
        value={edit ?? ''}
        placeholder={placeholder ?? (isSet ? 'New value' : 'Not set')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {isSet && (
        <Button size="icon" variant="ghost" title="Keep the stored value" onClick={() => onChange(undefined)}>
          <X className="size-4" />
        </Button>
      )}
    </div>
  )
}

/** Rows of key/value inputs (headers, params, form fields). Values may contain {{ }} where the caller allows. */
export function KeyValueEditor({
  rows,
  onChange,
  disabled,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
}: {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
  disabled?: boolean
  keyPlaceholder?: string
  valuePlaceholder?: string
}) {
  const update = (i: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((row, j) => (i === j ? { ...row, ...patch } : row)))
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
        <div key={i} className="flex gap-2">
          <Input
            className="font-mono"
            value={row.key}
            placeholder={keyPlaceholder}
            disabled={disabled}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            className="font-mono"
            value={row.value}
            placeholder={valuePlaceholder}
            disabled={disabled}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          {!disabled && (
            <Button
              size="icon"
              variant="ghost"
              title="Remove"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      ))}
      {!disabled && (
        <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          <Plus className="size-4" /> Add
        </Button>
      )}
    </div>
  )
}

type ConnectorErrorView = { code: string; message: string; details: Record<string, unknown> | null }

/** A failed query or test. `onConnected` retries after the person connects an account the query needed. */
export function ConnectorErrorNote({
  error,
  onConnected,
}: {
  error: ConnectorErrorView
  onConnected?: () => void
}) {
  const need = authRequired(error)
  if (need) return <AuthRequiredNote need={need} message={error.message} onConnected={onConnected} />
  const { hint, ...rest } = error.details ?? {}
  const extra = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null))
  return (
    <div className="space-y-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2 text-danger">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div>
          <Badge tone="danger" className="mr-2 font-mono">
            {error.code}
          </Badge>
          {error.message}
        </div>
      </div>
      {typeof hint === 'string' && <p className="pl-6 text-ink">{hint}</p>}
      {Object.keys(extra).length > 0 && (
        <pre className="overflow-x-auto pl-6 font-mono text-xs text-muted">
          {JSON.stringify(extra, null, 2)}
        </pre>
      )}
    </div>
  )
}

const MAX_TABLE_ROWS = 500

const isRecordArray = (data: unknown): data is Record<string, unknown>[] =>
  Array.isArray(data) && data.length > 0 && data.every((r) => r && typeof r === 'object' && !Array.isArray(r))

/** Arrays of objects as a table, anything else as JSON. */
export function ResultView({ data }: { data: unknown }) {
  const [asJson, setAsJson] = useState(false)
  if (!isRecordArray(data) || asJson) {
    return (
      <div className="space-y-2">
        {isRecordArray(data) && (
          <Button size="sm" variant="ghost" onClick={() => setAsJson(false)}>
            Show as table
          </Button>
        )}
        <pre className="max-h-[32rem] overflow-auto rounded-md bg-canvas p-3 font-mono text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    )
  }
  const columns = [...new Set(data.slice(0, 100).flatMap((row) => Object.keys(row)))]
  return (
    <div className="space-y-2">
      <Button size="sm" variant="ghost" onClick={() => setAsJson(true)}>
        Show as JSON
      </Button>
      <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
        <table className="w-full text-left font-mono text-xs">
          <thead className="sticky top-0 bg-canvas">
            <tr>
              {columns.map((c) => (
                <th key={c} className="border-b border-border px-3 py-2 font-medium text-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.slice(0, MAX_TABLE_ROWS).map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no stable id
              <tr key={i} className="odd:bg-surface even:bg-canvas/50">
                {columns.map((c) => (
                  <td key={c} className="max-w-xs truncate border-b border-border px-3 py-1.5">
                    <Cell value={row[c]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.length > MAX_TABLE_ROWS && (
        <p className="text-xs text-muted">
          Showing the first {MAX_TABLE_ROWS} of {data.length} rows.
        </p>
      )}
    </div>
  )
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">null</span>
  if (typeof value === 'object') return <>{JSON.stringify(value)}</>
  return <>{String(value)}</>
}

type Target = { objectType: 'resource' | 'folder' | 'app'; objectId: string | null }

/**
 * Group grants on one target (a resource, a folder, an app, or all of a type), per environment or for all of them.
 * Apps have no per-environment grants: their access applies everywhere.
 */
export function AccessEditor({
  target,
  help = 'Use runs queries · Edit also changes settings · Own also deletes and manages access. The highest grant wins.',
}: {
  target: Target
  help?: string
}) {
  const perEnvironment = target.objectType !== 'app'
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: grants, isLoading, error } = useQuery(trpc.permissions.list.queryOptions(target))
  const { data: groups } = useQuery(trpc.groups.list.queryOptions())
  const { data: environments } = useQuery(trpc.environments.list.queryOptions())
  const [draft, setDraft] = useState({ groupId: '', environmentId: '', level: 'use' as Level })

  const set = useMutation(
    trpc.permissions.set.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.permissions.list.queryKey(target) }),
          queryClient.invalidateQueries({ queryKey: trpc.resources.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.apps.list.queryKey() }),
        ]),
    }),
  )
  const envName = (id: string | null) =>
    id === null ? 'All environments' : (environments?.find((e) => e.id === id)?.name ?? id)

  if (isLoading) return <Spinner />
  if (error) return <ErrorNote error={error} />

  return (
    <div className="space-y-3">
      <ErrorNote error={set.error} />
      <Card className="divide-y divide-border">
        {grants?.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No grants yet.</p>}
        {grants?.map((g) => (
          <div key={g.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="flex-1 font-medium">{g.groupName}</span>
            {perEnvironment && <span className="w-40 text-muted">{envName(g.environmentId)}</span>}
            <Select
              value={g.level}
              onChange={(e) =>
                set.mutate({
                  ...target,
                  groupId: g.groupId,
                  environmentId: g.environmentId,
                  level: e.target.value as Level,
                })
              }
            >
              {(['use', 'edit', 'own'] as const).map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                </option>
              ))}
            </Select>
            <Button
              size="icon"
              variant="ghost"
              title="Remove"
              onClick={() =>
                set.mutate({ ...target, groupId: g.groupId, environmentId: g.environmentId, level: null })
              }
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Group"
          value={draft.groupId}
          onChange={(e) => setDraft({ ...draft, groupId: e.target.value })}
        >
          <option value="">Choose a group…</option>
          {groups?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        {perEnvironment && (
          <Select
            aria-label="Environment"
            value={draft.environmentId}
            onChange={(e) => setDraft({ ...draft, environmentId: e.target.value })}
          >
            <option value="">All environments</option>
            {environments?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Level"
          value={draft.level}
          onChange={(e) => setDraft({ ...draft, level: e.target.value as Level })}
        >
          {(['use', 'edit', 'own'] as const).map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABELS[l]}
            </option>
          ))}
        </Select>
        <Button
          variant="primary"
          disabled={!draft.groupId}
          loading={set.isPending}
          onClick={() =>
            set.mutate(
              {
                ...target,
                groupId: draft.groupId,
                environmentId: draft.environmentId || null,
                level: draft.level,
              },
              { onSuccess: () => setDraft({ ...draft, groupId: '' }) },
            )
          }
        >
          Grant
        </Button>
      </div>
      <p className="text-xs text-muted">{help}</p>
    </div>
  )
}

export type ResourceDetail = RouterOutputs['resources']['get']
export type ResourceSummary = RouterOutputs['resources']['list']['resources'][number]

export function TypeIcon({ type, className }: { type: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold',
        (TYPE_BADGES[type] ?? TYPE_BADGES.rest)!.className,
        className,
      )}
    >
      {(TYPE_BADGES[type] ?? TYPE_BADGES.rest)!.label}
    </span>
  )
}
