# Session handoff

What has been built, how, and where to pick up. **Read this first in a new session**, then the matching milestone in [architecture.md](architecture.md), which holds the full Retool analysis, the design decisions and the roadmap (M0–M9).

Last updated: 2026-10-13 (end of session 2).

| | |
|---|---|
| **Branch** | `feat/m1-resources`, 5 commits on top of `main`, pushed |
| **PR** | [#1 M1: Resources](https://github.com/FabioAlexandreCeriaco/optiply-workflows/pull/1), **still a draft**, CI green on every commit |
| **`main`** | `fe2f073` (M0), then `ee985ff` (session 1 handoff) |
| **Remote** | `origin` = github.com/FabioAlexandreCeriaco/optiply-workflows (**private**), pushed with the authenticated `gh` CLI |

---

## 1. Status at a glance

| Milestone | Status |
|---|---|
| Research: how Retool works | ✅ Part 1 of `architecture.md` |
| Build plan and architecture | ✅ Approved. Part 2 of `architecture.md` |
| **M0 Foundations** | ✅ Merged on `main` (§3) |
| **M1 Resources** | ✅ **Done on `feat/m1-resources`, PR #1 open as a draft.** All three "done when" criteria pass (§4). |
| **M2 Headless engine** | ⏭️ **Next**, after PR #1 is merged |
| M3–M9 | Not started |

**Start the next session with:**
1. Review and merge PR #1. It's still a draft: mark it ready, then squash or merge as you prefer.
2. Then start M2 on a new branch.

## 2. Decisions made with the user (don't re-ask)

### Product and process
- **Product:** an internal Retool-style platform for **Optiply only**: single org, self-hosted. Not multi-tenant SaaS.
- **Priority:** **Resources + Workflows first**. Database is M7, the App builder M8.
- **Stack:** TypeScript full stack. React + Vite frontend, Node backend, Postgres. pnpm + Turborepo monorepo.
- **Workflow engine:** our own Postgres-backed orchestrator, not Temporal and not pg-boss. Rationale in `architecture.md` §2.1; semantics specified in §2.2.
- **Licences:** write our own code. AGPL projects (ToolJet, Windmill, Lowcoder) and n8n are for ideas only. Libraries under permissive licences are fine as dependencies:
  - MIT: acorn, undici.
  - BSD-2-Clause: eslint-scope. Flagged to the user in session 2; no objection.
- **Git workflow:**
  - Repo-local identity `fabioceriaco <fabioceriaco@optiply.nl>`.
  - **Commit only when the user asks.** End commit messages with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - One feature branch per milestone, with a **draft PR** opened early so CI runs on every push. CI only runs on pushes to `main` and on PRs.
  - Commit messages are detailed: what changed in each file, why, and how it was verified.
  - After each commit, update the PR description's checklist.
- **Working rhythm the user likes:** do one step, report, then wait for "commit" / "continue". Don't start the next step unprompted. Watch CI in the background and report the result.
- **Session wrap-up:** commit, then update this file.

### Taken in M1 (keep these unless there's a reason to change)
- **Encrypted values are one self-describing text token** `<keyVersion>.<iv>.<ciphertext>.<tag>` (base64url), not the separate ciphertext, IV and key-version columns first sketched. The AAD is `table:rowId:envId`. Every writer goes through `encryptForRow` / `decryptForRow` (`apps/server/src/services/secrets.ts`), so the AAD is always built the same way.
- **Secrets are write-only.**
  - The browser receives `{ set: true }` masks in place of values.
  - Saves send a patch: a string sets a value, `null` clears it, a missing key keeps it. Nested records such as REST secret headers are patched the same way.
  - Secret validation errors report field paths only.
- **Permission model:**
  - Grants are `(group, objectType resource|folder|workflow, objectId?, environmentId?, level use|edit|own)`.
  - A user's level is the highest of their groups' grants on the resource, on all resources (no `objectId`), or on any folder containing it, for that environment or for all environments.
  - Admins implicitly own everything.
  - **Use** = run queries, **Edit** = change settings, **Own** = delete and manage access.
  - Creating resources and folders needs Edit on all resources in all environments.
  - Folder-wide and type-wide grants are admin-only.
  - Resources the user can't see in any environment return NOT_FOUND.
- **Secret config vars are not in the query playground scope** (anyone with Use could `select` them). They'll be exposed to released workflows later. Non-secret ones are `{{ configVars.NAME }}`, plus `current_user`. Whether a var is secret is fixed at creation.
- **Postgres read-only mode guards against mistakes; it isn't a security boundary.** That's documented in the UI, the schema and the PR. The real boundary is a SELECT-only database user.
- **REST data is scrubbed of secret values; Postgres data isn't.** That's the `scrubResultData` flag. Errors and metadata are always scrubbed.
- **SSRF guard:** a REST resource blocks private, loopback, link-local, metadata, CGNAT and multicast addresses unless the resource sets `allowPrivateNetwork`. Hosts are limited to the base URL's host plus `allowedHosts`, and redirects are followed by hand with every hop checked.

## 3. What M0 built (on `main`)

Summary only; read the files for detail.

- **Monorepo:**
  - pnpm 10.34.7 (pinned in `packageManager`), Turborepo 2.11, Biome 2.5, **TypeScript `~6.0.3`**. Not TS 7: the Go-native compiler breaks drizzle-kit.
  - Workspace packages export TS source; there's no per-package build. The server is bundled by esbuild, the web app by Vite.
  - `AGENTS.md` is written by turbo; keep it committed.
- **`packages/db`:** Drizzle schema with UUIDv7 IDs generated app-side, and migrations generated by `pnpm db:generate` (never hand-edited). `runMigrations` runs under an advisory lock and seeds the production and staging environments plus the Admins and All Users groups. Embedded Postgres 18 for dev and tests (no Docker).
- **`packages/sandbox`:** isolated-vm `IvmRuntime`, with one isolate per runtime and a fresh context per evaluation from a snapshot. A watchdog handles async loops. ⚠️ Processes need **`TZ=UTC`** and Node needs **`--no-node-snapshot`**.
- **`apps/server`:**
  - Fastify 5 + tRPC 11 (superjson).
  - Google OIDC (openid-client v6, PKCE; email must be verified, `@optiply.nl`, with the `hd` claim) and break-glass local login (scrypt).
  - Opaque session cookie, stored as its sha256.
  - Users, groups and audit routers; `ROLE=api|worker|migrate|all`; `HOST` defaults to `127.0.0.1`.
- **`apps/web`:** React 19, TanStack Router (code-based routes) and Query, Tailwind v4 tokens, and small shadcn-style primitives in `components/ui.tsx`.
- **Ops:** multi-stage Dockerfile (`pnpm deploy --prod --legacy`, runtime `node:24-bookworm-slim`), Compose (postgres, migrate, api, 2 workers), CI (`biome ci`, typecheck, test, docker build).

## 4. What M1 built (on `feat/m1-resources`)

**The three "done when" criteria, and the test that proves each:**

| Criterion | Proven by |
|---|---|
| No secret in any API response | `apps/server/test/resources.test.ts` records the raw body of every response (77+, errors included) and scans them, plus the audit table, for 4 distinctive secrets. It also has an inline snapshot of the masked shape. The headless browser run captured 25 responses and found no DB password. |
| SQL injection stays inert, and `pg_stat_activity` shows `$1` | `packages/connectors/test/postgres.test.ts`, against a real Postgres. `pg_stat_activity` showed `select pg_sleep(0.6), $1::text as v`. |
| A ciphertext swapped between rows fails to decrypt | `packages/crypto/test/aead.test.ts`, plus `rekey` tests in `apps/server/test/secrets.test.ts` |

### Step 1, `c133bad`: `packages/crypto`
- `parseKeyring(ENCRYPTION_KEYS, ENCRYPTION_KEY_CURRENT?)`. Keys are `v1:<base64 32 bytes>`, comma-separated; the current key defaults to the last one listed. Key text is validated **strictly**, because Node's base64 decoder silently ignores anything after the `=` padding (a bug the tests found).
- `encrypt` / `decrypt` (AES-256-GCM, 12-byte IV), `encryptJson` / `decryptJson`, `secretAad`, `keyVersionOf`, `rekey`.
- `generateApiKey` / `hashApiKey` / `verifyApiKey` (`ow_` prefix, sha256, timing-safe compare). Webhooks need these in M4.
- `redact` (moved here from the server), `secretStrings`, `scrubSecrets`, `scrubSecretsDeep`.
- **The server now requires `ENCRYPTION_KEYS`.** Config parses it into `config.keyring` and drops the raw string. `.env.example`, Compose and the test helpers are updated.

### Step 2, `110ed87`: schema and `rekey`
- **Migration `0001_resources.sql`** creates:
  - `folders` (typed, nestable, unique name per parent, `ON DELETE RESTRICT` on the parent);
  - `permissions` (`UNIQUE NULLS NOT DISTINCT`, with CHECKs on level and object type);
  - `resources` (unique `slug`);
  - `resource_configs` (unique per resource and environment; `config` jsonb plus a `secrets` token);
  - `config_vars` and `config_var_values` (a CHECK requires exactly one of `value` or `value_encrypted`).
- `services/secrets.ts` holds `ENCRYPTED_COLUMNS`, `encryptForRow` / `decryptForRow`, and `rekeyAll` (batched, row locks, keyset pagination; rows that fail are reported and skipped; dry run).
- **`rekey`** runs as `pnpm --filter @ow/server rekey [--dry-run]`, or `node --no-node-snapshot dist/cli/rekey.js` inside the image. **`build.mjs` now bundles the CLIs** (`dist/cli/rekey.js`, `dist/cli/create-admin.js`).
- **Fixed:** pnpm 10 forwards the `--` in `pnpm x -- --flag` literally, so `parseArgs` treated the flags as positional arguments and `create-admin -- --email …` crashed. `cli/args.ts` (`cliArgs()`) drops a leading `--`.
- The first `packages/db` tests (7). The db tsconfig now includes `test/`.

### Step 3, `682fc10`: `packages/expressions`
- `parseTemplate`: finding the closing `}}` understands JavaScript, so nested objects, strings, template literals with `${}`, and comments don't end an expression early. Regex literals aren't handled. `singleExpression` detects a field that's just one `{{ x }}`. `TemplateError` carries start, end and a hint.
- `freeIdentifiers` / `freeIdentifierRefs` (acorn + eslint-scope, with offsets):
  - Two kinds: `expression` and `function-body`. The wrappers match the sandbox exactly.
  - Code that breaks out of the wrapper (`a)(b`, `}) || x(() => {`) is rejected. Validation uses `preserveParens`, and analysis re-parses without it.
  - **acorn's `ranges` option is required** by eslint-scope.
- `compileSql` (Postgres only; MySQL and BigQuery come in M6):
  - `{{ }}` becomes `$n`, aware of `'…'`, `E'…'`, `"ident"`, `$tag$…$tag$`, `--` comments and nested `/* */`.
  - `{{ }}` inside a quoted string or name is an error with a fix-it hint; inside a comment it's left alone.
  - Hand-written `$1` is rejected, and placeholders always stay separate tokens.
- `renderTemplate` / `renderText` / `renderJson` (added in step 4). `renderJson` inserts values as JSON outside JSON strings and as escaped text inside them.

### Step 4, `3e4f5fc`: `packages/connectors`
- **`Connector` interface** (`types.ts`): zod config, secrets and query schemas; `createClient` / `destroyClient`; `testConnection`; `validateQuery`; `execute(client, query, { evaluate, signal, timeoutMs })`. Every failure is a `ConnectorError` with a `code`.
- **`PoolManager`:** one client per (config id, version). A client in use is never closed; stale, idle and LRU-evicted clients close once released. Failed connects aren't cached.
- **`runQuery` / `testResource`:** timeouts, cancellation, `expression` error labelling, and secret scrubbing.
- **Postgres** (`postgres.ts`):
  - ⚠️ **Security fix:** postgres.js sent SQL without parameters over the *simple* protocol, so `commit; delete …` could break out of a READ ONLY transaction. All user SQL now uses `{ simple: false, prepare: false }`.
  - `describe()` runs first: SQL errors surface before any `{{ }}` runs, parameter types come back (objects become JSON for non-json parameters), and we learn whether the statement returns rows.
  - Rows are read through a cursor with a `maxRows` guard. Writes report `command` and `rowCount`.
  - `statement_timeout` is set with `set_config(…, true)`; cancel works on abort; read-only uses a READ ONLY transaction plus a read-only session.
- **REST** (`rest.ts`, `net-guard.ts`): undici 8.11.2; auth modes none, apiKey, bearer, basic, secret headers and OAuth2 client credentials (cached, one retry on 401); allowed hosts; manual redirects; the SSRF guard (connect-time `lookup` plus an IP-literal check); response size cap; JSON, text or base64 decoding.

### Step 5, `02eb7c6`: API, UI and the sandbox stdlib fix
- **Sandbox:** the stdlib is now a **committed generated bundle**, `packages/sandbox/src/stdlib.generated.ts`, produced by `pnpm --filter @ow/sandbox bundle:stdlib`. `test/stdlib.test.ts` fails when it's stale (for example after bumping lodash or dayjs). esbuild, lodash and dayjs became dev dependencies. *This was the session 1 TODO "the stdlib breaks once bundled"; it's resolved.*
- **Server:**
  - `services/permissions.ts` (`ResourceAccess`) and `services/resources.ts` (masks, patches, `toResolved`, `publicConfigVars`).
  - Routers: `resources` (types, list, get, create, update, delete, saveConfig, deleteConfig, test, run), `permissions` (list, set), `folders`, `configVars`.
  - `ctx.services = { pool, sandbox }`, created in `buildApp` and closed `onClose`.
  - `trpc/errors.ts` (`uniqueOr`, `invalidInput`).
- **Web:**
  - `pages/resources/{list,detail,settings-forms,playground,shared}.tsx` and `pages/settings/config-vars.tsx`.
  - New primitives: `Textarea`, `Select`, `Field`, `Tabs`.
  - The detail page opens on Settings while the selected environment isn't configured.
- **Tests:** 14 resource API tests, including the no-secrets sweep.

### Totals at the end of M1
`biome ci` is clean. Typecheck passes **7/7** packages. **197 tests pass**:

| Package | Tests |
|---|---|
| expressions | 72 |
| connectors | 54 |
| server | 27 |
| crypto | 25 |
| sandbox | 12 |
| db | 7 |

The web and server builds succeed, and CI is green on all 5 commits, both jobs.

## 5. How things were verified (and how to repeat it)

- **Unit and integration tests:** `pnpm test`. Each server, db and connector test file boots its own embedded Postgres.
- **Headless browser walkthrough of M1**, against the **bundled** server (`dist/main.js` serving `apps/web/dist`). The script was `walk.mjs` with puppeteer-core and the local Chrome at `/Applications/Google Chrome.app`. It lived in the session scratchpad and **isn't committed**; Playwright e2e arrives in M3.
  - Steps covered: sign in → create a Postgres resource → fill settings → test connection → save → reload ("Stored securely") → playground with `{{ plan }}` → fix-it hint for `'{{ plan }}'` → create a config var → resource list.
  - Gotchas from writing it:
    - Puppeteer's `::-p-text()` matches **substrings**, so "Save" matched "Save details". Match text exactly.
    - Input values aren't part of `innerText`.
    - Top-level `await` errors don't fire `unhandledRejection`; wrap the steps in try/catch.
- **To run the bundled server locally**, set `MIGRATIONS_DIR=../../packages/db/migrations` and `WEB_DIST_DIR=../web/dist` (Docker sets both). `@fastify/static` lists files once at startup, so **restart it after rebuilding the web app**.

## 6. Local environment quirks (this Mac)

- Node v24.15.0 (arm64). **No global pnpm, no Docker, no system Postgres.**
- Run pnpm as **`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`**. **Turbo needs a `pnpm` binary on PATH.** In a Claude session, run `corepack enable --install-directory <scratchpad>/bin pnpm` and prepend that directory to PATH. The user can simply run `corepack enable`.
- **Dev database:** `pnpm dev:db` stores its data in `.data/pg` (gitignored), with `DATABASE_URL=postgres://ow:ow@127.0.0.1:5433/optiply_workflows`. It contains a **`demo_customers`** table (5 rows) for trying the playground. Point a Postgres resource at `127.0.0.1:5433`, database `optiply_workflows`, user `ow`, password `ow`, SSL off.
- **`.env`** (gitignored) has `SESSION_SECRET`, `LOCAL_LOGIN_ENABLED=true` and, **since session 2, a generated `ENCRYPTION_KEYS=v1:…`**. Losing that key makes the dev database's stored resource secrets unreadable, which is harmless in dev.
- **Dev admin:** `admin@optiply.nl`. Its password was reset to a random value during the browser test and given to the user in the chat. To set your own:
  ```bash
  corepack pnpm --filter @ow/server create-admin -- --email admin@optiply.nl --name Admin
  ```
  It prompts for a password, or reads `ADMIN_PASSWORD`.
- **Everything was stopped** at the end of the session (database, API, Vite).

## 7. Still unverified

1. **Google SSO** against real Google. This needs an OAuth client with redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`, plus `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` from the user.
2. **`docker compose up`** locally (Docker isn't installed). CI's `docker build` passes. Compose now **requires `ENCRYPTION_KEYS`** in `.env`.

## 8. Known gaps and TODOs carried forward

- **Pool invalidation across processes:** there's no `NOTIFY resource_changed` yet. Pooled clients are keyed by `updatedAt`, so a saved change gets a fresh client the next time anyone loads the config. Add LISTEN/NOTIFY when workers keep long-lived pools (M2).
- **Postgres `describe()`** leaves one named prepared statement per query on the server connection until postgres.js recycles it (after 60s idle, or its maximum lifetime). Acceptable; revisit if a connection's memory grows.
- **Expression evaluation** is one shared `IvmRuntime` per process; concurrent evaluations queue on one isolate. M2 creates one runtime per run lease, as the architecture says.
- **Tests not written yet:** the OIDC callback logic (extract the claim checks into a pure function and unit-test it), and Playwright e2e (M3).
- **Web:**
  - No toast or confirm-dialog system yet; `confirm()` is used.
  - No code-splitting; the bundle is 544 kB.
  - The playground uses textareas; Monaco arrives in M3.
- **Not built yet:**
  - MySQL and BigQuery connectors, and multipart REST bodies (M6).
  - API keys exist in `@ow/crypto` but there's no `api_keys` table or UI; that's M4.
  - `oauth_tokens` (per-user OAuth) is M9.
- **The permission model has a `workflow` object type** in the schema CHECK, but no code uses it yet. M2–M4 should reuse `ResourceAccess`'s approach for workflows.

## 9. Next step: M2 Headless engine

From `architecture.md` §2.2 (semantics), §2.3 (data model), §2.4 (definition) and §2.7:

1. **`packages/definition`:** a zod v4 schema for workflow definitions (`schemaVersion`, `settings`, triggers, `blocks`, `edges`, `functions`, `layout`) and `validateDefinition()`, which returns diagnostics: unique names, valid ports, no cycles, one start trigger, and expression identifiers that are ancestors or globals. That last check uses `@ow/expressions`' `freeIdentifiers`. It also needs canonical JSON and `definition_hash`.
2. **Schema:** `workflows`, `workflow_draft_snapshots`, `workflow_releases`, `workflow_triggers`, `workflow_runs` (the queue, with lease and fencing-epoch fields), `block_runs`, `block_run_payloads`, `run_logs`.
3. **`packages/engine`:**
   - The orchestrator: readiness, dead-path elimination, error ports, `finally=stop|continue`.
   - Block executors: startTrigger, code (sandbox `runCode`), resourceQuery (`@ow/connectors` `runQuery`), branch, filter, response.
   - Retries and timeouts.
   - A dispatcher: claim with `FOR UPDATE SKIP LOCKED`, LISTEN/NOTIFY wake-ups, leases with fencing epochs, and a reaper.
4. **Worker:** replace the heartbeat placeholder in `apps/server/src/worker/index.ts` with the claim loop.
5. **A manual-run REST API**, plus run and block-run reads.
6. **M2 is done when:**
   - Golden semantics tests cover every rule in §2.2.
   - A `kill -9` of a worker mid-run resumes without re-running completed blocks.
   - The zombie-worker fencing test passes.

## 10. How to start the next session

```bash
cd /Users/optiply/optiply-workflows
git fetch && git status                          # PR #1 merged? Then: git switch main && git pull
gh pr view 1                                     # draft → ready → merge, if not done yet
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
corepack pnpm dev:db &                           # Postgres on :5433
corepack pnpm --filter @ow/server dev &          # API on :3000 (auto-migrates; needs ENCRYPTION_KEYS in .env)
corepack pnpm --filter @ow/web dev               # http://localhost:5173
git switch -c feat/m2-engine                     # then open a draft PR early so CI runs
```
