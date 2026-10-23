import type { Block, BlockType } from '@ow/definition'
import {
  Code2,
  Database,
  FileCode2,
  Filter,
  GitBranch,
  Hourglass,
  type LucideIcon,
  Play,
  Repeat,
  Reply,
  SquareFunction,
  TriangleAlert,
  UserCheck,
  Workflow,
} from 'lucide-react'
import { defaultQuery } from '@/lib/resource-types'

export interface BlockKind {
  label: string
  icon: LucideIcon
  /**
   * The icon chip's classes, Optiply's tag colours by what the step does: triggers green (the error handler red),
   * data and calls blue, logic purple, JavaScript orange, Python and user tasks yellow, waiting grey.
   */
  tone: string
  /** New blocks are named `<prefix><n>`, like Retool. */
  prefix: string
}

export const BLOCK_KINDS: Record<BlockType, BlockKind> = {
  startTrigger: {
    label: 'Start trigger',
    icon: Play,
    tone: 'bg-op-green-1 text-op-green-4',
    prefix: 'startTrigger',
  },
  resourceQuery: {
    label: 'Resource query',
    icon: Database,
    tone: 'bg-op-blue-1 text-op-blue-4',
    prefix: 'query',
  },
  code: { label: 'Code', icon: Code2, tone: 'bg-op-orange-1 text-op-orange-4', prefix: 'code' },
  branch: { label: 'Branch', icon: GitBranch, tone: 'bg-op-purple-1 text-op-purple-4', prefix: 'branch' },
  filter: { label: 'Filter', icon: Filter, tone: 'bg-op-purple-1 text-op-purple-4', prefix: 'filter' },
  response: { label: 'Response', icon: Reply, tone: 'bg-op-green-1 text-op-green-4', prefix: 'response' },
  loop: { label: 'Loop', icon: Repeat, tone: 'bg-op-purple-1 text-op-purple-4', prefix: 'loop' },
  function: {
    label: 'Function',
    icon: SquareFunction,
    tone: 'bg-op-blue-1 text-op-blue-4',
    prefix: 'function',
  },
  workflow: { label: 'Workflow', icon: Workflow, tone: 'bg-op-blue-1 text-op-blue-4', prefix: 'workflow' },
  wait: { label: 'Wait', icon: Hourglass, tone: 'bg-subtle text-muted', prefix: 'wait' },
  userTask: { label: 'User task', icon: UserCheck, tone: 'bg-op-yellow-1 text-op-yellow-4', prefix: 'task' },
  errorTrigger: {
    label: 'Error handler',
    icon: TriangleAlert,
    tone: 'bg-op-red-1 text-op-red-4',
    prefix: 'errorHandler',
  },
}

/** A Python code block (a code block with `language: 'python'`) on the canvas, in the inspector and the toolbar. */
export const PYTHON_KIND: BlockKind = {
  label: 'Python',
  icon: FileCode2,
  tone: 'bg-op-yellow-1 text-op-yellow-4',
  prefix: 'python',
}

/** How a block is shown: its type's kind, or Python's for a Python code block. */
export function kindOf(block: Block): BlockKind {
  return block.type === 'code' && block.config.language === 'python' ? PYTHON_KIND : BLOCK_KINDS[block.type]
}

/** Block types the user can add (there's exactly one start trigger). */
export const ADDABLE: Exclude<BlockType, 'startTrigger'>[] = [
  'resourceQuery',
  'code',
  'branch',
  'filter',
  'response',
  'loop',
  'function',
  'workflow',
  'wait',
  'userTask',
  'errorTrigger',
]

/** What a function can't contain (see the validator's not_in_function). */
const NOT_IN_FUNCTIONS = new Set<BlockType>(['response', 'wait', 'userTask', 'errorTrigger'])

/** The block types that can be added to a graph: a function's, or the workflow's (one error handler at most). */
export function addableIn(
  inFunction: boolean,
  blocks: readonly Block[],
): Exclude<BlockType, 'startTrigger'>[] {
  return ADDABLE.filter((type) =>
    inFunction
      ? !NOT_IN_FUNCTIONS.has(type)
      : type !== 'errorTrigger' || !blocks.some((b) => b.type === 'errorTrigger'),
  )
}

/** The first free `<prefix><n>` name. */
export function nextName(
  type: BlockType,
  taken: Iterable<string>,
  kind: BlockKind = BLOCK_KINDS[type],
): string {
  const used = new Set(taken)
  const prefix = kind.prefix
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`
}

/**
 * A new block with a working default config. Queries need a resource, so the caller picks one; Function blocks
 * call the first function there is. Inside a function, child workflows start async (a function can't wait).
 */
export function newBlock(
  type: Exclude<BlockType, 'startTrigger'>,
  name: string,
  resource?: { slug: string; type: string },
  context: { functions?: string[]; inFunction?: boolean; python?: boolean } = {},
): Block {
  switch (type) {
    case 'resourceQuery':
      return {
        name,
        type,
        config: {
          resource: resource!.slug,
          query: defaultQuery(resource!.type),
        },
      }
    case 'code':
      return context.python
        ? { name, type, config: { code: 'return None', language: 'python' } }
        : { name, type, config: { code: 'return null' } }
    case 'branch':
      return { name, type, config: { conditions: [{ id: 'c1', expression: 'true' }] } }
    case 'filter':
      return { name, type, config: { input: '{{ [] }}', condition: 'true' } }
    case 'response':
      return { name, type, config: { status: '200', body: '{}' } }
    case 'loop':
      return { name, type, config: { input: '{{ [] }}', runner: { kind: 'code', code: 'return value' } } }
    case 'function':
      return { name, type, config: { function: context.functions?.[0] ?? '' } }
    case 'workflow':
      return { name, type, config: { workflow: '', ...(context.inFunction && { mode: 'async' as const }) } }
    case 'wait':
      return { name, type, config: { kind: 'duration', amount: '1', unit: 'minutes' } }
    case 'userTask':
      return {
        name,
        type,
        config: {
          title: 'Please review',
          assignees: { groups: [] },
          outcomes: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
          ],
        },
      }
    case 'errorTrigger':
      return { name, type }
  }
}

/** One line describing what a block does, for the canvas. */
export function summary(block: Block): string {
  switch (block.type) {
    case 'startTrigger':
      return 'Webhook, schedule or manual run'
    case 'resourceQuery': {
      const sql = block.config.query.sql
      return typeof sql === 'string' ? firstLine(sql) : `${block.config.resource}`
    }
    case 'code':
      return firstLine(block.config.code)
    case 'branch':
      return `${block.config.conditions.length} condition${block.config.conditions.length === 1 ? '' : 's'}`
    case 'filter':
      return firstLine(block.config.condition)
    case 'response':
      return `HTTP ${block.config.status ?? '200'}`
    case 'loop':
      return `Each of ${block.config.input.trim()}`
    case 'function':
      return block.config.function
        ? `${block.config.function}(${Object.keys(block.config.params ?? {}).join(', ')})`
        : 'No function chosen'
    case 'workflow':
      return block.config.workflow || 'No workflow chosen'
    case 'wait':
      return block.config.kind === 'duration'
        ? `${block.config.amount} ${block.config.unit}`
        : `Until ${block.config.until}`
    case 'userTask': {
      const people = [...(block.config.assignees.users ?? []), ...(block.config.assignees.groups ?? [])]
      return `${firstLine(block.config.title)} · ${people.length ? people.join(', ') : 'nobody assigned'}`
    }
    case 'errorTrigger':
      return 'Runs when the workflow fails'
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
