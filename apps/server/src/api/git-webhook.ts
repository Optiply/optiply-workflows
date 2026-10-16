import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Db } from '@ow/db'
import type { FastifyPluginAsync } from 'fastify'
import type { Config } from '../config'
import type { GitDeployer } from '../services/git/deployer'
import { loadGitSettings } from '../services/git/settings'

/** GitHub's push payloads for big pushes stay well under this. */
const BODY_LIMIT = 5 * 1024 * 1024

/**
 * GitHub's push webhook (`POST /api/git/webhook`): a push to the deploy branch starts a deploy right away (polling
 * would get there within a minute anyway). The body must be signed with the webhook secret (`X-Hub-Signature-256`,
 * HMAC-SHA256 of the exact bytes); without a secret set, the endpoint isn't there. JSON and form-encoded deliveries
 * both work. `ping` answers 200; other events and other branches are acknowledged and ignored.
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
    const signature = req.headers['x-hub-signature-256']
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
    const given = Buffer.from(typeof signature === 'string' ? signature : '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply
        .code(401)
        .send({ error: { code: 'bad_signature', message: 'The signature does not match' } })
    }

    const event = req.headers['x-github-event']
    if (event === 'ping') return { ok: true }
    if (event !== 'push') return { ignored: `${String(event ?? 'unknown')} events don't deploy` }

    let payload: { ref?: unknown }
    try {
      const text = String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')
        ? (new URLSearchParams(raw.toString('utf8')).get('payload') ?? '')
        : raw.toString('utf8')
      payload = JSON.parse(text)
    } catch {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'The payload is not valid JSON' } })
    }
    if (payload.ref !== `refs/heads/${loaded.row.branch}`) {
      return { ignored: `Only pushes to ${loaded.row.branch} deploy` }
    }
    void deployer.request('webhook')
    return reply.code(202).send({ deploy: 'requested' })
  })
}
