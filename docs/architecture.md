# Optiply Workflows: a Retool-style internal platform

## Context
Optiply wants its own internal-tools platform, built like Retool but with our own interface. It will let us connect data sources (**Resources**), automate backend processes (**Workflows**), keep simple tables (**Database**), and later build internal UIs (**Apps**).

The repo (`/Users/optiply/optiply-workflows`) is empty, so this is a greenfield build.

Decisions so far:
- **Stack:** TypeScript full-stack (React + Vite, Node, Postgres).
- **Audience:** a single org, self-hosted, for Optiply internal use only.
- **MVP focus:** Resources and Workflows first. Database and the App builder come in later phases.

Part 1 explains how Retool works. Part 2 is the build plan.

---

# Part 1: How Retool works

> Retool runs two app builders as of 2026. In **classic apps** you drag and drop components and wire them up with `{{ }}` bindings. The **new app builder** (beta since May 2026) has an AI agent that generates React 19, shadcn and Tailwind code, with server-side TypeScript functions. Everything below describes the classic model, which is the core of the product and what we are cloning.

## 1.1 Platform architecture
- **One backend image, many roles**, chosen with `SERVICE_TYPE`:
  - `api`: serves the frontend and REST API, and runs queries from apps.
  - `db-connector` / `db-ssh-connector`: execute queries against resources.
  - `jobs-runner`: exactly one replica. Runs migrations, Git sync and cron jobs.
  - `multiplayer`: WebSocket co-editing.
  - `workflows-worker`: a Temporal worker.
  - `workflows-backend`: runs queries for workflows and stores block results.
  - `code-executor`: user JS and Python, sandboxed with nsjail.
  - `agent-*`.
- **Dependencies:**
  - **Postgres**: the platform database holding apps, resources (encrypted), users, permissions, `page_saves` history, `audit_trail_events`, `workflow_run` and `workflow_block_results`.
  - **Temporal**: durable execution for Workflows and Agents.
  - Optional Redis (cache) and S3 (large block results).
- **Secrets:**
  - `ENCRYPTION_KEY` (AES-GCM) encrypts resource credentials. Losing it means losing every resource.
  - `JWT_SECRET` signs sessions.
- **Queries always run on the server.** The browser sends the query ID plus the evaluated `{{ }}` values. The server loads the resource config, decrypts the credentials, and executes. Credentials never reach the browser.
  - SQL `{{ }}` values become **prepared-statement bind parameters**, which prevents SQL injection but means you cannot pass a dynamic table name.
  - `current_user` is injected on the server, which prevents spoofing.
- **Tech stack:** TypeScript, Node and React (18), built with Vite. App state is probably Redux plus Immutable.js. User JS runs in a **cross-origin iframe**, on a separate `SANDBOX_DOMAIN`.

## 1.2 Resources (connections)
- There are about 80 connector types:
  - **SQL:** Postgres, MySQL, MSSQL, Snowflake, BigQuery, …
  - **NoSQL:** Mongo, Redis, Dynamo, …
  - **APIs:** REST (manual or from an **OpenAPI spec**), GraphQL, gRPC.
  - **SaaS:** Stripe, Slack, Google, Salesforce, …
  - **AI:** OpenAI, Anthropic, …
  - **Storage and messaging:** S3, SQS, Kafka.
- **Config per environment:** each resource has separate host and credentials for `production` and `staging`, plus any custom environments. Apps and workflows stay the same; only the resource binding changes, selected with `_environment` or `?environment=`.
- **Auth methods:**
  - API key, Basic, Bearer, AWS SigV4, Google service account.
  - **OAuth2**: authorization code, client credentials or PKCE, with tokens stored per user and per environment, or shared via "share credentials between users".
  - **Custom auth flows**: ordered steps (form → API request → JS → define variable) plus a refresh flow that retries once after a non-2xx response.
- **Networking:** SSH tunnels through a bastion host, SSL client certs, and an outbound IP allowlist.
- **SQL query editor:**
  - **SQL mode**: raw SQL with bind params.
  - **GUI mode** for writes: insert, update, upsert, delete, plus bulk variants by primary key. Its fields are Table, Changeset, Filter-by and Primary key. A guard blocks writes to multiple rows unless you opt in.
- **REST query editor:** method, path, params, headers, cookies, and body (JSON, raw, form, multipart or binary). When a spec is attached it guides you through the operation.
- **Config variables and secrets:** per-environment values, referenced as `{{ retoolContext.configVars.X }}`. Secrets stay on the server.
- **Permissions:** Use / Edit / Own per group, on resources and resource folders, set per environment. Enterprise adds row and column **access policies** using user attributes.
- **Pooling and timeouts:** Postgres pools default to 10 connections; query timeout defaults to 120s (720s in workflows).

## 1.3 Workflows
- **Canvas model:**
  - Named **blocks** are joined by **connectors**, starting from `startTrigger`.
  - Fan-out runs in parallel. A block with several parents waits for all of them.
  - Every block exposes `name.data`, `name.error` and `name.metadata`. Any block that already ran can be read with `{{ }}`.
