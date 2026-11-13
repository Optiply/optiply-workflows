/**
 * What an import did, part by part, so people can see what to check. It never holds values from the export (no
 * code, queries or secrets): names, kinds and notes only. It's kept with the imported app or workflow; the export
 * itself isn't.
 */

/**
 * `converted` as it was; `approximated` working, with notes on what differs; `unsupported` replaced by a stand-in;
 * `skipped` left out, because it never ran in Retool (a block nothing leads to).
 */
export type EntryStatus = 'converted' | 'approximated' | 'unsupported' | 'skipped'

export interface ReportEntry {
  /** The part's name in Retool. */
  retool: string
  /** Its Retool kind: a block type, a component or query kind (`TableWidget2`, `SqlQueryUnified`). */
  kind: string
  /** What it became here (`code`, `resourceQuery`, `table`), or what stands in for it. */
  became: string
  /** Its name here, if it changed (a reserved or taken name). */
  name?: string
  /** Inside a function (workflows) or a page (apps). */
  in?: string
  status: EntryStatus
  notes: string[]
}

/** A resource the import needs: a Retool resource some query uses, and the slug it got here. */
export interface ResourceNeed {
  /** What Retool calls it in the export: a resource name, or its uuid. */
  key: string
  /** The name to show (Retool's display name when the export has it). */
  label: string
  /** The kind of query that uses it, which decides what kind of resource fits. */
  kind: 'sql' | 'rest' | 'openapi' | 'graphql' | 'other'
  /** The slug the import used: the mapped resource's, or a placeholder (`retool_…`) until one is mapped. */
  slug: string
  mapped: boolean
  /** The parts that use it. */
  usedBy: string[]
}

/** A Retool workflow an app runs (M36): which of ours it is, the person says (exports name workflows by uuid only). */
export interface WorkflowNeed {
  /** Retool's workflow id. */
  key: string
  /** The slug the import used: the mapped workflow's, or a placeholder (`retool-…`) until one is mapped. */
  slug: string
  mapped: boolean
  usedBy: string[]
}

/** A secret found written into the export: replaced by a config var, which someone has to set. */
export interface SecretFound {
  /** Where it was: `<part> header Authorization`. */
  where: string
  /** The config var that now stands in for it (`{{ configVars.NAME }}`). */
  configVar: string
}

export interface ImportReport {
  kind: 'app' | 'workflow'
  name: string
  entries: ReportEntry[]
  resources: ResourceNeed[]
  /** Workflows the app runs (M36). */
  workflows: WorkflowNeed[]
  secrets: SecretFound[]
  /** Notes about the whole import (settings, triggers, libraries…). */
  notes: string[]
  /** Problems our validator found in the result (code, message, where). */
  diagnostics: { code: string; message: string; where?: string }[]
  counts: Record<EntryStatus, number>
}

/** Collects a report while a converter runs. */
export class ReportBuilder {
  readonly entries: ReportEntry[] = []
  readonly notes: string[] = []
  private readonly resources = new Map<string, ResourceNeed>()
  private readonly workflows = new Map<string, WorkflowNeed>()
  private readonly secrets: SecretFound[] = []
  /** Secrets seen, to their config var: the same value gets the same one. Never part of the report. */
  private readonly secretVars = new Map<string, string>()

  constructor(
    readonly kind: 'app' | 'workflow',
    readonly name: string,
  ) {}

  add(entry: Omit<ReportEntry, 'notes'> & { notes?: string[] }): ReportEntry {
    const full = { ...entry, notes: entry.notes ?? [] }
    this.entries.push(full)
    return full
  }

  note(text: string) {
    if (!this.notes.includes(text)) this.notes.push(text)
  }

  resource(need: Omit<ResourceNeed, 'usedBy'>, usedBy: string): ResourceNeed {
    const known = this.resources.get(need.key)
    if (known) {
      if (!known.usedBy.includes(usedBy)) known.usedBy.push(usedBy)
      return known
    }
    const added = { ...need, usedBy: [usedBy] }
    this.resources.set(need.key, added)
    return added
  }

  workflow(need: Omit<WorkflowNeed, 'usedBy'>, usedBy: string): WorkflowNeed {
    const known = this.workflows.get(need.key)
    if (known) {
      if (!known.usedBy.includes(usedBy)) known.usedBy.push(usedBy)
      return known
    }
    const added = { ...need, usedBy: [usedBy] }
    this.workflows.set(need.key, added)
    return added
  }

  /** The config var standing in for `value`, a secret found at `where`: a new one, or the one it already got. */
  secret(where: string, value: string): string {
    const configVar = this.secretVars.get(value) ?? `RETOOL_SECRET_${this.secretVars.size + 1}`
    this.secretVars.set(value, configVar)
    this.secrets.push({ where, configVar })
    return configVar
  }

  build(diagnostics: ImportReport['diagnostics'] = []): ImportReport {
    const counts: Record<EntryStatus, number> = { converted: 0, approximated: 0, unsupported: 0, skipped: 0 }
    for (const e of this.entries) counts[e.status]++
    return {
      kind: this.kind,
      name: this.name,
      entries: this.entries,
      resources: [...this.resources.values()],
      workflows: [...this.workflows.values()],
      secrets: this.secrets,
      notes: this.notes,
      diagnostics,
      counts,
    }
  }
}
