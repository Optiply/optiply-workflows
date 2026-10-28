import {
  type Block,
  canonicalize,
  canonicalJson,
  type FunctionDefinition,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from '@ow/definition'
import {
  caseCollisions,
  type Decoded,
  type Files,
  isRecord,
  issuePath,
  type Problem,
  parseJsonFile,
  sortFiles,
  textFile,
  type Warning,
} from './files'
import { metaFields, type ObjectMeta, splitMeta } from './meta'
import { FileSlots, namedRecords } from './slots'

export const WORKFLOW_FILE = 'workflow.json'
export const LAYOUT_FILE = 'layout.json'
/** The workflow's Python packages (M23), one requirement a line, as pip reads them. */
export const REQUIREMENTS_FILE = 'requirements.txt'

export interface WorkflowObject extends ObjectMeta {
  definition: WorkflowDefinition
}

/**
 * A workflow as the files of its directory:
 * - `workflow.json`: the name, the description and the canonical definition without its layouts, and without the
 *   strings that have files of their own;
 * - `blocks/<name>.js`: a code block's code, or a loop's code runner (`blocks/<name>.py` when it's Python);
 * - `blocks/<name>.sql`: a resource query's `sql` (the loop's query runner too), its `{{ }}`s as they are;
 * - `functions/<function>/blocks/…`: the same for a function's blocks;
 * - `layout.json`: the canvas positions (`blocks`, and `functions.<name>.blocks`), when there are any;
 * - `requirements.txt`: the Python packages (`settings.python.requirements`), when there are any. Read back, blank
 *   lines and comment lines are left out (people edit it on GitHub too).
 *
 * Everything else (conditions, REST queries, templates) stays in the JSON. Empty layouts aren't kept: they read
 * back as none, which is the same canvas.
 */
export function encodeWorkflow(workflow: WorkflowObject): { files: Files; warnings: Warning[] } {
  const def = canonicalize(workflow.definition)
  const files: Files = {}
  const blocks = def.blocks.map((block) => moveOut(block, 'blocks/', files))
  const functions = def.functions?.map(({ layout: _layout, ...fn }) => ({
    ...fn,
    blocks: fn.blocks.map((block) => moveOut(block, `functions/${fn.name}/blocks/`, files)),
  }))
  const { layout: _layout, ...logic } = withoutRequirements(def)
  const requirements = def.settings?.python?.requirements
  if (requirements?.length) files[REQUIREMENTS_FILE] = textFile(requirements.join('\n'))
  files[WORKFLOW_FILE] = canonicalJson(
    { ...metaFields(workflow), ...logic, blocks, ...(functions ? { functions } : {}) },
    { pretty: true },
  )
  const layout = layoutFile(def)
  if (layout) files[LAYOUT_FILE] = canonicalJson(layout, { pretty: true })
  const sorted = sortFiles(files)
  return { files: sorted, warnings: caseCollisions(sorted) }
}

/** The workflow back from its directory's files, canonical. Problems name the file they're about. */
export function decodeWorkflow(files: Files): Decoded<WorkflowObject> {
  const source = files[WORKFLOW_FILE]
  if (source === undefined) {
    return {
      ok: false,
      problems: [{ path: WORKFLOW_FILE, code: 'missing_file', message: `${WORKFLOW_FILE} is missing` }],
    }
  }
  const parsed = parseJsonFile(WORKFLOW_FILE, source)
  if (!parsed.ok) return { ok: false, problems: [parsed.problem] }
  if (!isRecord(parsed.value)) {
    return { ok: false, problems: [invalid(WORKFLOW_FILE, 'Expected an object')] }
  }
  const { meta, rest: raw, problems } = splitMeta(WORKFLOW_FILE, parsed.value)

  const slots = new FileSlots(files, [WORKFLOW_FILE, LAYOUT_FILE, REQUIREMENTS_FILE])
  for (const block of namedRecords(raw.blocks)) moveIn(block, 'blocks/', slots)
  for (const fn of namedRecords(raw.functions)) {
    for (const block of namedRecords(fn.blocks)) moveIn(block, `functions/${fn.name}/blocks/`, slots)
  }
  problems.push(...slots.problems, ...slots.leftovers())

  if (files[LAYOUT_FILE] !== undefined) {
    const layout = parseJsonFile(LAYOUT_FILE, files[LAYOUT_FILE])
    if (!layout.ok) problems.push(layout.problem)
    else if (!isRecord(layout.value)) problems.push(invalid(LAYOUT_FILE, 'Expected an object'))
    else problems.push(...applyLayout(raw, layout.value))
  }

  if (files[REQUIREMENTS_FILE] !== undefined) {
    if (isRecord(raw.settings) && isRecord(raw.settings.python)) {
      problems.push(invalid(WORKFLOW_FILE, `settings.python: the packages belong in ${REQUIREMENTS_FILE}`))
    }
    const requirements = readRequirements(files[REQUIREMENTS_FILE])
    if (requirements.length) {
      raw.settings = { ...(isRecord(raw.settings) ? raw.settings : {}), python: { requirements } }
    }
  }

  const result = workflowDefinitionSchema.safeParse(raw)
  if (!result.success) {
    problems.push(
      ...result.error.issues.map((issue) =>
        invalid(
          isLayoutPath(issue.path) ? LAYOUT_FILE : WORKFLOW_FILE,
          `${issuePath(issue.path)}: ${issue.message}`,
        ),
      ),
    )
  }
  if (problems.length > 0 || !meta || !result.success) return { ok: false, problems }
  return { ok: true, value: { ...meta, definition: canonicalize(result.data) } }
}

/**
 * The definition as the repo keeps it, for comparing with what comes back: canonical, with empty layouts dropped.
 */
export function workflowForGit(def: WorkflowDefinition): WorkflowDefinition {
  const out = canonicalize(def)
  if (out.layout && Object.keys(out.layout).length === 0) delete out.layout
  if (out.functions) {
    out.functions = out.functions.map((fn) => {
      if (!fn.layout || Object.keys(fn.layout).length > 0) return fn
      const { layout: _layout, ...rest } = fn
      return rest
    })
  }
  return out
}

/** The definition without its Python packages (they're `requirements.txt`), and without `settings` left empty. */
function withoutRequirements(def: WorkflowDefinition): WorkflowDefinition {
  if (!def.settings?.python) return def
  const { python: _python, ...settings } = def.settings
  const { settings: _settings, ...rest } = def
  return Object.keys(settings).length ? { ...rest, settings } : rest
}

/** `requirements.txt`'s requirements: its lines without blank ones and comments (the validator checks the rest). */
export function readRequirements(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

/** The block without the strings that get files, which go into `files`. */
function moveOut(block: Block, dir: string, files: Files): Block {
  switch (block.type) {
    case 'code': {
      files[`${dir}${block.name}.${extension(block.config.language)}`] = textFile(block.config.code)
      const { code: _code, ...config } = block.config
      return { ...block, config } as Block
    }
    case 'resourceQuery': {
      const { sql, ...query } = block.config.query
      if (typeof sql !== 'string') return block
      files[`${dir}${block.name}.sql`] = textFile(sql)
      return { ...block, config: { ...block.config, query } }
    }
    case 'loop': {
      const runner = block.config.runner
      if (runner.kind === 'code') {
        files[`${dir}${block.name}.${extension(runner.language)}`] = textFile(runner.code)
        const { code: _code, ...rest } = runner
        return { ...block, config: { ...block.config, runner: rest } } as Block
      }
      if (runner.kind === 'query') {
        const { sql, ...query } = runner.query
        if (typeof sql !== 'string') return block
        files[`${dir}${block.name}.sql`] = textFile(sql)
        return { ...block, config: { ...block.config, runner: { ...runner, query } } }
      }
      return block
    }
    default:
      return block
  }
}

/** A code file's extension by the code's language (from the raw JSON too: anything but `python` is JavaScript). */
function extension(language: unknown): 'py' | 'js' {
  return language === 'python' ? 'py' : 'js'
}

/** The reverse of `moveOut`, on the raw JSON (the schema checks the result). */
function moveIn(block: Record<string, unknown> & { name: string }, dir: string, slots: FileSlots): void {
  const config = block.config
  const what = (kind: string) => `${kind} ${dir === 'blocks/' ? '' : `${dir.split('/')[1]}.`}${block.name}`
  switch (block.type) {
    case 'code':
      slots.take(
        `${dir}${block.name}.${extension(isRecord(config) ? config.language : undefined)}`,
        config,
        'code',
        {
          required: true,
          what: what('code block'),
        },
      )
      return
    case 'resourceQuery':
      if (isRecord(config)) {
        slots.take(`${dir}${block.name}.sql`, config.query, 'sql', { required: false, what: what('query') })
      }
      return
    case 'loop': {
      const runner = isRecord(config) ? config.runner : undefined
      if (!isRecord(runner)) return
      if (runner.kind === 'code') {
        slots.take(`${dir}${block.name}.${extension(runner.language)}`, runner, 'code', {
          required: true,
          what: what('loop'),
        })
      } else if (runner.kind === 'query') {
        slots.take(`${dir}${block.name}.sql`, runner.query, 'sql', { required: false, what: what('loop') })
      }
      return
    }
  }
}

type LayoutFile = NonNullable<WorkflowDefinition['layout']> & {
  functions?: Record<string, NonNullable<FunctionDefinition['layout']>>
}

function layoutFile(def: WorkflowDefinition): LayoutFile | null {
  const out: LayoutFile = { ...def.layout }
  const fns = Object.fromEntries(
    (def.functions ?? []).flatMap((fn) =>
      fn.layout && Object.keys(fn.layout).length > 0 ? [[fn.name, fn.layout]] : [],
    ),
  )
  if (Object.keys(fns).length > 0) out.functions = fns
  return Object.keys(out).length > 0 ? out : null
}

function applyLayout(raw: Record<string, unknown>, layout: Record<string, unknown>): Problem[] {
  const { functions, ...top } = layout
  if (Object.keys(top).length > 0) raw.layout = top
  if (functions === undefined) return []
  if (!isRecord(functions)) return [invalid(LAYOUT_FILE, 'functions: Expected an object')]
  const byName = new Map(namedRecords(raw.functions).map((fn) => [fn.name, fn]))
  const problems: Problem[] = []
  for (const [name, fnLayout] of Object.entries(functions)) {
    const fn = byName.get(name)
    if (!fn) problems.push(invalid(LAYOUT_FILE, `functions.${name}: there's no function ${name}`))
    else fn.layout = fnLayout
  }
  return problems
}

/** Schema issues in a layout come from `layout.json`. */
function isLayoutPath(path: readonly PropertyKey[]): boolean {
  return path[0] === 'layout' || (path[0] === 'functions' && path[2] === 'layout')
}

function invalid(path: string, message: string): Problem {
  return { path, code: 'invalid_definition', message: `${path}: ${message}` }
}
