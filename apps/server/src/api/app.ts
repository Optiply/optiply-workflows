import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
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
import { RunEventHub } from '../services/run-events'
import { dbResourceProvider, dbRunContext } from '../services/workflow-runs'
import { contextFactory } from '../trpc/init'
import { type AppRouter, appRouter } from '../trpc/router'
import { runsApi } from './runs'
import { webhooksApi } from './webhooks'

/** `logger`: a shared pino instance (production), or `false` to silence logs (tests). */
export async function buildApp(deps: {
  db: Db
  config: Config
  logger?: FastifyBaseLogger | false
  /** The postgres.js client behind `db`, for LISTEN (live run events). Without it, run events aren't served. */
  listener?: postgres.Sql
}) {
  const { db, config } = deps
  const logger = deps.logger || pino({ level: deps.logger === false ? 'silent' : config.LOG_LEVEL })
  const app = Fastify({ loggerInstance: logger, trustProxy: config.TRUST_PROXY, bodyLimit: 10 * 1024 * 1024 })

  await app.register(fastifyCookie, { secret: config.SESSION_SECRET })

  const services = { pool: new PoolManager(), sandbox: new IvmRuntime() }
  // Sync webhooks execute here when a slot is free (see webhooks.ts); on shutdown their runs go back to the queue.
  const fetcher = new CodeFetcher({ allowPrivateNetwork: config.CODE_FETCH_ALLOW_PRIVATE_NETWORK })
  const runner = new InlineRunner({
    db,
    pool: services.pool,
    fetcher,
    resources: dbResourceProvider(db, config.keyring),
    context: dbRunContext(db, config.keyring),
    concurrency: config.WEBHOOK_INLINE_CONCURRENCY,
    log: app.log.child({ component: 'inline-runner' }),
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

  await app.register(authRoutes, { db, config })
  const events = deps.listener ? new RunEventHub(deps.listener) : undefined
  app.addHook('onClose', async () => {
    await events?.close()
  })
  await app.register(runsApi, { prefix: '/api/v1', db, events })
  await app.register(webhooksApi, { prefix: '/api/v1', db, events, runner })

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