- **Block types:**

  | Block | What it does |
  |---|---|
  | startTrigger | `data`, `headers`, `pathParams`, `urlParams` from the trigger |
  | Resource query | Any resource, same editors as in apps |
  | Code | JS (Node 20, npm via package.json) or Python 3.x (requirements.txt), sandboxed with nsjail |
  | Branch | if / else-if / else, each with its own output connector |
  | Filter | iterable plus an expression on `value` / `index` |
  | Loop | runner = query / JS / function / workflow; parallel, sequential or batch(size, delay); per-iteration timeout, retries and error policy |
  | Function | Reusable subflow with named params; called from a Function block, `await fn()` in JS, or a Loop |
  | Workflow | Calls a child workflow, sync ("Finished") or async ("Queued") |
  | Response | HTTP status plus JSON body, the reply to a sync webhook or app call |
  | Wait | Durable delay, up to 60 days |
  | User Task | Human-in-the-loop. Assigns an app-based task to users or groups; the workflow resumes with its output. |
  | AI Action / Invoke Agent | LLM actions (generate, classify, extract…) and agents |
  | Global error handler | Unconnected block that runs on any unhandled error |

- **Settings on every block:** `timeoutMs` (default 10s), `retryCount`, `interval`, `exponential`, `coefficient`, `maxInterval`, and `finally` = stop or continue. "Continue" exposes a red **on-error** connector.
- **Triggers:**
  - **Manual**: the editor's Run button, using test JSON.
  - **Schedule**: interval or cron with a timezone; runs never overlap; jitter is added.
  - **Webhook**: `POST /api/workflows/:id/startTrigger` or an alias with `:params`, authenticated with an `X-Workflow-Api-Key` header. It is **synchronous if a Response block exists**. `?environment=` picks the environment.
  - Also: called from an app, called from another workflow, SQS/Kafka polling, and Retool platform events.
- **Context objects:** `workflowContext {currentRun, lastRun, lastSuccessfulRun, environment, triggerType}` and `retoolContext {configVars, secrets, users, groups}`.
- **Engine:** each run is a Temporal workflow. A worker calls code-executor (nsjail) for code blocks and workflows-backend for queries. Block results live in **Postgres or S3, not in Temporal**, because of Temporal's payload size limits.
- **Limits:**
  - Async runs: 30h. Sync runs: 15 min to the Response block.
  - 2.5 GB memory per run.
  - 50 in-flight requests per run.
  - 100 runs of a workflow per 15 min.
- **Versioning:** an autosaved **draft**, plus SemVer **releases**. Only the live release runs from schedules and webhooks.
- **Run history:** each run shows per-block status, logs, timing and data, with filters and JSON export. Default retention is 30 days.
- **IDE features:**
  - Run a single block, using cached upstream results.
  - Autolayout, minimap, README.
  - "Create function" from a selection of blocks.
  - Libraries tab, environment picker, AI-generated workflows.

## 1.4 Retool Database
- **What it is:** managed **Postgres** (self-hosted: a separate `retooldb-postgres`), exposed as a built-in resource named "Retool Database".
- **Spreadsheet-like editor:**
  - Tables list and tabs, inline cell editing, add or delete rows.
  - Filter, sort, hide and pin columns.
  - **Import CSV** or generate a schema with AI; export to CSV.
  - An `id` primary key is added automatically; foreign-key fields can open the linked row.
  - Field options: type, nullable, unique, default value (including SQL defaults).
- **Environments:** each environment gets its own isolated tables. Schemas are **migrated** between environments using a reviewed diff and generated SQL; data is not copied.

## 1.5 Apps (classic builder)
- **Layout:**
  - A **12-column grid** with fixed-height rows. **Frames** are Main, Header, Sidebar (240px), Modal, Drawer and Split pane.
  - **Containers** hold nested grids and support tabbed, stepped and multi-view variants. **Stack** is a flexbox container.
  - **List View / Grid View** repeat a template using `item` and `i`.
  - **Multipage** apps have global or per-page scope. **Modules** are reusable sub-apps with typed inputs and outputs.
  - A separate **mobile layout**, used below 600px.
- **Components:** about 100, grouped as buttons, Plotly charts, containers, forms, the Table, date, number, select and text inputs, presentation components, and special ones (file, signature, scanner, LLM chat).
  - Every component has an `id`, **properties** (configurable and runtime state), **methods** (`setValue`, `setHidden`, …) and **events**.
  - **Table** is the flagship component: selection, server-side pagination, filters and sort, editable cells (`changesetArray` → bulk-upsert query), row actions, grouping and export.
  - **Form** collects child `formDataKey`s into `form.data`, with validation and submit. It can be generated from a DB table, along with an insert query.
- **Reactivity:**
  - Every field can contain `{{ js }}`. All components, queries, transformers and variables are global identifiers.
  - A **dependency graph** re-evaluates the values that depend on a change, spreadsheet-style.
  - **Transformers** are pure.
  - **JS queries** have side effects: `query.trigger({additionalScope})`, `setValue`, and `utils.*`.
  - **Variables** hold temporary state; `localStorage` and `url` params are also available.
  - JS runs in a sandboxed cross-origin iframe with `_`, `moment`, `uuid`, `numbro` and `Papa` preloaded.
