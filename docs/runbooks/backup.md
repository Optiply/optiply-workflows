# Backup and restore

How to back up Optiply Workflows, restore it, and prove the restore works. Every command here was run against the Docker Compose stack (session 6, 2026-10-14); adapt the `docker compose exec` parts to wherever Postgres runs.

## What to back up

| What | Where | Why it matters |
|---|---|---|
| **The Postgres database** | `optiply_workflows` | Everything: workflows, drafts and releases, resources (credentials encrypted), config vars, users and groups, permissions, API keys (hashed), run history, User Tasks, the audit log. |
| **`ENCRYPTION_KEYS`** | the deployment's secrets (`.env` here) | Decrypts resource credentials and secret config vars. **A database backup without its keys has no usable secrets**, and the keys can't be recovered from the database. |
| `SESSION_SECRET` | same | Signs session cookies. Losing it only signs everyone out. |
| `OIDC_CLIENT_SECRET` | same | Google sign-in. Can be re-issued in Google Cloud Console. |

Nothing else holds state: the `api` and `worker` containers are stateless, and the image is rebuilt from Git.

**Keep the keys and the database backups apart** (different storage, different access). Someone holding both can read every credential. Keep every key version for as long as a backup made under it may be restored: a backup taken before a key rotation is encrypted with the old key.

## Taking backups

### Recommended: managed Postgres

Run the database on managed Postgres (Cloud SQL, RDS, …) with automated daily backups and **point-in-time recovery** (PITR), kept 14–30 days. That's the lowest-effort way to a small recovery point (minutes) and needs no scripts.

### Self-hosted (and the Compose stack)

A logical dump is a consistent snapshot (one transaction), safe to take while workers run:

```bash
docker compose exec -T postgres pg_dump -U ow -Fc optiply_workflows > backups/ow-$(date +%F).dump
```

- Schedule it nightly (cron or a systemd timer on the host) and copy the file off the machine (object storage with encryption at rest and versioning).
- Keep, for example, 14 daily, 8 weekly and 12 monthly dumps.
- Size: run history dominates; retention (`RUN_RETENTION_DAYS`, default 30) keeps it bounded. The drill's dump of a database with 20,000 block rows was 0.75 MB.
- For a recovery point smaller than a day, add WAL archiving (pgBackRest or WAL-G) for PITR.

Check that a dump is readable without restoring it:

```bash
docker compose exec -T postgres pg_restore --list < backups/ow-2026-10-14.dump | grep -c "TABLE DATA"   # 24 tables
```

## Restoring

1. **Stop the app** so nothing writes while you restore: `docker compose stop api worker`.
2. **Restore into a new, empty database** (keep the broken one until you're sure):

   ```bash
   docker compose exec -T postgres createdb -U ow ow_restored
   docker compose exec -T postgres pg_restore -U ow -d ow_restored --no-owner --exit-on-error < backups/ow-2026-10-14.dump
   ```

3. **Check the keys belong to it.** Every stored secret must decrypt with the configured `ENCRYPTION_KEYS`:

   ```bash
   docker compose run --rm --no-deps -e DATABASE_URL=postgres://ow:ow@postgres:5432/ow_restored \
     api node --no-node-snapshot dist/cli/verify-secrets.js
   ```

   It prints, per table, how many values decrypted and under which key versions, and exits 1 if any failed (wrong or missing key). Don't go on until it says `All secrets decrypt with the configured keys.`

4. **Bring the schema up to date** (a backup from an older version gets the newer migrations; otherwise this does nothing):

   ```bash
   docker compose run --rm --no-deps -e DATABASE_URL=postgres://ow:ow@postgres:5432/ow_restored -e ROLE=migrate api
   ```

5. **Point the app at it** (`DATABASE_URL`, or rename the databases: `alter database optiply_workflows rename to optiply_workflows_broken; alter database ow_restored rename to optiply_workflows;` with nothing connected) and start everything: `docker compose up -d`.

### What happens to work in flight

The backup is a moment in time; anything after it is gone (runs, edits, completed tasks, audit events). For what the backup caught mid-flight:

- **Running runs** have leases that have long expired: the workers' reaper puts them back in the queue and they resume from their last checkpoint (finished blocks don't run again). Each counts as a recovery; a run is failed after three.
- **Waiting runs** (Waits, child workflows, User Tasks) resume when they're due, or when their task is completed. Open User Tasks are still in people's inboxes.
- **Schedules** catch up with one run for the latest fire that passed, not one per missed fire.
- **Webhook calls** during the outage failed; callers have to retry them (the `Idempotency-Key` header makes retrying safe).
- **Retention** may delete runs the restored database still has, if they're older than `RUN_RETENTION_DAYS`.

## The restore drill (do it every quarter)

Restore the latest backup next to production and check it, without touching production. This is what was run on the Compose stack:

```bash
docker compose exec -T postgres pg_dump -U ow -Fc optiply_workflows > drill.dump
docker compose exec -T postgres createdb -U ow ow_restore_drill
docker compose exec -T postgres pg_restore -U ow -d ow_restore_drill --no-owner --exit-on-error < drill.dump

# Same counts in both databases:
Q="select (select count(*) from workflows), (select count(*) from workflow_runs), (select count(*) from block_runs),
          (select count(*) from resource_configs), (select count(*) from users), (select count(*) from audit_events)"
for db in optiply_workflows ow_restore_drill; do docker compose exec -T postgres psql -U ow -d $db -Atc "$Q"; done

# The keys decrypt everything (and a wrong key is caught: exit 1):
docker compose run --rm --no-deps -e DATABASE_URL=postgres://ow:ow@postgres:5432/ow_restore_drill \
  api node --no-node-snapshot dist/cli/verify-secrets.js

# An API on the restored copy (port 3001), to sign in and look around:
docker compose run -d --rm --no-deps -p 127.0.0.1:3001:3000 --name ow-drill-api \
  -e DATABASE_URL=postgres://ow:ow@postgres:5432/ow_restore_drill -e PUBLIC_URL=http://localhost:3001 api
curl -s localhost:3001/api/health        # {"ok":true}
docker stop ow-drill-api

docker compose exec -T postgres dropdb -U ow ow_restore_drill
```

Drill result on 2026-10-14: the dump (0.75 MB, 24 tables) restored with `--exit-on-error` and no errors; workflows, runs, the 20,024 block rows, resource configs, users and 40 audit events matched exactly; `verify-secrets` decrypted both stored secrets with the right key and failed both (exit 1) with a wrong one; `migrate` on the copy was a no-op; the API on the copy answered its health check, sign-in worked, and the three workflows were listed.

Write down each drill (date, backup used, how long the restore took, anything that failed) so the recovery time is known rather than guessed.

> **Careful with side processes in the Postgres container.** In the official image Postgres itself is the container's first process, so anything started with `docker exec -d` (a monitoring `psql \watch`, say) becomes its child once the exec's shell exits. If such a process is then killed by a signal (`pkill`), Postgres treats it as a crashed backend: it drops every connection and runs crash recovery. That happened during the session 6 check (about a second; the data recovered from the WAL, and runs carried on). Run monitors from another container (`docker compose run --rm postgres psql -h postgres …`) or let them exit on their own.

## Related

- **Key rotation:** README, "Local development" (`ENCRYPTION_KEYS`, `rekey`). Run `verify-secrets` before removing an old key: it lists how many values each key version still holds.
- **Retention:** README, "Building and running workflows" (`RUN_RETENTION_DAYS`).
- **Monitoring backups:** alert when the newest backup is older than a day. `ow_retention_last_finished_timestamp_seconds` in `/metrics` shows the retention job is running.
