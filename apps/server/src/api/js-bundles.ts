import type { AppDefinition } from '@ow/app-definition'
import { appReleases, apps, type Db } from '@ow/db'
import { BlockFailure } from '@ow/engine'
import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import { branchDraftDefinition } from '../services/git/branch-drafts'
import { jsBundleByHash, jsBundleState } from '../services/js-bundles'
import { bundleConfig, bundleFor, renameReleaseBundle } from '../services/js-modules'
import { atLeast, loadAccess } from '../services/permissions'

const HASH = /^([0-9a-f]{64})\.js$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * An app's JavaScript packages' bundle: `/api/js-bundles/<sha256>.js?app=<appId>` (and `&branchDraft=<id>` for a
 * Git branch draft open in the editor). The app's page fetches it and hands it to the app's sandbox, which can fetch
 * nothing itself. Bundles may hold private registries' packages, so one is served only for an app the caller can
 * see, and only:
 * - a bundle one of that app's releases names (whoever uses the app), built again from the release's lock when it's
 *   no longer kept (retention), or
 * - the bundle of the app's draft package list (or of the branch draft's), to people who can edit the app (the
 *   editor's preview).
 * Workflows' bundles never leave the server. Anything else answers 404, as for an app the caller can't see.
 */
export const jsBundlesApi: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{ Params: { file: string }; Querystring: { app?: string; branchDraft?: string } }>(
    '/api/js-bundles/:file',
    async (req, reply) => {
      const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
      if (!user) return reply.code(401).send({ error: 'Not signed in' })
      const notFound = () => reply.code(404).send({ error: 'Not found' })
      const m = HASH.exec(req.params.file)
      const { app: appId, branchDraft } = req.query
      if (!m || !appId || !UUID.test(appId) || (branchDraft !== undefined && !UUID.test(branchDraft))) {
        return notFound()
      }
      const hash = m[1]!
      const [target] = await db.select().from(apps).where(eq(apps.id, appId))
      const level = target ? (await loadAccess(db, user)).appLevel(target) : null
      if (!target || level === null) return notFound()

      const [release] = await db
        .select({ definition: appReleases.definition, jsLock: appReleases.jsLock })
        .from(appReleases)
        .where(and(eq(appReleases.appId, target.id), eq(appReleases.jsBundleHash, hash)))
        .limit(1)
      if (!release) {
        if (!atLeast(level, 'edit')) return notFound()
        const draft = await draftOf(db, target.id, target.draftDefinition, branchDraft)
        const state = draft && (await jsBundleState(db, bundleConfig(), draft.javascript?.packages ?? []))
        if (state?.state !== 'ready' || state.bundleHash !== hash) return notFound()
      }

      let js = (await jsBundleByHash(db, hash))?.js
      let renamed = false
      if (js === undefined && release?.jsLock) {
        try {
          const built = await bundleFor(
            db,
            release.definition.javascript?.packages ?? [],
            { objectType: 'app', objectId: target.id, actorUserId: null },
            release.jsLock,
          )
          await renameReleaseBundle(db, hash, built.bundleHash)
          js = built.js
          renamed = built.bundleHash !== hash
        } catch (err) {
          if (!(err instanceof BlockFailure)) throw err
          return reply.code(502).send({ error: err.message })
        }
      }
      if (js === undefined) return notFound()
      return (
        reply
          // Rebuilt under another hash (the releases now name it): not this hash's content for good.
          .header('cache-control', renamed ? 'private, no-store' : 'private, max-age=31536000, immutable')
          .header('x-content-type-options', 'nosniff')
          .type('text/javascript; charset=utf-8')
          .send(js)
      )
    },
  )
}

/** The app's draft, or one of its Git branch drafts; null when there's no such branch draft. */
async function draftOf(
  db: Db,
  appId: string,
  main: AppDefinition,
  branchDraft: string | undefined,
): Promise<AppDefinition | null> {
  if (!branchDraft) return main
  try {
    return (await branchDraftDefinition(db, 'app', appId, branchDraft)) as AppDefinition
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'NOT_FOUND') return null
    throw err
  }
}
