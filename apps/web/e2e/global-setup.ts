import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  executorAvailable,
  startTestBuilder,
  startTestExecutor,
  startTestIndex,
  testEnvsVolume,
} from '@ow/code-executor/testing'
import { kafkaClient, kafkaConsumer, produceTo } from '@ow/connectors'
import {
  kafkaAvailable,
  rabbitAvailable,
  s3Available,
  startFakeAi,
  startFakeAws,
  startFakePubSub,
  startFakeRegistry,
  startFakeServices,
  startTestGraphql,
  startTestIapServer,
  startTestKafka,
  startTestRabbit,
  startTestS3,
  type TestKafka,
  type TestRabbit,
  type TestS3,
} from '@ow/connectors/testing'
import { createDb } from '@ow/db'
import { startTestDatabase } from '@ow/db/testing'
import { FakeGoogle } from '../../../packages/connectors/test/google-fake'
import { fakeGitHub } from '../../server/test/fake-github'
import { fakeGitLab } from '../../server/test/fake-gitlab'
import { startTestRegistry } from '../../server/test/npm-registry'
import { E2E_PORT } from '../playwright.config'

const serverDir = fileURLToPath(new URL('../../server', import.meta.url))
const webDist = fileURLToPath(new URL('../dist', import.meta.url))

export const E2E_EMAIL = 'e2e@optiply.nl'
export const E2E_PASSWORD = 'e2e-password-not-secret'
/** The e2e's private package index's password (M32; username `ci`). */
const E2E_PRIVATE_INDEX_PASSWORD = 'private-index-password-not-secret'
/** The e2e's private npm registry's token (M33). */
const E2E_NPM_PRIVATE_TOKEN = 'npm-token-not-secret'
/** A second person, for what differs between people (their own OAuth accounts). Same password. */
export const E2E_SECOND_EMAIL = 'e2e-second@optiply.nl'
/** Someone who isn't an admin: they reach only what's shared with them (M10's done-when). Same password. */
export const E2E_MEMBER_EMAIL = 'e2e-member@optiply.nl'
/** The token the fake GitHub takes (M11). */
export const E2E_GITHUB_TOKEN = 'github_pat_e2e_not_secret'
/** The VM the fake IAP endpoint reaches (at 127.0.0.1, on the port asked for: specs start the SSH server) (M18). */
export const E2E_IAP_VM = { project: 'e2e-project', zone: 'europe-west1-b', instance: 'bastion' }

/**
 * Starts what the editor needs, as in production: an embedded Postgres, the bundled server (API and worker in one
 * process) serving the built web app, an admin, and a Postgres resource pointing at a seeded `customers` table.
 * Build first: `pnpm --filter @ow/web build && pnpm --filter @ow/server build`.
 */
