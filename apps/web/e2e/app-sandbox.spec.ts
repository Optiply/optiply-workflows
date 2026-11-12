import { expect, test } from '@playwright/test'
import { openCode, signIn, trpcMutate, typeInto } from './helpers'

/**
 * An app's code runs in a sandbox: a Worker started by an iframe with an opaque origin and no network access. It
 * can still do what apps do (run its queries, read current_user, notify, ask for confirmation), but not reach the
 * page, the session or anything on the network. The probe reaches for them through globalThis, as determined code
 * would (the validator already refuses plain `fetch` and `document`); none of its requests may leave the browser.
 */
test('app code runs sandboxed, and talks to the page only through the runtime', async ({ page, baseURL }) => {
  // Chrome reports some requests the CSP then refuses (an XHR's): those must fail for that reason, none get answered.
  const answered: string[] = []
  const refused: string[] = []
  page.on('requestfinished', (r) => {
    if (r.url().includes('/probe-')) answered.push(r.url())
  })
  page.on('requestfailed', (r) => {
    if (r.url().includes('/probe-')) refused.push(r.failure()?.errorText ?? 'unknown')
  })
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
          const g = globalThis
          const base = ${JSON.stringify(baseURL)}
          const attempt = async (name, fn) => {
            try { await fn(); out[name] = 'allowed' } catch (e) { out[name] = 'blocked' }
          }
          await attempt('fetch', () => g.fetch(base + '/probe-fetch'))
          await attempt('xhr', () => new Promise((ok, no) => {
            const x = new g.XMLHttpRequest(); x.open('GET', base + '/probe-xhr'); x.onload = ok; x.onerror = no; x.send()
          }))
          await attempt('websocket', () => new Promise((ok, no) => {
            const ws = new g.WebSocket(base.replace('http', 'ws') + '/probe-ws'); ws.onopen = ok; ws.onerror = no
          }))
          await attempt('importScripts', () => g.importScripts(base + '/probe-import.js'))
          await attempt('worker', () => new g.Worker(base + '/probe-worker.js'))
          try { out.parent = typeof g.parent.document } catch (e) { out.parent = 'blocked' }
          try { out.cookie = g.document.cookie } catch (e) { out.cookie = 'blocked' }
          out.stdlib = _.sum([1, 2]) + ' ' + dayjs('2026-10-15').format('DD/MM')
          out.retool = [
            moment('2026-10-15').format('DD-MM'),
            numbro(1234.5).format({ thousandSeparated: true, mantissa: 1 }),
            Papa.parse('a\\n7').data[1][0],
            uuid.validate(uuid.v4()),
          ].join(' ')
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
  for (const blocked of ['fetch', 'xhr', 'websocket', 'importScripts', 'worker', 'parent', 'cookie']) {
    await expect(probe).toContainText(new RegExp(`${blocked}\\\\?":\\\\?"blocked`))
  }
  expect(answered).toEqual([])
  for (const reason of refused) expect(reason).toBe('csp')
  await expect(probe).toContainText('3 15/10')
  await expect(probe).toContainText('15-10 1,234.5 7 true')
  await expect(probe).toContainText('e2e@optiply.nl')

  // A query asking for confirmation waits for the person.
  await expect(page.getByRole('dialog', { name: 'Are you sure?' })).toContainText('Run it?')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('[data-component="answer"]')).toContainText('answer=42')
})

/**
 * An endless loop in an app's code freezes only its Worker: the page keeps running, the watchdog stops the sandbox
 * within seconds, and Restart starts the app afresh. Also when the loop runs as the app opens (a transformer).
 */
