import { createDb } from '@ow/db'
import type { Page } from '@playwright/test'
import { E2E_EMAIL, E2E_MEMBER_EMAIL, E2E_SECOND_EMAIL, E2E_WAITING_EMAIL } from '../e2e/global-setup'
import { trpcMutate, trpcQuery } from '../e2e/helpers'

/**
 * Demo data for the manuals' screenshots: a fictional wholesaler's workflows, apps, resources and people. Nothing in
 * here is real: the names are made up, the hosts are example.com ones, the secrets are placeholders.
 */

/** The e2e's people, renamed so the screenshots show names rather than test accounts. */
export const PEOPLE = {
  admin: { from: E2E_EMAIL, email: 'sanne.devries@optiply.nl', name: 'Sanne de Vries' },
  second: { from: E2E_SECOND_EMAIL, email: 'thomas.bakker@optiply.nl', name: 'Thomas Bakker' },
  member: { from: E2E_MEMBER_EMAIL, email: 'lotte.jansen@optiply.nl', name: 'Lotte Jansen' },
  waiting: { from: E2E_WAITING_EMAIL, email: 'daan.visser@optiply.nl', name: 'Daan Visser' },
} as const

/** More people, active, for a fuller Users page (they never sign in). */
const EXTRA_PEOPLE = [
  { email: 'mila.smit@optiply.nl', name: 'Mila Smit' },
  { email: 'ruben.dejong@optiply.nl', name: 'Ruben de Jong' },
  { email: 'noor.mulder@optiply.nl', name: 'Noor Mulder' },
]

export const SLUGS = {
  overstock: 'sync-overstock-to-slack',
  report: 'daily-supplier-report',
  approve: 'approve-purchase-orders',
  reorder: 'reorder-suggestions',
  invoices: 'match-supplier-invoices',
  dashboard: 'supplier-dashboard',
}

export type Demo = {
  production: string
  staging: string
  folders: { operations: string; finance: string }
  workflows: { overstock: string; report: string; approve: string; reorder: string; invoices: string }
  apps: { dashboard: string }
  resources: { warehouse: string; supplierApi: string }
  groups: { operations: string; finance: string }
  users: { admin: string; member: string; second: string }
  library: string
  module: string
}

type Env = { id: string; slug: string; name: string; isDefault: boolean }

const pg = () => {
  const url = process.env.E2E_PG_URL
  if (!url) throw new Error('E2E_PG_URL is missing: run with playwright.manual.config.ts (its global setup)')
  return url
}

/**
 * Straight into the throwaway e2e database: people's names, a few more people, and the warehouse tables the demo's
 * Postgres resource reads. (The test database only; never a real one.)
 */
export async function seedDatabase() {
  const { sql, close } = createDb(pg(), { max: 1 })
  try {
    for (const p of Object.values(PEOPLE)) {
      await sql`update users set name = ${p.name}, email = ${p.email}, last_login_at = now() - interval '2 hours'
        where email = ${p.from}`
    }
    await sql`update users set last_login_at = null where email = ${PEOPLE.waiting.email}`
    for (const [i, p] of EXTRA_PEOPLE.entries()) {
      await sql`insert into users (id, email, name, status, last_login_at)
        values (gen_random_uuid(), ${p.email}, ${p.name}, 'active', now() - ${`${i + 1} days`}::interval)
        on conflict (email) do nothing`
    }
    await sql.unsafe(`
      create table if not exists stock_levels (
        sku text primary key, product text not null, supplier text not null,
        stock int not null, max_stock int not null, reorder_point int not null);
      insert into stock_levels values
        ('LMP-1042', 'Desk lamp, brass', 'Bloom & Co', 412, 250, 60),
        ('CHR-2210', 'Dining chair, oak', 'Nordhout', 96, 120, 30),
        ('RUG-0815', 'Wool rug 160x230', 'Weverij Twente', 38, 40, 12),
        ('MUG-3300', 'Stoneware mug, sage', 'Bloom & Co', 1280, 900, 200),
        ('VAS-7781', 'Glass vase, smoke', 'Lumen Glas', 14, 80, 20),
        ('TBL-5120', 'Side table, walnut', 'Nordhout', 61, 50, 10),
        ('PLW-4402', 'Linen pillow, rust', 'Weverij Twente', 7, 150, 40),
        ('CND-9001', 'Soy candle, cedar', 'Lumen Glas', 530, 400, 100)
      on conflict do nothing;
      create table if not exists purchase_orders (
        id text primary key, supplier text not null, lines int not null, total numeric(10,2) not null,
        status text not null, created_at date not null);
      insert into purchase_orders values
        ('PO-2026-0412', 'Bloom & Co', 6, 4820.00, 'waiting', '2026-11-12'),
        ('PO-2026-0411', 'Nordhout', 3, 2310.50, 'approved', '2026-11-11'),
        ('PO-2026-0409', 'Lumen Glas', 9, 1275.25, 'approved', '2026-11-10'),
        ('PO-2026-0405', 'Weverij Twente', 4, 3980.00, 'sent', '2026-11-07')
      on conflict do nothing;
    `)
  } finally {
    await close()
  }
}

