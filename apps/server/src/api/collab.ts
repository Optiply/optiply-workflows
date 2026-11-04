import { CLOSE_ACCESS_LOST } from '@ow/collab'
import type { Db } from '@ow/db'
import type { FastifyPluginAsync } from 'fastify'
import { lookupSession, SESSION_COOKIE } from '../auth/sessions'
import type { CollabHub, CollabPeer, CollabRoom } from '../services/collab/rooms'
import { type CollabTarget, resolveTarget } from '../services/collab/target'

/** The largest message: a whole definition as one update fits easily. Register `@fastify/websocket` with it. */
export const MAX_COLLAB_MESSAGE_BYTES = 10 * 1024 * 1024

/** How often a connection is pinged; one that hasn't answered the last ping by the next is dropped. */
const PING_MS = 30_000

/** Who someone is and what they may do with the draft, or why they can't have it. */
async function admit(
  db: Db,
  token: string | undefined,
  key: string,
): Promise<{ user: CollabPeer['user']; target: CollabTarget } | { refused: string }> {
  const user = await lookupSession(db, token)
  if (!user) return { refused: 'Not signed in' }
  const target = await resolveTarget(db, user, key)
  if (!target) return { refused: 'This draft is gone, or you no longer have access to it' }
  return { user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl }, target }
}

/**
 * `GET /api/collab/<key>`: a WebSocket per open editor, speaking y-protocols sync and awareness (architecture §2.19).
 * The session cookie signs in; Edit writes, Use watches, a protected main is watched by everyone. Another site's page
 * is refused before the upgrade (403). Everything else is checked once the socket is open, and again every
 * `accessCheckMs`: no session, no such draft or no access (any more), or access that changed (read-only now, or
 * editable now) ends the connection with CLOSE_ACCESS_LOST and the reason, which the editor shows and stops at. (A
 * refused upgrade would look like a network failure to a browser, which keeps trying.)
 */
export const collabApi: FastifyPluginAsync<{
  db: Db
  hub: CollabHub
  publicUrl: string
  accessCheckMs: number
}> = async (app, { db, hub, publicUrl, accessCheckMs }) => {
  const allowedOrigin = new URL(publicUrl).origin

  app.get<{ Params: { key: string } }>(
    '/api/collab/:key',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        // Browsers send the cookie with any site's WebSocket; only our own pages may open one.
        const origin = req.headers.origin
        if (origin !== undefined && origin !== allowedOrigin)
          return reply.code(403).send({ error: 'Forbidden' })
      },
    },
    (socket, req) => {
      const token = req.cookies[SESSION_COOKIE]
      const { key } = req.params
      let peer: CollabPeer | null = null
      let room: CollabRoom | null = null
      let closed = false
      const end = (reason: string) => socket.close(CLOSE_ACCESS_LOST, reason)
      // Messages arriving while access is checked and the room loads wait for it.
      const waiting: Uint8Array[] = []
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return socket.close(1003, 'Binary messages only')
        if (room && peer) room.receive(peer, data)
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

      // Access, again and again: what ends it ends the connection.
      let checking = false
      const recheck = setInterval(async () => {
        if (checking || !peer) return
        checking = true
        try {
          const now = await admit(db, token, key)
          if ('refused' in now) end(now.refused)
          else if (now.target.readOnly !== peer.readOnly) {
            end(
              now.target.readOnly
                ? 'You can only view this draft now: reload'
                : 'You can edit this draft now: reload',
            )
          }
        } catch (err) {
          // The database didn't answer: the next check will tell.
          req.log.warn({ err, key }, 'collab: checking access failed')
        } finally {
          checking = false
        }
      }, accessCheckMs)

      socket.on('close', () => {
        closed = true
        clearInterval(ping)
        clearInterval(recheck)
        if (room && peer) void hub.leave(room, peer)
      })

      admit(db, token, key)
        .then(async (admitted) => {
          if (closed) return
          if ('refused' in admitted) return end(admitted.refused)
          const joining: CollabPeer = {
            user: admitted.user,
            readOnly: admitted.target.readOnly,
            send: (message) => {
              if (socket.readyState === socket.OPEN) socket.send(message)
            },
            close: (code, reason) => socket.close(code, reason),
          }
          peer = joining
          const joined = await hub.join(admitted.target, joining)
          if (closed) return void hub.leave(joined, joining)
          room = joined
          for (const message of waiting.splice(0)) joined.receive(joining, message)
        })
        .catch((err) => {
          req.log.error({ err, key }, 'collab: opening a document failed')
          socket.close(1011, 'Could not open the document')
        })
    },
  )
}
