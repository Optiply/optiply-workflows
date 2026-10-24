/** Library query blocks and runners (M21): the release a reference runs, its parameters and `current_user`. */
import type { LibraryQueryDefinition } from '@ow/definition'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { BlockFailure, type LibraryQueries } from '../src'
import { run, testServices, wf } from './helpers'

const t = testServices()
const { fake } = t
afterAll(() => t.close())

/** Releases by slug and version; `live` by slug. `resolved` counts lookups. */
const releases: Record<string, Record<string, LibraryQueryDefinition>> = {}
const live: Record<string, string> = {}
let resolved = 0
const library: LibraryQueries = {
  async resolve(slug, version) {
    resolved++
    const v = version === 'latest' ? live[slug] : version
    const definition = v ? releases[slug]?.[v] : undefined
    if (!v || !definition)
      throw new BlockFailure('library', `Library query "${slug}" has no release ${version}`)
    return { version: v, definition }
  },
  async user(id) {
    return id === 'u1' ? { id: 'u1', email: 'ada@optiply.nl', name: 'Ada' } : null
  },
}
const services = { ...t.services, library }

const release = (
  query: LibraryQueryDefinition['query'],
  params: string[],
  extra: object = {},
): LibraryQueryDefinition => ({
  schemaVersion: 1,
  resource: 'fake',
  query,
  params: params.map((name) => ({ name })),
  ...extra,
})

beforeEach(() => {
  t.reset()
  resolved = 0
  for (const k of Object.keys(releases)) delete releases[k]
  for (const k of Object.keys(live)) delete live[k]
  releases.customers = {
    '1.0.0': release(
      {
        id: 'customers',
        value: '{{ [id, region, current_user && current_user.email, typeof startTrigger] }}',
      },
      ['id', 'region'],
    ),
  }
  live.customers = '1.0.0'
})

const lib = (name: string, config: object, settings?: object) => ({
  name,
  type: 'libraryQuery',
  config,
  ...(settings && { settings }),
})

describe('Library query blocks', () => {
  it("runs the release's query with the parameters from the run and current_user from whoever started it", async () => {
    const { outcome, data } = await run(
      services,
      wf(
        [
          lib('library1', {
            library: 'customers',
            version: '1.0.0',
            params: { id: '{{ startTrigger.data.n }}' },
          }),
        ],
        [['startTrigger', 'library1']],
      ),
      { input: { data: { n: 7 } }, currentUserId: 'u1' },
    )
    expect(outcome.status).toBe('succeeded')
    // An undeclared or missing parameter is null; the run's blocks aren't in the library query's scope.
    expect(data('library1')).toEqual([7, null, 'ada@optiply.nl', 'undefined'])
    expect(outcome.results.get('library1')!.metadata).toMatchObject({
      resource: 'fake',
      library: { slug: 'customers', version: '1.0.0' },
    })
    expect(fake.labels[0]).toMatchObject({ ow_source: 'workflow', ow_library: 'customers' })
  })

  it('gives a null current_user to a run nobody started', async () => {
    const { data } = await run(
      services,
      wf([lib('library1', { library: 'customers', version: 'latest' })], [['startTrigger', 'library1']]),
    )
    expect(data('library1')).toEqual([null, null, null, 'undefined'])
  })

  it('resolves latest on every attempt, so a retry runs whichever release is live then', async () => {
    releases.customers!['1.1.0'] = release({ id: 'v2', value: "{{ 'second' }}" }, [])
    releases.customers!['1.0.0'] = release({ id: 'v1', failTimes: 5 }, [])
    const { outcome, data } = await run(
      {
        ...services,
        library: {
          ...library,
          resolve: (s, v) => {
            const found = library.resolve(s, v)
            live.customers = '1.1.0' // Published while the first attempt runs.
            return found
          },
        },
      },
      wf(
        [
          lib(
            'library1',
            { library: 'customers', version: 'latest' },
            { retry: { count: 1, intervalMs: 10 } },
          ),
        ],
        [['startTrigger', 'library1']],
      ),
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('library1')).toBe('second')
    expect(outcome.results.get('library1')!.metadata).toMatchObject({ library: { version: '1.1.0' } })
    expect(resolved).toBe(2)
  })

  it('fails the block when the library query or release is unknown, or a parameter fails', async () => {
    const one = (config: object) =>
      run(services, wf([lib('library1', config)], [['startTrigger', 'library1']])).then(
        ({ outcome }) => outcome.results.get('library1')!.error,
      )
    expect(await one({ library: 'nope', version: 'latest' })).toMatchObject({ code: 'library' })
    expect(await one({ library: 'customers', version: '9.9.9' })).toMatchObject({ code: 'library' })
    const broken = await one({ library: 'customers', version: 'latest', params: { id: '{{ null.x }}' } })
    expect(broken).toMatchObject({ code: 'expression' })
    expect(broken!.message).toMatch(/^Parameter id: Error in \{\{ null\.x \}\}/)
  })

  it("keeps to the library query's own timeout when it's shorter than the block's", async () => {
    releases.customers!['1.0.0'] = release({ id: 'slow', delayMs: 2000 }, [], { timeoutMs: 100 })
    const started = Date.now()
    const { outcome } = await run(
      services,
      wf([lib('library1', { library: 'customers', version: 'latest' })], [['startTrigger', 'library1']]),
    )
    expect(outcome.status).toBe('failed')
    expect(Date.now() - started).toBeLessThan(1500)
    expect(fake.aborted).toEqual(['slow'])
  })

  it('fails without a library service', async () => {
    const { outcome } = await run(
      t.services,
      wf([lib('library1', { library: 'customers', version: 'latest' })], [['startTrigger', 'library1']]),
    )
    expect(outcome.results.get('library1')!.error).toMatchObject({ code: 'library' })
  })
})

describe('library loop runners', () => {
  it('runs the library query per item with value and index in the parameters', async () => {
    const { outcome, data } = await run(
      services,
      wf(
        [
          {
            name: 'loop1',
            type: 'loop',
            config: {
              input: "{{ ['a', 'b'] }}",
              runner: {
                kind: 'library',
                library: 'customers',
                version: '1.0.0',
                params: { id: '{{ value }}', region: '{{ index }}' },
              },
            },
          },
        ],
        [['startTrigger', 'loop1']],
      ),
      { currentUserId: 'u1' },
    )
    expect(outcome.status).toBe('succeeded')
    expect(data('loop1')).toEqual([
      ['a', 0, 'ada@optiply.nl', 'undefined'],
      ['b', 1, 'ada@optiply.nl', 'undefined'],
    ])
  })
})
