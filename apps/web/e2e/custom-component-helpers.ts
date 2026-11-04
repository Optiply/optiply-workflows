import type { Page } from '@playwright/test'
import { trpcMutate } from './helpers'

/** Custom components (M25) for the e2e specs: a counter library, and publishing a library or an app by the API. */

export const COUNTER = `import { useEvent, useMethod, useProp, useStateValue, useTheme } from '@ow/component-sdk'
import { useState } from 'react'
import format from 'tiny-format'

export default function Counter() {
  const label = useProp<string>('label')
  const [count, setCount] = useStateValue<number>('count')
  const bumped = useEvent('bump')
  const [mark, setMark] = useState('')
  useMethod('highlight', (id: number) => {
    setMark('row ' + id)
    return 'highlighted ' + id
  })
  return (
    <div className="counter">
      <span data-testid="label">{label}</span>
      <button type="button" onClick={() => { setCount((count ?? 0) + 1); bumped() }}>{format(count ?? 0)}</button>
      <i data-testid="mark">{mark}</i>
      <b data-testid="mode">{useTheme().mode}</b>
    </div>
  )
}
`

export const counterLibrary = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  files: [
    { path: 'src/Counter.tsx', content: COUNTER },
    { path: 'src/counter.css', content: '.counter { display: flex; gap: 8px; color: var(--ow-text) }' },
  ],
  dependencies: { 'tiny-format': '^1.0.0' },
  allowedOrigins: [],
  components: [
    {
      name: 'Counter',
      label: 'Counter',
      entry: 'src/Counter.tsx',
      props: { label: { type: 'string', default: '', label: 'Label', testValue: 'Preview' } },
      state: { count: { default: 0 } },
      events: ['bump'],
      methods: { highlight: { params: ['id'] } },
      defaultSize: { w: 6, h: 6 },
    },
  ],
  ...extra,
})

/** A library with `definition` as its draft, published; returns its id. */
export async function publishedLibrary(page: Page, slug: string, definition: object): Promise<string> {
  const { id } = await trpcMutate<{ id: string }>(page, 'componentLibraries.create', { slug, name: slug })
  await trpcMutate(page, 'componentLibraries.saveDraft', { id, revision: 1, definition })
  await trpcMutate(page, 'componentLibraries.publish', { componentLibraryId: id, draftRevision: 2 })
  return id
}

/** An app with `definition` as its draft, published. */
export async function publishedApp(page: Page, slug: string, definition: object): Promise<string> {
  const { id } = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: slug })
  await trpcMutate(page, 'apps.saveDraft', { id, revision: 1, definition })
  await trpcMutate(page, 'apps.publish', { appId: id, draftRevision: 2 })
  return id
}
