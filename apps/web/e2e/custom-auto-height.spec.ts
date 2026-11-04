import { expect, type Page, test } from '@playwright/test'
import { publishedApp, publishedLibrary } from './custom-component-helpers'
import { signIn } from './helpers'

/**
 * Auto height (M33, docs/architecture.md §2.36): a custom component on Auto grows and shrinks with its content (the
 * frame reports it), moving what's under it; on Fixed it keeps its rows and its frame scrolls.
 */
const LINES = `import { useProp } from '@ow/component-sdk'

export default function Lines() {
  const count = useProp<number>('count') ?? 1
  return (
    <ol style={{ margin: 0 }}>
      {Array.from({ length: count }, (_, i) => <li key={i} style={{ height: 24 }}>Line {i + 1}</li>)}
    </ol>
  )
}
`

const library = {
  schemaVersion: 1,
  files: [{ path: 'src/Lines.tsx', content: LINES }],
  dependencies: {},
  allowedOrigins: [],
  components: [
    {
      name: 'Lines',
      label: 'Lines',
      entry: 'src/Lines.tsx',
      props: { count: { type: 'number', default: 1, label: 'Lines' } },
      defaultSize: { w: 6, h: 6 },
      autoHeight: true,
    },
  ],
}

const app = (slug: string, heightMode?: 'fixed') => ({
  schemaVersion: 1,
  queries: [],
  components: [
    { name: 'input1', type: 'numberInput', props: { label: 'Lines', defaultValue: 2 } },
    {
      name: 'lines1',
      type: 'custom',
      props: {
        library: slug,
        component: 'Lines',
        count: '{{ input1.value }}',
        ...(heightMode && { heightMode }),
      },
    },
    { name: 'under1', type: 'text', props: { value: 'Under the lines' } },
  ],
  layout: {
    input1: { x: 0, y: 0, w: 4, h: 4 },
    lines1: { x: 0, y: 4, w: 6, h: 6 },
    under1: { x: 0, y: 10, w: 6, h: 2 },
  },
})

const box = async (page: Page, name: string) =>
  (await page.locator(`[data-component="${name}"]`).boundingBox())!

test('a custom component on Auto grows with its content, and on Fixed scrolls', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  const slug = `auto-lines-${Date.now().toString(36)}`
  await publishedLibrary(page, slug, library)
  await publishedApp(page, `${slug}-auto`, app(slug))
  await publishedApp(page, `${slug}-fixed`, app(slug, 'fixed'))

  await page.goto(`/apps/${slug}-auto`)
  const frame = page.frameLocator('[data-component="lines1"] iframe')
  await expect(frame.getByText('Line 2')).toBeVisible()
  // Two lines (48 px) need 3 rows of 16 px: smaller than its stored 6.
  await expect.poll(async () => (await box(page, 'lines1')).height, { timeout: 15_000 }).toBeLessThan(60)
  const before = (await box(page, 'under1')).y
  await page.getByLabel('Lines').fill('12')
  await expect(frame.getByText('Line 12')).toBeVisible()
  // Twelve lines: 288 px, 18 rows; the text under it moved down by as much.
  await expect
    .poll(async () => (await box(page, 'lines1')).height, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(288)
  await expect.poll(async () => (await box(page, 'under1')).y).toBeGreaterThan(before + 200)

  await page.goto(`/apps/${slug}-fixed`)
  await expect(page.locator('[data-component="lines1"] iframe')).toBeVisible()
  await page.getByLabel('Lines').fill('12')
  await expect(page.frameLocator('[data-component="lines1"] iframe').getByText('Line 12')).toBeAttached()
  // Fixed: its 6 rows (96 px), whatever its content.
  await page.waitForTimeout(1000)
  expect(Math.round((await box(page, 'lines1')).height)).toBe(96)
})
