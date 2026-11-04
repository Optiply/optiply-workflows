import type { Db } from '@ow/db'
import type { FastifyPluginAsync } from 'fastify'
import type { Config } from '../config'
import type { GitDeployer } from '../services/git/deployer'
import { checkGitWebhook } from '../services/git/hosts'
import { loadGitSettings } from '../services/git/settings'

/** Push payloads for big pushes stay well under this. */
const BODY_LIMIT = 5 * 1024 * 1024

/**
 * The Git host's push webhook (`POST /api/git/webhook`): a push to the deploy branch starts a deploy right away
 * (polling would get there within a minute anyway). The host proves it with the webhook secret, its own way (GitHub
 * signs the body; M31: `services/git/hosts`); without a secret set, the endpoint isn't there. A ping answers 200;
 * other events and other branches are acknowledged and ignored.
 */
export const gitWebhookApi: FastifyPluginAsync<{ db: Db; config: Config; deployer: GitDeployer }> = async (
  app,
  { db, config, deployer },
) => {
  // The signature covers the raw bytes, so nothing parses them first.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) =>
    done(null, body),
  )

  app.post('/api/git/webhook', async (req, reply) => {
    const loaded = await loadGitSettings(db, config.keyring)
    const secret = loaded?.secrets.webhookSecret
    if (!loaded || !secret) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Git sync has no webhook set up' } })
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const check = checkGitWebhook(loaded, secret, req.headers, raw)
    if (!check.ok)
      return reply.code(check.status).send({ error: { code: check.code, message: check.message } })
    if (check.event === 'ping') return { ok: true }
    if (check.event === 'other') return { ignored: `${check.name} events don't deploy` }
    if (check.ref !== `refs/heads/${loaded.row.branch}`) {
      return { ignored: `Only pushes to ${loaded.row.branch} deploy` }
    }
    void deployer.request('webhook')
    return reply.code(202).send({ deploy: 'requested' })
  })
}
