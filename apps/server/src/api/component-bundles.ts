import { componentBundles, type Db } from '@ow/db'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'

/**
 * Component library bundles (M25) by their hash: `/api/component-bundles/<sha256>.js` and `.css`, for anyone signed
 * in (whoever opens an app placing a component needs nothing on its library; the hash names one build and can't be
 * guessed). The app's page fetches them and hands them to the component's frame, so the frame needs no URL of ours.
 * A hash's content never changes: cached for a year.
 */
export const componentBundlesApi: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{ Params: { file: string } }>('/api/component-bundles/:file', async (req, reply) => {
    const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
    if (!user) return reply.code(401).send({ error: 'Not signed in' })
    const m = /^([0-9a-f]{64})\.(js|css)$/.exec(req.params.file)
    if (!m) return reply.code(404).send({ error: 'Not found' })
    const [hash, ext] = [m[1]!, m[2]!]
    const [bundle] = await db
      .select({ js: componentBundles.js, css: componentBundles.css })
      .from(componentBundles)
      .where(eq(componentBundles.hash, hash))
    if (!bundle) return reply.code(404).send({ error: 'Not found' })
    return reply
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .type(ext === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8')
      .send(ext === 'js' ? bundle.js : bundle.css)
  })
}