- **Queries in apps:**
  - Run behavior is **automatic** (reads and GETs) or **manual** (writes).
  - Options: run on page load, periodic runs, watched inputs, disabled-if, a confirmation prompt, throttle, timeout, cache TTL (on the server), and failure conditions.
  - Success and failure **event handlers** are how queries get chained.
- **Event handlers:** control query, control component, run script, go to app/page/URL, notify, set variable, set localStorage, set URL params, copy, export. Advanced options include "only run when", debounce and throttle.
  - Handlers on the same event run in parallel.
- **Reusing queries:** the **Query Library** offers org-wide versioned queries; apps can pin a version or follow the latest.
- **Serialization:** **Toolscript (`.rsx`)**, a JSX-like format:
  - `main.rsx` and `functions.rsx`.
  - Query bodies extracted to `lib/*.sql` and `*.js`.
  - **Layout stored separately** in `.positions/*.json`, which keeps diffs clean.
- **Releases and history:**
  - Every save is a history point. SemVer releases can be draft or published.
  - URL params: `_releaseVersion`, `_historyOffset`, `_environment`, `_embed`.
- **Extensibility:** custom component libraries are React built with a CLI and loaded in a sandboxed iframe through `Retool.useStateX` hooks. Also themes (tokens, light and dark), custom CSS, preloaded JS, Embed (signed single-use URLs for external users), and public apps.
- **Collaboration:** multiplayer editing (CRDT over WebSockets, last write wins, presence) and Debug Tools (console REPL, timeline, state and dependency inspector, linting, performance).

## 1.6 Org-level features
- **Tenancy:** Instance → Organization → **Spaces** (Enterprise: isolated sub-orgs on one instance).
- **Seats and groups:**
  - Seat types: builder, internal user, external user.
  - Default groups: `admin`, `editor`, `viewer`, `All Users`. Custom groups are available.
- **Permissions:** Use / Edit / Own on apps, resources (per environment), workflows, agents and folders. When several grants apply, the highest wins.
- **Admin controls:** granular admin roles, and **user attributes** (`current_user.metadata.*`) for row-level logic.
- **Identity:** SSO through SAML or OIDC with group sync at login, JIT provisioning, SCIM 2.0, and forced SSO per domain.
- **Audit logs:** logins, page views, query runs with parameters, and permission changes. Export to CSV or Datadog.
- **Source Control:** GitHub, GitLab and others. "Protected" objects are edited on branches, then go through a PR; merging auto-deploys. Multi-instance promotion (dev → prod).

## 1.7 Open-source reference points

| Project | Licence | Study it for |
|---|---|---|
| **Appsmith** | Apache-2.0 | `{{ }}` evaluation in a Web Worker: acorn dependency extraction, topological evaluation. Safe to borrow ideas from. |
| **Lowcoder/Openblocks** | AGPL | A clean typed node-graph eval engine. Study only. |
| **ToolJet** | AGPL | NestJS, TypeORM, Postgres, Temporal, isolated-vm, Yjs. Closest in shape to our stack. Study only. |
| **Windmill** | AGPL | Postgres as the job queue, nsjail workers, flows. Study only. |
| **n8n** | Sustainable Use (not OSI) | Node and plugin model. Do not copy code. |

**Rule:** we write our own code. We borrow ideas only, and code only from Apache-2.0 or MIT sources.

---

# Part 2: Build plan

## 2.1 Key decisions

| Area | Decision | Why |
|---|---|---|
| Execution engine | **Our own run-level orchestrator on Postgres.** No Temporal, no pg-boss. `workflow_runs` is the queue: claimed with `FOR UPDATE SKIP LOCKED`, workers woken by `LISTEN/NOTIFY`, protected by leases with **fencing epochs**. Each block result is checkpointed to `block_runs`. | Temporal adds a cluster plus replay/versioning costs on every interpreter change. Block-as-job on pg-boss has a join race, two sources of truth, about 0.5s of poll latency per hop, and can't support `await fn()` from JS. Durable timers, retries and leases are about 400 lines of code when the program is data. Hide the engine behind `RunDispatcher`/`RunExecutor` interfaces so it can be swapped. |
| Sync webhooks | The API runs the run in-process (the same engine, under a semaphore). When the semaphore is full, the run is queued and the API waits on `NOTIFY`. After `syncTimeoutMs`, or if the run suspends, it returns `202 {runId}`. | Target p50 under 50ms. |
| JS sandbox | **isolated-vm.** One isolate per run lease and a fresh context per evaluation. A snapshotted stdlib (lodash, dayjs, uuid, papaparse, numbro). A watchdog calls `dispose()` at the timeout, and memory is capped (128MB by default). Host bridges provide `fetch` (SSRF-guarded), `console` (into run_logs, redacted), and `await fn()`. | No Node APIs are exposed, so `process.env` and `ENCRYPTION_KEY` stay out of reach. The `CodeRuntime` interface allows a QuickJS or remote fallback. Python comes later as a separate nsjail executor. |
| Backend | Fastify v5 + **tRPC v11** for UI↔API calls, plus REST + zod with OpenAPI for public routes (webhooks, runs API). | End-to-end types, and clean public contracts. |
| DB | Postgres 18 (native `uuidv7()`), Drizzle ORM with committed SQL migrations, postgres.js driver. | |
| Frontend | Vite, React 19, TanStack Router + Query, **@xyflow/react** canvas + elkjs autolayout, **Monaco** (bundled locally), shadcn/ui + Tailwind v4, zustand for editor state. | |
| Auth | Google Workspace OIDC limited to `optiply.nl`, plus a break-glass local admin. Groups `admins` and `all_users` plus custom groups. Use/Edit/Own permissions per object, set per environment. | Internal-only use. |
| Secrets | AES-256-GCM with versioned keys (`ENCRYPTION_KEYS=v1:…,v2:…`), and **AAD = `table:rowId:envId`** so a ciphertext can't be swapped into another row. A `rekey` CLI re-encrypts existing rows. Secrets are never returned to the browser; responses show `{set:true}`. | |
| Deploy | One Docker image (`node:<lts>-bookworm-slim`, which isolated-vm needs for glibc). `ROLE=api|worker|migrate|all`. Docker Compose for local and server use. | This mirrors Retool's `SERVICE_TYPE` pattern. |

