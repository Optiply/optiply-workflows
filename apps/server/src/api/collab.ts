import type { Db } from '@ow/db'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import type { CollabHub, CollabPeer, CollabRoom } from '../services/collab/rooms'
import { type CollabTarget, resolveTarget } from '../services/collab/target'

/** The largest message: a whole definition as one update fits easily. Register `@fastify/websocket` with it. */
export const MAX_COLLAB_MESSAGE_BYTES = 10 * 1024 * 1024

/** How often a connection is pinged; one that hasn't answered the last ping by the next is dropped. */
const PING_MS = 30_000

/**
 * `GET /api/collab/<key>`: a WebSocket per open editor, speaking y-protocols sync and awareness (architecture §2.19).
 * The session cookie signs in; Edit writes, Use watches, a protected main is watched by everyone. Refused before the
 * upgrade: no session (401), another site's page (403), no such draft or no access (404).
 */
export const collabApi: FastifyPluginAsync<{ db: Db; hub: CollabHub; publicUrl: string }> = async (
  app,
  { db, hub, publicUrl },
) => {
  const allowedOrigin = new URL(publicUrl).origin
  const admitted = new WeakMap<FastifyRequest, { target: CollabTarget; user: CollabPeer['user'] }>()

  app.get<{ Params: { key: string } }>(
    '/api/collab/:key',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        // Browsers send the cookie with any site's WebSocket; only our own pages may open one.
        const origin = req.headers.origin
        if (origin !== undefined && origin !== allowedOrigin)
          return reply.code(403).send({ error: 'Forbidden' })
        const user = await lookupSession(db, req.cookies[SESSION_COOKIE])
        if (!user) return reply.code(401).send({ error: 'Not signed in' })
        const target = await resolveTarget(db, user, req.params.key)
        if (!target) return reply.code(404).send({ error: 'Not found' })
        admitted.set(req, { target, user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl } })
      },
    },
    (socket, req) => {
      const { target, user } = admitted.get(req)!
      const peer: CollabPeer = {
        user,
        readOnly: target.readOnly,
        send: (message) => {
          if (socket.readyState === socket.OPEN) socket.send(message)
        },
        close: (code, reason) => socket.close(code, reason),
      }
      let room: CollabRoom | null = null
      let closed = false
      // Messages arriving while the room loads wait for it.
      const waiting: Uint8Array[] = []
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return peer.close(1003, 'Binary messages only')
        if (room) room.receive(peer, data)
        else waiting.push(data)
      })

      let alive = true
      socket.on('pong', () => {
        alive = true
      })
      const ping = setInterval(() => {
        if (!alive) return socket.terminate()
        alive = false
        socket.ping()
      }, PING_MS)

      socket.on('close', () => {
        closed = true
        clearInterval(ping)
        if (room) void hub.leave(room, peer)
      })

      hub.join(target, peer).then(
        (joined) => {
          if (closed) return void hub.leave(joined, peer)
          room = joined
          for (const message of waiting.splice(0)) joined.receive(peer, message)
        },
        (err) => {
          req.log.error({ err, key: target.key }, 'collab: opening a document failed')
          peer.close(1011, 'Could not open the document')
        },
      )
    },
  )
}