/** Everything the tour shows. Idempotent enough to run against a server that has it already (it returns early). */
export async function seed(page: Page): Promise<Demo> {
  const envs = await trpcQuery<Env[]>(page, 'environments.list', undefined)
  const production = envs.find((e) => e.slug === 'production')!.id
  const staging = envs.find((e) => e.slug === 'staging')?.id ?? production
  const users = await trpcQuery<{ id: string; email: string }[]>(page, 'users.list', undefined)
  const userId = (email: string) => users.find((u) => u.email === email)!.id

  const existing = await trpcQuery<{ id: string; slug: string }[]>(page, 'workflows.list', undefined)
  if (existing.some((w) => w.slug === SLUGS.overstock)) return lookup(page, production, staging, userId)

  // Resources: the warehouse database (the e2e Postgres, in both environments) and a supplier's REST API.
  const url = new URL(pg())
  const warehouse = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'postgres',
    name: 'Warehouse DB',
    slug: 'warehouse_db',
  })
  // Production reaches the e2e database (the demo's runs query it); staging shows what a real setup looks like.
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: warehouse.id,
    environmentId: production,
    config: {
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      ssl: 'disable',
    },
    secrets: { password: decodeURIComponent(url.password) },
  })
  if (staging !== production) {
    await trpcMutate(page, 'resources.saveConfig', {
      resourceId: warehouse.id,
      environmentId: staging,
      config: {
        host: 'warehouse-staging.db.example.com',
        port: 5432,
        database: 'warehouse',
        user: 'workflows_readonly',
        ssl: 'require',
      },
      secrets: { password: 'demo-password-not-real' },
    })
  }
  const supplierApi = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Supplier API',
    slug: 'supplier_api',
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: supplierApi.id,
    environmentId: production,
    config: {
      baseUrl: 'https://api.supplier-portal.example.com/v2',
      headers: [{ key: 'Accept', value: 'application/json' }],
      params: [],
      auth: { type: 'bearer' },
    },
    secrets: { bearerToken: 'demo-token-not-real' },
  })
  const slack = await trpcMutate<{ id: string }>(page, 'resources.create', {
    type: 'rest',
    name: 'Slack webhook',
    slug: 'slack_ops',
  })
  await trpcMutate(page, 'resources.saveConfig', {
    resourceId: slack.id,
    environmentId: production,
    // The e2e's fake services echo the message (a real Slack webhook in production).
    config: {
      baseUrl: `${process.env.E2E_SERVICES}/_fake/echo`,
      headers: [],
      params: [],
      auth: { type: 'none' },
      allowPrivateNetwork: true,
    },
    secrets: {},
  })

  // Config vars.
  const vars: [string, string, boolean, string, string][] = [
    ['SLACK_CHANNEL', 'Where stock alerts go', false, '#ops-stock', '#ops-stock-test'],
    ['OVERSTOCK_MARGIN', 'Percent above max stock before we alert', false, '10', '0'],
    ['SUPPLIER_API_TOKEN', 'The supplier portal token', true, 'demo-secret-not-real', 'demo-secret-staging'],
    ['WAREHOUSE_REGION', 'Region of the main warehouse', false, 'eu-west', 'eu-west'],
  ]
  for (const [name, description, isSecret, prod, stag] of vars) {
    const v = await trpcMutate<{ id: string }>(page, 'configVars.create', { name, description, isSecret })
    await trpcMutate(page, 'configVars.setValue', {
      configVarId: v.id,
      environmentId: production,
      value: prod,
    })
    if (staging !== production) {
      await trpcMutate(page, 'configVars.setValue', {
        configVarId: v.id,
        environmentId: staging,
        value: stag,
      })
    }
  }

  // Groups, people and what they may use.
  const opsGroup = await trpcMutate<{ id: string }>(page, 'groups.create', {
    name: 'Operations',
    description: 'Warehouse and supply chain',
  })
  const finGroup = await trpcMutate<{ id: string }>(page, 'groups.create', {
    name: 'Finance',
    description: 'Buyers and controllers',
  })
  await trpcMutate(page, 'groups.create', { name: 'Customer success', description: 'Support and onboarding' })
  for (const email of [PEOPLE.member.email, 'ruben.dejong@optiply.nl', PEOPLE.second.email]) {
    await trpcMutate(page, 'groups.addMember', { groupId: opsGroup.id, userId: userId(email) })
  }
  for (const email of ['mila.smit@optiply.nl', 'noor.mulder@optiply.nl', PEOPLE.member.email]) {
    await trpcMutate(page, 'groups.addMember', { groupId: finGroup.id, userId: userId(email) })
  }

  // Folders and workflows.
  const operations = await trpcMutate<{ id: string }>(page, 'folders.create', {
    name: 'Operations',
    type: 'workflow',
  })
  const finance = await trpcMutate<{ id: string }>(page, 'folders.create', {
    name: 'Finance',
    type: 'workflow',
  })
  const flow = async (slug: string, name: string, description: string, folderId: string | null) =>
    (await trpcMutate<{ id: string }>(page, 'workflows.create', { slug, name, description, folderId })).id
  const overstock = await flow(
    SLUGS.overstock,
    'Sync overstock to Slack',
    'Posts products above their max stock to #ops-stock',
    operations.id,
  )
  const report = await flow(SLUGS.report, 'Daily supplier report', 'Stock per supplier, every morning', null)
  await flow(
    'notify-late-deliveries',
    'Notify late deliveries',
    'Deliveries past their promised date',
    operations.id,
  )
  await flow('weekly-kpi-digest', 'Weekly KPI digest', 'Service level and stock value, every Monday', null)
  const approve = await flow(
    SLUGS.approve,
    'Approve purchase orders',
    'Large orders wait for a buyer',
    finance.id,
  )
  const reorder = await flow(SLUGS.reorder, 'Reorder suggestions', 'Products below their reorder point', null)
  const invoices = await flow(
    SLUGS.invoices,
    'Match supplier invoices',
    'Invoices against purchase orders',
    finance.id,
  )

  const save = async (id: string, definition: object) => {
    const current = await trpcQuery<{ draftRevision: number }>(page, 'workflows.get', { id })
    const saved = await trpcMutate<{ revision: number }>(page, 'workflows.saveDraft', {
      id,
      revision: current.draftRevision,
      definition: { schemaVersion: 1, ...definition },
    })
    return saved.revision
  }
  const publish = async (id: string, draftRevision: number, notes?: string) =>
    trpcMutate(page, 'releases.publish', { workflowId: id, draftRevision, ...(notes && { notes }) })

  // Sync overstock to Slack: the editor's main example.
  const overstockDef = {
    blocks: [
      { name: 'startTrigger', type: 'startTrigger', config: { testInput: { margin: 10 } } },
      {
        name: 'getStock',
        type: 'resourceQuery',
        description: 'Products and their stock levels',
        config: {
          resource: 'warehouse_db',
          query: {
            sql: 'select sku, product, supplier, stock, max_stock\n  from stock_levels\n where stock > max_stock * (1 + {{ startTrigger.data.margin ?? 0 }} / 100.0)\n order by stock - max_stock desc',
          },
        },
      },
      {
        name: 'formatMessage',
        type: 'code',
        description: 'One Slack line per product',
        config: {
          code: [
            'const lines = getStock.data.map(',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: code run in the sandbox, not here
            '  (p) => `• ${p.product} (${p.sku}): ${p.stock} in stock, max ${p.max_stock}`,',
            ')',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: code run in the sandbox, not here
            'console.log(`${lines.length} products above their max stock`)',
            'return { count: lines.length, text: lines.join("\\n") }',
          ].join('\n'),
        },
      },
      {
        name: 'anyOverstock',
        type: 'branch',
        config: {
          conditions: [
            { id: 'c1', expression: 'formatMessage.data.count > 0' },
            { id: 'c2', expression: 'startTrigger.data.dryRun === true' },
          ],
        },
      },
      {
        name: 'postToSlack',
        type: 'resourceQuery',
        config: {
          resource: 'slack_ops',
          query: {
            method: 'POST',
            path: '',
            params: [],
            headers: [],
            body: {
              type: 'json',
              json: '{"channel": "{{ configVars.SLACK_CHANNEL }}", "text": {{ JSON.stringify(formatMessage.data.text) }}}',
            },
          },
        },
      },
      {
        name: 'reply',
        type: 'response',
        config: { status: '200', body: '{"overstocked": {{ formatMessage.data.count }}}' },
      },
      { name: 'nothingToDo', type: 'response', config: { status: '200', body: '{"overstocked": 0}' } },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'getStock' },
      { from: 'getStock', port: 'out', to: 'formatMessage' },
      { from: 'formatMessage', port: 'out', to: 'anyOverstock' },
      { from: 'anyOverstock', port: 'cond:c1', to: 'postToSlack' },
      { from: 'postToSlack', port: 'out', to: 'reply' },
      { from: 'anyOverstock', port: 'cond:c2', to: 'reply' },
      { from: 'anyOverstock', port: 'else', to: 'nothingToDo' },
    ],
    triggers: {
      webhook: { enabled: true, methods: ['POST'] },
      schedules: [
        { name: 'weekday-mornings', enabled: true, cron: '0 8 * * 1-5', timezone: 'Europe/Amsterdam' },
        { name: 'hourly-check', enabled: false, intervalMs: 3_600_000 },
      ],
    },
    settings: { timeoutMs: 120_000 },
  }
  const r1 = await save(overstock, overstockDef)
  await publish(overstock, r1, 'First version')
  const r2 = await save(overstock, {
    ...overstockDef,
    blocks: overstockDef.blocks.map((b) =>
      b.name === 'startTrigger' ? { ...b, config: { testInput: { margin: 10, dryRun: false } } } : b,
    ),
  })
  await publish(overstock, r2, 'A dry run option')
  await trpcMutate(page, 'workflows.update', { id: overstock, maxConcurrentRuns: 2 })

  // Daily supplier report: Python, a loop and a schedule; one of its runs fails.
  const reportRev = await save(report, {
    blocks: [
      { name: 'startTrigger', type: 'startTrigger', config: { testInput: { date: '2026-11-13' } } },
      {
        name: 'suppliers',
        type: 'resourceQuery',
        config: {
          resource: 'warehouse_db',
          query: {
            sql: 'select supplier, count(*) as products, sum(stock) as units\n  from stock_levels group by supplier order by supplier',
          },
        },
      },
      {
        name: 'summarise',
        type: 'code',
        description: 'Totals per supplier, in Python',
        config: {
          language: 'python',
          code: [
            'rows = suppliers["data"]',
            'total = sum(int(r["units"]) for r in rows)',
            'print(f"{len(rows)} suppliers, {total} units in stock")',
            'largest = max(rows, key=lambda r: int(r["units"]))["supplier"]',
            'return {"suppliers": len(rows), "units": total, "largest": largest}',
          ].join('\n'),
        },
      },
      {
        name: 'perSupplier',
        type: 'loop',
        description: 'One message per supplier',
        config: {
          input: '{{ suppliers.data }}',
          mode: 'sequential',
          runner: {
            kind: 'code',
            code: [
              'if (!value.supplier) throw new Error("Supplier feed returned a row without a supplier")',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: code run in the sandbox, not here
              'return `${value.supplier}: ${value.units} units over ${value.products} products`',
            ].join('\n'),
          },
          onError: 'stop',
        },
      },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'suppliers' },
      { from: 'suppliers', port: 'out', to: 'summarise' },
      { from: 'summarise', port: 'out', to: 'perSupplier' },
    ],
    triggers: {
      schedules: [{ name: 'every-morning', enabled: true, cron: '30 6 * * *', timezone: 'Europe/Amsterdam' }],
    },
  })
  await publish(report, reportRev, 'Daily report')

  // Approve purchase orders: a User Task.
  const approveRev = await save(approve, {
    blocks: [
      {
        name: 'startTrigger',
        type: 'startTrigger',
        config: { testInput: { po: 'PO-2026-0412', supplier: 'Bloom & Co', total: 4820 } },
      },
      {
        name: 'approval',
        type: 'userTask',
        config: {
          title:
            'Approve {{ startTrigger.data.po }} for {{ startTrigger.data.supplier }} (€ {{ startTrigger.data.total }})',
          description:
            'Orders above € 2,500 need a buyer’s approval before they go to the supplier. Check the quantities against the forecast.',
          assignees: { users: [PEOPLE.admin.email], groups: ['Finance'] },
          fields: [
            {
              name: 'budget',
              label: 'Budget line',
              type: 'select',
              options: ['Q4 restock', 'Seasonal', 'New products'],
              required: true,
            },
            {
              name: 'total',
              label: 'Approved amount (€)',
              type: 'number',
              default: '{{ startTrigger.data.total }}',
            },
            {
              name: 'note',
              label: 'Note for the supplier',
              type: 'longText',
              help: 'Sent along with the order',
            },
          ],
          outcomes: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
          ],
          due: { amount: '2', unit: 'days' },
        },
      },
      {
        name: 'decision',
        type: 'branch',
        config: { conditions: [{ id: 'c1', expression: "approval.data.outcome === 'approve'" }] },
      },
      {
        name: 'sendOrder',
        type: 'resourceQuery',
        config: {
          resource: 'supplier_api',
          query: {
            method: 'POST',
            path: '/orders',
            params: [],
            headers: [],
            body: { type: 'json', json: '{"po": "{{ startTrigger.data.po }}"}' },
          },
        },
      },
      {
        name: 'markRejected',
        type: 'resourceQuery',
        config: {
          resource: 'warehouse_db',
          query: {
            sql: "update purchase_orders set status = 'rejected' where id = {{ startTrigger.data.po }}",
          },
        },
      },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'approval' },
      { from: 'approval', port: 'out', to: 'decision' },
      { from: 'decision', port: 'cond:c1', to: 'sendOrder' },
      { from: 'decision', port: 'else', to: 'markRejected' },
    ],
    triggers: { webhook: { enabled: true } },
  })
  await publish(approve, approveRev, 'Approval flow')

  const reorderRev = await save(reorder, {
    blocks: [
      { name: 'startTrigger', type: 'startTrigger' },
      {
        name: 'belowReorderPoint',
        type: 'resourceQuery',
        config: {
          resource: 'warehouse_db',
          query: {
            sql: 'select sku, product, stock, reorder_point from stock_levels where stock < reorder_point',
          },
        },
      },
      { name: 'reply', type: 'response', config: { status: '200', body: '{{ belowReorderPoint.data }}' } },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'belowReorderPoint' },
      { from: 'belowReorderPoint', port: 'out', to: 'reply' },
    ],
    triggers: { webhook: { enabled: true } },
  })
  await publish(reorder, reorderRev)
  const invoicesRev = await save(invoices, {
    blocks: [
      { name: 'startTrigger', type: 'startTrigger', config: { testInput: { invoice: 'INV-88213' } } },
      {
        name: 'openOrders',
        type: 'resourceQuery',
        config: {
          resource: 'warehouse_db',
          query: { sql: "select id, supplier, total from purchase_orders where status <> 'sent'" },
        },
      },
      {
        name: 'match',
        type: 'code',
        config: {
          code: [
            'const order = openOrders.data.find((o) => o.id === startTrigger.data.po)',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: code run in the sandbox, not here
            'if (!order) throw new Error(`Invoice ${startTrigger.data.invoice} has no matching purchase order`)',
            'return { invoice: startTrigger.data.invoice, order: order.id }',
          ].join('\n'),
        },
      },
    ],
    edges: [
      { from: 'startTrigger', port: 'out', to: 'openOrders' },
      { from: 'openOrders', port: 'out', to: 'match' },
    ],
  })
  await publish(invoices, invoicesRev)

  // Shared with Lotte herself, besides her groups.
  for (const [objectType, objectId, level] of [
    ['workflow', reorder, 'edit'],
    ['resource', supplierApi.id, 'use'],
  ] as const) {
    await trpcMutate(page, 'permissions.set', {
      objectType,
      objectId,
      userId: userId(PEOPLE.member.email),
      environmentId: null,
      level,
    })
  }

  // API keys (one starts some of the runs below through the webhooks).
  const webshopKey = await trpcMutate<{ key: string }>(page, 'apiKeys.create', {
    name: 'Webshop order events',
    workflowIds: [overstock, approve, reorder],
  })
  await trpcMutate(page, 'apiKeys.create', {
    name: 'Data warehouse sync',
    environmentIds: [production],
    expiresAt: new Date(Date.now() + 180 * 86_400_000),
  })
  await trpcMutate(page, 'apiKeys.create', { name: 'Staging tests', environmentIds: [staging] })
  // Runs of the live releases: from webhooks (with the API key) and by hand; one fails, one waits for its task.
  const start = (slug: string, input: unknown) =>
    page.request.post(`/api/v1/workflows/${slug}/runs`, { data: { input, version: 'live' } })
  const hook = (slug: string, body: unknown) =>
    page.request.post(`/api/v1/workflows/${slug}/webhook`, {
      headers: { 'x-api-key': webshopKey.key },
      data: body,
    })
  await hook(SLUGS.overstock, { margin: 10 })
  await start(SLUGS.overstock, { margin: 0 })
  await hook(SLUGS.reorder, {})
  if (process.env.E2E_PYTHON) await start(SLUGS.report, { date: '2026-11-13' })
  await start(SLUGS.invoices, { invoice: 'INV-88211', po: 'PO-2026-0411' })
  await start(SLUGS.invoices, { invoice: 'INV-88213', po: 'PO-2026-0399' })
  await hook(SLUGS.overstock, { margin: 25 })
  await start(SLUGS.approve, { po: 'PO-2026-0412', supplier: 'Bloom & Co', total: 4820 })

  const grant = (objectType: string, objectId: string | null, groupId: string, level: string) =>
    trpcMutate(page, 'permissions.set', { objectType, objectId, groupId, environmentId: null, level })
  await grant('folder', operations.id, opsGroup.id, 'edit')
  await grant('workflow', null, opsGroup.id, 'use')
  await grant('library_query', null, opsGroup.id, 'use')
  await grant('folder', finance.id, finGroup.id, 'edit')
  await grant('resource', warehouse.id, opsGroup.id, 'use')
  await grant('workflow', overstock, finGroup.id, 'use')
  await trpcMutate(page, 'permissions.set', {
    objectType: 'workflow',
    objectId: overstock,
    userId: userId('mila.smit@optiply.nl'),
    environmentId: null,
    level: 'edit',
  })

  // The admin's own access tokens.
  // The one scope there is: publishing component libraries from the CLI.
  const scopes = ['component-libraries']
  // Its expiry is a Date, sent the way superjson sends one.
  const res = await page.request.post('/api/trpc/accessTokens.create', {
    data: {
      json: { name: 'Laptop CLI', scopes, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() },
      meta: { values: { expiresAt: ['Date'] } },
    },
  })
  if (!res.ok()) throw new Error(`accessTokens.create: ${res.status()} ${await res.text()}`)
  await trpcMutate(page, 'accessTokens.create', { name: 'CI deploys', scopes, expiresAt: null })

  // Database tables (the built-in database, production).
  await databaseTables(page)

  // A library query, a module, a component library.
  const lib = await trpcMutate<{ id: string }>(page, 'libraryQueries.create', {
    slug: 'stock_by_supplier',
    name: 'Stock by supplier',
    description: 'Every product of one supplier with its stock levels',
  })
  const libSaved = await trpcMutate<{ revision: number }>(page, 'libraryQueries.saveDraft', {
    id: lib.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      resource: 'warehouse_db',
      query: {
        sql: 'select sku, product, stock, max_stock, reorder_point\n  from stock_levels\n where supplier = {{ supplier }}\n order by product',
      },
      params: [{ name: 'supplier', description: 'The supplier’s name, e.g. Nordhout' }],
    },
  })
  await trpcMutate(page, 'libraryQueries.publish', {
    libraryQueryId: lib.id,
    draftRevision: libSaved.revision,
  })
  const lib2 = await trpcMutate<{ id: string }>(page, 'libraryQueries.create', {
    slug: 'open_purchase_orders',
    name: 'Open purchase orders',
  })
  await trpcMutate(page, 'libraryQueries.saveDraft', {
    id: lib2.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      resource: 'warehouse_db',
      query: { sql: "select * from purchase_orders where status <> 'sent' order by created_at desc" },
      params: [],
    },
  })

  const mod = await trpcMutate<{ id: string }>(page, 'modules.create', {
    slug: 'supplier_picker',
    name: 'Supplier picker',
  })
  const modSaved = await trpcMutate<{ revision: number }>(page, 'modules.saveDraft', {
    id: mod.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      components: [
        {
          name: 'supplier',
          type: 'select',
          props: {
            label: 'Supplier',
            options: '{{ supplierList.data.map((r) => r.supplier) }}',
            defaultValue: '{{ inputs.initial }}',
          },
        },
        { name: 'count', type: 'text', props: { value: '{{ supplierList.data.length }} suppliers' } },
      ],
      queries: [
        {
          name: 'supplierList',
          kind: 'resource',
          resource: 'warehouse_db',
          run: 'auto',
          query: { sql: 'select distinct supplier from stock_levels order by supplier' },
        },
      ],
      layout: { supplier: { x: 0, y: 0, w: 8, h: 4 }, count: { x: 8, y: 0, w: 4, h: 3 } },
      module: {
        inputs: [{ name: 'initial', default: 'Nordhout', testValue: 'Bloom & Co' }],
        outputs: [{ name: 'selected', value: '{{ supplier.value }}' }],
        events: [],
      },
    },
  })
  await trpcMutate(page, 'modules.publish', { moduleId: mod.id, draftRevision: modSaved.revision })
  await trpcMutate(page, 'modules.create', { slug: 'order_header', name: 'Order header' })

  const cl = await trpcMutate<{ id: string }>(page, 'componentLibraries.create', {
    slug: 'optiply_widgets',
    name: 'Optiply widgets',
  })
  await trpcMutate(page, 'componentLibraries.saveDraft', {
    id: cl.id,
    revision: 1,
    definition: {
      schemaVersion: 1,
      files: [
        {
          path: 'src/StockGauge.tsx',
          content: [
            "import { useProp } from '@ow/component-sdk'",
            '',
            'export default function StockGauge() {',
            "  const stock = useProp<number>('stock') ?? 0",
            "  const max = useProp<number>('max') ?? 100",
            '  const pct = Math.min(100, Math.round((stock / max) * 100))',
            '  return (',
            '    <div className="gauge">',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: code run in the sandbox, not here
            '      <div className="bar" style={{ width: `${pct}%` }} />',
            '      <span>{stock} / {max}</span>',
            '    </div>',
            '  )',
            '}',
          ].join('\n'),
        },
        {
          path: 'src/gauge.css',
          content: '.gauge { position: relative; height: 24px; border-radius: 6px; background: #eef1f6 }',
        },
      ],
      dependencies: {},
      allowedOrigins: [],
      components: [
        {
          name: 'StockGauge',
          label: 'Stock gauge',
          entry: 'src/StockGauge.tsx',
          props: {
            stock: { type: 'number', default: 0, label: 'Stock', testValue: 412 },
            max: { type: 'number', default: 100, label: 'Max stock', testValue: 500 },
          },
          state: {},
          events: [],
          methods: {},
          defaultSize: { w: 6, h: 3 },
        },
      ],
    },
  })
  await trpcMutate(page, 'componentLibraries.publish', { componentLibraryId: cl.id, draftRevision: 2 }).catch(
    () => {},
  )

  // Apps.
  const appFolder = await trpcMutate<{ id: string }>(page, 'folders.create', {
    name: 'Purchasing',
    type: 'app',
  })
  const dashboard = await trpcMutate<{ id: string }>(page, 'apps.create', {
    slug: SLUGS.dashboard,
    name: 'Supplier dashboard',
    description: 'Stock and purchase orders per supplier',
  })
  const dashSaved = await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
    id: dashboard.id,
    revision: 1,
    definition: dashboardDefinition(),
  })
  await trpcMutate(page, 'apps.publish', { appId: dashboard.id, draftRevision: dashSaved.revision })
  await grant('app', dashboard.id, finGroup.id, 'use')
  await grant('app', dashboard.id, opsGroup.id, 'edit')
  await trpcMutate(page, 'permissions.set', {
    objectType: 'app',
    objectId: dashboard.id,
    userId: userId(PEOPLE.member.email),
    environmentId: null,
    level: 'use',
  })
  for (const [slug, name, folderId] of [
    ['po-approvals', 'Purchase order approvals', appFolder.id],
    ['stock-checker', 'Stock checker', null],
    ['supplier-onboarding', 'Supplier onboarding', appFolder.id],
  ] as const) {
    const a = await trpcMutate<{ id: string }>(page, 'apps.create', { slug, name, folderId })
    const s = await trpcMutate<{ revision: number }>(page, 'apps.saveDraft', {
      id: a.id,
      revision: 1,
      definition: {
        schemaVersion: 1,
        components: [{ name: 'title', type: 'text', props: { value: `## ${name}`, markdown: true } }],
        queries: [],
        layout: { title: { x: 0, y: 0, w: 12, h: 3 } },
      },
    })
    if (slug !== 'supplier-onboarding') {
      await trpcMutate(page, 'apps.publish', { appId: a.id, draftRevision: s.revision })
    }
  }

  // Python package index, npm registry, a JDBC driver.
  await trpcMutate(page, 'pythonIndexes.create', {
    name: 'Optiply packages',
    slug: 'optiply',
    url: 'https://pypi.packages.example.com/simple',
    username: 'workflows',
    passwordConfigVar: 'SUPPLIER_API_TOKEN',
    mode: 'extra',
  })
  await trpcMutate(page, 'npmRegistries.create', {
    scope: '@optiply',
    url: 'https://npm.packages.example.com',
    tokenConfigVar: 'SUPPLIER_API_TOKEN',
  }).catch(() => {})
  await page.request
    .post(
      '/api/v1/jdbc-drivers?name=Exasol&className=com.exasol.jdbc.EXADriver&fileName=exajdbc-25.2.2.jar',
      {
        headers: { 'content-type': 'application/octet-stream' },
        data: Buffer.concat([
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          Buffer.from('demo driver, not a real jar'),
        ]),
      },
    )
    .catch(() => {})

  return lookup(page, production, staging, userId)
}