## 2.2 Workflow semantics (filling the gaps Retool leaves undocumented)

- **Block status:** `pending | running | succeeded | errored | failed | skipped | waiting | cancelled | interrupted`.
- **Edges** carry ports: `out`, `error`, `cond:<id>`, `else`.
- **Readiness:**
  - A block becomes ready when every incoming edge is resolved, and it runs if **at least one edge fired**.
  - If every incoming edge is dead, the block is `skipped`, and the skip propagates downstream (dead-path elimination). So a join after an if/else just works.
- **Branch:** only the first truthy condition fires. A condition that throws is a block error.
- **Errors:**
  - `finally=stop`: the run fails, in-flight sibling blocks are aborted, and the global error handler runs.
  - `finally=continue`: the block's `out` edge is dead and its `error` edge fires. To mean "always run C", connect both `out` and `error` to C.
- **References:** an expression may only reference static graph **ancestors** plus globals. Anything else is a lint error. A skipped ancestor evaluates to `{data:null, error:null, metadata:{status:'skipped'}}`.
- **Response:**
  - The first Response block sends the HTTP reply, and execution **continues**. Later Response blocks are marked `ignored`.
  - No Response reached: `200 {runId, status}`. Failure before a Response: `500`, unless the error handler contains a Response block.
- **Loop:**
  - `data` is an array the same length and order as the input.
  - `metadata.iterations[]` records each iteration's status.
  - Each iteration is checkpointed (`loop1[17]`), so a crash resumes without recomputing completed iterations.
  - `onError` is `stop` or `continue` (continue puts `null` in the failed slot).
- **Functions:** a subgraph with `params`. It returns the data of its return block. Called from a Function block, a Loop runner, or `await fn()` in JS.
- **Wait, sync child workflow, and User Task** persist the run as `waiting` with an `available_at`, which frees the worker slot. Time spent waiting doesn't count toward the run timeout (default 15 min, maximum 6h).
- **Delivery:** blocks execute at least once, and their outputs are committed exactly once (epoch fence plus unique `(run_id, block_key)`).
  - The scope exposes `idempotencyKey`.
  - Webhooks accept an `Idempotency-Key` header.
  - A run whose worker keeps crashing fails after 3 recoveries.
- **Schedules:** our own scheduler, rather than a library's.
  - `workflow_triggers.next_fire_at` holds the next fire time. Every worker ticks every 5s using SKIP LOCKED.
  - Overlap policy is `skip` (default), `queue` or `allow`. Runs are inserted with `ON CONFLICT (trigger_id, scheduled_for)`, so each fire happens exactly once.
  - After downtime the schedule catches up with one run, not a storm.
  - Timezone defaults to `Europe/Amsterdam`.

## 2.2a How §2.2 is tested

Built in M2 unless the status says otherwise. Engine tests are in `packages/engine/test/`: `semantics.test.ts` (in-memory store), `dispatcher.test.ts` and `crash.test.ts` (Postgres). Validator tests are in `packages/definition/test/validate.test.ts`; schema tests in `packages/db/test/workflows.test.ts`.

