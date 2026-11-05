import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
  type WebSocketRoute,
} from '@playwright/test'
import { E2E_SECOND_EMAIL } from './global-setup'
import {
  addBlock,
  block,
  editorText,
  field,
  openCode,
  signIn,
  trpcMutate,
  trpcQuery,
  typeInto,
} from './helpers'

/**
 * M16's done-when (architecture.md §2.7): two people (two browsers, two users) in one workflow: one adds and connects
 * a block while the other types in a code block, and each sees the other's change within a second; both type in the
 * same code field at once and the text merges; avatars, selection outlines and pointers show; undo undoes only one's
 * own edit; a browser that loses its connection for 10 s and edits meanwhile merges on reconnect; after both leave, the
 * saved draft is the merged definition and a run executes it. The same in an app: two people moving components and
 * typing in a query. (Two people on different API processes: apps/server/test/collab.test.ts and the Compose check.)
 */

const WITHIN_A_SECOND = { timeout: 1_000 }
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')

/**
 * The collab sockets of a browser context, passed through to the server, with a switch to cut them: Chrome's offline
 * mode (`context.setOffline`) leaves an open WebSocket open. While cut, the provider's reconnects are refused too.
 */
async function cuttableSockets(context: BrowserContext) {
  let cut = false
  const open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>()
  await context.routeWebSocket(/\/api\/collab\//, (ws) => {
    if (cut) return ws.close({ code: 4000, reason: 'cut' })
    const pair = { page: ws, server: ws.connectToServer() }
    open.add(pair)
    // (An onClose handler turns off Playwright's own forwarding of the close.)
    ws.onClose(() => {
      open.delete(pair)
      void pair.server.close()
    })
  })
  return {
    /** Both ends go: the server sees the peer leave (on a real outage, its ping finds out within 30 s). */
    async cut() {
      cut = true
      for (const { page, server } of [...open]) {
        await server.close()
        await page.close({ code: 4000, reason: 'cut' })
      }
    },
    restore() {
      cut = false
    },
  }
}

async function caretAt(page: Page, editor: Locator, key: 'Home' | 'End') {
  await editor.locator('.view-lines').click({ position: { x: 4, y: 4 } })
  await expect(editor.locator('.monaco-editor')).toHaveClass(/focused/)
  await page.keyboard.press(key)
}

