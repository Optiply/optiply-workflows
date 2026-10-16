import { create } from 'zustand'
import { type BlockStatus, FINAL_RUN_STATUSES, type RunView, runsApi } from '@/lib/runs-api'
import { ensureSaved } from './save'
import { useEditor } from './store'

export interface LiveBlock {
  status: BlockStatus
  attempt: number
  port: string | null
}

const FINAL_BLOCK = new Set<string>(['succeeded', 'errored', 'failed', 'skipped', 'cancelled'])

interface RunState {
  slug: string
  /** The environment Run uses (slug). */
  environment: string | null
  /** The run shown on the canvas and in the run panel. */
  runId: string | null
  run: RunView | null
  /** Live block statuses of that run. */
  blocks: Record<string, LiveBlock>
  /** Loop iterations committed while watching, by loop (live progress). */
  iterations: Record<string, number>
  panelOpen: boolean
  starting: boolean
  startError: string | null

  init(slug: string, environment: string | null): void
  setEnvironment(slug: string): void
  /** Shows a run (or none) on the canvas and in the panel. */
  open(runId: string | null): void
  togglePanel(open?: boolean): void
  snapshot(run: RunView, blocks: (LiveBlock & { key: string })[]): void
  applyBlock(event: LiveBlock & { key: string }): void
  applyRun(status: RunView['status']): void
  applyIterations(key: string, count: number): void
  setRun(run: RunView): void
}

export const useRun = create<RunState>()((set, get) => ({
  slug: '',
  environment: null,
  runId: null,
  run: null,
  blocks: {},
  iterations: {},
  panelOpen: false,
  starting: false,
  startError: null,

  init: (slug, environment) =>
    set({
      slug,
      environment,
      runId: null,
      run: null,
      blocks: {},
      iterations: {},
      panelOpen: false,
      startError: null,
    }),
  setEnvironment: (environment) => set({ environment }),
  open: (runId) =>
    set({ runId, run: null, blocks: {}, iterations: {}, panelOpen: runId !== null || get().panelOpen }),
  togglePanel: (open) => set({ panelOpen: open ?? !get().panelOpen }),
  snapshot: (run, blocks) =>
    set({
      run,
      blocks: Object.fromEntries(
        blocks.map(({ key, status, attempt, port }) => [key, { status, attempt, port }]),
      ),
    }),
  applyBlock: ({ key, ...next }) => {
    const current = get().blocks[key]
    // An event that raced the snapshot can be older than what it shows: never step back from a final status.
    if (
      current &&
      FINAL_BLOCK.has(current.status) &&
      !FINAL_BLOCK.has(next.status) &&
      next.attempt <= current.attempt
    ) {
      return
    }
    set({ blocks: { ...get().blocks, [key]: next } })
  },
  applyRun: (status) => {
    const run = get().run
    if (run) set({ run: { ...run, status } })
  },
  applyIterations: (key, count) =>
    set({ iterations: { ...get().iterations, [key]: (get().iterations[key] ?? 0) + count } }),
  setRun: (run) => set({ run }),
}))

/** Cancels the open run; a running run keeps `running` until its process has stopped it. */
export async function cancelOpenRun() {
  const { runId } = useRun.getState()
  if (!runId) return
  const run = await runsApi.cancel(runId)
  if (useRun.getState().runId === runId) useRun.getState().setRun(run)
}

/** Saves the draft, then runs the whole workflow with the start trigger's test input. */
export async function runWorkflow() {
  const { slug, environment } = useRun.getState()
  const trigger = useEditor.getState().definition.blocks.find((b) => b.type === 'startTrigger')
  const input = trigger?.type === 'startTrigger' ? trigger.config?.testInput : undefined
  const draftId = useEditor.getState().branchDraftId
  await start(() => runsApi.start(slug, input ?? null, environment ?? undefined, draftId))
}

/** Saves the draft, then runs one block, reusing its ancestors' results from the latest run. */
export async function runBlock(name: string) {
  const { slug, environment } = useRun.getState()
  const draftId = useEditor.getState().branchDraftId
  await start(() => runsApi.startBlock(slug, name, environment ?? undefined, draftId))
}

async function start(launch: () => Promise<RunView>) {
  useRun.setState({ starting: true, startError: null })
  try {
    await ensureSaved()
    const run = await launch()
    useRun.getState().open(run.id)
    useRun.getState().setRun(run)
  } catch (err) {
    useRun.setState({ startError: err instanceof Error ? err.message : String(err) })
  } finally {
    useRun.setState({ starting: false })
  }
}

export function isFinal(status: string | undefined) {
  return status !== undefined && FINAL_RUN_STATUSES.has(status)
}
