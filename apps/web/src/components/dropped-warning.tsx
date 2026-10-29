import { AlertTriangle } from 'lucide-react'

/** What a publish would drop for those following on `latest` (`publishImpact`, M21). */
export interface DroppedImpact {
  dropped: string[]
  uses: { kind: 'app' | 'module' | 'workflow'; id: string; slug: string; name: string; passes: string[] }[]
  hidden: number
}

/**
 * The publish dialog's warning (M21): this release drops parameters (or inputs) that apps, modules or workflows
 * following the latest release still pass. Publishing goes ahead if wanted; they then pass a name nothing reads.
 */
export function DroppedWarning({
  impact,
  what,
}: {
  impact: DroppedImpact | undefined
  what: 'parameter' | 'input' | 'component or prop'
}) {
  if (!impact || (!impact.uses.length && !impact.hidden)) return null
  const names = impact.dropped.map((n) => `“${n}”`).join(', ')
  return (
    <div
      className="flex gap-2 rounded-md border border-warning-strong/40 bg-op-yellow-1 p-3 text-sm"
      data-testid="publish-dropped"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-strong" />
      <div className="flex flex-col gap-1">
        <p>
          This release no longer has the {what}
          {impact.dropped.length === 1 ? '' : 's'} {names}, which these pass while following the latest
          release:
        </p>
        <ul className="list-disc pl-4">
          {impact.uses.map((u) => (
            <li key={`${u.kind}:${u.id}`}>
              {u.kind} <strong>{u.name}</strong> passes {u.passes.map((p) => `“${p}”`).join(', ')}
            </li>
          ))}
          {impact.hidden > 0 && <li>and {impact.hidden} more you can’t see</li>}
        </ul>
        <p className="text-xs text-muted">
          Update them, or publish anyway: what they pass for it is then ignored.
        </p>
      </div>
    </div>
  )
}