test('two people edit one workflow together, one of them offline for 10 s', async ({ page, browser }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'New workflow' }).click()
  await page.getByPlaceholder('Sync orders').fill(`M16 ${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/)
  const id = page.url().split('/').at(-1)!
  await block(page, 'startTrigger').click()
  await addBlock(page, 'code')
  await saved(page)

  const secondContext = await browser.newContext()
  const sockets = await cuttableSockets(secondContext)
  const second = await secondContext.newPage()
  await signIn(second, E2E_SECOND_EMAIL)
  await second.goto(`/workflows/${id}`)
  await saved(second)
  const mine = field(page, 'code1', 'code.js')
  const theirs = field(second, 'code1', 'code.js')

  await test.step('each sees the other in the header', async () => {
    await expect(page.getByTestId('presence-Second')).toBeVisible()
    await expect(second.getByTestId('presence-E2E')).toBeVisible()
  })

  await test.step('code typed there shows here within a second', async () => {
    await block(second, 'code1').click()
    await expect(mine).toBeVisible()
    await typeInto(second, theirs, 'return "together"')
    await expect.poll(() => editorText(mine), WITHIN_A_SECOND).toBe('return "together"')
  })

  await test.step('a block added and connected here shows there within a second', async () => {
    await addBlock(page, 'response')
    await expect(block(second, 'response1')).toBeVisible(WITHIN_A_SECOND)
    await expect(second.locator('.react-flow__edge')).toHaveCount(2, WITHIN_A_SECOND)
    await typeInto(page, field(page, 'response1', 'body.txt'), '{"merged": {{ code1.data }}}')
    await saved(page)
  })

  await test.step('both type in one code field at once: both kept, each caret shown to the other', async () => {
    await block(page, 'code1').click()
    await caretAt(page, mine, 'End')
    await caretAt(second, theirs, 'Home')
    await Promise.all([
      page.keyboard.type(' + 1', { delay: 60 }),
      second.keyboard.type('/*b*/', { delay: 60 }),
    ])
    const merged = '/*b*/return "together" + 1'
    await expect.poll(() => editorText(mine)).toBe(merged)
    await expect.poll(() => editorText(theirs)).toBe(merged)
    await expect(mine.locator('.ow-remote-caret')).toHaveCount(1)
    await expect(theirs.locator('.ow-remote-caret')).toHaveCount(1)
    await saved(page)
    await saved(second)
  })

  await test.step('selections are outlined with names, and pointers move on the canvas', async () => {
    await expect(page.getByTestId('peers-code1')).toHaveText('Second')
    await expect(second.getByTestId('peers-code1')).toHaveText('E2E')
    const box = (await second.getByTestId('canvas').boundingBox())!
    await second.mouse.move(box.x + 200, box.y + 200)
    await second.mouse.move(box.x + 260, box.y + 240, { steps: 5 })
    await expect(page.getByTestId('pointer-Second')).toBeVisible()
  })

  await test.step("undo takes back one's own typing only", async () => {
    await caretAt(page, mine, 'End')
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => editorText(mine)).toBe('/*b*/return "together"')
    await expect.poll(() => editorText(theirs)).toBe('/*b*/return "together"')
    await saved(page)
  })

  await test.step('offline for 10 s, both edit; on reconnect the edits merge', async () => {
    const lost = Date.now()
    await sockets.cut()
    await expect(second.getByTestId('save-status')).toHaveText('Offline: changes will sync')
    await expect(page.getByTestId('presence-Second')).toHaveCount(0)
    // There: typed offline. Here, meanwhile: the response body changed.
    await caretAt(second, theirs, 'End')
    await second.keyboard.type(' + 2', { delay: 30 })
    await second.keyboard.press('Escape')
    await block(page, 'response1').click()
    await typeInto(page, field(page, 'response1', 'body.txt'), '{"merged": {{ code1.data }}, "ok": true}')
    await saved(page)
    await expect.poll(() => editorText(theirs)).toBe('/*b*/return "together" + 2')
    await block(page, 'code1').click()
    await expect.poll(() => editorText(mine)).toBe('/*b*/return "together"')
    await page.waitForTimeout(Math.max(0, 10_000 - (Date.now() - lost)))

    sockets.restore()
    await saved(second)
    await expect.poll(() => editorText(mine)).toBe('/*b*/return "together" + 2')
    await block(second, 'response1').click()
    await expect
      .poll(() => editorText(field(second, 'response1', 'body.txt')))
      .toBe('{"merged": {{ code1.data }}, "ok": true}')
    await expect(page.getByTestId('presence-Second')).toBeVisible()
    await saved(page)
  })

  await test.step('after both leave, the saved draft is the merged one, and it runs', async () => {
    await secondContext.close()
    await page.goto('/')
    const workflow = await trpcQuery<{ draftDefinition: unknown }>(page, 'workflows.get', { id })
    const draft = JSON.stringify(workflow.draftDefinition)
    expect(draft).toContain(JSON.stringify('/*b*/return "together" + 2'))
    expect(draft).toContain(JSON.stringify('{"merged": {{ code1.data }}, "ok": true}'))

    await page.goto(`/workflows/${id}`)
    await saved(page)
    await page.locator('header').getByRole('button', { name: 'Run', exact: true }).click()
    const panel = page.getByTestId('run-panel')
    await expect(panel.getByTestId('run-status').first()).toHaveText('succeeded')
    await panel.getByRole('button', { name: 'output' }).click()
    await expect(panel.getByTestId('run-output')).toContainText('"merged": "together2"')
    await expect(panel.getByTestId('run-output')).toContainText('"ok": true')
  })
})

test('two people edit one app together: moving components and typing in a query', async ({
  page,
  browser,
}) => {
  await signIn(page)
  const slug = `m16-${Date.now()}`
  const { id } = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name: 'M16' })
  const at = (x: number, y: number) => ({ x, y, w: 4, h: 2 })
  await trpcMutate(page, 'apps.saveDraft', {
    id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        { name: 'total', type: 'text', props: { value: 'Total {{ query1.data }}' } },
        { name: 'note', type: 'text', props: { value: 'A note' } },
      ],
      queries: [{ name: 'query1', kind: 'js', code: 'return 1' }],
      layout: { total: at(0, 0), note: at(0, 2) },
    },
  })
  const appSaved = (p: Page) => expect(p.getByText('Saved', { exact: true })).toBeVisible()
  await page.goto(`/apps/${slug}/edit`)
  await appSaved(page)

  const secondContext = await browser.newContext()
  const second = await secondContext.newPage()
  await signIn(second, E2E_SECOND_EMAIL)
  await second.goto(`/apps/${slug}/edit`)
  await appSaved(second)
  await expect(page.getByTestId('presence-Second')).toBeVisible()
  await expect(second.getByTestId('presence-E2E')).toBeVisible()

  const left = async (p: Page, name: string) => (await p.getByTestId(`frame-${name}`).boundingBox())!.x
  /** Drags a component right, and waits to see it there. Sideways: the grid compacts upwards (down into empty space, back up). */
  const moveRight = async (p: Page, name: string, by: number, past: number) => {
    await p.getByTestId(`frame-${name}`).click()
    // Mouse moves don't scroll: a top-row handle sits in the canvas's top padding, out of sight once it scrolls.
    const handle = p.getByTestId(`frame-${name}`).getByTitle('Drag to move')
    await handle.scrollIntoViewIfNeeded()
    const box = (await handle.boundingBox())!
    await p.mouse.move(box.x + 10, box.y + 5)
    await p.mouse.down()
    await p.mouse.move(box.x + 10 + by, box.y + 5, { steps: 12 })
    await p.mouse.up()
    await expect.poll(() => left(p, name)).toBeGreaterThan(past)
  }

  await test.step('each moves a component; each sees the other move within a second', async () => {
    // (Columns are about 80 px: note ends at the right, total moves two columns and doesn't cross it.)
    const [total, note] = [await left(page, 'total'), await left(page, 'note')]
    await moveRight(second, 'note', 600, note + 400)
    await expect.poll(() => left(page, 'note'), WITHIN_A_SECOND).toBeGreaterThan(note + 400)
    await moveRight(page, 'total', 200, total + 100)
    await expect.poll(() => left(second, 'total'), WITHIN_A_SECOND).toBeGreaterThan(total + 100)
    // Each has the moved component selected: outlined on the other side with their name.
    await expect(page.getByTestId('peers-note')).toHaveText('Second')
    await expect(second.getByTestId('peers-total')).toHaveText('E2E')
    await appSaved(page)
    await appSaved(second)
  })

  await test.step("both type in the query at once: merged; undo takes back one's own", async () => {
    await openCode(page, 'query1')
    await openCode(second, 'query1')
    const mine = page.locator('[data-testid$="/queries/0/code"]')
    const theirs = second.locator('[data-testid$="/queries/0/code"]')
    await caretAt(page, mine, 'End')
    await caretAt(second, theirs, 'Home')
    await Promise.all([
      page.keyboard.type(' + 1', { delay: 60 }),
      second.keyboard.type('/* b */ ', { delay: 60 }),
    ])
    await expect.poll(() => editorText(mine)).toBe('/* b */ return 1 + 1')
    await expect.poll(() => editorText(theirs)).toBe('/* b */ return 1 + 1')
    await expect(mine.locator('.ow-remote-caret')).toHaveCount(1)
    // Undo here takes back only this side's typing.
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => editorText(theirs)).toBe('/* b */ return 1')
    await caretAt(second, theirs, 'End')
    await second.keyboard.type(' + 41', { delay: 30 })
    await expect.poll(() => editorText(mine)).toBe('/* b */ return 1 + 41')
    await appSaved(page)
    await appSaved(second)
  })

  await test.step('after both leave, the saved draft is the merged one, and it runs', async () => {
    await secondContext.close()
    await page.goto('/')
    const app = await trpcQuery<{
      draftDefinition: { queries: { code: string }[]; layout: Record<string, { x: number }> }
    }>(page, 'apps.get', { slug })
    expect(app.draftDefinition.queries[0]!.code).toBe('/* b */ return 1 + 41')
    expect(app.draftDefinition.layout.total!.x).toBeGreaterThan(0)
    expect(app.draftDefinition.layout.note!.x).toBeGreaterThan(0)

    await page.goto(`/apps/${slug}/edit`)
    await appSaved(page)
    await openCode(page, 'query1')
    await page.getByTestId('query-query1').click()
    // Run is retried: twice in about 80 runs, a Run right after reopening was lost (result null; handoff §12).
    await expect(async () => {
      await page.getByRole('button', { name: 'Run' }).click()
      await expect(page.getByTestId('frame-total')).toContainText('Total 42', { timeout: 3_000 })
    }).toPass()
  })
})
