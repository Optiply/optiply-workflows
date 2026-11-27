/**
 * A webhook's synchronous reply for a failed run (`sendRunReply`): the error as the run recorded it, except that
 * a failure naming the publisher (a live run acting as them, §2.47) doesn't tell the caller who that is.
 */
import type { WorkflowRun } from '@ow/db'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { sendRunReply } from '../src/services/webhooks'

async function replyFor(error: unknown) {
  const app = Fastify()
  app.get('/', (_req, reply) =>
    sendRunReply(reply, { id: 'r1', status: 'failed', response: null, error } as unknown as WorkflowRun),
  )
  const res = await app.inject({ method: 'GET', url: '/' })
  await app.close()
  return { status: res.statusCode, body: res.json() }
}

describe('sendRunReply', () => {
  it('passes a run error on as it is', async () => {
    expect(await replyFor({ code: 'http', message: 'me: The API answered 500' })).toEqual({
      status: 500,
      body: { runId: 'r1', status: 'failed', error: { code: 'http', message: 'me: The API answered 500' } },
    })
  })

  it("leaves the publisher's name out", async () => {
    const res = await replyFor({
      code: 'auth_required',
      message: "This workflow's live runs use the own account of Ada Lovelace, who made this release live: …",
      details: { reason: 'not_connected', account: 'user', publisher: true },
    })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('auth_required')
    expect(res.body.error.message).not.toContain('Ada')
    expect(res.body.error.message).toMatch(/publisher's account .* can't be used right now/)
  })
})
