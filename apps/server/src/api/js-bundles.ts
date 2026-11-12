import { appReleases, type Db, workflowReleases } from '@ow/db'
import { BlockFailure } from '@ow/engine'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import { jsBundleByHash } from '../services/js-bundles'
import { bundleFor } from '../services/js-modules'

/**
 * JavaScript package bundles by their hash: `/api/js-bundles/<sha256>.js`, for anyone signed in, like component
 * bundles (whoever opens an app needs nothing on its packages; the hash names one bundle and can't be guessed). The
 * app's page fetches it and hands it to the app's sandbox, which can fetch nothing itself. A bundle no longer kept
 * (unused for a while) that a release names is built again from the release's lock. A hash's content never changes:
 * cached for a year.
 */
export const jsBundlesApi: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{ Params: { file: string } }>('/api/js-bundles/:file', async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return reply.code(401).send({ error: 'Not signed in' })
    const m = /^([0-9a-f]{64})\.js$/.exec(req.params.file)
    if (!m) return reply.code(404).send({ error: 'Not found' })
    const hash = m[1]!
    let js = (await jsBundleByHash(db, hash))?.js
    if (js === undefined) {
      try {
        js = await rebuildForRelease(db, hash)
      } catch (err) {
        if (!(err instanceof BlockFailure)) throw err
        return reply.code(502).send({ error: err.message })
      }
    }
    if (js === undefined) return reply.code(404).send({ error: 'Not found' })
    return reply
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .type('text/javascript; charset=utf-8')
      .send(js)
  })
}

/** The bundle an app or workflow release names, built again from its lock; undefined when no release names it. */
async function rebuildForRelease(db: Db, hash: string): Promise<string | undefined> {
  const [appRelease] = await db
    .select({ appId: appReleases.appId, definition: appReleases.definition, jsLock: appReleases.jsLock })
    .from(appReleases)
    .where(eq(appReleases.jsBundleHash, hash))
    .limit(1)
  if (appRelease?.jsLock) {
    const built = await bundleFor(
      db,
      appRelease.definition.javascript?.packages ?? [],
      { objectType: 'app', objectId: appRelease.appId, actorUserId: null },
      appRelease.jsLock,
    )
    return built.js
  }
  const [workflowRelease] = await db
    .select({
      workflowId: workflowReleases.workflowId,
      definition: workflowReleases.definition,
      jsLock: workflowReleases.jsLock,
    })
    .from(workflowReleases)
    .where(eq(workflowReleases.jsBundleHash, hash))
    .limit(1)
  if (workflowRelease?.jsLock) {
    const built = await bundleFor(
      db,
      workflowRelease.definition.settings?.javascript?.packages ?? [],
      { objectType: 'workflow', objectId: workflowRelease.workflowId, actorUserId: null },
      workflowRelease.jsLock,
    )
    return built.js
  }
  return undefined
}
