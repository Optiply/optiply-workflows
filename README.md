# Optiply Workflows

Optiply's internal tools platform, modeled on Retool. It covers **Resources** (connections to databases and APIs), **Workflows** (automated backend processes with triggers and schedules), and later **Database** (simple managed tables) and **Apps** (internal UIs).

- Architecture and roadmap: [docs/architecture.md](docs/architecture.md)
- Progress log and where to pick up: [docs/handoff.md](docs/handoff.md)

## Stack

TypeScript monorepo (pnpm + Turborepo):

| Path | What |
|---|---|
| `apps/server` | Fastify v5 + tRPC v11 API, with Google OIDC and local break-glass login, plus the REST runs API. The workflow worker runs queued runs. One entrypoint; `ROLE=api\|worker\|migrate\|all` picks what it runs. |
| `apps/web` | Vite + React 19, TanStack Router and Query, Tailwind v4 |
| `packages/db` | Drizzle ORM schema and migrations (Postgres). Embedded Postgres for dev and tests. |
| `packages/sandbox` | isolated-vm runtime that runs user JavaScript (code blocks, `{{ }}` expressions) with no Node APIs and with time and memory limits |
| `packages/crypto` | AES-256-GCM for stored secrets (versioned keys, each value bound to its row and environment), API-key hashing, secret redaction |
| `packages/expressions` | `{{ }}` template parsing and rendering, free-identifier analysis, and the SQL lexer that turns `{{ }}` into bind parameters |
| `packages/connectors` | Postgres and REST connectors, client pooling, timeouts and cancellation, SSRF guard |
| `packages/definition` | The workflow definition format (zod), its validator, graph helpers, canonical JSON and the definition hash |
| `packages/engine` | Runs workflows: the orchestrator and block executors, and the Postgres queue (claims, leases with fencing epochs, recovery of runs whose worker died) |

## Local development

Requires Node ≥ 24. Docker is **not** needed for development: Postgres comes from the `embedded-postgres` npm package.

```bash
corepack enable                  # provides pnpm (or prefix commands with `corepack pnpm`)
pnpm install
cp .env.example .env             # then set SESSION_SECRET and ENCRYPTION_KEYS (and the OIDC_* values for Google SSO)

pnpm dev:db                      # terminal 1: Postgres on 127.0.0.1:5433 (data in .data/pg)
pnpm --filter @ow/server create-admin -- --email you@optiply.nl --name "You"   # local admin (prompts for password)
pnpm dev                         # terminal 2: API on :3000 (auto-migrates) + web on http://localhost:5173
```

`ENCRYPTION_KEYS` encrypts resource credentials and secret config vars. Generate a key with `node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"` and **back it up**: losing it makes every stored secret unreadable. To rotate, add a new key to `ENCRYPTION_KEYS`, make it current with `ENCRYPTION_KEY_CURRENT`, run `pnpm --filter @ow/server rekey`, then remove the old key.

The first user to sign in becomes an admin. After that, admins manage access under **Settings → Groups**.

### Google SSO

Create an OAuth client of type "Web application" in Google Cloud Console. Set its redirect URI to `<PUBLIC_URL>/api/auth/oidc/callback`, then fill in `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Only verified `@optiply.nl` accounts can sign in (`OIDC_ALLOWED_DOMAIN`).

## Running a workflow

There's no workflow editor yet (M3). Workflows are created and saved over tRPC (`workflows.create`, `workflows.saveDraft`) and run over the REST API, signed in with the session cookie:

```bash
curl -c jar -H 'content-type: application/json' -d '{"email":"you@optiply.nl","password":"…"}' localhost:3000/api/auth/local
curl -b jar -H 'content-type: application/json' -d '{"input":{"id":2}}' 'localhost:3000/api/v1/workflows/<slug>/runs?environment=production'
curl -b jar localhost:3000/api/v1/runs/<runId>          # also /blocks, /blocks/<name> (with data) and /logs
```

A draft run needs Edit on the workflow and Use on every resource it queries. With `ROLE=all` the same process runs the worker; `WORKER_CONCURRENCY` (default 4) sets how many runs it executes at once.

## Checks

```bash
pnpm lint        # Biome
pnpm typecheck
pnpm test        # Vitest; server tests boot a throwaway embedded Postgres per file
```

## Deployment

```bash
docker compose up --build        # postgres:18, one-shot migrate, api (serves the web app on :3000), 2 workers
```

The image (`Dockerfile`) runs on `node:24-bookworm-slim`, with `TZ=UTC` and `--no-node-snapshot` (both required by the sandbox).
