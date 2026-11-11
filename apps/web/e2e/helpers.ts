import { expect, type Locator, type Page } from '@playwright/test'
import { E2E_EMAIL, E2E_PASSWORD } from './global-setup'

export async function signIn(page: Page, email = E2E_EMAIL) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The first section they can reach (Workflows for admins), or the welcome page with none.
  await expect(page).toHaveURL(
    /\/(workflows|apps|library|modules|component-libraries|resources|database|runs|inbox|start)$/,
  )
}

/** A tRPC mutation as the signed-in user (the page's cookies), returning its data. */
export async function trpcMutate<T = Record<string, unknown>>(
  page: Page,
  path: string,
  input: unknown,
): Promise<T> {
  const res = await page.request.post(`/api/trpc/${path}`, { data: { json: input } })
  const body = await res.json()
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${JSON.stringify(body)}`)
  return body.result.data.json
}

export async function trpcQuery<T = Record<string, unknown>>(
  page: Page,
  path: string,
  input: unknown,
): Promise<T> {
  const res = await page.request.get(
    `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
  )
  const body = await res.json()
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${JSON.stringify(body)}`)
  return body.result.data.json
}

export const block = (page: Page, name: string) => page.getByTestId(`block-${name}`)

/** A block's Monaco field, by the end of its model path (`<workflow>/<block>/<file>`). */
export const field = (page: Page, blockName: string, file: string) =>
  page.locator(`[data-testid$="/${blockName}/${file}"]`)

/** A block's name field: its title, double-clicked (M28). */
export async function nameField(page: Page, blockName: string) {
  // Shown first (from the Outline, which centres it), then selected: the click that selects a block re-renders it,
  // and a double-click's second click is lost.
  const outline = await openRail(page, 'outline')
  await outline.getByRole('button', { name: blockName, exact: true }).click()
  await page.getByTestId('rail-outline').click()
  await page.getByTestId(`block-title-${blockName}`).click()
  await page.getByTestId(`block-title-${blockName}`).dblclick()
  return block(page, blockName).getByTestId('block-name')
}

/** Opens one of the workflow editor's rail panels (M28), unless it's open already. */
export async function openRail(page: Page, panel: string) {
  const button = page.getByTestId(`rail-${panel}`)
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
  return page.getByTestId('rail-panel')
}

/** Adds a block from the rail's Blocks panel (after the selected block, connected to it). */
export async function addBlock(page: Page, kind: string) {
  await openRail(page, 'blocks')
  await page.getByTitle(`Add a ${kind} block`).click()
  await canvasSettled(page)
}

/**
 * Waits for the canvas to stop moving: an added block is brought into view (a 200 ms pan 150 ms after it's added),
 * and a drag started meanwhile misses its handles.
 */
export async function canvasSettled(page: Page) {
  const transform = () => page.locator('.react-flow__viewport').getAttribute('style')
  await page.waitForTimeout(400)
  await expect
    .poll(async () => {
      const before = await transform()
      await page.waitForTimeout(100)
      return before === (await transform())
    })
    .toBe(true)
}

/**
 * Replaces a Monaco field's text. The text is inserted in one go, like a paste: typed key by key, Monaco's
 * auto-closing of brackets and quotes races the keystrokes on a slow machine (`{"id": 1}` became `{"id"}: 1}` in CI).
 * The whole replacement is retried until the field shows the text.
 */
export async function typeInto(page: Page, editor: Locator, text: string) {
  // On the canvas a block's code field is a preview until the block is selected (M28): a click makes it an editor.
  if (await isPreview(editor)) await editor.first().click()
  const monaco = editor.locator('.monaco-editor')
  await expect(async () => {
    // On the first visible line, in the field's middle: the lines can be taller and wider than the field (they
    // scroll inside it), so a point on them can be outside it, under the next field or a header; the field's own
    // box can't.
    const box = await monaco.boundingBox()
    await monaco.click({ position: { x: (box?.width ?? 40) / 2, y: Math.min(10, (box?.height ?? 20) / 2) } })
    await expect(monaco).toHaveClass(/focused/, { timeout: 1000 })
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(text)
    await page.keyboard.press('Escape')
    await expect.poll(() => editorText(editor), { timeout: 2000 }).toBe(text)
  }).toPass()
}

/**
 * The text a Monaco field shows. Monaco renders spaces as non-breaking spaces, and long lines wrap onto several
 * rendered lines; the fields this test types are single lines, so line breaks are dropped.
 */
export async function editorText(editor: Locator): Promise<string> {
  const text = (await isPreview(editor))
    ? await editor.first().innerText()
    : await editor.locator('.view-lines').innerText()
  return text.replace(/ /g, ' ').replace(/\n/g, '').trim()
}

/** Whether a code field is a node's preview of its text rather than an editor. */
async function isPreview(field: Locator): Promise<boolean> {
  const id = await field
    .first()
    .getAttribute('data-testid', { timeout: 5000 })
    .catch(() => null)
  return id?.startsWith('code-preview-') ?? false
}

/** Drags from one handle to another in small steps, as React Flow expects. */
export async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 })
  await page.mouse.up()
}

/** Clicks an empty part of the canvas (the toolbar floats top left, controls and minimap sit at the bottom). */
export async function clickEmptyCanvas(page: Page) {
  const box = (await page.locator('.react-flow__pane').boundingBox())!
  await page.mouse.click(box.x + box.width - 40, box.y + 80)
}

/** Global setup's fake Pub/Sub (`orders` and `refunds`, each with a `<topic>-sub`), through its control routes. */
/** The fake SQS (M26), through the setup's control routes. */
export const fakeSqs = {
  send: async (
    queue: string,
    body: string,
    opts: { attributes?: Record<string, string>; groupId?: string } = {},
  ) =>
    (
      await (
        await fetch(
          `${process.env.E2E_IAP_CONTROL}/sqs/send?${new URLSearchParams({
            queue,
            body,
            attributes: JSON.stringify(opts.attributes ?? {}),
            groupId: opts.groupId ?? '',
          })}`,
          { method: 'POST' },
        )
      ).json()
    ).messageId as string,
  messages: async (queue: string) =>
    (await (await fetch(`${process.env.E2E_IAP_CONTROL}/sqs/messages?queue=${queue}`)).json()) as {
      messageId: string
      body: string
      receiveCount: number
      deleted: boolean
      movedFrom?: string
    }[],
}

/** The Kafka broker (M26), through the setup's control routes; specs skip without E2E_KAFKA. */
export const testKafka = {
  produce: async (topic: string, value: string, key?: string, headers: Record<string, string> = {}) => {
    await fetch(
      `${process.env.E2E_IAP_CONTROL}/kafka/produce?${new URLSearchParams({ topic, value, key: key ?? '', headers: JSON.stringify(headers) })}`,
      { method: 'POST' },
    )
  },
  read: async (topic: string, count = 1) =>
    (await (
      await fetch(`${process.env.E2E_IAP_CONTROL}/kafka/read?topic=${topic}&count=${count}`)
    ).json()) as {
      key: string | null
      value: string | null
      headers: Record<string, string>
    }[],
}

export const fakePubSub = {
  publish: async (topic: string, data: string, attributes: Record<string, string> = {}) =>
    (
      await (
        await fetch(
          `${process.env.E2E_IAP_CONTROL}/pubsub/publish?${new URLSearchParams({ topic, data, attributes: JSON.stringify(attributes) })}`,
          { method: 'POST' },
        )
      ).json()
    ).messageId as string,
  published: async (topic: string) =>
    (await (await fetch(`${process.env.E2E_IAP_CONTROL}/pubsub/published?topic=${topic}`)).json()) as {
      messageId: string
      data: string
    }[],
  redeliver: async (subscription: string, messageId: string) => {
    await fetch(
      `${process.env.E2E_IAP_CONTROL}/pubsub/redeliver?${new URLSearchParams({ subscription, messageId })}`,
      { method: 'POST' },
    )
  },
  messages: async (subscription: string) =>
    (await (
      await fetch(`${process.env.E2E_IAP_CONTROL}/pubsub/messages?subscription=${subscription}`)
    ).json()) as {
      messageId: string
      data: string
      deliveries: number
      acked: boolean
    }[],
}

/**
 * Confirms each confirmation the platform asks (M24: its dialog took the place of the browser's `confirm()`, which
 * `page.on('dialog', …)` used to accept): from now on in this page, and after it navigates.
 */
export async function acceptConfirms(page: Page): Promise<void> {
  const watch = () => {
    const click = () => document.querySelector<HTMLButtonElement>('[data-testid="confirm-ok"]')?.click()
    // The document itself: in an init script its root element may not exist yet.
    new MutationObserver(click).observe(document, { childList: true, subtree: true })
  }
  await page.addInitScript(watch)
  await page.evaluate(watch)
}

/** The app editor's rail panels (session 41): one shows at a time, left of the canvas. */
export type EditorPanel =
  | 'Add components'
  | 'Pages'
  | 'Module'
  | 'Component tree'
  | 'Code'
  | 'Search'
  | 'State'
  | 'History'
  | 'App settings'

/** Shows that panel in the app or module editor (a no-op when it's already showing). */
export async function openEditorPanel(page: Page, panel: EditorPanel) {
  const tab = page
    .getByRole('tablist', { name: 'Editor panels' })
    .getByRole('tab', { name: panel, exact: true })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

/** Opens the app editor's debug drawer on Problems or the console, from the status bar. */
export async function openDebug(page: Page, tab: 'Problems' | 'Console') {
  const drawer = page.getByRole('tablist', { name: 'Debug' })
  if (!(await drawer.isVisible()))
    await page
      .getByTestId('status-bar')
      .getByRole('button', { name: tab === 'Problems' ? /problem/i : /^Console/ })
      .click()
  await drawer.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
}

/** Opens a query, transformer or variable in the app editor's code dock, from the Code panel. */
export async function openCode(page: Page, name: string) {
  await openEditorPanel(page, 'Code')
  await page.getByRole('navigation', { name: 'Code' }).getByRole('button', { name, exact: true }).click()
}
