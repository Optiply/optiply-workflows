import type { ImportReport, ReportEntry } from '@ow/retool-import'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, FileUp, History, X } from 'lucide-react'
import { useState } from 'react'
import { FolderSelect, useOpenFolder } from '@/components/folders'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ErrorNote,
  Field,
  Select,
  Spinner,
  sectionLabelClass,
} from '@/components/ui'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

/**
 * Importing Retool exports (M36): pick one or more JSON files of the list's kind, see what each would become, map
 * Retool's resources (and, for apps, the Retool workflows they run) to ours, pick a folder, import. Each file is
 * analyzed and imported on its own (`retoolImport.analyze`, `.run`); nothing is kept of the files themselves.
 */

type Kind = 'app' | 'workflow'

interface Analysis {
  kind: Kind
  name: string
  update: { id: string; slug: string; name: string } | null
  report: ImportReport
  remembered: { resources: Record<string, string>; workflows: Record<string, string> }
  suggested: Record<string, string>
}

interface PickedFile {
  id: number
  name: string
  size: number
  content: string
  analysis?: Analysis
  error?: unknown
  copy: boolean
}

interface Imported {
  file: string
  kind: Kind
  id: string
  slug: string
  name: string
  mode: 'created' | 'updated' | 'copied'
}

/** As the server's `MAX_EXPORT_CHARS`: an export travels as a string, its quotes escaped again. */
const MAX_EXPORT_BYTES = 7_000_000

const noun = (kind: Kind) => (kind === 'app' ? 'app' : 'workflow')