async function databaseTables(page: Page) {
  const status = await trpcQuery<{ environments: { id: string; slug: string }[] }>(
    page,
    'database.environments',
    undefined,
  )
  const environmentId = status.environments.find((e) => e.slug === 'production')!.id
  await trpcMutate(page, 'database.createTable', {
    environmentId,
    name: 'suppliers',
    columns: [
      { name: 'name', type: 'text', nullable: false },
      { name: 'country', type: 'text' },
      { name: 'lead_time_days', type: 'integer' },
      { name: 'contact_email', type: 'text' },
      { name: 'preferred', type: 'boolean' },
    ],
  })
  const suppliers: [string, string, number, string, boolean][] = [
    ['Bloom & Co', 'Netherlands', 5, 'orders@bloom.example.com', true],
    ['Nordhout', 'Denmark', 12, 'sales@nordhout.example.com', true],
    ['Weverij Twente', 'Netherlands', 8, 'info@weverij.example.com', false],
    ['Lumen Glas', 'Belgium', 10, 'hello@lumenglas.example.com', true],
    ['Atelier Sud', 'France', 21, 'commandes@ateliersud.example.com', false],
    ['Keramiek Noord', 'Netherlands', 7, 'shop@keramieknoord.example.com', false],
  ]
  for (const [name, country, lead_time_days, contact_email, preferred] of suppliers) {
    await trpcMutate(page, 'database.insertRow', {
      environmentId,
      table: 'suppliers',
      values: { name, country, lead_time_days, contact_email, preferred },
    })
  }
  await trpcMutate(page, 'database.createTable', {
    environmentId,
    name: 'stock_alerts',
    columns: [
      { name: 'sku', type: 'text', nullable: false },
      { name: 'kind', type: 'text' },
      { name: 'stock', type: 'integer' },
    ],
  })
  for (const [sku, kind, stock] of [
    ['LMP-1042', 'overstock', 412],
    ['MUG-3300', 'overstock', 1280],
    ['PLW-4402', 'below reorder point', 7],
  ] as const) {
    await trpcMutate(page, 'database.insertRow', {
      environmentId,
      table: 'stock_alerts',
      values: { sku, kind, stock },
    })
  }
  await trpcMutate(page, 'database.createTable', {
    environmentId,
    name: 'price_overrides',
    columns: [
      { name: 'sku', type: 'text', nullable: false },
      { name: 'price', type: 'decimal' },
      { name: 'valid_until', type: 'date' },
    ],
  })
  for (const [sku, price, valid_until] of [
    ['LMP-1042', 39.95, '2026-12-31'],
    ['MUG-3300', 8.5, '2026-11-30'],
  ] as const) {
    await trpcMutate(page, 'database.insertRow', {
      environmentId,
      table: 'price_overrides',
      values: { sku, price, valid_until },
    })
  }
}

