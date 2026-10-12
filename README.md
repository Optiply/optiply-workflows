# Optiply Workflows

Optiply's internal tools platform, modeled on Retool. It covers **Resources** (connections to databases and APIs), **Workflows** (automated backend processes with triggers and schedules), and later **Database** (simple managed tables) and **Apps** (internal UIs).

- Architecture and roadmap: [docs/architecture.md](docs/architecture.md)
- Progress log and where to pick up: [docs/handoff.md](docs/handoff.md)

## Stack

TypeScript monorepo (pnpm + Turborepo):

| Path | What |
|---|---|
| `apps/server` | Fastify v5 + tRPC v11 API, with Google OIDC and local break-glass login. Workflow worker (placeholder until M2). One entrypoint; `ROLE=api\|worker\|migrate\|all` picks what it runs. |
| `apps/web` | Vite + React 19, TanStack Router and Query, Tailwind v4 |
| `packages/db` | Drizzle ORM schema and migrations (Postgres). Embedded Postgres for dev and tests. |
| `packages/sandbox` | isolated-vm runtime that runs user JavaScript (code blocks, `{{ }}` expressions) with no Node APIs and with time and memory limits |

## Local development

Requires Node ≥ 24. Docker is **not** needed for development: Postgres comes from the `embedded-postgres` npm package.

```bash
corepack enable                  # provides pnpm (or prefix commands with `corepack pnpm`)
pnpm install
cp .env.example .env             # then set SESSION_SECRET (and the OIDC_* values if you want Google SSO)

pnpm dev:db                      # terminal 1: Postgres on 127.0.0.1:5433 (data in .data/pg)
pnpm --filter @ow/server create-admin -- --email you@optiply.nl --name "You"   # local admin (prompts for password)
pnpm dev                         # terminal 2: API on :3000 (auto-migrates) + web on http://localhost:5173
```

The first user to sign in becomes an admin. After that, admins manage access under **Settings → Groups**.

### Google SSO

Create an OAuth client of type "Web application" in Google Cloud Console. Set its redirect URI to `<PUBLIC_URL>/api/auth/oidc/callback`, then fill in `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Only verified `@optiply.nl` accounts can sign in (`OIDC_ALLOWED_DOMAIN`).

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
