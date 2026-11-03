import type { Block, BlockOf } from '@ow/definition'

/**
 * Switching a block's type from its ⋯ menu (M28), only where the config carries over: a code, query, library query,
 * function or child workflow block becomes a loop running the same thing for each item, and such a loop becomes the
 * single block again. The name, description and connections stay; the settings move (a loop's retry is per item).
 */
export type SwitchTarget = 'loop' | 'single'

type Single = BlockOf<'code' | 'resourceQuery' | 'libraryQuery' | 'function' | 'workflow'>
type Loop = BlockOf<'loop'>
type Runner = Loop['config']['runner']

/** What a block can be switched to, with the menu's label; null when nothing carries over. */
export function switchTarget(block: Block): { to: SwitchTarget; label: string } | null {
  switch (block.type) {
    case 'code':
    case 'resourceQuery':
    case 'libraryQuery':
    case 'function':
    case 'workflow':
      return { to: 'loop', label: 'Switch to a loop' }
    case 'loop':
      return { to: 'single', label: `Switch to ${SINGLE_LABEL[block.config.runner.kind]}` }
    default:
      return null
  }
}

const SINGLE_LABEL: Record<Runner['kind'], string> = {
  code: 'a code block',
  query: 'a resource query',
  library: 'a library query',
  function: 'a function call',
  workflow: 'a workflow call',
}

/** The block switched; null when it can't be. */
export function switchBlock(block: Block): Block | null {
  if (block.type === 'loop') return toSingle(block)
  if (switchTarget(block)?.to === 'loop') return toLoop(block as Single)
  return null
}

function toLoop(block: Single): Loop {
  const { retry, ...settings } = block.settings ?? {}
  return {
    name: block.name,
    ...(block.description !== undefined && { description: block.description }),
    type: 'loop',
    ...(Object.keys(settings).length > 0 && { settings }),
    config: {
      input: '{{ [] }}',
      runner: runnerOf(block),
      ...(retry && { iteration: { retry } }),
    },
  }
}

function runnerOf(block: Single): Runner {
  switch (block.type) {
    case 'code':
      return {
        kind: 'code',
        code: block.config.code,
        ...(block.config.language && { language: block.config.language }),
      }
    case 'resourceQuery':
      return { kind: 'query', resource: block.config.resource, query: block.config.query }
    case 'libraryQuery':
      return { kind: 'library', ...block.config }
    case 'function':
      return { kind: 'function', ...block.config }
    case 'workflow':
      return { kind: 'workflow', ...block.config }
  }
}

function toSingle(block: Loop): Single {
  const { kind, ...runner } = block.config.runner
  const retry = block.config.iteration?.retry
  const settings = { ...block.settings, ...(retry && { retry }) }
  const base = {
    name: block.name,
    ...(block.description !== undefined && { description: block.description }),
    ...(Object.keys(settings).length > 0 && { settings }),
  }
  switch (kind) {
    case 'code':
      return { ...base, type: 'code', config: runner as BlockOf<'code'>['config'] }
    case 'query':
      return { ...base, type: 'resourceQuery', config: runner as BlockOf<'resourceQuery'>['config'] }
    case 'library':
      return { ...base, type: 'libraryQuery', config: runner as BlockOf<'libraryQuery'>['config'] }
    case 'function':
      return { ...base, type: 'function', config: runner as BlockOf<'function'>['config'] }
    case 'workflow':
      return { ...base, type: 'workflow', config: runner as BlockOf<'workflow'>['config'] }
  }
}
