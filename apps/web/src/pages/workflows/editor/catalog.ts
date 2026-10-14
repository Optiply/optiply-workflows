import type { Block, BlockType } from '@ow/definition'
import {
  Code2,
  Database,
  Filter,
  GitBranch,
  Hourglass,
  type LucideIcon,
  Play,
  Repeat,
  Reply,
  SquareFunction,
  TriangleAlert,
  Workflow,
} from 'lucide-react'

export interface BlockKind {
  label: string
  icon: LucideIcon
  /** Tailwind classes for the icon chip. */
  tone: string
  /** New blocks are named `<prefix><n>`, like Retool. */
  prefix: string
}

export const BLOCK_KINDS: Record<BlockType, BlockKind> = {
  startTrigger: {
    label: 'Start trigger',
    icon: Play,
    tone: 'bg-success/10 text-success',
    prefix: 'startTrigger',
  },
  resourceQuery: {
    label: 'Resource query',
    icon: Database,
    tone: 'bg-accent-soft text-accent',
    prefix: 'query',
  },
  code: { label: 'Code', icon: Code2, tone: 'bg-amber-100 text-amber-700', prefix: 'code' },
  branch: { label: 'Branch', icon: GitBranch, tone: 'bg-sky-100 text-sky-700', prefix: 'branch' },
  filter: { label: 'Filter', icon: Filter, tone: 'bg-teal-100 text-teal-700', prefix: 'filter' },
  response: { label: 'Response', icon: Reply, tone: 'bg-rose-100 text-rose-700', prefix: 'response' },
  loop: { label: 'Loop', icon: Repeat, tone: 'bg-violet-100 text-violet-700', prefix: 'loop' },
  function: {
    label: 'Function',
    icon: SquareFunction,
    tone: 'bg-indigo-100 text-indigo-700',
    prefix: 'function',
  },
  workflow: { label: 'Workflow', icon: Workflow, tone: 'bg-cyan-100 text-cyan-700', prefix: 'workflow' },
  wait: { label: 'Wait', icon: Hourglass, tone: 'bg-stone-100 text-stone-700', prefix: 'wait' },
  errorTrigger: {
    label: 'Error handler',
    icon: TriangleAlert,
    tone: 'bg-danger/10 text-danger',
    prefix: 'errorHandler',
  },
}

/** Block types the user can add (there's exactly one start trigger). The M5 blocks get their forms in step 7. */
export const ADDABLE: Exclude<BlockType, 'startTrigger'>[] = [
  'resourceQuery',
  'code',
  'branch',
  'filter',
  'response',
]

/** The first free `<prefix><n>` name. */
export function nextName(type: BlockType, taken: Iterable<string>): string {
  const used = new Set(taken)
  const prefix = BLOCK_KINDS[type].prefix
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`
}

/** A new block with a working default config. Queries need a resource, so the caller picks one. */
export function newBlock(
  type: Exclude<BlockType, 'startTrigger'>,
  name: string,
  resource?: { slug: string; type: string },
): Block {
  switch (type) {
    case 'resourceQuery':
      return {
        name,
        type,
        config: {
          resource: resource!.slug,
          query:
            resource!.type === 'postgres'
              ? { sql: 'select 1' }
              : { method: 'GET', path: '', params: [], headers: [], body: { type: 'none' } },
        },
      }
    case 'code':
      return { name, type, config: { code: 'return null' } }
    case 'branch':
      return { name, type, config: { conditions: [{ id: 'c1', expression: 'true' }] } }
    case 'filter':
      return { name, type, config: { input: '{{ [] }}', condition: 'true' } }
    case 'response':
      return { name, type, config: { status: '200', body: '{}' } }
    case 'loop':
      return { name, type, config: { input: '{{ [] }}', runner: { kind: 'code', code: 'return value' } } }
    case 'function':
      return { name, type, config: { function: '' } }
    case 'workflow':
      return { name, type, config: { workflow: '' } }
    case 'wait':
      return { name, type, config: { kind: 'duration', amount: '1', unit: 'minutes' } }
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
      return block.config.function ? `${block.config.function}()` : 'No function chosen'
    case 'workflow':
      return block.config.workflow || 'No workflow chosen'
    case 'wait':
      return block.config.kind === 'duration'
        ? `${block.config.amount} ${block.config.unit}`
        : `Until ${block.config.until}`
    case 'errorTrigger':
      return 'Runs when the workflow fails'
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
