import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { FastifyPluginAsync } from 'fastify'

/**
 * The components CLI (M33, `ow-components`): one file the server's build makes (`dist/cli/ow-components.mjs`, beside
 * `dist/main.js`), served to anyone: it holds nothing of the instance's. `node ow-components.mjs --help`.
 * `COMPONENTS_CLI_FILE` points elsewhere (tests); from the sources (`pnpm dev`) there's none: 404.
 */
export const cliApi: FastifyPluginAsync = async (app) => {
  const file =
    process.env.COMPONENTS_CLI_FILE ?? fileURLToPath(new URL('./cli/ow-components.mjs', import.meta.url))
  app.get('/api/cli/ow-components.mjs', async (_req, reply) => {
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      return reply.code(404).send({ error: "The CLI isn't built here (the server's build makes it)" })
    }
    return reply
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment; filename="ow-components.mjs"')
      .type('text/javascript; charset=utf-8')
      .send(body)
  })
}
