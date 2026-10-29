import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { FileDiff } from '@/components/git-bar'
import { Badge, type BadgeTone, Button, Dialog, ErrorNote, Field, Select, Spinner } from '@/components/ui'
import {
  compareDefinitions,
  type DefinitionKind,
  type DiffItem,
  diffSummary,
  type FieldChange,
  groupDiff,
} from '@/lib/definition-diff'
import { showValue } from '@/lib/merge-choices'
import { cn } from '@/lib/utils'

/** A release as the Releases lists have it. */
export interface CompareRelease {
  id: string
  version: string
  live: boolean
}

/** A side of the comparison: the draft, or a release by id. */
type Side = 'draft' | string

const STATUS: Record<DiffItem['status'], { label: string; tone: BadgeTone }> = {
  added: { label: 'Added', tone: 'success' },
  removed: { label: 'Removed', tone: 'danger' },
  changed: { label: 'Changed', tone: 'accent' },
  renamed: { label: 'Renamed', tone: 'warning' },
}

/**
 * Compare (M24): what changed between two releases, or a release and the draft. Opened from a release, it compares
 * it with the one before it (with the draft, for the first release); both sides can be changed.
 */
export function CompareReleasesDialog({
  kind,
  objectId,
  releases,
  releaseId,
  draft,
  loadRelease,
  onClose,
}: {
  kind: DefinitionKind
  objectId: string
  /** Newest first, as the lists have them. */
  releases: readonly CompareRelease[]
  releaseId: string
  /** The draft's definition as the editor has it now. */
  draft: unknown
  loadRelease: (id: string) => Promise<{ definition: unknown }>
  onClose: () => void
}) {
  const at = releases.findIndex((r) => r.id === releaseId)
  const older = releases[at + 1]
  const [from, setFrom] = useState<Side>(older ? older.id : releaseId)
  const [to, setTo] = useState<Side>(older ? releaseId : 'draft')
  // Releases never change: each is fetched once.
  const side = (id: Side) => ({
    queryKey: ['release-definition', kind, objectId, id],
    queryFn: () => loadRelease(id),
    enabled: id !== 'draft',
    staleTime: Number.POSITIVE_INFINITY,
  })
  const before = useQuery(side(from))
  const after = useQuery(side(to))
  const beforeDef = from === 'draft' ? draft : before.data?.definition
  const afterDef = to === 'draft' ? draft : after.data?.definition
  const groups = useMemo(
    () =>
      beforeDef !== undefined && afterDef !== undefined
        ? groupDiff(kind, compareDefinitions(kind, beforeDef, afterDef))
        : null,
    [kind, beforeDef, afterDef],
  )
  const options = (
    <>
      <option value="draft">Draft</option>
      {releases.map((r) => (
        <option key={r.id} value={r.id}>
          v{r.version}
          {r.live ? ' (live)' : ''}
        </option>
      ))}
    </>
  )
  const summary = groups && diffSummary(groups)
  return (
    <Dialog title="Compare" onClose={onClose} className="max-w-4xl">
      <div className="flex items-end gap-2">
        <Field label="From" className="flex-1">
          <Select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From">
            {options}
          </Select>
        </Field>
        <Button
          size="icon"
          variant="ghost"
          title="Swap"
          onClick={() => {
            setFrom(to)
            setTo(from)
          }}
        >
          <ArrowLeftRight className="size-4" />
        </Button>
        <Field label="To" className="flex-1">
          <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To">
            {options}
          </Select>
        </Field>
      </div>
      <ErrorNote error={before.error ?? after.error} />
      <div className="mt-4" data-testid="compare">
        {!groups ? (
          <Spinner />
        ) : groups.length === 0 ? (
          <p className="text-muted">Nothing changed.</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">
              {(['changed', 'renamed', 'added', 'removed'] as const)
                .filter((s) => summary?.[s])
                .map((s) => `${summary?.[s]} ${s}`)
                .join(' · ')}
            </p>
            <div className="flex flex-col gap-4">
              {groups.map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <h3 className="mb-1.5 text-xs font-semibold text-muted">
                    {g.label}
                    {g.reordered && <span className="font-normal"> · order changed</span>}
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {g.items.map((item) => (
                      <ItemDiff key={item.key} item={item} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}

function ItemDiff({ item }: { item: DiffItem }) {
  const status = STATUS[item.status]
  const detail = item.value !== undefined || item.changes.length > 0
  const head = (
    <span className="flex min-w-0 items-center gap-2">
      <Badge tone={status.tone}>{status.label}</Badge>
      <span className="truncate font-mono text-xs">
        {item.renamedFrom && <span className="text-muted">{item.renamedFrom} → </span>}
        {item.name}
      </span>
    </span>
  )
  if (!detail) return <li className="rounded-md border border-border px-3 py-2">{head}</li>
  return (
    <li className="rounded-md border border-border">
      <details open={item.status === 'changed' || item.status === 'renamed'}>
        <summary className="cursor-pointer px-3 py-2">{head}</summary>
        {item.value !== undefined ? (
          <ValueBlock value={item.value} tone={item.status === 'added' ? 'added' : 'removed'} />
        ) : (
          item.changes.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an item's changes have no identity but their place
            <ChangeView key={i} field={c} />
          ))
        )}
      </details>
    </li>
  )
}

function ChangeView({ field }: { field: FieldChange }) {
  const { change } = field
  return (
    <div className="border-t border-border">
      {field.label && <p className="px-3 pt-1.5 font-mono text-xs text-muted">{field.label}</p>}
      {change.kind === 'text' ? (
        <FileDiff before={change.before} after={change.after} />
      ) : change.kind === 'added' ? (
        <ValueBlock value={change.after} tone="added" />
      ) : change.kind === 'removed' ? (
        <ValueBlock value={change.before} tone="removed" />
      ) : change.kind === 'order' ? (
        <p className="px-3 py-1.5 text-xs">Order: {change.after.join(', ')}</p>
      ) : typeof change.before === 'string' && typeof change.after === 'string' ? (
        <FileDiff before={change.before} after={change.after} />
      ) : (
        <FileDiff before={showValue(change.before)} after={showValue(change.after)} />
      )}
    </div>
  )
}

function ValueBlock({ value, tone }: { value: unknown; tone: 'added' | 'removed' }) {
  return (
    <pre
      className={cn(
        'max-h-72 overflow-auto px-3 py-1.5 font-mono text-xs whitespace-pre-wrap',
        tone === 'added' ? 'bg-success/10' : 'bg-danger/10',
      )}
    >
      {showValue(value)}
    </pre>
  )
}
