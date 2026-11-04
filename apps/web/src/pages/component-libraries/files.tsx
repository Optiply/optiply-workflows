import {
  type ComponentLibraryDefinition,
  type ComponentLibraryDiagnostic,
  componentPathReason,
} from '@ow/app-definition'
import { SDK_TYPES } from '@ow/component-sdk/types'
import { FileCode2, FilePlus, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import CodeField from '@/components/code/code-field'
import { REACT_DTS } from '@/components/code/component-dts'
import {
  installComponentTypes,
  libraryLanguage,
  libraryModelPath,
  syncLibraryModels,
} from '@/components/code/monaco'
import type { TextBinding } from '@/components/code/text-binding'
import { confirmDialog } from '@/components/confirm'
import { Button, Card, ErrorNote, Input, SectionLabel } from '@/components/ui'
import { cn } from '@/lib/utils'
import { componentLibraryAwareness } from './collab'
import { useComponentLibraryEditor } from './store'

type Edit = (next: (d: ComponentLibraryDefinition) => ComponentLibraryDefinition) => void

installComponentTypes(SDK_TYPES, REACT_DTS)

/** Starting content for a new file, by its extension. */
function starter(path: string): string {
  if (path.endsWith('.css')) return ''
  if (!/\.(tsx|jsx)$/.test(path)) return ''
  const name =
    (path.split('/').at(-1) ?? 'Component').replace(/\.\w+$/, '').replace(/[^A-Za-z0-9_$]/g, '') ||
    'Component'
  return `import { useProp } from '@ow/component-sdk'

export default function ${name[0]!.toUpperCase()}${name.slice(1)}() {
  const label = useProp<string>('label')
  return <div>{label}</div>
}
`
}

/**
 * A library's files (M25): a list on the left, the selected file in Monaco (TypeScript checked against the SDK's and
 * React's declarations; the build's problems as markers through the store), typed together with others.
 */
export function FilesCard({
  library,
  definition,
  diagnostics,
  readOnly,
  edit,
}: {
  library: string
  definition: ComponentLibraryDefinition
  diagnostics: ComponentLibraryDiagnostic[]
  readOnly: boolean
  edit: Edit
}) {
  const files = definition.files
  const [selected, setSelected] = useState<string | null>(null)
  const current =
    files.find((f) => f.path === selected) ??
    files.find((f) => definition.components.some((c) => c.entry === f.path)) ??
    files[0]
  const index = current ? files.indexOf(current) : -1
  const [naming, setNaming] = useState<{ mode: 'new' | 'rename'; value: string } | null>(null)
  const nameProblem = naming ? (componentPathReason(naming.value) ?? taken(naming.value)) : null
  function taken(path: string) {
    const lower = path.toLowerCase()
    const other = files.find((f) => f.path.toLowerCase() === lower)
    return other && !(naming?.mode === 'rename' && other === current) ? 'A file is already there' : null
  }
  const buildProblems = useComponentLibraryEditor((s) => s.buildProblems)
  const shared = useComponentLibraryEditor((s) => s.shared)
  const open = current ? libraryModelPath(library, current.path) : null

  // Every file is a model, so imports between them resolve in the TypeScript service.
  useEffect(() => {
    syncLibraryModels(library, files, open)
  }, [library, files, open])

  const binding = useMemo((): TextBinding | null => {
    const text = shared && !readOnly && index >= 0 ? shared.textAt(['files', index, 'content']) : null
    if (!text) return null
    return {
      text,
      write: (change) => useComponentLibraryEditor.getState().editText(['files', index, 'content'], change),
      undo: () => useComponentLibraryEditor.getState().undo(),
      redo: () => useComponentLibraryEditor.getState().redo(),
      awareness: componentLibraryAwareness(),
    }
  }, [shared, readOnly, index])

  const problems = [
    ...diagnostics
      .filter((d) => d.path[0] === 'files' && d.path[1] === index)
      .map((d) => ({ message: d.message, severity: d.severity })),
    ...buildProblems
      .filter((p) => current && p.file === current.path && p.line !== null)
      .map((p) => ({
        ...lineOffsets(current!.content, p.line!, p.column ?? 1),
        message: p.message,
        severity: 'error' as const,
      })),
  ]

  const submitName = () => {
    if (!naming || nameProblem) return
    const path = naming.value
    if (naming.mode === 'new') {
      edit((d) => ({ ...d, files: [...d.files, { path, content: starter(path) }] }))
    } else if (current) {
      const from = current.path
      edit((d) => ({
        ...d,
        files: d.files.map((f) => (f.path === from ? { ...f, path } : f)),
        // A component's entry follows its file.
        components: d.components.map((c) => (c.entry === from ? { ...c, entry: path } : c)),
      }))
    }
    setSelected(path)
    setNaming(null)
  }

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="library-files">
      <div className="flex items-center gap-2">
        <SectionLabel className="flex-1">Files</SectionLabel>
        {!readOnly && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setNaming({ mode: 'new', value: 'src/' })}>
              <FilePlus className="size-3.5" /> New file
            </Button>
            {current && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setNaming({ mode: 'rename', value: current.path })}
                >
                  <Pencil className="size-3.5" /> Rename
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirmDialog(`Delete ${current.path}?`, { danger: true }))) return
                    edit((d) => ({ ...d, files: d.files.filter((f) => f.path !== current.path) }))
                    setSelected(null)
                  }}
                >
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              </>
            )}
          </>
        )}
      </div>
      {naming && (
        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            submitName()
          }}
        >
          <div className="flex flex-1 flex-col gap-1">
            <Input
              autoFocus
              aria-label="File path"
              className="font-mono"
              value={naming.value}
              onChange={(e) => setNaming({ ...naming, value: e.target.value })}
              onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
            />
            {nameProblem && naming.value !== 'src/' && <ErrorNote error={nameProblem} />}
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={Boolean(nameProblem)}>
            {naming.mode === 'new' ? 'Add' : 'Rename'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>
            Cancel
          </Button>
        </form>
      )}
      <div className="grid min-h-[28rem] grid-cols-[12rem_minmax(0,1fr)] gap-3">
        <ul className="flex flex-col gap-0.5 overflow-auto" aria-label="Files">
          {[...files]
            .sort((a, b) => (a.path < b.path ? -1 : 1))
            .map((f) => {
              const failing =
                buildProblems.some((p) => p.file === f.path) ||
                diagnostics.some((d) => d.path[0] === 'files' && files[d.path[1] as number] === f)
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => setSelected(f.path)}
                    className={cn(
                      'flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-subtle',
                      f === current && 'bg-accent-soft text-accent',
                      failing && 'text-danger',
                    )}
                    title={f.path}
                  >
                    <FileCode2 className="size-3.5 shrink-0" />
                    <span className="truncate">{f.path}</span>
                  </button>
                </li>
              )
            })}
          {files.length === 0 && <li className="px-2 text-xs text-muted">No files yet</li>}
        </ul>
        {current ? (
          <CodeField
            key={open}
            path={open!}
            language={libraryLanguage(current.path)}
            value={current.content}
            onChange={(content) =>
              edit((d) => ({
                ...d,
                files: d.files.map((f) => (f.path === current.path ? { ...f, content } : f)),
              }))
            }
            height={448}
            problems={problems}
            readOnly={readOnly}
            binding={binding}
          />
        ) : (
          <p className="text-sm text-muted">Add a file to write a component.</p>
        )}
      </div>
    </Card>
  )
}

/** The offsets of a line and column (from 1) in `text`, to the end of that line. */
function lineOffsets(text: string, line: number, column: number): { start: number; end: number } {
  let start = 0
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', start)
    if (next === -1) break
    start = next + 1
  }
  const lineEnd = text.indexOf('\n', start)
  const end = lineEnd === -1 ? text.length : lineEnd
  return { start: Math.min(start + column - 1, end), end: Math.max(end, start + column) }
}
