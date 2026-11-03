import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { CodeFetcher, PoolManager } from '@ow/connectors'
import type { Db } from '@ow/db'
import { InlineRunner } from '@ow/engine'
import { IvmRuntime } from '@ow/sandbox'
import { type FastifyTRPCPluginOptions, fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import Fastify, { type FastifyBaseLogger } from 'fastify'
import pino from 'pino'
import type postgres from 'postgres'
import { authRoutes } from '../auth/routes'
import type { Config } from '../config'
import { Metrics, metricsAllowed } from '../metrics'
import { configureAwsServer } from '../services/aws'
import { CollabHub } from '../services/collab/rooms'
import { CollabStore } from '../services/collab/store'
import { configureConnectors } from '../services/connectors'
import { DatabaseSetupError, provisionDatabases } from '../services/database'
import { GitDeployer } from '../services/git/deployer'
import { configureGoogle } from '../services/google'
import { engineLibrary } from '../services/library-queries'
import { configurePython, pythonConfigWarning } from '../services/python'
import { pythonEnvProvider } from '../services/python-envs'
import { RunEventHub } from '../services/run-events'
import { configureSnsWebhooks } from '../services/sns-webhook'
import { dbResourceProvider, dbRunContext } from '../services/workflow-runs'
import { contextFactory } from '../trpc/init'
import { type AppRouter, appRouter } from '../trpc/router'
import { auditApi } from './audit'
import { collabApi, MAX_COLLAB_MESSAGE_BYTES } from './collab'
import { componentBundlesApi } from './component-bundles'
import { databaseApi } from './database'
import { gitWebhookApi } from './git-webhook'
import { oauthApi } from './oauth'
import { runsApi } from './runs'
import { webhooksApi } from './webhooks'

/** `logger`: a shared pino instance (production), or `false` to silence logs (tests). */
export async function buildApp(deps: {
  db: Db
  config: Config
  logger?: FastifyBaseLogger | false
  /** The postgres.js client behind `db`, for LISTEN (live run events). Without it, run events aren't served. */
  listener?: postgres.Sql
  /** The process's metrics, shared with the worker when both run here. Default: the app's own. */
  metrics?: Metrics
}) {
  const { db, config } = deps
  const logger = deps.logger || pino({ level: deps.logger === false ? 'silent' : config.LOG_LEVEL })
  const app = Fastify({ loggerInstance: logger, trustProxy: config.TRUST_PROXY, bodyLimit: 10 * 1024 * 1024 })

  await app.register(fastifyCookie, { secret: config.SESSION_SECRET })
  const metrics = deps.metrics ?? new Metrics(db)
  metrics.instrument(app)

  // The managed database (schemas, roles, the built-in resource): kept in shape at every start. A failure here
  // (e.g. no CREATEROLE) leaves the rest of the platform working; the Database page says what's wrong.
  try {
    await provisionDatabases(db, config.keyring, config.DATABASE_URL)
  } catch (err) {
    if (err instanceof DatabaseSetupError) logger.warn(err.message)
    else logger.error({ err }, 'managed database provisioning failed')
  }

  const services = { pool: new PoolManager(), sandbox: new IvmRuntime() }
  // Sync webhooks execute here when a slot is free (see webhooks.ts); on shutdown their runs go back to the queue.
  const fetcher = new CodeFetcher({ allowPrivateNetwork: config.CODE_FETCH_ALLOW_PRIVATE_NETWORK })
  const pythonWarning = pythonConfigWarning(config)
  if (pythonWarning) app.log.warn(pythonWarning)
  configureGoogle(config)
  configureAwsServer(config)
  configureConnectors(config)
  configureSnsWebhooks(config.SNS_CERT_HOSTS)
  const runner = new InlineRunner({
    db,
    pool: services.pool,
    fetcher,
    resources: dbResourceProvider(db, config.keyring, services.sandbox),
    context: dbRunContext(db, config.keyring),
    concurrency: config.WEBHOOK_INLINE_CONCURRENCY,
    python: configurePython(config) ?? undefined,
    pythonEnvs: pythonEnvProvider(db, config),
    library: engineLibrary(db),
    listener: deps.listener,
    log: app.log.child({ component: 'inline-runner' }),
    observer: metrics.observer,
  })
  app.addHook('onClose', async () => {
    await runner.stop()
    await services.pool.closeAll()
    await fetcher.close()
    services.sandbox.dispose()
  })

  app.get('/api/health', async () => {
    await db.execute('select 1')
    return { ok: true }
  })

  // Prometheus. Protected by METRICS_TOKEN when it's set.
  app.get('/metrics', async (request, reply) => {
    if (!metricsAllowed(config.METRICS_TOKEN, request.headers.authorization)) {
      return reply.code(401).header('www-authenticate', 'Bearer').send()
    }
    const { contentType, body } = await metrics.text()
    return reply.type(contentType).send(body)
  })

  await app.register(authRoutes, { db, config })
  await app.register(oauthApi, { db, config })
  const events = deps.listener ? new RunEventHub(deps.listener) : undefined
  app.addHook('onClose', async () => {
    await events?.close()
  })
  await app.register(runsApi, { prefix: '/api/v1', db, events, publicUrl: config.PUBLIC_URL })
  await app.register(auditApi, { prefix: '/api/v1', db })
  await app.register(componentBundlesApi, { db })
  await app.register(databaseApi, { prefix: '/api/v1', db, keyring: config.keyring, pool: services.pool })
  await app.register(webhooksApi, {
    prefix: '/api/v1',
    db,
    keyring: config.keyring,
    publicUrl: config.PUBLIC_URL,
    events,
    runner,
    metrics,
  })
  // The API deploys from Git when GitHub says the branch moved; workers poll (see worker/index.ts).
  const gitDeployer = new GitDeployer({ db, config, log: app.log.child({ component: 'git' }), pollMs: 0 })
  app.addHook('onClose', () => gitDeployer.stop())
  await app.register(gitWebhookApi, { db, config, deployer: gitDeployer })

  // Editing drafts together (M16): rooms of open documents in this process.
  const collab = new CollabHub(new CollabStore(db), app.log.child({ component: 'collab' }), deps.listener)
  app.addHook('onClose', () => collab.close())
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_COLLAB_MESSAGE_BYTES } })
  await app.register(collabApi, {
    db,
    hub: collab,
    publicUrl: config.PUBLIC_URL,
    accessCheckMs: config.COLLAB_ACCESS_CHECK_MS,
  })

  await app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: contextFactory({ db, config, services }),
      onError({ error, path }) {
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error, path }, 'tRPC error')
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  })

  // Production: serve the built SPA, falling back to index.html for client-side routes.
  const webDist = config.WEB_DIST_DIR ? resolve(config.WEB_DIST_DIR) : undefined
  if (webDist && existsSync(resolve(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html')
      return reply.code(404).send({ error: 'Not found' })
    })
  }

  return app
}
