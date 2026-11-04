import { expect, test } from '@playwright/test'
import { signIn, typeInto } from './helpers'

/**
 * The component library editor (M25 step 5): a library made from the list, its file written in Monaco, a package
 * and a prop declared, built, previewed with the prop's test value, a method called in the preview, and published.
 */

const CODE =
  "import { useMethod, useProp } from '@ow/component-sdk'; import format from 'tiny-format'; " +
  "export default function Hello() { useMethod('method', (x: string) => 'echo ' + x); " +
  'return <b data-testid="out">{format(useProp<number>(\'n\'))}</b> }'

test('a library is written, built, previewed and published in its editor', async ({ page }) => {
  await signIn(page)
  await page.goto('/component-libraries')
  await page.getByRole('button', { name: 'New library' }).click()
  await page.getByLabel('Name').fill('Editor test')
  await expect(page.getByLabel('Slug')).toHaveValue('editor-test')
  await page.getByRole('button', { name: 'Create library' }).click()
  await expect(page).toHaveURL(/\/component-libraries\/editor-test$/)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await typeInto(page, page.getByTestId('code-file:///component-libraries/editor-test/src/Hello.tsx'), CODE)

  const deps = page.getByTestId('library-dependencies')
  await deps.getByLabel('Package').fill('tiny-format')
  await deps.getByLabel('Version range').fill('^1.0.0')
  await deps.getByRole('button', { name: 'Add' }).click()
  await expect(deps.getByText('tiny-format')).toBeVisible()

  const components = page.getByTestId('library-components')
  const propName = components.getByLabel('Name of prop name')
  await propName.fill('n')
  await propName.press('Enter')
  await components.getByLabel('Type of n').selectOption('number')
  const testValue = components.getByLabel('Test value of n')
  await testValue.fill('7')
  await testValue.press('Enter')
  await components.getByRole('button', { name: 'Add method' }).click()
  await expect(components.getByLabel('Parameters of method')).toBeVisible()
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await page.getByTestId('build-library').click()
  const build = page.getByTestId('library-build')
  await expect(build.getByText(/^Built/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('library-dependencies').getByText('1.0.0', { exact: true })).toBeVisible()
  const preview = page.frameLocator('[data-testid="library-preview"] iframe')
  await expect(preview.getByTestId('out')).toHaveText('#007')
  await build.getByLabel('Arguments of method').fill('"x"')
  await build.getByRole('button', { name: 'method' }).click()
  await expect(page.getByTestId('preview-log')).toContainText('method → "echo x"')

  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByTestId('publish-confirm').click()
  await expect(page.getByTestId('release-status')).toContainText('Live v1.0.0', { timeout: 60_000 })
})

test('a build’s problem shows on its file', async ({ page }) => {
  await signIn(page)
  await page.goto('/component-libraries')
  await page.getByRole('button', { name: 'New library' }).click()
  await page.getByLabel('Name').fill('Broken one')
  await page.getByRole('button', { name: 'Create library' }).click()
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await typeInto(
    page,
    page.getByTestId('code-file:///component-libraries/broken-one/src/Hello.tsx'),
    'export default function Hello() { return <b>{1 + }</b> }',
  )
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await page.getByTestId('build-library').click()
  await expect(page.getByTestId('library-build').getByText('Bundling failed')).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByTestId('build-problems')).toContainText('src/Hello.tsx:1:')
  await expect(page.getByRole('button', { name: 'src/Hello.tsx' })).toHaveClass(/text-danger/)
})
