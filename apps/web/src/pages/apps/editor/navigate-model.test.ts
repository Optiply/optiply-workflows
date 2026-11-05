import { type AppDefinition, buildAppGraph } from '@ow/app-definition'
import { describe, expect, it } from 'vitest'
import { entityLinks, fieldLabel, fuzzyScore, searchApp, searchPattern } from './navigate-model'

const def: AppDefinition = {
  schemaVersion: 1,
  pages: [{ name: 'orders' }, { name: 'detail' }],
  components: [
    { name: 'table1', type: 'table', page: 'orders', props: { data: '{{ query1.data }}' } },
    { name: 'textInput1', type: 'textInput', page: 'orders' },
    {
      name: 'button1',
      type: 'button',
      page: 'orders',
      props: { text: 'Save {{ textInput1.value }}' },
      events: [{ id: 'h1', event: 'click', action: { type: 'runScript', code: 'query1.trigger()' } }],
    },
    { name: 'header', type: 'text', props: { value: 'Hello {{ url.page }}' } },
  ],
  queries: [
    { name: 'query1', kind: 'js', page: 'orders', code: 'return textInput1.value + table1.data.length' },
  ],
  transformers: [{ name: 'transformer1', code: 'return table1.data.length + textInput1.value.length' }],
  variables: [{ name: 'variable1', initialValue: null }],
}
const graph = buildAppGraph(def)

describe('entity links', () => {
  it('finds what reads what, from templates and plain JavaScript alike, without globals or itself', () => {
    const links = entityLinks(graph)
    expect(links.get('query1')).toEqual({ uses: ['table1', 'textInput1'], usedBy: ['button1', 'table1'] })
    expect(links.get('textInput1')).toEqual({ uses: [], usedBy: ['button1', 'query1', 'transformer1'] })
    expect(links.get('header')).toEqual({ uses: [], usedBy: [] })
    expect(links.get('variable1')).toEqual({ uses: [], usedBy: [] })
  })
})

describe('searching the app', () => {
  it('finds names and fields, labelled, with the line around the match and the page', () => {
    const hits = searchApp(def, graph, searchPattern('textInput1') as RegExp)
    expect(hits.map((h) => [h.owner, h.label])).toEqual([
      ['textInput1', 'Name'],
      ['button1', 'Text'],
      ['query1', 'Code'],
      ['transformer1', 'Code'],
    ])
    const text = hits[1]!
    expect([text.before, text.match, text.after, text.page]).toEqual([
      'Save {{ ',
      'textInput1',
      '.value }}',
      'orders',
    ])
    expect(hits[3]!.page).toBeNull()
  })

  it('matches case, whole words and regular expressions on request', () => {
    expect(searchApp(def, graph, searchPattern('TEXTINPUT1') as RegExp)).toHaveLength(4)
    expect(searchApp(def, graph, searchPattern('TEXTINPUT1', { matchCase: true }) as RegExp)).toHaveLength(0)
    expect(
      searchApp(def, graph, searchPattern('data', { wholeWord: true }) as RegExp).map((h) => h.owner),
    ).toEqual(['table1', 'query1', 'transformer1'])
    expect(searchApp(def, graph, searchPattern('trig+er\\(\\)', { regex: true }) as RegExp)).toEqual([
      expect.objectContaining({ owner: 'button1', label: 'Event handler 1' }),
    ])
    expect(searchPattern('(', { regex: true })).toMatch(/./)
    expect(searchPattern('')).toBeNull()
  })

  it('labels fields as people read them', () => {
    expect(fieldLabel(def, ['components', 0, 'props', 'data'])).toBe('Data')
    expect(fieldLabel(def, ['components', 2, 'events', 0, 'action', 'code'])).toBe('Event handler 1')
    expect(fieldLabel(def, ['queries', 0, 'query', 'sql'])).toBe('SQL')
    expect(fieldLabel(def, ['transformers', 0, 'code'])).toBe('Code')
  })
})

describe('the fuzzy match', () => {
  it('matches subsequences, preferring starts, runs and short texts', () => {
    expect(fuzzyScore('tab', 'Table')).not.toBeNull()
    expect(fuzzyScore('tbl1', 'table1')).not.toBeNull()
    expect(fuzzyScore('xyz', 'table1')).toBeNull()
    expect(fuzzyScore('tab', 'table1')!).toBeGreaterThan(fuzzyScore('tab', 'textInput but able')!)
    expect(fuzzyScore('q1', 'query1')!).toBeGreaterThan(fuzzyScore('q1', 'a long query1')!)
    expect(fuzzyScore('', 'anything')).toBe(0)
  })
})