/** The Supplier dashboard: an overview page (stock table, a search, a refresh button) and a purchase orders page. */
export function dashboardDefinition() {
  return {
    schemaVersion: 1,
    pages: [
      { name: 'overview', title: 'Overview' },
      { name: 'orders', title: 'Purchase orders' },
    ],
    components: [
      { name: 'heading', type: 'text', props: { value: '## Supplier dashboard', markdown: true } },
      {
        name: 'supplierFilter',
        type: 'textInput',
        page: 'overview',
        props: { label: 'Supplier', placeholder: 'All suppliers' },
      },
      {
        name: 'refreshButton',
        type: 'button',
        page: 'overview',
        props: { text: 'Refresh' },
        events: [
          {
            id: 'e1',
            event: 'click',
            action: { type: 'controlQuery', query: 'stockLevels', method: 'trigger' },
          },
          {
            id: 'e2',
            event: 'click',
            action: { type: 'notify', message: 'Stock levels refreshed', tone: 'success' },
          },
        ],
      },
      {
        name: 'summary',
        type: 'text',
        page: 'overview',
        props: { value: '{{ stockLevels.data.length }} products, {{ overstocked.value }} above max stock' },
      },
      { name: 'stockTable', type: 'table', page: 'overview', props: { data: '{{ stockLevels.data }}' } },
      { name: 'ordersTable', type: 'table', page: 'orders', props: { data: '{{ purchaseOrders.data }}' } },
    ],
    queries: [
      {
        name: 'stockLevels',
        kind: 'resource',
        resource: 'warehouse_db',
        run: 'auto',
        page: 'overview',
        query: {
          sql: "select sku, product, supplier, stock, max_stock, reorder_point\n  from stock_levels\n where {{ !supplierFilter.value }} or supplier ilike {{ '%' + supplierFilter.value + '%' }}\n order by supplier, product",
        },
      },
      {
        name: 'purchaseOrders',
        kind: 'resource',
        resource: 'warehouse_db',
        run: 'auto',
        page: 'orders',
        query: { sql: 'select * from purchase_orders order by created_at desc' },
      },
    ],
    transformers: [
      {
        name: 'overstocked',
        page: 'overview',
        code: 'return (stockLevels.data ?? []).filter((r) => r.stock > r.max_stock).length',
      },
    ],
    variables: [],
    layout: {
      heading: { x: 0, y: 0, w: 12, h: 3 },
      supplierFilter: { x: 0, y: 0, w: 4, h: 4 },
      refreshButton: { x: 4, y: 0, w: 2, h: 4 },
      summary: { x: 6, y: 0, w: 6, h: 4 },
      stockTable: { x: 0, y: 4, w: 12, h: 18 },
      ordersTable: { x: 0, y: 0, w: 12, h: 14 },
    },
  }
}

