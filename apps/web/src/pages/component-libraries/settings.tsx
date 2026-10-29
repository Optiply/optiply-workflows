import type { ComponentLibraryDefinition, ComponentLibraryDiagnostic } from '@ow/app-definition'
import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Button, Card, ErrorNote, Input, SectionLabel } from '@/components/ui'
import { useComponentLibraryEditor } from './store'

type Edit = (next: (d: ComponentLibraryDefinition) => ComponentLibraryDefinition) => void

interface CardProps {
  definition: ComponentLibraryDefinition
  diagnostics: ComponentLibraryDiagnostic[]
  readOnly: boolean
  edit: Edit
}

/** The versions a lock resolved its direct dependencies to, by name. */
function lockedVersions(lock: string | null): Record<string, string> {
  if (!lock) return {}
  try {
    const packages = (JSON.parse(lock) as { packages?: Record<string, { version?: string }> }).packages ?? {}
    return Object.fromEntries(
      Object.entries(packages).flatMap(([key, p]) =>
        key.startsWith('node_modules/') && !key.slice(13).includes('node_modules/') && p.version
          ? [[key.slice(13), p.version]]
          : [],
      ),
    )
  } catch {
    return {}
  }
}

/**
 * npm dependencies (M25): a name and a version range each, as in a `package.json`. React, ReactDOM and the SDK are
 * the frame's. A build installs them (no install scripts run) and keeps the lock: the versions it resolved show here.
 */
export function DependenciesCard({ definition, diagnostics, readOnly, edit }: CardProps) {
  const [name, setName] = useState('')
  const [range, setRange] = useState('')
  const lock = useComponentLibraryEditor((s) => s.lock)
  const locked = useMemo(() => lockedVersions(lock), [lock])
  const entries = Object.entries(definition.dependencies).sort(([a], [b]) => (a < b ? -1 : 1))
  const problem = (dep: string) =>
    diagnostics.find((d) => d.path[0] === 'dependencies' && d.path[1] === dep)?.message
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="library-dependencies">
      <SectionLabel>Dependencies</SectionLabel>
      {entries.length === 0 && (
        <p className="text-sm text-muted">None: React and the SDK are always there.</p>
      )}
      <ul className="flex flex-col gap-1">
        {entries.map(([dep, r]) => (
          <li key={dep} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="flex-1 truncate">{dep}</span>
              <span className="text-muted">{r}</span>
              {locked[dep] && <Badge>{locked[dep]}</Badge>}
              {!readOnly && (
                <Button
                  size="icon"
                  variant="ghost"
                  title={`Remove ${dep}`}
                  onClick={() =>
                    edit((d) => {
                      const { [dep]: _, ...rest } = d.dependencies
                      return { ...d, dependencies: rest }
                    })
                  }
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            {problem(dep) && <ErrorNote error={problem(dep)} />}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            edit((d) => ({
              ...d,
              dependencies: { ...d.dependencies, [name.trim()]: range.trim() || 'latest' },
            }))
            setName('')
            setRange('')
          }}
        >
          <Input
            aria-label="Package"
            className="h-8 flex-1 font-mono text-xs"
            placeholder="package"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            aria-label="Version range"
            className="h-8 w-24 font-mono text-xs"
            placeholder="^1.0.0"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          />
          <Button type="submit" size="sm" variant="ghost" disabled={!name.trim()}>
            <Plus className="size-3.5" /> Add
          </Button>
        </form>
      )}
    </Card>
  )
}

/**
 * Allowed origins (M25): where its components may fetch from and load images, fonts and media from; nothing else.
 * Anyone editing may propose them; publishing a release whose origins differ from the live one's needs an admin.
 */
export function OriginsCard({
  definition,
  diagnostics,
  readOnly,
  edit,
  liveOrigins,
}: CardProps & { liveOrigins: string[] }) {
  const [origin, setOrigin] = useState('')
  const changed =
    definition.allowedOrigins.length !== liveOrigins.length ||
    definition.allowedOrigins.some((o) => !liveOrigins.includes(o))
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="library-origins">
      <div className="flex items-center gap-2">
        <SectionLabel className="flex-1">Allowed origins</SectionLabel>
        {changed && <Badge tone="warning">An admin publishes this</Badge>}
      </div>
      <p className="text-xs text-muted">
        Components reach nothing but these (fetch, images, fonts, media). Data from the app normally comes in
        through props.
      </p>
      <ul className="flex flex-col gap-1">
        {definition.allowedOrigins.map((o, i) => {
          const problem = diagnostics.find((d) => d.path[0] === 'allowedOrigins' && d.path[1] === i)?.message
          return (
            <li key={o} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="flex-1 truncate">{o}</span>
                {!liveOrigins.includes(o) && <Badge tone="warning">new</Badge>}
                {!readOnly && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title={`Remove ${o}`}
                    onClick={() =>
                      edit((d) => ({ ...d, allowedOrigins: d.allowedOrigins.filter((x) => x !== o) }))
                    }
                  >
                    <X className="size-3.5" />
                  </Button>
                )}
              </div>
              {problem && <ErrorNote error={problem} />}
            </li>
          )
        })}
      </ul>
      {!readOnly && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            const value = origin.trim().replace(/\/+$/, '')
            if (!value || definition.allowedOrigins.includes(value)) return
            edit((d) => ({ ...d, allowedOrigins: [...d.allowedOrigins, value] }))
            setOrigin('')
          }}
        >
          <Input
            aria-label="Origin"
            className="h-8 flex-1 font-mono text-xs"
            placeholder="https://api.example.com"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          />
          <Button type="submit" size="sm" variant="ghost" disabled={!origin.trim()}>
            <Plus className="size-3.5" /> Add
          </Button>
        </form>
      )}
    </Card>
  )
}