test('an endless loop stops the app, not the page', async ({ page }) => {
  await signIn(page)
  const publish = async (slug: string, definition: object) => {
    const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: slug })
    await trpcMutate(page, 'apps.saveDraft', { id: app.id, revision: 1, definition })
    await trpcMutate(page, 'apps.publish', { appId: app.id, draftRevision: 2 })
  }
  const stamp = Date.now()
  await publish(`spin-${stamp}`, {
    schemaVersion: 1,
    components: [
      { name: 'greeting', type: 'text', props: { value: 'up for {{ name.value }}' } },
      {
        name: 'spinButton',
        type: 'button',
        props: { text: 'Spin' },
        events: [
          { id: 'a', event: 'click', action: { type: 'controlQuery', query: 'spin', method: 'trigger' } },
        ],
      },
    ],
    queries: [{ name: 'spin', kind: 'js', code: 'while (true) {}' }],
    variables: [{ name: 'name', initialValue: 'ada' }],
    layout: { greeting: { x: 0, y: 0, w: 6, h: 4 }, spinButton: { x: 6, y: 0, w: 3, h: 4 } },
  })

  const workers: string[] = []
  page.on('worker', (w) => {
    workers.push(w.url())
  })
  await page.goto(`/apps/spin-${stamp}`)
  await expect(page.locator('[data-component="greeting"]')).toContainText('up for ada')
  expect(workers).toHaveLength(1)
  expect(workers[0]).toMatch(/^blob:null\//)
  const [first] = page.workers()
  const firstClosed = new Promise<void>((resolve) => first!.on('close', () => resolve()))

  await page.getByRole('button', { name: 'Spin' }).click()
  // The page keeps drawing frames while the app's code spins.
  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0
        const start = performance.now()
        const tick = () => {
          count++
          if (performance.now() - start < 1000) requestAnimationFrame(tick)
          else resolve(count)
        }
        requestAnimationFrame(tick)
      }),
  )
  expect(frames).toBeGreaterThan(20)

  const alert = page.getByRole('alert').filter({ hasText: 'stopped responding' })
  await expect(alert).toBeVisible({ timeout: 10_000 })
  await expect(alert).toContainText('Restart it to carry on')
  await firstClosed
  await expect(page.locator('iframe[title="App sandbox"]')).toHaveCount(0)

  await alert.getByRole('button', { name: 'Restart' }).click()
  await expect(alert).toBeHidden()
  await expect(page.locator('[data-component="greeting"]')).toContainText('up for ada')
  expect(workers).toHaveLength(2)

  // Stuck while opening: the spinner gives way to the notice.
  await publish(`spin-open-${stamp}`, {
    schemaVersion: 1,
    components: [{ name: 'label', type: 'text', props: { value: '{{ forever.value }}' } }],
    queries: [],
    transformers: [{ name: 'forever', code: 'while (true) {}\nreturn 1' }],
    layout: { label: { x: 0, y: 0, w: 6, h: 4 } },
  })
  await page.goto(`/apps/spin-open-${stamp}`)
  await expect(page.getByRole('alert').filter({ hasText: 'stopped responding' })).toBeVisible({
    timeout: 10_000,
  })
})

/** In the editor, the edit that fixes the loop restarts the app (the draft runs as it's edited). */
test('an edit restarts an app that stopped responding in the editor', async ({ page }) => {
  await signIn(page)
  const slug = `spin-edit-${Date.now()}`
  const app = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: slug })
  await trpcMutate(page, 'apps.saveDraft', {
    id: app.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [{ name: 'label', type: 'text', props: { value: 'got {{ forever.value }}' } }],
      queries: [],
      transformers: [{ name: 'forever', code: 'while (true) {}\nreturn 1' }],
      layout: { label: { x: 0, y: 0, w: 6, h: 4 } },
    },
  })
  await page.goto(`/apps/${slug}/edit`)
  const alert = page.getByRole('alert').filter({ hasText: 'stopped responding' })
  await expect(alert).toBeVisible({ timeout: 10_000 })
  await expect(alert).toContainText('Editing the app restarts it')

  await openCode(page, 'forever')
  await typeInto(page, page.locator('[data-testid$="/transformers/0/code"]'), 'return 7')
  await expect(alert).toBeHidden()
  await expect(page.getByTestId('frame-label')).toContainText('got 7')
})