| Rule | Status | Covered by |
|---|---|---|
| Block statuses | ✅ `running`, `succeeded`, `errored`, `failed`, `skipped`, `cancelled`, `interrupted`. `waiting` comes in M5. `pending` is never written: a block gets a row when it starts or is skipped. | semantics (all groups); dispatcher "recovers runs…" (`interrupted`) |
| Edge ports | ✅ | semantics "branch", "errors"; validator "edges" |
| Readiness: all edges resolved, at least one fired | ✅ | semantics "fans out in parallel, and a join waits for every parent" |
| Dead-path elimination, join after if/else | ✅ | semantics "skips a block whose incoming edges are all dead…", "runs a join after if/else…", "skips blocks that nothing connects to" |
| Branch: first truthy only; a throwing condition is a block error | ✅ | semantics "branch" |
| `finally=stop`: run fails, in-flight siblings aborted | ✅. The global error handler is M5. | semantics "with finally=stop…" |
| `finally=continue`, and "always run C" via both ports | ✅ | semantics "with finally=continue…", "always runs a block connected to both out and error" |
| References: ancestors and globals only | ✅ | validator "references"; semantics "refuses an invalid definition…"; server "refuses to start runs that would fail anyway" |
| A skipped ancestor reads as `{data:null, error:null, metadata:{status:'skipped'}}` | ✅ | semantics "runs a join after if/else…" |
| Response: the first one replies, execution continues, later ones `ignored` | ✅, including across a resume | semantics "response", "does not reply again when an earlier lease already did" |
| Response HTTP mapping (no Response → 200 `{runId, status}`; failure → 500) | M4 (webhooks). The engine reports `response: null`. | semantics "has no response when no Response block runs" |
| Loop | M5 | |
| Functions | M5 | |
| Wait / sync child / User Task, `waiting` with `available_at` | M5. The run timeout (default 15 min, max 6 h) is ✅. | dispatcher "claims a queued run…" (15 min deadline); semantics "fails the run at its deadline…"; definition schema "bounds the run timeout…" |
| Delivery: at least once, committed exactly once | ✅ | crash "resumes a run on another worker after kill -9…"; dispatcher "fences off a zombie worker…", "never overwrites a committed result…"; semantics "delivery and resume"; db "commits one result per block key" |
| `idempotencyKey` in scope | ✅ (the caller's key, or the run id) | dispatcher "exposes the caller's idempotency key…" |
| Webhook `Idempotency-Key` header | M4. The unique index is ✅. | db "accepts an idempotency key once per workflow" |
| Fails after 3 recoveries | ✅ | dispatcher "recovers runs whose lease expired and fails one that keeps losing its worker" |
| Schedules | M4. The `ON CONFLICT (trigger_id, scheduled_for)` insert is ✅. | db "records each schedule fire once…" |

## 2.3 Data model (Drizzle, `packages/db`)
- **Identity:** `users`, `sessions`, `groups`, `group_members`, `permissions(group_id, object_type, object_id?, environment_id?, level)`, `environments`, `folders`.
- **Resources:**
  - `resources`
  - `resource_configs(resource_id, environment_id, config jsonb, secrets)`. In M1, `secrets` became one self-describing token `<keyVersion>.<iv>.<ciphertext>.<tag>` instead of separate ciphertext, IV and key-version columns; see `docs/handoff.md` §2.
  - `oauth_tokens`
  - `config_vars` + `config_var_values` (per environment, optionally secret)
  - `api_keys` (prefix + sha256 hash, scoped to workflows and environments)
- **Workflows:**
  - `workflows(draft_definition, draft_revision, live_release_id, max_concurrent_runs)`
  - `workflow_draft_snapshots`
  - `workflow_releases(version semver, definition frozen, definition_hash)`
  - `workflow_triggers`: the runtime projection of the live release's triggers, holding the webhook alias and `next_fire_at`
- **Runs:**
  - `workflow_runs`: status, input/output/error, lease fields, `available_at`, `idempotency_key`, `scheduled_for`, `parent_run_id`. In M2, `output` became `response` (the first Response block's reply), and each run points at exactly one release or draft snapshot.
  - `block_runs(run_id, block_key, status, attempt, timings, error, metadata)`. M2 added `epoch` (the lease that wrote it) and `port` (the output that fired).
  - `block_run_payloads` (data jsonb, 10MB cap)
  - `run_logs`
  - `user_tasks`
- **Audit:** `audit_events`, append-only; the app's DB role gets INSERT/SELECT only.
- **Retention:** a daily batched delete of runs older than 30 days.

## 2.4 Workflow definition (`packages/definition`, zod v4)
- **Shape:** `{schemaVersion, settings, triggers{webhook, schedules[], manual}, blocks[], edges[], functions[], layout}`.
- **Block types:** `startTrigger`, `errorTrigger`, `resourceQuery`, `code`, `branch`, `filter`, `loop`, `function`, `workflow`, `response`, `wait`, `userTask`.
- **Settings on every block:** `{timeoutMs, retry{count, intervalMs, exponential, coefficient, maxIntervalMs}, finally}`.
- **Built for Git:**
  - Block **names** are the identity. Resources and child workflows are referenced by **slug**.
  - Layout is stored separately, and JSON is canonical.
  - `definition_hash` covers everything except layout.
  - No secrets appear in a definition.
- **Validator** (`validateDefinition()` returns diagnostics for the editor):
  - unique names
  - valid ports
  - no cycles
  - exactly one start trigger
  - expression identifiers are ancestors or globals
  - no Response block inside functions
  - each query passes its connector's `querySchema`
  - at release time, the publisher has Use on every resource in the target environments

## 2.5 Connectors (`packages/connectors`)
- **Interface:** `Connector { type, configSchema, secretsSchema, querySchema, ui, poolKey, createClient, destroyClient, testConnection, compile, execute, introspect? }`.
- **Pools:** a PoolManager holds them in an LRU and evicts idle pools. `NOTIFY resource_changed` invalidates them everywhere.
- **SQL `{{ }}` → bind parameters**, through one shared lexer that is aware of quotes and comments:
  - Postgres uses `$n` (arrays bind natively, so you write `= ANY({{ids}})`).
  - MySQL uses `?` and expands arrays.
  - BigQuery uses `@pN` named parameters.
  - A `{{ }}` inside a string literal is a validation error that suggests a fix.
  - Per-resource `disablePreparedStatements` is for Own/admin only.
- **MVP connectors:**
  - **Postgres** (postgres.js): `SET LOCAL statement_timeout`, cancel on abort, `maxRows`, optional read-only mode.
  - **REST** (undici):
    - Config: base URL, default headers and parameters, `allowedHosts`.
    - Auth: none, API key, bearer, basic, or OAuth2 client-credentials (tokens cached, refreshed once on a 401).
    - Bodies: json, form, raw or multipart.
    - Non-2xx responses error.
  - **MySQL** (mysql2).
  - **BigQuery**: `maximumBytesBilled` guardrail, job labels for cost attribution, job cancel on abort.
- **Who runs as whom:** editor test runs use the editing user's Use permission. Released runs (schedule, webhook) were permission-checked when the release was published.

## 2.6 Monorepo layout (pnpm + Turborepo)
```
apps/
  web/      React editor + run history + resources UI (later: database editor, app builder)
  server/   main.ts ROLE switch → api/ (Fastify, tRPC, webhooks, SSE) · worker/ (claim loop, reaper,
            scheduler tick, retention) · cli/ (rekey, create-admin)
packages/
  definition/   zod schema, validator, graph utils, canonical JSON + hash           [web+server]
  expressions/  {{ }} parser, acorn free-identifier analysis, rename refactor, SQL lexer [web+server]
  engine/       orchestrator, block executors, scheduler, dispatcher (claim/lease/fast path)
  sandbox/      CodeRuntime, IvmRuntime, esbuild stdlib bundle + snapshot, host bridges
  connectors/   registry, PoolManager, postgres/ rest/ mysql/ bigquery/
  db/           Drizzle schema, migrations, repositories, LISTEN/NOTIFY helper
  crypto/       AES-GCM versioned keys + AAD, api-key hashing, secret redaction
  api-contract/ tRPC router types + REST zod/OpenAPI
  ui/           shared shadcn components (reused by the App builder later)
```
- **Files that carry the design:** `packages/definition/src/schema.ts`, `packages/engine/src/orchestrator.ts`, `packages/engine/src/dispatcher.ts`, `packages/db/src/schema.ts`, `packages/sandbox/src/ivm-runtime.ts`, `packages/connectors/src/types.ts`.
- **Editor features:**
  - **Canvas:** React Flow nodes per block type, ports for `out`, `error` and `cond:*`, an elk-based autolayout button, and a minimap.
  - **Inspector panel:** each block type has its own form. SQL and JS use Monaco, with a `.d.ts` generated from the last run's outputs so `query1.data[0].` autocompletes.
  - **Running:** Run (with test JSON), plus **Run block**, which uses the cached upstream outputs.
  - **Live status:** each block shows its status on the canvas, pushed over SSE.
  - **Run history panel:** filters, per-block data, logs, timing, and JSON export.
  - **Saving:** autosave with `draft_revision` (optimistic concurrency). A Releases tab handles publishing and rollback.
  - **App navigation:** the sidebar has Workflows, Resources, Runs and Settings (environments, groups, config vars, API keys, audit). Database and Apps are added in later phases.

## 2.7 Milestones

| # | Scope | Done when |
|---|---|---|
| **M0 Foundations** | `corepack enable` (pnpm), Docker/OrbStack (**neither is on PATH today**). Monorepo skeleton, CI (lint, typecheck, test), Docker image and Compose, Drizzle + migrate role, Google OIDC login, groups/admin, audit skeleton. **isolated-vm spike on Node 24 LTS** (fall back to Node 22). | `docker compose up` gives a working login. CI green. The spike shows a fresh isolate starting in under 10ms with the stdlib, and infinite-loop and memory-bomb tests are killed cleanly. |
| **M1 Resources** | crypto, environments (production/staging), resource CRUD per environment, Postgres + REST connectors, test connection, query playground with `{{ }}`, permissions, config vars and secrets | Snapshot tests show no secret in any API response. SQL injection fixtures stay inert and `pg_stat_activity` shows `$1`. A ciphertext swapped between rows fails to decrypt. |
| **M2 Headless engine** | definition + validator, orchestrator (startTrigger, code, resourceQuery, branch, filter, response), retries/timeouts/finally, claim/lease/reaper, block_runs/logs, manual-run REST API | **Golden semantics tests** cover every rule in 2.2. A `kill -9` of a worker mid-run resumes without re-running completed blocks. The zombie-worker fencing test passes. |
| **M3 Editor** | canvas, block inspectors, Monaco + generated types, autosave, Run / Run block, SSE live status, run history | Playwright: build "query → branch → code → response", run it, rename a block, and its references update. |
| **M4 Releases & triggers** | semver releases and rollback, trigger projection, webhooks (sync and async, aliases with `:params`, API keys, `?environment=`, Idempotency-Key), schedules (cron/interval, timezone, overlap), per-workflow concurrency | Sync webhook p50 under 50ms. Tests pass across the Amsterdam DST change. A 1-min cron with a 2-min run never overlaps. |
| **M5 Advanced blocks** | Loop (all modes and runners), Functions + `await fn()`, Workflow block, durable Wait, global error handler, run timeout, cancel | A 10k-iteration loop survives a crash. A Wait survives a full stack restart. Cancel aborts in-flight SQL and fetch calls. |
| **M6 Hardening** | MySQL, BigQuery, OAuth2 client-credentials, retention, audit UI, Prometheus `/metrics`, backup runbook, User Tasks + inbox | Retention runs without long locks. A User Task resumes its run. |
| **M7 Database** | Retool-DB clone: a managed Postgres schema per environment, a spreadsheet editor (TanStack Table / Glide Data Grid), schema editor, CSV import/export, exposed as a built-in resource | Create a table, import CSV, query it from a workflow. |
| **M8 App builder** | 12-column grid (react-grid-layout), component registry (`id`, props, methods, events), reactive `{{ }}` graph in a Web Worker (acorn deps + topological evaluation, reusing `packages/expressions`), queries proxied through the same connectors, event handlers, Table/Form/inputs first | Build a CRUD app on a Postgres table with an editable Table and a save query. |
| **M9+** | Python executor (nsjail), SQS/Kafka triggers, OAuth auth-code + custom auth flows, Git sync (canonical JSON already exists), multiplayer editing (Yjs), AI actions | n/a |

## 2.7a M0 implementation detail (in progress)

**Environment facts (checked):**
- Node v24.15.0, arm64 macOS. There is no pnpm, Docker or Postgres on PATH.
- pnpm runs through `corepack pnpm` (pinned `packageManager: pnpm@10.34.7`), so no global install is needed.
- **Postgres for dev and tests comes from `embedded-postgres@18.4.0-beta.17`** (downloads PG18 binaries via npm), so Docker isn't needed locally. Docker Compose files are still written for deployment, but can't be run on this machine until Docker or OrbStack is installed.
- **TypeScript is pinned to `~6.0.3`**, not 7.x. TS 7 is the Go-native compiler and tooling such as drizzle-kit relies on the JS compiler API.
- `isolated-vm@7.0.1` requires Node ≥24, which is a match.

**Pinned versions:**

| Package | Version |
|---|---|
| turbo | 2.11.7 |
| biome | 2.5.15 |
| vitest | 5.0.4 |
| drizzle-orm | 0.45.4 |
| drizzle-kit | 0.31.11 |
| postgres.js | 3.4.9 |
| fastify | 5.12.5 |
| tRPC | 11.19.0 |
| zod | 4.6.7 |
| openid-client | 6.8.8 |
| vite | 8.3.4 |
| react | 19.3.0 |
| TanStack Router | 1.170.x |
| TanStack Query | 5.104.x |
| tailwindcss | 4.3.3 |
| uuid | 14.0.3 |

**Conventions:**
- Internal packages export TypeScript source (`"exports": {".": "./src/index.ts"}`). There is no per-package build.
- The server runs with `tsx` in dev and is bundled with esbuild for the Docker image. The web app is built by Vite.
- IDs are UUIDv7, generated app-side (`uuid` v7) rather than depending on PG18's `uuidv7()`.

**Done:**
- Root config: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.nvmrc`.
- `docs/architecture.md`, a copy of this plan.
- `packages/db`: `package.json`, `tsconfig.json`, `drizzle.config.ts`, and `src/schema.ts` with tables users, sessions, groups, group_members, environments and audit_events.

**Remaining M0 steps:**
1. **`packages/db`:**
   - `src/client.ts`: `createDb(url)` returning drizzle with postgres.js.
   - `src/migrate.ts`: runs the drizzle migrator under `pg_advisory_lock`, then idempotently seeds environments `production` (default) and `staging`, and groups `admins` and `all_users`.
   - `src/dev-db.ts`: embedded PG on :5433, data in `.data/pg`.
   - `src/testing.ts`: `startTestDatabase()` uses embedded PG with a temp dir and a random port, or `TEST_DATABASE_URL` if set.
   - `src/index.ts`.
   - Run `drizzle-kit generate` to produce `migrations/0000_*.sql`.
2. **`packages/sandbox`, the isolated-vm spike:**
   - `CodeRuntime` interface and `IvmRuntime` providing `evalExpression` and `runCode`.
   - The stdlib (lodash, dayjs) is bundled with esbuild and loaded into the isolate.
   - Memory limit, a watchdog that calls `dispose()`, and a fresh context for every evaluation.
   - Vitest tests:
     - a fresh context starts in under 10ms
     - the stdlib works
     - `while(true){}` is killed at the timeout
     - a memory bomb is killed
     - `process`, `require` and `globalThis.process` are undefined
     - the isolate is recreated after an out-of-memory error
3. **`apps/server`:**
   - `src/config.ts`: environment variables parsed with zod (`DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_URL`, `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET`, `OIDC_ALLOWED_DOMAIN=optiply.nl`, `LOCAL_LOGIN_ENABLED`, `ROLE`).
   - `src/main.ts`: the ROLE switch for api, worker, migrate and all.
   - `src/api/app.ts`: Fastify with cookie and static plugins, `/api/health`, and tRPC at `/api/trpc`.
   - `src/api/auth.ts`:
     - Google OIDC authorization code + PKCE with openid-client v6.
     - Rejects emails outside the allowed domain (checks `hd` and the email suffix).
     - Upserts the user by `oidcSubject` or email, then adds them to `all_users`.
     - The first user ever is added to `admins`.
     - Opaque session token in an httpOnly SameSite=Lax cookie, stored as its sha256.
     - Break-glass `POST /api/auth/local` using scrypt, only if `LOCAL_LOGIN_ENABLED`.
     - Logout.
   - `src/trpc.ts`: context, plus `authed` and `admin` procedures.
   - Routers:
     - `me`
     - `users.list`, `users.setDisabled`
     - `groups.list`, `create`, `rename`, `delete`, `addMember`, `removeMember` (system groups are protected, and you cannot remove the last admin)
     - `environments.list`
     - `audit.list` (paginated)
   - `src/audit.ts`: `recordAudit()` with redaction.
   - `src/worker/index.ts`: a placeholder loop with heartbeat logging. The engine itself comes in M2.
   - `src/cli/create-admin.ts`: creates a local user with a password in `admins`.
   - Tests: Fastify `inject` against an embedded PG. Cover the health check, that an unauthenticated tRPC call returns 401, local login creating a session, that admin-only procedures reject non-admins, that the last admin can't be removed, and that audit rows are written.
4. **`apps/web`:**
   - Vite, React 19, TanStack Router (file-based), TanStack Query, tRPC client, Tailwind v4, and small shadcn-style UI primitives.
   - Login page with a Google button and an optional local form.
   - App shell with a sidebar: Workflows, Resources and Runs (placeholders), and Settings.
   - Settings pages: Users, Groups (with members), Environments (read-only) and Audit log.
   - The Vite dev server proxies `/api` to `:3000`.
5. **Ops:**
   - `Dockerfile`, multi-stage: turbo prune, a build stage with python3/make/g++, and a runtime on `node:24-bookworm-slim` started with `node --no-node-snapshot`.
   - `docker-compose.yml`: postgres:18, migrate, api, and 2× worker.
   - `.env.example`.
   - `.github/workflows/ci.yml`: corepack, `pnpm install --frozen-lockfile`, lint, typecheck, test.
   - `README.md` with dev quickstart steps: `corepack pnpm install` → `pnpm dev:db` → `pnpm db:migrate` → `pnpm dev`.
6. **Verify M0:**
   - `corepack pnpm install` succeeds, including the isolated-vm native build.
   - `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass.
   - Start the dev DB, run migrate, create a local admin, then run `pnpm dev`. Log in with the local admin at http://localhost:5173, then add a group and a member and check the action appears in the audit log.
   - Google login is verified once you provide OAuth client credentials. Docker Compose is verified once Docker is installed.
   - No commits are made unless you ask.

## 2.8 Verification (end to end, from M4 on)
1. `docker compose up` (postgres, migrate, api, 2× worker), then log in with Google.
2. Create a Postgres resource pointing at a seeded demo database in the same Compose file, with separate production and staging configs. Test connection succeeds. Check the API response contains no password.
3. Build the workflow webhook → `getOrders` (SQL with `{{ startTrigger.data.customerId }}`) → JS transform → Branch → Response, then publish v1.0.0.
4. `curl -X POST -H 'X-Api-Key: …' /api/workflows/<slug>/run -d '{"customerId":1}'` returns the Response body synchronously. Repeat with `?environment=staging` and check that it hits the staging database.
5. Add a 1-minute cron: runs appear in history with per-block data and logs, and none overlap.
6. Run `kill -9` on a worker mid-run. The run resumes on the other worker and completed blocks are not re-run.
7. Automated: `pnpm turbo test` (Vitest unit and golden-semantics tests, with Testcontainers for Postgres/MySQL connectors) and `pnpm --filter web e2e` (Playwright).

## 2.9 Open items (defaults chosen; change later if needed)
- Importing existing Retool workflows: block names, `{{ }}` semantics and settings were kept compatible, so an importer is cheap. It is not in scope yet.
- Under `skip`, a run that is waiting blocks the next scheduled fire. The default is yes, and each trigger can override it.
- Block results are capped at 10MB in Postgres. Object storage can come later.
- Licences: we write our own code. Ideas only from AGPL projects; code only from Apache-2.0 or MIT ones.
