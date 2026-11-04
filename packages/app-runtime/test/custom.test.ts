import { type AppDefinition, componentLibraryInterface, emptyComponentLibrary } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { AppRuntime, type ComponentLibraryReleases, type StatePatch } from '../src'

/** Custom components in the runtime (M25): declared props, state the frame sets, events, methods through the page. */

const library = emptyComponentLibrary()
library.components[0]!.methods = { highlight: { params: ['id'] } }
const libraries: ComponentLibraryReleases = {
  'widgets@latest': {
    releaseId: 'r1',
    version: '1.0.0',
    bundleHash: 'a'.repeat(64),
    allowedOrigins: [],
    components: componentLibraryInterface(library),
  },
}

const app = (parts: Partial<AppDefinition>): AppDefinition => ({
  schemaVersion: 1,
  components: [],
  queries: [],
  ...parts,
})
const hello = {
  name: 'hello1',
  type: 'custom',
  props: { library: 'widgets', component: 'Hello', name: '{{ who.value }}' },
}

function setup(def: AppDefinition, callable = true) {
  const state: Record<string, unknown> = {}
  const calls: [string, string, unknown[]][] = []
  const runtime = new AppRuntime(
    def,
    {
      runQuery: async () => ({ ok: true, data: null }),
      confirm: async () => true,
      effect: () => {},
      publish: (p: StatePatch) => Object.assign(state, p.values),
      log: () => {},
      ...(callable && {
        callComponent: async (component: string, method: string, args: unknown[]) => {
          calls.push([component, method, args])
          if (method === 'highlight' && args[0] === 'bad') throw new Error('No such row')
          return `highlighted ${args[0]}`
        },
      }),
    },
    { libraries, autoRunDelayMs: 0 },
  )
  return { runtime, state, calls }
}

describe('custom components', () => {
  it('evaluate declared props, start state from its default and take what the frame sets', async () => {
    const { runtime, state } = setup(
      app({
        components: [hello, { name: 'text1', type: 'text', props: { value: 'Clicks: {{ hello1.clicks }}' } }],
        variables: [{ name: 'who', initialValue: 'Ada' }],
      }),
    )
    await runtime.start()
    expect(state['hello1.name']).toBe('Ada')
    expect(state['hello1.clicks']).toBe(0)
    expect(state['text1.value']).toBe('Clicks: 0')
    runtime.set({ 'hello1.clicks': 3 })
    expect(state['text1.value']).toBe('Clicks: 3')
  })

  it('run their events’ handlers, and call their methods through the page', async () => {
    const { runtime, state, calls } = setup(
      app({
        components: [
          {
            ...hello,
            events: [
              {
                id: 'h1',
                event: 'click',
                action: { type: 'setVariable', variable: 'clicked', value: 'yes' },
              },
            ],
          },
        ],
        variables: [
          { name: 'who', initialValue: 'Ada' },
          { name: 'clicked', initialValue: 'no' },
        ],
        queries: [
          { name: 'go', kind: 'js', code: 'return await hello1.highlight(2)' },
          { name: 'bad', kind: 'js', code: 'return await hello1.highlight("bad")' },
        ],
      }),
    )
    await runtime.start()
    await runtime.fire('hello1', 'click')
    expect(state['clicked.value']).toBe('yes')
    await runtime.trigger('go')
    expect(state['go.data']).toBe('highlighted 2')
    await runtime.trigger('bad').catch(() => {})
    expect(state['bad.error']).toMatchObject({ message: expect.stringContaining('No such row') })
    expect(calls).toEqual([
      ['hello1', 'highlight', [2]],
      ['hello1', 'highlight', ['bad']],
    ])
  })

  it('take any props and have no methods while their release isn’t known', async () => {
    const { runtime, state } = setup(
      app({
        components: [{ ...hello, props: { ...hello.props, library: 'unknown' } }],
        variables: [{ name: 'who', initialValue: 'x' }],
      }),
    )
    await runtime.start()
    expect(state['hello1.name']).toBe('x')
    expect(state['hello1.clicks']).toBeUndefined()
  })
})
