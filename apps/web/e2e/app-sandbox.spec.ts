import { expect, test } from '@playwright/test'
import { signIn, trpcMutate } from './helpers'

/**
 * An app's code runs in a sandbox: an iframe with an opaque origin and no network access. It can still do what
 * apps do (run its queries, read current_user, notify, ask for confirmation), but not reach the page, the session
 * or anything on the network. The probe reaches for them through globalThis, as determined code would (the
 * validator already refuses plain `fetch` and `document`).
 */
test('app code runs sandboxed, and talks to the page only through the runtime', async ({ page }) => {
  await signIn(page)
  const slug = `sandbox-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'Sandbox check' })
  const definition = {
    schemaVersion: 1,
    components: [
      {
        name: 'hello',
        type: 'text',
        props: { value: '{{ greet.data?.[0]?.hello }} / {{ greet.data?.[0]?.who }}' },
      },
      { name: 'probeView', type: 'text', props: { value: '{{ JSON.stringify(results.value) }}' } },
      { name: 'answer', type: 'text', props: { value: 'answer={{ ask.data?.[0]?.n }}' } },
    ],
    queries: [
      {
        name: 'greet',
        kind: 'resource',
        resource: 'optiply_db',
        run: 'auto',
        // The browser sends the word; the server fills in current_user itself.
        query: { sql: 'select {{ word.value }}::text as hello, {{ current_user.email }}::text as who' },
      },
      {
        name: 'ask',
        kind: 'resource',
        resource: 'optiply_db',
        run: 'manual',
        confirm: 'Run it?',
        query: { sql: 'select 41 + 1 as n' },
      },
      {
        name: 'probe',
        kind: 'js',
        runOnLoad: true,
        code: `
          const out = {}
          try { await globalThis.fetch('/api/trpc/me'); out.fetch = 'allowed' } catch (e) { out.fetch = 'blocked' }
          try { out.parent = typeof globalThis.parent.document } catch (e) { out.parent = 'blocked' }
          try { out.cookie = globalThis.document.cookie } catch (e) { out.cookie = 'blocked' }
          out.stdlib = _.sum([1, 2]) + ' ' + dayjs('2026-10-15').format('DD/MM')
          out.user = current_user.email
          results.setValue(out)
          utils.notify('probe done', 'success')
          await ask.trigger()
        `,
      },
    ],
    variables: [{ name: 'word', initialValue: 'hallo' }, { name: 'results' }],
    layout: {
      hello: { x: 0, y: 0, w: 6, h: 6 },
      answer: { x: 6, y: 0, w: 6, h: 6 },
      probeView: { x: 0, y: 6, w: 12, h: 12 },
    },
  }
  await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
  await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })

  await page.goto(`/apps/${slug}`)
  await expect(page.locator('iframe[title="App sandbox"]')).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.locator('[data-component="hello"]')).toContainText('hallo / e2e@optiply.nl')
  await expect(page.getByRole('status').filter({ hasText: 'probe done' })).toBeVisible()

  const probe = page.locator('[data-component="probeView"]')
  for (const blocked of ['fetch', 'parent', 'cookie']) {
    await expect(probe).toContainText(new RegExp(`${blocked}\\\\?":\\\\?"blocked`))
  }
  await expect(probe).toContainText('3 15/10')
  await expect(probe).toContainText('e2e@optiply.nl')

  // A query asking for confirmation waits for the person.
  await expect(page.getByRole('dialog', { name: 'Are you sure?' })).toContainText('Run it?')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('[data-component="answer"]')).toContainText('answer=42')
})
