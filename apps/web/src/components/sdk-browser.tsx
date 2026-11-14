import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Input } from '@/components/ui'
import { useTRPC } from '@/lib/trpc'

// Browse the SDK (M37): an SDK resource's client described by the runner (its methods and their signatures, its
// values), filterable; picking a method fills in a "Call a method" query.

interface Member {
  path: string
  kind: 'method' | 'value'
  signature?: string
  doc?: string
  type?: string
}

export function SdkBrowser({
  lookup,
  onPick,
}: {
  lookup: { resourceId: string; environmentId: string }
  onPick: (method: string) => void
}) {
  const trpc = useTRPC()
  const describe = useMutation(trpc.resources.run.mutationOptions())
  const [filter, setFilter] = useState('')
  const result = describe.data as
    | { ok: true; data: { type?: string; members?: Member[] } }
    | { ok: false; error: { message: string } }
    | undefined
  const members = result?.ok ? (result.data.members ?? []) : []
  const shown = members.filter((m) => m.path.toLowerCase().includes(filter.toLowerCase())).slice(0, 200)
  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="sdk-browser">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Browse the SDK</p>
          <p className="text-xs text-muted">
            What the client offers, from the setup code (it runs once to look).
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={describe.isPending}
          data-testid="sdk-describe"
          onClick={() =>
            describe.mutate({ ...lookup, query: { action: 'describe' }, scope: {} } as Parameters<
              typeof describe.mutate
            >[0])
          }
        >
          {describe.isPending ? 'Looking…' : result ? 'Look again' : 'Describe the client'}
        </Button>
      </div>
      {describe.error && <p className="text-xs text-danger">{describe.error.message}</p>}
      {result && !result.ok && (
        <p className="text-xs text-danger" data-testid="sdk-describe-error">
          {result.error.message}
        </p>
      )}
      {result?.ok && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">
              {result.data.type ?? 'The client'}: {members.length} members
            </span>
            <Input
              className="h-7 flex-1 text-xs"
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <ul className="max-h-64 space-y-0.5 overflow-auto font-mono text-xs">
            {shown.map((m) => (
              <li key={m.path}>
                {m.kind === 'method' ? (
                  <button
                    type="button"
                    className="w-full rounded px-1.5 py-1 text-left hover:bg-canvas"
                    title={m.doc || 'Call it'}
                    data-testid={`sdk-member-${m.path}`}
                    onClick={() => onPick(m.path)}
                  >
                    <span className="text-ink">{m.path}</span>
                    <span className="text-muted">{m.signature}</span>
                    {m.doc && <span className="ml-2 font-sans text-faint">{m.doc}</span>}
                  </button>
                ) : (
                  <span className="block px-1.5 py-1 text-muted">
                    {m.path}: {m.type}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
