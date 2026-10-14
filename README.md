# Optiply Workflows

Optiply's internal tools platform, modeled on Retool. It covers **Resources** (connections to databases and APIs), **Workflows** (automated backend processes with triggers and schedules), and later **Database** (simple managed tables) and **Apps** (internal UIs).

- Architecture and roadmap: [docs/architecture.md](docs/architecture.md)
- Progress log and where to pick up: [docs/handoff.md](docs/handoff.md)

## Stack

TypeScript monorepo (pnpm + Turborepo):

| Path | What |
|---|---|
| `apps/server` | Fastify v5 + tRPC v11 API, with Google OIDC and local break-glass login, plus the REST runs API. The workflow worker runs queued runs. One entrypoint; `ROLE=api\|worker\|migrate\|all` picks what it runs. |
| `apps/web` | Vite + React 19, TanStack Router and Query, Tailwind v4. The workflow editor: @xyflow/react canvas, dagre layout, Monaco, zustand. Playwright e2e in `e2e/`. |
| `packages/db` | Drizzle ORM schema and migrations (Postgres). Embedded Postgres for dev and tests. |
| `packages/sandbox` | isolated-vm runtime that runs user JavaScript (code blocks, `{{ }}` expressions) with no Node APIs and with time and memory limits |
| `packages/crypto` | AES-256-GCM for stored secrets (versioned keys, each value bound to its row and environment), API-key hashing, secret redaction |
| `packages/expressions` | `{{ }}` template parsing and rendering, free-identifier analysis, and the SQL lexer that turns `{{ }}` into bind parameters |
| `packages/connectors` | Postgres and REST connectors, client pooling, timeouts and cancellation, SSRF guard |
| `packages/definition` | The workflow definition format (zod), its validator, graph helpers, canonical JSON and the definition hash, cron with time zones, webhook aliases, release versions |
| `packages/engine` | Runs workflows: the orchestrator and block executors, the Postgres queue (claims with concurrency limits, leases with fencing epochs, recovery of runs whose worker died), the scheduler, and the in-process runner for sync webhooks |

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

## Building and running workflows

Open **Workflows** in the app to create one. The editor has:

- a canvas for blocks and connections;
- a side panel with each block's settings, Monaco for code and SQL, and autocomplete from the latest run;
- **Run** (it saves first and uses the start trigger's test input) and **Run block** (it reuses earlier results);
- live status on the canvas, and a run panel with each block's data, logs and output.

**Runs** lists every run you can see.

A draft run needs Edit on the workflow and Use on every resource it queries. With `ROLE=all` the same process runs the worker; `WORKER_CONCURRENCY` (default 4) sets how many runs it executes at once.

Code blocks can call `await fetch(url, { method, headers, body })` (the body is a string; the response has `status`, `headers`, `text()` and `json()`). Requests to private, loopback and link-local addresses are refused unless `CODE_FETCH_ALLOW_PRIVATE_NETWORK=true` (for local test servers); responses are capped at 10 MB, and a request stops when its block times out or the run stops.

Runs can also be started and read over the REST API, signed in with the session cookie:

```bash
curl -c jar -H 'content-type: application/json' -d '{"email":"you@optiply.nl","password":"…"}' localhost:3000/api/auth/local
curl -b jar -H 'content-type: application/json' -d '{"input":{"id":2}}' 'localhost:3000/api/v1/workflows/<slug>/runs?environment=production'
curl -b jar localhost:3000/api/v1/runs/<runId>          # also /blocks, /blocks/<name> (with data), /logs and /events (SSE)
```

### Releases, webhooks and schedules

Editor runs use the draft. **Publish** (top right) releases the draft as a new semver version and makes it live; the **Releases** tab lists every release and can make an earlier one live again (rollback). Webhooks, schedules and `"version": "live"` runs execute the live release. Publishing or rolling back needs Edit on the workflow and Use on every resource it queries in every environment.

Triggers are set on the start trigger and take effect when you publish:

- **Webhook**: `POST /api/v1/workflows/<slug>/webhook`, plus `/api/v1/hooks/<alias>` with an alias such as `orders/:orderId` (params arrive in `startTrigger.pathParams`). Callers need an API key (**Settings → API keys**, admins only; shown once):

  ```bash
  curl -X POST 'localhost:3000/api/v1/hooks/orders/42?environment=staging' \
    -H 'X-Api-Key: ow_…' -H 'Content-Type: application/json' -d '{"note":"hi"}'
  ```

  The call waits for the Response block (up to the webhook's timeout, 30 s by default) and answers with its status, headers and body; without a Response block it gets `200 {runId, status}`, and `500` if the run failed first. `Prefer: respond-async` (or a timeout) answers `202 {runId}` with a `Location` the same key can read. `Idempotency-Key` makes a retry return the same run. Sync webhook runs execute in the API process (`WEBHOOK_INLINE_CONCURRENCY`, default 8) when a slot is free.
- **Schedules**: a cron expression on a time zone's wall clock (Europe/Amsterdam by default) or a fixed interval, in a chosen environment. Workers fire due schedules every 5 s, each fire once; after downtime a schedule catches up with one run. If the previous run is still going, the fire is skipped (default), queued, or allowed to overlap.

**Settings → Runs at once** in the editor caps how many runs of a workflow execute at the same time.

## Checks

```bash
pnpm lint        # Biome
pnpm typecheck
pnpm test        # Vitest; server tests boot a throwaway embedded Postgres per file
pnpm --filter @ow/server bench:webhooks   # sync webhook latency (p50 < 50 ms), run alone because it's timing-sensitive

# End-to-end (Playwright): builds, then drives the editor against the bundled server
pnpm --filter @ow/web build && pnpm --filter @ow/server build
pnpm --filter @ow/web e2e   # uses the installed Chrome locally; CI installs Chromium
```

## Deployment

```bash
docker compose up --build        # postgres:18, one-shot migrate, api (serves the web app on :3000), 2 workers
```

Compose reads `.env`; set `PUBLIC_URL=http://localhost:3000` there (or in the shell) when the app is served by the `api` container rather than Vite. Create the first admin with `docker compose exec api node dist/cli/create-admin.js --email you@optiply.nl --name You`.

The image (`Dockerfile`) runs on `node:24-bookworm-slim`, with `TZ=UTC` and `--no-node-snapshot` (both required by the sandbox).
