import { createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'

/**
 * Google's token endpoint and a GCE metadata server, just enough for `google-auth.ts`: a JWT must be signed by the
 * fake's service account and addressed to its token URL; a refresh token must be the fake user's; the metadata
 * server wants `Metadata-Flavor: Google`. Tokens issued are counted per kind.
 */
export class FakeGoogle {
  /** A service account key file whose JWTs this fake accepts. */
  readonly keyJson: string
  /** An `authorized_user` file (as `gcloud auth application-default login` writes) this fake accepts. */
  readonly userJson: string
  readonly issued = { jwt: 0, refresh: 0, metadata: 0 }
  /** Scopes asked of the metadata server, in order. */
  readonly metadataScopes: string[] = []
  private readonly publicKey: string
  private server?: Server
  private base = ''

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    this.publicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    this.keyJson = JSON.stringify({
      type: 'service_account',
      project_id: 'fake-project',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: 'tunnel@fake-project.iam.gserviceaccount.com',
      token_uri: 'https://evil.example.com/token',
    })
    this.userJson = JSON.stringify({
      type: 'authorized_user',
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'csecret',
      refresh_token: 'refresh-me',
      token_uri: 'https://evil.example.com/token',
    })
  }

  get tokenUrl(): string {
    return `${this.base}/token`
  }

  /** For `GCE_METADATA_HOST`. */
  get metadataHost(): string {
    return new URL(this.base).host
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const { status, json, text } = this.answer(req.method ?? '', req.url ?? '', req.headers, body)
        res.writeHead(status, { 'content-type': text === undefined ? 'application/json' : 'text/plain' })
        res.end(text ?? JSON.stringify(json))
      })
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server?.close(r))
  }

  private answer(
    method: string,
    path: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
  ): { status: number; json?: unknown; text?: string } {
    const url = new URL(path, this.base)
    const md = '/computeMetadata/v1/instance/service-accounts/default'
    if (url.pathname.startsWith(md)) {
      if (headers['metadata-flavor'] !== 'Google') return { status: 403, text: 'Missing Metadata-Flavor' }
      if (url.pathname === `${md}/email`)
        return { status: 200, text: 'vm@fake-project.iam.gserviceaccount.com' }
      if (url.pathname === `${md}/token`) {
        this.metadataScopes.push(url.searchParams.get('scopes') ?? '')
        return { status: 200, json: { access_token: `md-${++this.issued.metadata}`, expires_in: 3599 } }
      }
    }
    if (method === 'POST' && url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(body))
      if (form.grant_type === 'refresh_token') {
        const user = JSON.parse(this.userJson)
        if (form.refresh_token !== user.refresh_token || form.client_secret !== user.client_secret)
          return { status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request' } }
        return { status: 200, json: { access_token: `user-${++this.issued.refresh}`, expires_in: 3599 } }
      }
      const [header, claims, signature] = (form.assertion ?? '').split('.')
      const valid = createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(this.publicKey, signature ?? '', 'base64url')
      const c = valid ? JSON.parse(Buffer.from(claims!, 'base64url').toString()) : {}
      if (!valid || c.aud !== this.tokenUrl)
        return { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }
      return {
        status: 200,
        json: { access_token: `sa-${++this.issued.jwt}`, expires_in: 3599, scope: c.scope },
      }
    }
    return { status: 404, text: 'Not found' }
  }
}