export function RetoolImportDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [files, setFiles] = useState<PickedFile[]>([])
  const [resourceMap, setResourceMap] = useState<Record<string, string>>({})
  const [workflowMap, setWorkflowMap] = useState<Record<string, string>>({})
  const [folderId, setFolderId] = useState<string | null>(useOpenFolder(kind).id)
  const [imported, setImported] = useState<Imported[] | null>(null)
  const [importError, setImportError] = useState<unknown>(null)
  const [importing, setImporting] = useState(false)
  const resources = useQuery(trpc.resources.list.queryOptions())
  const workflows = useQuery({ ...trpc.workflows.list.queryOptions(), enabled: kind === 'app' })
  const analyze = useMutation(trpc.retoolImport.analyze.mutationOptions())
  const run = useMutation(trpc.retoolImport.run.mutationOptions())

  const update = (id: number, change: Partial<PickedFile>) =>
    setFiles((list) => list.map((f) => (f.id === id ? { ...f, ...change } : f)))

  const pick = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      const id = Date.now() + Math.random()
      if (file.size > MAX_EXPORT_BYTES) {
        const error = new Error(
          `Over ${MAX_EXPORT_BYTES / 1_000_000} MB: the import takes exports up to that size`,
        )
        setFiles((all) => [...all, { id, name: file.name, size: file.size, content: '', copy: false, error }])
        continue
      }
      const content = await file.text()
      setFiles((all) => [...all, { id, name: file.name, size: file.size, content, copy: false }])
      try {
        const analysis = (await analyze.mutateAsync({
          expect: kind,
          fileName: file.name,
          content,
        })) as Analysis
        update(id, { analysis })
        // What's remembered or looks alike fills the mapping in; what the person chose stays.
        setResourceMap((m) => ({ ...analysis.suggested, ...analysis.remembered.resources, ...m }))
        setWorkflowMap((m) => ({ ...analysis.remembered.workflows, ...m }))
      } catch (error) {
        update(id, { error })
      }
    }
  }

  const ready = files.filter((f) => f.analysis)
  const needs = <T extends { key: string; mapped: boolean; usedBy: string[] }>(
    of: (r: ImportReport) => T[],
  ) => {
    const all = new Map<string, T & { usedBy: string[] }>()
    for (const f of ready) {
      for (const need of of(f.analysis!.report)) {
        // Built-in ones (REST without a resource) are mapped already.
        if (need.mapped && !(need.key in resourceMap) && !(need.key in workflowMap)) continue
        const known = all.get(need.key)
        all.set(need.key, known ? { ...known, usedBy: [...known.usedBy, ...need.usedBy] } : { ...need })
      }
    }
    return [...all.values()]
  }
  const resourceNeeds = needs((r) => r.resources)
  const workflowNeeds = needs((r) => r.workflows ?? [])

  const submit = async () => {
    setImporting(true)
    setImportError(null)
    const done: Imported[] = []
    try {
      for (const f of ready) {
        const report = f.analysis!.report
        const only = (map: Record<string, string>, keys: string[]) =>
          Object.fromEntries(Object.entries(map).filter(([k, v]) => v && keys.includes(k)))
        const result = await run.mutateAsync({
          expect: kind,
          fileName: f.name,
          content: f.content,
          resources: only(
            resourceMap,
            report.resources.map((r) => r.key),
          ),
          workflows: only(
            workflowMap,
            (report.workflows ?? []).map((w) => w.key),
          ),
          folderId,
          copy: f.copy,
        })
        done.push({
          file: f.name,
          kind,
          id: result.id,
          slug: result.slug,
          name: result.name,
          mode: result.mode,
        })
      }
    } catch (error) {
      setImportError(error)
    } finally {
      setImporting(false)
      if (done.length) {
        setImported(done)
        await queryClient.invalidateQueries({
          queryKey: kind === 'app' ? trpc.apps.list.queryKey() : trpc.workflows.list.queryKey(),
        })
      }
    }
  }

  if (imported) {
    return (
      <Dialog
        title={`Imported from Retool`}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <ul className="space-y-2" data-testid="retool-imported">
          {imported.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-sm">
              <Badge tone={item.mode === 'updated' ? 'accent' : 'success'}>
                {item.mode === 'updated' ? 'New draft' : item.mode === 'copied' ? 'Copy' : 'New'}
              </Badge>
              {item.kind === 'app' ? (
                <Link
                  to="/apps/$slug/edit"
                  params={{ slug: item.slug }}
                  className="text-accent hover:underline"
                >
                  {item.name}
                </Link>
              ) : (
                <Link
                  to="/workflows/$workflowId"
                  params={{ workflowId: item.id }}
                  className="text-accent hover:underline"
                >
                  {item.name}
                </Link>
              )}
              <span className="font-mono text-xs text-muted">{item.slug}</span>
            </li>
          ))}
        </ul>
        <ErrorNote error={importError} />
      </Dialog>
    )
  }

  return (
    <Dialog
      title={`Import ${noun(kind)}s from Retool`}
      className="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={importing}
            disabled={!ready.length || analyze.isPending}
            onClick={submit}
          >
            Import {ready.length > 1 ? `${ready.length} ${noun(kind)}s` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-muted">
          In Retool, open the {noun(kind)} and choose <b>Export to JSON</b> (
          {kind === 'app' ? 'the app menu' : 'the workflow menu'}).
          {kind === 'app' && ' Import the workflows an app runs first, from Workflows, to link them.'} The
          files aren&apos;t kept; each {noun(kind)} keeps its import report.
        </p>
        <label
          className="flex h-16 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-muted hover:bg-canvas"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            void pick(e.dataTransfer.files)
          }}
        >
          <FileUp className="size-4" />
          Choose or drop Retool {noun(kind)} exports (.json)
          <input
            type="file"
            accept=".json,application/json"
            multiple
            aria-label="Retool exports"
            className="sr-only"
            onChange={(e) => {
              void pick(e.target.files)
              e.target.value = ''
            }}
          />
        </label>

        {files.length > 0 && (
          <ul className="space-y-2" data-testid="retool-files">
            {files.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                onCopy={(copy) => update(f.id, { copy })}
                onRemove={() => setFiles((all) => all.filter((x) => x.id !== f.id))}
              />
            ))}
          </ul>
        )}

        {resourceNeeds.length > 0 && (
          <section className="space-y-2">
            <h3 className={sectionLabelClass}>Resources</h3>
            <p className="text-xs text-muted">
              Which resource here each Retool resource is. Remembered for the next import; left unpicked,
              queries use a placeholder you can change in the editor.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {resourceNeeds.map((need) => (
                <Field
                  key={need.key}
                  label={`${need.label} (${need.kind.toUpperCase()})`}
                  hint={`Used by ${need.usedBy.slice(0, 3).join(', ')}${need.usedBy.length > 3 ? ` and ${need.usedBy.length - 3} more` : ''}`}
                >
                  <Select
                    aria-label={`Resource for ${need.label}`}
                    value={resourceMap[need.key] ?? ''}
                    onChange={(e) => setResourceMap((m) => ({ ...m, [need.key]: e.target.value }))}
                  >
                    <option value="">Pick one later</option>
                    {(resources.data?.resources ?? []).map((r) => (
                      <option key={r.slug} value={r.slug}>
                        {r.name} ({r.slug})
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </section>
        )}

        {workflowNeeds.length > 0 && (
          <section className="space-y-2">
            <h3 className={sectionLabelClass}>Workflows it runs</h3>
            <p className="text-xs text-muted">
              Retool names them by id only: pick the workflow here each one is (import them first).
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {workflowNeeds.map((need) => (
                <Field
                  key={need.key}
                  label={`Retool workflow ${need.key.slice(0, 8)}…`}
                  hint={`Used by ${need.usedBy.join(', ')}`}
                >
                  <Select
                    aria-label={`Workflow for ${need.key}`}
                    value={workflowMap[need.key] ?? ''}
                    onChange={(e) => setWorkflowMap((m) => ({ ...m, [need.key]: e.target.value }))}
                  >
                    <option value="">Pick one later</option>
                    {(workflows.data ?? []).map((w) => (
                      <option key={w.id} value={w.slug}>
                        {w.name} ({w.slug})
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </section>
        )}

        {ready.some((f) => !f.analysis!.update || f.copy) && (
          <Field label="Folder for new ones">
            <FolderSelect type={kind} value={folderId} onChange={setFolderId} />
          </Field>
        )}
        <ErrorNote error={importError} />
      </div>
    </Dialog>
  )
}

function FileRow({
  file,
  onCopy,
  onRemove,
}: {
  file: PickedFile
  onCopy: (copy: boolean) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const a = file.analysis
  return (
    <li className="rounded-md border border-border" data-testid="retool-file">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <button
          type="button"
          className="text-muted"
          aria-label={open ? 'Hide details' : 'Show details'}
          disabled={!a}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <span className="font-medium">{a?.name ?? file.name}</span>
        {!a && !file.error && <Spinner />}
        {a && (
          <>
            {a.update && !file.copy ? (
              <Badge tone="accent">Updates {a.update.name}</Badge>
            ) : (
              <Badge tone="success">New</Badge>
            )}
            <Counts report={a.report} />
            {a.update && (
              <Checkbox
                label="Make a copy instead"
                checked={file.copy}
                onChange={(e) => onCopy(e.target.checked)}
              />
            )}
          </>
        )}
        <button
          type="button"
          className="ml-auto text-muted hover:text-text"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
        >
          <X className="size-4" />
        </button>
      </div>
      {file.error ? (
        <div className="px-3 pb-2">
          <ErrorNote error={file.error} />
        </div>
      ) : null}
      {a && open && (
        <div className="border-t border-border px-3 py-2">
          <ReportDetails report={a.report} />
        </div>
      )}
    </li>
  )
}

/** Converted / approximated / not imported / skipped, and problems left. */
function Counts({ report }: { report: ImportReport }) {
  const c = report.counts
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      <Badge tone="success">{c.converted} converted</Badge>
      {c.approximated > 0 && <Badge tone="warning">{c.approximated} approximated</Badge>}
      {c.unsupported > 0 && <Badge tone="danger">{c.unsupported} not imported</Badge>}
      {c.skipped > 0 && <Badge>{c.skipped} skipped</Badge>}
      {report.diagnostics.length > 0 && <Badge tone="danger">{report.diagnostics.length} problems</Badge>}
    </span>
  )
}

const STATUS_TONE: Record<ReportEntry['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  converted: 'success',
  approximated: 'warning',
  unsupported: 'danger',
  skipped: 'neutral',
}

/** What to check after an import: notes, config vars to set, problems, and every part that isn't as it was. */
export function ReportDetails({ report }: { report: ImportReport }) {
  const configVars = [...new Set(report.secrets.map((s) => s.configVar))]
  const parts = report.entries.filter((e) => e.status !== 'converted' || e.name)
  return (
    <div className="space-y-3 text-sm">
      {report.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {configVars.length > 0 && (
        <div>
          <p className="font-medium">Config vars to set</p>
          <p className="text-xs text-muted">
            Secrets written into the export were replaced: set these in Settings → Config vars (the values are
            in Retool).
          </p>
          <ul className="mt-1 space-y-0.5">
            {configVars.map((name) => (
              <li key={name} className="text-xs">
                <span className="font-mono">{name}</span>{' '}
                <span className="text-muted">
                  (
                  {report.secrets
                    .filter((s) => s.configVar === name)
                    .map((s) => s.where)
                    .join('; ')}
                  )
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.diagnostics.length > 0 && (
        <div>
          <p className="font-medium">Problems to fix before publishing</p>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {report.diagnostics.map((d, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: problems have no identity of their own.
              <li key={i}>
                {d.message}
                {d.where && <span className="text-muted"> · {d.where}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {parts.length > 0 && (
        <div>
          <p className="font-medium">Parts to check</p>
          <ul className="mt-1 max-h-72 space-y-1 overflow-y-auto text-xs" data-testid="retool-report-parts">
            {parts.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat across functions.
              <li key={i} className="flex flex-wrap items-baseline gap-1.5">
                <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                <span className="font-mono">
                  {e.in ? `${e.in}.` : ''}
                  {e.retool}
                </span>
                <span className="text-muted">
                  {e.kind} → {e.became}
                  {e.name && ` as ${e.name}`}
                </span>
                {e.notes.length > 0 && (
                  <span className={cn('basis-full pl-2 text-muted')}>{e.notes.join('; ')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** In an editor's status bar: "Imported from Retool", opening the import's report (for editors of what was imported). */
export function ImportedFromRetool({ kind, id }: { kind: Kind; id: string }) {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.retoolImport.reportFor.queryOptions({ kind, id }))
  const [open, setOpen] = useState(false)
  if (!data) return null
  return (
    <>
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 hover:text-ink"
        onClick={() => setOpen(true)}
        title="What the import did, and what to check"
      >
        <History className="size-3" /> Imported from Retool
      </button>
      {open && (
        <Dialog
          title={`Imported from Retool: ${data.retoolName}`}
          className="max-w-3xl"
          onClose={() => setOpen(false)}
        >
          <div className="space-y-3">
            <p className="text-xs text-muted">Last imported {new Date(data.updatedAt).toLocaleString()}.</p>
            <Counts report={data.report} />
            <ReportDetails report={data.report} />
          </div>
        </Dialog>
      )}
    </>
  )
}