async function lookup(page: Page, production: string, staging: string, userId: (e: string) => string) {
  const flows = await trpcQuery<{ id: string; slug: string }[]>(page, 'workflows.list', undefined)
  const wf = (slug: string) => flows.find((w) => w.slug === slug)!.id
  const folders = await trpcQuery<{ id: string; name: string }[]>(page, 'folders.list', { type: 'workflow' })
  const apps = await trpcQuery<{ id: string; slug: string }[]>(page, 'apps.list', undefined)
  const resources = await trpcQuery<{ id: string; slug: string }[]>(page, 'resources.list', undefined)
  const groups = await trpcQuery<{ id: string; name: string }[]>(page, 'groups.list', undefined)
  const libs = await trpcQuery<{ id: string; slug: string }[]>(page, 'libraryQueries.list', undefined)
  const mods = await trpcQuery<{ id: string; slug: string }[]>(page, 'modules.list', undefined)
  const arr = <T>(x: unknown): T[] =>
    Array.isArray(x) ? x : (Object.values(x as object).find(Array.isArray) ?? [])
  const by = <T extends { slug?: string; name?: string; id: string }>(
    list: unknown,
    key: 'slug' | 'name',
    v: string,
  ) => arr<T>(list).find((x) => x[key] === v)?.id ?? ''
  return {
    production,
    staging,
    folders: { operations: by(folders, 'name', 'Operations'), finance: by(folders, 'name', 'Finance') },
    workflows: {
      overstock: wf(SLUGS.overstock),
      report: wf(SLUGS.report),
      approve: wf(SLUGS.approve),
      reorder: wf(SLUGS.reorder),
      invoices: wf(SLUGS.invoices),
    },
    apps: { dashboard: by(apps, 'slug', SLUGS.dashboard) },
    resources: {
      warehouse: by(resources, 'slug', 'warehouse_db'),
      supplierApi: by(resources, 'slug', 'supplier_api'),
    },
    groups: { operations: by(groups, 'name', 'Operations'), finance: by(groups, 'name', 'Finance') },
    users: {
      admin: userId(PEOPLE.admin.email),
      member: userId(PEOPLE.member.email),
      second: userId(PEOPLE.second.email),
    },
    library: by(libs, 'slug', 'stock_by_supplier'),
    module: by(mods, 'slug', 'supplier_picker'),
  } satisfies Demo
}