export default async function globalSetup() {
  for (const path of [`${serverDir}/dist/main.js`, `${webDist}/index.html`]) {
    if (!existsSync(path)) {
      throw new Error(`${path} is missing: run pnpm --filter @ow/web build && pnpm --filter @ow/server build`)
    }
  }

  const pg = await startTestDatabase()
  // For specs that point a resource of their own at this database (M17's SSH tunnel spec, through a test SSH server).
  process.env.E2E_PG_URL = pg.url
  const seed = createDb(pg.url, { max: 1 })
  await seed.sql.unsafe(`
    create table customers (id int primary key, email text not null, plan text not null);
    insert into customers values (1, 'ada@example.com', 'pro'), (2, 'grace@example.com', 'free');
  `)
  await seed.close()

  // Git sync (M11): an empty bare repo (optiply/flows) and a fake GitHub for its pull requests. Specs read where
  // they are from E2E_GIT_REPO_URL and E2E_FAKE_GITHUB, and merge pull requests through the fake's /_test routes.
  const gitRoot = mkdtempSync(join(tmpdir(), 'ow-e2e-git-'))
  mkdirSync(join(gitRoot, 'optiply'))
  const repoPath = join(gitRoot, 'optiply', 'flows.git')
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', repoPath], {
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  // M31: the fake GitHub also has a GitHub App installed on the repo (E2E_GITHUB_APP: its id and private key).
  const appKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const github = await fakeGitHub({
    repoPath,
    owner: 'optiply',
    repo: 'flows',
    token: E2E_GITHUB_TOKEN,
    app: { id: '424242', publicKey: appKeys.publicKey },
  })
  process.env.E2E_GIT_REPO_URL = `file://${repoPath}`
  process.env.E2E_FAKE_GITHUB = github.url
  process.env.E2E_GITHUB_APP = JSON.stringify({ id: '424242', privateKey: appKeys.privateKey })
  // M31: a second repo (optiply/data/flows) behind a fake GitLab, its project the file:// path as GitLab reads it
  // (E2E_GITLAB: the fake's URL, the repo, the project and the token).
  mkdirSync(join(gitRoot, 'optiply', 'data'))
  const gitlabRepo = join(gitRoot, 'optiply', 'data', 'flows.git')
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', gitlabRepo], {
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const gitlabProject = gitlabRepo
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .join('/')
  const gitlab = await fakeGitLab({
    repoPath: gitlabRepo,
    project: gitlabProject,
    token: 'glpat-e2e-not-secret',
  })
  process.env.E2E_GITLAB = JSON.stringify({
    url: gitlab.url,
    repoUrl: `file://${gitlabRepo}`,
    repoDir: gitlabRepo,
    project: gitlabProject,
    token: 'glpat-e2e-not-secret',
  })

  // Python (M12): the code executor in a container, when Docker is there (CI must have it). Specs that need it read
  // E2E_PYTHON.
  // Workflows' packages (M23): a local package index, the builder and the executor sharing an envs volume, unless
  // the executor is another one (PYTHON_EXECUTOR_TEST_URL). Specs that need them read E2E_PYTHON_PACKAGES.
  const docker = executorAvailable()
  const packages = docker && !process.env.PYTHON_EXECUTOR_TEST_URL
  const index = packages
    ? await startTestIndex([
        {
          name: 'owtest-a',
          version: '1.0.0',
          requires: ['owtest-b'],
          files: { 'owtest_a/__init__.py': 'from owtest_b import VERSION as B\nNAME = "owtest-a"\n' },
        },
        { name: 'owtest-b', version: '1.0.0', files: { 'owtest_b/__init__.py': 'VERSION = "1.0.0"\n' } },
      ])
    : null
  // M32: a private index with a password (a package only it has, and one with only an sdist). Specs read
  // E2E_PRIVATE_INDEX_URL and E2E_PRIVATE_INDEX_PASSWORD (username `ci`).
  const privateIndex = packages
    ? await startTestIndex(
        [
          {
            name: 'owtest-private',
            version: '1.0.0',
            requires: ['owtest-b'],
            files: { 'owtest_private/__init__.py': 'SAUCE = 42\n' },
          },
          { name: 'owtest-psrc', version: '2.0.0', files: { 'owtest_psrc.py': 'P = 2\n' }, sdist: {} },
        ],
        { auth: { username: 'ci', password: E2E_PRIVATE_INDEX_PASSWORD } },
      )
    : null
  if (privateIndex) {
    process.env.E2E_PRIVATE_INDEX_URL = privateIndex.url
    process.env.E2E_PRIVATE_INDEX_PASSWORD = E2E_PRIVATE_INDEX_PASSWORD
  }
  const volume = packages ? testEnvsVolume() : null
  // The builder first: a new volume takes its /envs and their owner.
  const builder =
    index && volume ? await startTestBuilder({ indexUrl: index.url, envsVolume: volume.name }) : null
  const executor = docker ? await startTestExecutor(volume ? { envsVolume: volume.name } : {}) : null
  if (executor) process.env.E2E_PYTHON = '1'
  if (builder) process.env.E2E_PYTHON_PACKAGES = '1'

  // Google Cloud IAP (M18): a fake Google issues tokens (for a service account key, and from its metadata server as
  // this server's own identity) and a fake IAP endpoint takes them. Specs read the key from E2E_IAP_KEY.
  const google = new FakeGoogle()
  await google.start()
  const iap = await startTestIapServer({
    tokens: [],
    accept: (token) => /^(sa|md)-\d+$/.test(token),
    instances: { [`${E2E_IAP_VM.project}/${E2E_IAP_VM.zone}/${E2E_IAP_VM.instance}`]: '127.0.0.1' },
  })
  process.env.E2E_IAP_KEY = google.keyJson
  // Specs steer the fake IAP from their own process: POST /drop cuts every WebSocket (sessions stay, as on a dropped
  // network), POST /refuse-next?code=&reason= closes the next connect so; GET /stats counts connects and reconnects.
  // Pub/Sub (M19): a fake in project `fake-project`, a topic per spec part with a subscription each (`<topic>-sub`):
  // `flaky-sub` dead-letters to `flaky-dead` after 3 deliveries, `slow-sub` gives 2 s to ack. Specs publish and look
  // through E2E_IAP_CONTROL's /pubsub routes.
  const pubsub = await startFakePubSub({ project: 'fake-project' })
  pubsub.createTopic('flaky-dead')
  for (const topic of ['orders', 'refunds', 'm19', 'flaky', 'slow', 'busy', 'chain', 'paused']) {
    pubsub.createTopic(topic)
    pubsub.createSubscription(`${topic}-sub`, {
      topic,
      ...(topic === 'flaky' && {
        deadLetterPolicy: { deadLetterTopic: 'flaky-dead', maxDeliveryAttempts: 3 },
      }),
      ...(topic === 'slow' && { ackDeadlineSeconds: 2 }),
    })
  }
  // SQS (M26): a fake AWS (STS and SQS, signatures checked) with a queue per spec part: `m26-flaky` moves a message to
  // `m26-dlq` after 2 receives, `m26-slow` hides one for 2 s, `m26-groups.fifo` deduplicates by content. Specs sign in
  // with E2E_AWS_KEY_ID / E2E_AWS_SECRET (or assume E2E_AWS_ROLE with external id `optiply-e2e`), and send and look
  // through E2E_IAP_CONTROL's /sqs routes. The server's own credentials are a fake user's, never the developer's.
  const aws = await startFakeAws()
  const awsUser = aws.addUser('e2e')
  const awsServer = aws.addUser('server')
  const awsRole = aws.addRole('m26-reader', { trusted: [awsUser.arn], externalId: 'optiply-e2e' })
  aws.sqs.createQueue('m26-dlq')
  for (const queue of ['orders', 'm26', 'm26-busy', 'm26-sent']) aws.sqs.createQueue(queue)
  aws.sqs.createQueue('m26-slow', { visibilityTimeout: 2 })
  aws.sqs.createQueue('m26-flaky', { redrive: { deadLetterQueue: 'm26-dlq', maxReceiveCount: 2 } })
  aws.sqs.createQueue('m26-groups.fifo', { contentBasedDeduplication: true })
  process.env.E2E_AWS_KEY_ID = awsUser.accessKeyId
  process.env.E2E_AWS_SECRET = awsUser.secretAccessKey
  process.env.E2E_AWS_ROLE = awsRole.arn
  process.env.E2E_AWS_SERVER_ARN = awsServer.arn
  process.env.E2E_AWS_USER_ARN = awsUser.arn

  // M27: fakes of Slack, HubSpot, SendGrid and Google Sheets (with Drive) on one server, and a GraphQL endpoint. Sheets
  // also takes the fake Google's tokens (`sa-…` for E2E_IAP_KEY's service account, `md-…` the server's identity).
  // Specs read state and seed spreadsheets through E2E_SERVICES's /_fake routes; the built-in REST API may reach
  // 127.0.0.1 (REST_API_PRIVATE_HOSTS), so specs call E2E_SERVICES's /_fake/echo with it.
  const services = await startFakeServices({
    sheetsTrust: (token) =>
      /^sa-\d+$/.test(token)
        ? 'tunnel@fake-project.iam.gserviceaccount.com'
        : /^md-\d+$/.test(token)
          ? 'any'
          : null,
  })
  const graphql = await startTestGraphql()
  process.env.E2E_SERVICES = services.url
  process.env.E2E_SERVICES_TOKENS = JSON.stringify({
    slack: services.slack.token,
    hubspot: services.hubspot.token,
    sendgrid: services.sendgrid.key,
  })
  process.env.E2E_GRAPHQL = JSON.stringify({ url: graphql.url, token: graphql.token })
  // M29: Stripe, Airtable, Jira, Notion and Salesforce on the same fake server; an Airtable base and a Notion
  // database to start from. Specs read their state through /_fake/state (`m29`).
  services.airtable.bases.set('appE2EBASE0000001', [
    {
      id: 'tblStock00000001',
      name: 'Stock',
      fields: [
        { id: 'fldSku', name: 'SKU', type: 'singleLineText' },
        { id: 'fldQty', name: 'Qty', type: 'number' },
      ],
      records: new Map(),
    },
  ])
  services.notion.databases.set('5e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b', {
    id: '5e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b',
    title: 'Purchase orders',
    properties: {
      Name: { id: 'title', type: 'title' },
      Qty: { id: 'q', type: 'number' },
      Status: { id: 's', type: 'status' },
    },
  })
  process.env.E2E_M29 = JSON.stringify({
    stripe: services.stripe.key,
    airtable: { token: services.airtable.token, base: 'appE2EBASE0000001' },
    jira: { site: services.urls.jiraCloud, email: services.jira.email, token: services.jira.apiToken },
    notion: { token: services.notion.token, database: '5e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b' },
    salesforce: { clientId: services.salesforce.clientId, clientSecret: services.salesforce.clientSecret },
  })
  // M35: fakes of Anthropic's Messages API and an OpenAI-compatible API on one server (markers in prompts steer them:
  // REFUSE_ME, RATE_LIMIT_ONCE, LABEL=). Specs read the URLs and keys from E2E_AI.
  const ai = await startFakeAi()
  process.env.E2E_AI = JSON.stringify({
    anthropicUrl: ai.anthropicUrl,
    anthropicKey: ai.anthropicKey,
    openaiUrl: ai.openaiUrl,
    openaiKey: ai.openaiKey,
  })
  // S3 (M29): an S3-compatible store in Docker where Docker runs (the spec's S3 part skips without E2E_S3).
  let s3: TestS3 | undefined
  if (s3Available()) {
    s3 = await startTestS3()
    await s3.createBucket('e2e-files')
    process.env.E2E_S3 = JSON.stringify({
      endpoint: s3.endpoint,
      region: s3.region,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    })
  }

  // Kafka (M26): a broker in Docker where Docker runs (specs skip without E2E_KAFKA), one topic per spec part.
  // E2E_KAFKA is its plaintext listener; E2E_KAFKA_SCRAM its SASL-over-TLS one with a SCRAM-SHA-256 user and the CA.
  let kafka: TestKafka | undefined
  if (kafkaAvailable()) {
    kafka = await startTestKafka()
    for (const topic of [
      'kafka-ui',
      'm26-keys',
      'm26-retry',
      'm26-retry-dlt',
      'm26-takeover',
      'm26-produced',
      'm30-avro',
    ])
      await kafka.createTopic(topic)
    process.env.E2E_KAFKA = kafka.plaintext
    process.env.E2E_KAFKA_SCRAM = JSON.stringify({
      broker: kafka.saslSsl,
      ...kafka.users.scram256,
      ca: kafka.ca,
      clientCertificate: kafka.clientCertificate,
      clientKey: kafka.clientKey,
      mtls: kafka.mtls,
    })
  }
  // M30: RabbitMQ in Docker where Docker runs (E2E_RABBIT; specs skip without it); SNS and Kinesis on the fake AWS (the
  // server trusts the fake's certificate host through SNS_CERT_HOSTS, and its HTTP subscriptions post to the e2e
  // server's webhooks); a fake Schema Registry with an Avro subject for Kafka. E2E_M30 names the topic and registry.
  let rabbit: TestRabbit | undefined
  if (rabbitAvailable()) {
    rabbit = await startTestRabbit()
    await rabbit.declare('m30-jobs', { deadLetterQueue: 'm30-jobs-dead' })
    process.env.E2E_RABBIT = JSON.stringify({
      host: rabbit.host,
      port: rabbit.port,
      username: rabbit.username,
      password: rabbit.password,
    })
  }
  const m30Topic = aws.sns.createTopic('m30-orders')
  aws.kinesis.createStream('m30-clicks')
  const schemaRegistry = await startFakeRegistry()
  const avroSchemaId = schemaRegistry.register('m30-avro-value', {
    type: 'record',
    name: 'Order',
    fields: [
      { name: 'id', type: 'long' },
      { name: 'sku', type: 'string' },
    ],
  })
  process.env.E2E_M30 = JSON.stringify({
    topicArn: m30Topic,
    registry: {
      url: schemaRegistry.url,
      username: schemaRegistry.username,
      password: schemaRegistry.password,
      avroSchemaId,
    },
  })

  const kafkaPlain = () =>
    kafkaClient({ brokers: [kafka!.plaintext], auth: 'none', tls: false, identity: 'key' }, {})

  const iapControl = createServer((req, res) => {
    control(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(err))
    })
  })
  async function control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const param = (name: string) => url.searchParams.get(name) ?? ''
    if (url.pathname === '/pubsub/publish' && req.method === 'POST')
      return json({
        messageId: pubsub.publish(param('topic'), param('data'), JSON.parse(param('attributes') || '{}')),
      })
    if (url.pathname === '/pubsub/messages') return json(pubsub.messages(param('subscription')))
    if (url.pathname === '/sqs/send' && req.method === 'POST')
      return json({
        messageId: aws.sqs.send(param('queue'), param('body'), {
          attributes: JSON.parse(param('attributes') || '{}'),
          ...(param('groupId') ? { groupId: param('groupId') } : {}),
        }),
      })
    if (url.pathname === '/sqs/messages') return json(aws.sqs.messages(param('queue')))
    if (url.pathname === '/kafka/produce' && req.method === 'POST') {
      const client = kafkaPlain()
      try {
        await produceTo(
          client,
          param('topic'),
          [
            {
              ...(param('key') ? { key: param('key') } : {}),
              value: param('value'),
              headers: JSON.parse(param('headers') || '{}'),
            },
          ],
          AbortSignal.timeout(10_000),
        )
      } finally {
        await client.close()
      }
      return json({})
    }
    if (url.pathname === '/kafka/read') {
      // A topic from its beginning, by a group of its own: what was produced to it (dead letters).
      const client = kafkaPlain()
      const consumer = await kafkaConsumer(client, {
        groupId: `e2e-reader-${randomBytes(4).toString('hex')}`,
        topics: [param('topic')],
        startAt: 'earliest',
        onAssign() {},
        onRevoke() {},
      })
      const got: { key: string | null; value: string | null; headers: Record<string, string> }[] = []
      try {
        const deadline = Date.now() + 10_000
        while (got.length < Number(param('count') || 1) && Date.now() < deadline)
          for (const m of await consumer.consume(10, 500))
            got.push({ key: m.key, value: m.value?.toString() ?? null, headers: m.headers })
      } finally {
        await consumer.close()
        await client.close()
      }
      return json(got)
    }
    if (url.pathname === '/pubsub/published') return json(pubsub.published(param('topic')))
    // M30: subscribe a webhook to an SNS topic (the fake sends its SubscriptionConfirmation at once), and whether it
    // confirmed; what an SNS topic was sent; what's left in a RabbitMQ queue (read and acked).
    if (url.pathname === '/sns/subscribe' && req.method === 'POST') {
      await aws.sns.subscribe(param('topicArn'), param('endpoint'))
      return json({})
    }
    if (url.pathname === '/sns/confirmed')
      return json(aws.sns.confirmed(param('topicArn'), param('endpoint')))
    if (url.pathname === '/sns/messages')
      return json(aws.sns.messages.filter((m) => m.topicArn === param('topicArn')))
    if (url.pathname === '/rabbit/drain') return json(await rabbit!.drain(param('queue')))
    if (url.pathname === '/pubsub/redeliver' && req.method === 'POST') {
      pubsub.redeliver(param('subscription'), param('messageId'))
      return json({})
    }
    if (req.method === 'POST' && url.pathname === '/drop') iap.dropAll()
    else if (req.method === 'POST' && url.pathname === '/refuse-next')
      iap.refuseNext(Number(url.searchParams.get('code')), url.searchParams.get('reason') ?? '')
    else if (req.method !== 'GET' || url.pathname !== '/stats') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ connects: iap.connects.length, reconnects: iap.reconnects.length }))
  }
  await new Promise<void>((r) => iapControl.listen(0, '127.0.0.1', r))
  process.env.E2E_IAP_CONTROL = `http://127.0.0.1:${(iapControl.address() as { port: number }).port}`

  // Custom components (M25): an npm registry with a package to bundle, and two origins a component can fetch from
  // (CORS open), one of which a spec allows. Specs read E2E_ORIGIN_ALLOWED and E2E_ORIGIN_OTHER.
  const registry = await startTestRegistry([
    {
      name: 'tiny-format',
      version: '1.0.0',
      files: { 'index.js': 'module.exports = (n) => "#" + String(n).padStart(3, "0")' },
    },
  ])
  // M33: a private registry for the @acme scope, with a token. Specs read E2E_NPM_PRIVATE_URL and _TOKEN.
  const privateNpm = await startTestRegistry(
    [
      {
        name: '@acme/greeting',
        version: '1.0.0',
        files: { 'index.js': 'module.exports = (name) => "Hello from @acme, " + name' },
      },
    ],
    { token: E2E_NPM_PRIVATE_TOKEN },
  )
  process.env.E2E_NPM_PRIVATE_URL = privateNpm.url
  process.env.E2E_NPM_PRIVATE_TOKEN = E2E_NPM_PRIVATE_TOKEN
  const origins = await Promise.all(
    ['allowed', 'other'].map(async (which) => {
      const origin = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify({ from: which }))
      })
      await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
      return origin
    }),
  )
  const originUrl = (o: (typeof origins)[number]) =>
    `http://127.0.0.1:${(o.address() as { port: number }).port}`
  process.env.E2E_ORIGIN_ALLOWED = originUrl(origins[0]!)
  process.env.E2E_ORIGIN_OTHER = originUrl(origins[1]!)
  const componentBuilds = mkdtempSync(join(tmpdir(), 'ow-e2e-components-'))

  const base = `http://127.0.0.1:${E2E_PORT}`
  const env = {
    ...process.env,
    TZ: 'UTC',
    ROLE: 'all',
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    HOST: '127.0.0.1',
    PORT: String(E2E_PORT),
    PUBLIC_URL: base,
    // Editors notice lost access quickly (M16).
    COLLAB_ACCESS_CHECK_MS: '500',
    DATABASE_URL: pg.url,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    LOCAL_LOGIN_ENABLED: 'true',
    AUTO_MIGRATE: 'true',
    MIGRATIONS_DIR: `${serverDir}/../../packages/db/migrations`,
    WEB_DIST_DIR: webDist,
    GIT_ALLOW_INSECURE_URLS: 'true',
    GIT_CACHE_DIR: join(gitRoot, 'cache'),
    GITHUB_API_URL: github.url,
    GITLAB_API_URL: gitlab.url,
    GIT_POLL_SECONDS: '2',
    ...(executor && { PYTHON_EXECUTOR_URL: executor.url, PYTHON_EXECUTOR_TOKEN: executor.token }),
    ...(builder && { PYTHON_BUILDER_URL: builder.url, PYTHON_BUILDER_TOKEN: builder.token }),
    NPM_REGISTRY_URL: registry.url,
    NPM_ALLOW_INSECURE_REGISTRIES: 'true',
    COMPONENT_BUILD_DIR: componentBuilds,
    GOOGLE_SERVER_IDENTITY: 'allow',
    GOOGLE_IAP_URL: iap.url,
    GOOGLE_PUBSUB_URL: pubsub.url,
    GOOGLE_TOKEN_URL: google.tokenUrl,
    // The server's identity is the fake metadata server's, never the developer's own gcloud login.
    GOOGLE_APPLICATION_CREDENTIALS: '',
    AWS_SERVER_IDENTITY: 'allow',
    AWS_STS_URL: aws.url,
    AWS_SQS_URL: aws.url,
    AWS_SNS_URL: aws.url,
    AWS_KINESIS_URL: aws.url,
    SNS_CERT_HOSTS: new URL(aws.url).host,
    SLACK_API_URL: services.urls.slack,
    HUBSPOT_API_URL: services.urls.hubspot,
    SENDGRID_API_URL: services.urls.sendgrid,
    SENDGRID_EU_API_URL: services.urls.sendgridEu,
    GOOGLE_SHEETS_API_URL: services.urls.sheets,
    GOOGLE_DRIVE_API_URL: services.urls.drive,
    STRIPE_API_URL: services.urls.stripe,
    AIRTABLE_API_URL: services.urls.airtable,
    NOTION_API_URL: services.urls.notion,
    SALESFORCE_URL: services.urls.salesforce,
    REST_API_PRIVATE_HOSTS: '127.0.0.1',
    // The server's own AWS credentials: the fake's `server` user, never the developer's.
    AWS_ACCESS_KEY_ID: awsServer.accessKeyId,
    AWS_SECRET_ACCESS_KEY: awsServer.secretAccessKey,
    AWS_SESSION_TOKEN: '',
    AWS_PROFILE: '',
    HOME: gitRoot,
    GCE_METADATA_HOST: google.metadataHost,
  }

  for (const [email, name] of [
    [E2E_EMAIL, 'E2E'],
    [E2E_SECOND_EMAIL, 'Second'],
    [E2E_MEMBER_EMAIL, 'Member'],
  ] as const) {
    await run(['dist/cli/create-admin.js', '--email', email, '--name', name], {
      ...env,
      ADMIN_PASSWORD: E2E_PASSWORD,
    })
  }
  // The CLI only makes admins: the member leaves the admins group.
  const members = createDb(pg.url, { max: 1 })
  await members.sql.unsafe(
    `delete from group_members
      where user_id = (select id from users where email = $1)
        and group_id = (select id from groups where system_kind = 'admins')`,
    [E2E_MEMBER_EMAIL],
  )
  await members.close()
  const server = spawn('node', ['--no-node-snapshot', 'dist/main.js'], {
    cwd: serverDir,
    env,
    stdio: 'inherit',
  })
  await waitForHealth(`${base}/api/health`, server)

  // A resource for the query block, configured in production.
  const cookie = await login(base)
  const trpc = async (path: string, input: unknown) => {
    const res = await fetch(`${base}/api/trpc/${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ json: input }),
    })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return (await res.json()).result.data.json
  }
  const envs = await (await fetch(`${base}/api/trpc/environments.list`, { headers: { cookie } })).json()
  const production = envs.result.data.json.find((e: { slug: string }) => e.slug === 'production')
  const resource = await trpc('resources.create', { type: 'postgres', name: 'Shop DB', slug: 'shop_db' })
  const url = new URL(pg.url)
  await trpc('resources.saveConfig', {
    resourceId: resource.id,
    environmentId: production.id,
    config: {
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      ssl: 'disable',
    },
    secrets: { password: decodeURIComponent(url.password) },
  })

  return async () => {
    server.kill('SIGTERM')
    await new Promise((resolve) => server.once('exit', resolve))
    await pg.stop()
    await github.close()
    await gitlab.close()
    await executor?.stop()
    await builder?.stop()
    await index?.stop()
    await privateIndex?.stop()
    volume?.remove()
    await new Promise((r) => iapControl.close(r))
    await iap.close()
    await pubsub.close()
    await aws.close()
    await kafka?.stop()
    await rabbit?.stop()
    await schemaRegistry.stop()
    await s3?.stop()
    await google.stop()
    await services.stop()
    await ai.stop()
    await graphql.stop()
    await registry.stop()
    await privateNpm.stop()
    for (const origin of origins) await new Promise((r) => origin.close(r))
    rmSync(componentBuilds, { recursive: true, force: true })
    rmSync(gitRoot, { recursive: true, force: true })
  }
}

export function run(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--no-node-snapshot', ...args], { cwd: serverDir, env, stdio: 'inherit' })
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${args[0]} exited with ${code}`)),
    )
  })
}

export async function waitForHealth(url: string, server: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode}`)
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the server did not become healthy')
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}
