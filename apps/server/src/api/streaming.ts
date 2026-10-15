import type { ServerResponse } from 'node:http'

/** Waits until a response can take more, or until the client is gone (so a download nobody reads can't hang). */
export function drainOrClose(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}
