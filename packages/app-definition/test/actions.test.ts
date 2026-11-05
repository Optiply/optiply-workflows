import { describe, expect, it } from 'vitest'
import { type AppDefinition, appFields, buildAppGraph, renamePage, validateApp } from '../src'

/** Session 41's event actions: go to page, URL parameters, clipboard, download, local storage, throttle. */
const def: AppDefinition = {
  schemaVersion: 1,
  pages: [{ name: 'list' }, { name: 'detail' }],
  components: [
    { name: 'id', type: 'textInput', page: 'list' },
    {
      name: 'go',
      type: 'button',
      page: 'list',
      props: { text: '{{ localStorage.values.theme }}' },
      events: [
        {
          id: 'a',
          event: 'click',
          action: { type: 'openPage', page: 'detail', params: { id: '{{ id.value }}' } },
        },
        { id: 'b', event: 'click', action: { type: 'setUrlParams', params: { tab: '{{ id.value }}' } } },
        { id: 'c', event: 'click', action: { type: 'copyToClipboard', text: '{{ id.value }}' } },
        {
          id: 'd',
          event: 'click',
          action: { type: 'download', data: '{{ [id.value] }}', fileName: 'x.json' },
        },
        {
          id: 'e',
          event: 'click',
          action: { type: 'setLocalStorage', key: 'theme', value: '{{ id.value }}' },
        },
        { id: 'f', event: 'click', action: { type: 'clearLocalStorage' }, throttleMs: 500 },
      ],
    },
  ],
  queries: [],
}

describe('the new event actions', () => {
  it('are valid, and their templates are fields reading what they read', () => {
    expect(validateApp(def).diagnostics).toEqual([])
    const paths = appFields(def)
      .filter((f) => f.owner === 'go' && f.path.includes('action'))
      .map((f) => f.path.slice(4).join('.'))
    expect(paths).toEqual([
      'action.params.id',
      'action.params.tab',
      'action.text',
      'action.data',
      'action.fileName',
      'action.value',
    ])
    // `localStorage` is built in, like `url`: reading it isn't an unknown name, and nothing may take its name.
    expect(buildAppGraph(def).nodes.has('localStorage.values')).toBe(true)
    const taken = { ...def, components: [...def.components, { name: 'localStorage', type: 'text' }] }
    expect(validateApp(taken).diagnostics.map((d) => d.code)).toContain('invalid_name')
  })

  it('reports a page that isn’t there, and debounce with throttle', () => {
    const wrong = structuredClone(def)
    wrong.components[1]!.events![0]!.action = { type: 'openPage', page: 'nowhere' }
    wrong.components[1]!.events![5]!.debounceMs = 100
    expect(validateApp(wrong).diagnostics.map((d) => [d.code, d.path.join('.')])).toEqual([
      ['unknown_page', 'components.1.events.0.action.page'],
      ['invalid_args', 'components.1.events.5.throttleMs'],
    ])
  })

  it('follows a page rename in Go to page', () => {
    const renamed = renamePage(def, 'detail', 'order')
    expect(renamed.components[1]!.events![0]!.action).toEqual({
      type: 'openPage',
      page: 'order',
      params: { id: '{{ id.value }}' },
    })
  })
})
